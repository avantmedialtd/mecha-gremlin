import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { err, ok } from '@mecha-gremlin/core/result';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import { z } from 'zod';
import { type ToolHandler, defineTool } from './tool-handler.ts';

/** About 8k tokens, so a capped file still fits LM Studio's default 8k context (Brief R5.5). */
export const READ_LIMIT = 32 * 1024;

/** Git's test for binary files: text has no NUL bytes, and the first few KB tell. */
const BINARY_PROBE = 8 * 1024;

const ReadFileArgs = z.strictObject({
    path: z
        .string()
        .describe(
            "The file's path relative to the working directory, such as README.md or docs/guide.md",
        ),
});

const isInside = (root: string, target: string): boolean => {
    const path = relative(root, target);

    return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

/** Files named `.env*` hold secrets by convention; direnv's `.envrc` is meant to match too. */
const isEnvFile = (path: string): boolean => {
    return basename(path).startsWith('.env');
};

const readHead = async (file: string, length: number): Promise<Uint8Array> => {
    // Reading past `length` only costs memory: the caller cuts the content at the limit.
    // Stryker disable next-line ObjectLiteral,ArithmeticOperator
    const chunks = await Array.fromAsync(createReadStream(file, { start: 0, end: length - 1 }));

    return Buffer.concat(chunks);
};

/**
 * UTF-8 continuation bytes are 10xxxxxx; cutting just before one would split a character. A
 * character has at most 3 of them, so in invalid UTF-8 the cut stops 3 bytes back.
 */
const characterBoundary = (bytes: Uint8Array, cut: number): number => {
    let boundary = cut;

    while (boundary > cut - 3 && ((bytes[boundary] ?? 0) & 0xc0) === 0x80) {
        boundary--;
    }

    return boundary;
};

/** TextDecoder replaces invalid UTF-8 with U+FFFD instead of throwing. */
const decode = (bytes: Uint8Array): string => {
    return new TextDecoder().decode(bytes);
};

/** `Object()` wraps anything thrown, null and strings too, so reading from it can't fail. */
const errorCode = (error: unknown): unknown => {
    return Object(error).code;
};

const readFile = async (root: string, path: string): Promise<ToolOutcome> => {
    const name = JSON.stringify(path);
    const outside = (): ToolOutcome => err(`${name} is outside the directory read_file may read.`);
    const secret = (): ToolOutcome =>
        err(`${name} is an environment file. read_file doesn't read those: they hold secrets.`);

    // A path that's outside lexically is refused without touching the disk at all.
    const target = resolve(root, path);

    if (!isInside(resolve(root), target)) {
        return outside();
    }

    if (isEnvFile(target)) {
        return secret();
    }

    try {
        // Again with symbolic links resolved, so a link can't lead outside or to a secret.
        const real = await realpath(target);

        if (!isInside(await realpath(root), real)) {
            return outside();
        }

        if (isEnvFile(real)) {
            return secret();
        }

        const info = await stat(real);

        if (info.isDirectory()) {
            return err(`${name} is a directory.`);
        }

        const bytes = await readHead(real, READ_LIMIT + 1);

        if (bytes.subarray(0, BINARY_PROBE).includes(0)) {
            return err(`${name} is a binary file.`);
        }

        if (bytes.length <= READ_LIMIT) {
            return ok(decode(bytes));
        }

        const cut = characterBoundary(bytes, READ_LIMIT);
        const note = `[truncated: showing the first ${cut} of ${info.size} bytes]`;

        return ok(`${decode(bytes.subarray(0, cut))}\n\n${note}`);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return err(`No such file: ${name}.`);
        }

        return err(`Can't read ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
};

export const readFileTool = (root: string): ToolHandler => {
    return defineTool(
        {
            name: 'read_file',
            description:
                'Read a UTF-8 text file in the working directory and return its contents. Files over 32 KiB are cut short, with a note saying so.',
            schema: ReadFileArgs,
        },
        ({ path }) => readFile(root, path),
    );
};
