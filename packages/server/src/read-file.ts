import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolOutcome } from "@mecha-gremlin/core";
import { z } from "zod";
import { type ToolHandler, defineTool } from "./tool-handler.ts";

/**
 * At most this much of a file goes back to the model: about 8k tokens, so a capped file still fits
 * LM Studio's default 8k context (Brief R5.5).
 */
export const READ_LIMIT = 32 * 1024;

/** A NUL byte this early in a file marks it as binary. */
const BINARY_PROBE = 8 * 1024;

const ReadFileArgs = z.strictObject({
    path: z
        .string()
        .describe(
            "The file's path relative to the working directory, such as README.md or docs/guide.md",
        ),
});

/**
 * The `read_file` tool, confined to `root`. It reads UTF-8 text files under `root` and nothing
 * else: not paths outside it (symbolic links included), environment files, directories or
 * binary files. It returns at most `READ_LIMIT` bytes. Every failure is a value.
 */
export function readFileTool(root: string): ToolHandler {
    return defineTool(
        {
            name: "read_file",
            description:
                "Read a UTF-8 text file in the working directory and return its contents. Files over 32 KiB are cut short, with a note saying so.",
            schema: ReadFileArgs,
        },
        ({ path }) => readFile(root, path),
    );
}

async function readFile(root: string, path: string): Promise<ToolOutcome> {
    const name = JSON.stringify(path);
    const outside = (): ToolOutcome =>
        failure(`${name} is outside the directory read_file may read.`);
    const secret = (): ToolOutcome =>
        failure(`${name} is an environment file. read_file doesn't read those: they hold secrets.`);

    // Before touching the disk: `..` and absolute paths.
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
            return failure(`${name} is a directory.`);
        }
        const bytes = await readHead(real, READ_LIMIT + 1);
        if (bytes.subarray(0, BINARY_PROBE).includes(0)) {
            return failure(`${name} is a binary file.`);
        }
        if (bytes.length <= READ_LIMIT) {
            return { ok: true, output: decode(bytes) };
        }
        const cut = characterBoundary(bytes, READ_LIMIT);
        const note = `[truncated: showing the first ${cut} of ${info.size} bytes]`;
        return { ok: true, output: `${decode(bytes.subarray(0, cut))}\n\n${note}` };
    } catch (error) {
        if (errorCode(error) === "ENOENT") {
            return failure(`No such file: ${name}.`);
        }
        return failure(
            `Can't read ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

function isInside(root: string, target: string): boolean {
    const path = relative(root, target);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** `.env`, `.env.local`, `.envrc` and the like: files that hold secrets by convention. */
function isEnvFile(path: string): boolean {
    return basename(path).startsWith(".env");
}

/** The first `length` bytes of a file, or all of it if it's shorter. */
async function readHead(file: string, length: number): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of createReadStream(file, { start: 0, end: length - 1 })) {
        chunks.push(chunk as Uint8Array);
    }
    return Buffer.concat(chunks);
}

/** Moves a cut back while it would split a UTF-8 character, whose continuation bytes are 10xxxxxx. */
function characterBoundary(bytes: Uint8Array, cut: number): number {
    let boundary = cut;
    while (boundary > 0 && ((bytes[boundary] ?? 0) & 0xc0) === 0x80) {
        boundary--;
    }
    return boundary;
}

/** UTF-8, with invalid sequences replaced by U+FFFD. */
function decode(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

function failure(error: string): ToolOutcome {
    return { ok: false, error };
}

function errorCode(error: unknown): unknown {
    return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
