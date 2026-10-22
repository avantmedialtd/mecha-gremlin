import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { err, ok } from '@mecha-gremlin/core/result';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import { z } from 'zod';
import { errorCode, fenceRead, reasonOf } from './fence.ts';
import { type ToolHandler, defineTool } from './tool-handler.ts';

// About 8k tokens (Brief R5.5). A browsing run needs a larger context than LM Studio's 8k default
// anyway: the skill's instructions and one snapshot already exceed it.
export const READ_LIMIT = 32 * 1024;

/** Git's test for binary files: text has no NUL bytes, and the first few KB tell. */
const BINARY_PROBE = 8 * 1024;

const NEWLINE = 0x0a;

const DESCRIPTION =
    "Read a UTF-8 text file and return its contents. The path is relative to the working directory, or absolute inside a skill's directory. offset is the first line to read, from 1, and limit the most lines; pass null for both to read from the start. Each call returns at most 32 KiB in whole lines, with a note giving the offset to continue from.";

const LineNumber = z.int().min(1).nullable();

// Strict mode needs every property required, and models that ignore it (LM Studio doesn't enforce
// it) leave the paging arguments out. validateArgs passes only JSON objects, so a missing one is
// made null before the schema checks it, and the model's JSON Schema still requires all three.
const ReadArgs = z.preprocess(
    (args) => {
        return { offset: null, limit: null, ...Object(args) };
    },
    z.strictObject({
        path: z
            .string()
            .describe(
                "The file's path: relative to the working directory, such as README.md or docs/guide.md, or absolute inside a skill's directory",
            ),
        offset: LineNumber,
        limit: LineNumber,
    }),
);

/**
 * What one call returns: whole lines, with the line to continue from when more follow; the start
 * of a first line longer than the cap; or, for an offset past the end, the file's line count.
 */
type Page =
    | { readonly kind: 'lines'; readonly bytes: Uint8Array; readonly next: number | undefined }
    | { readonly kind: 'long'; readonly bytes: Uint8Array; readonly follows: boolean }
    | { readonly kind: 'past'; readonly lines: number };

const readHead = async (file: string): Promise<Uint8Array> => {
    const chunks = await Array.fromAsync(createReadStream(file, { end: BINARY_PROBE - 1 }));

    return Buffer.concat(chunks);
};

/**
 * Streams the file from its start, skipping the lines before `first`, and stops as soon as the
 * page is known, so a large file costs only what is read. A line ends with `\n`, and a last run
 * without one is a line too.
 */
const readPage = async (file: string, first: number, limit: number): Promise<Page> => {
    const kept: Uint8Array[] = [];
    // The bytes of the requested lines kept so far, and how many of them make whole lines.
    let size = 0;
    let whole = 0;
    // The number of the line that the next byte belongs to.
    let line = 1;
    let lineEnded = true;
    // Set once the first requested line proves longer than the cap: the rest of it is skipped.
    let long = false;

    const take = (piece: Uint8Array): Page | undefined => {
        if (long) {
            return line > first
                ? { kind: 'long', bytes: Buffer.concat(kept), follows: true }
                : undefined;
        }

        if (line - first >= limit) {
            return { kind: 'lines', bytes: Buffer.concat(kept), next: line };
        }

        if (line < first) {
            return undefined;
        }

        if (size + piece.length <= READ_LIMIT) {
            kept.push(piece);
            size += piece.length;

            return undefined;
        }

        if (whole > 0) {
            return { kind: 'lines', bytes: Buffer.concat(kept).subarray(0, whole), next: line };
        }

        // The bytes past the cap tell whether the cut splits a character.
        kept.push(piece);
        long = true;

        return undefined;
    };

    for await (const chunk of createReadStream(file)) {
        const bytes: Buffer = chunk;

        for (let start = 0; start < bytes.length;) {
            const newline = bytes.indexOf(NEWLINE, start);
            const end = newline === -1 ? bytes.length : newline + 1;
            const page = take(bytes.subarray(start, end));

            if (page !== undefined) {
                return page;
            }

            start = end;
            lineEnded = newline !== -1;

            if (lineEnded) {
                line++;
                whole = size;
            }
        }
    }

    if (long) {
        return { kind: 'long', bytes: Buffer.concat(kept), follows: false };
    }

    // Only an empty file has nothing at line 1, and its empty contents are what was asked for.
    if (size === 0 && first > 1) {
        return { kind: 'past', lines: lineEnded ? line - 1 : line };
    }

    return { kind: 'lines', bytes: Buffer.concat(kept), next: undefined };
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

const describePage = (page: Page, name: string, first: number): ToolOutcome => {
    switch (page.kind) {
        case 'lines': {
            const text = decode(page.bytes);

            if (page.next === undefined) {
                return ok(text);
            }

            const last = page.next - 1;
            const shown = last === first ? `line ${first}` : `lines ${first}–${last}`;

            // Whole lines end with a line break already, so one more makes the blank line.
            return ok(`${text}\n[showing ${shown}; read with offset ${page.next} to continue]`);
        }
        case 'long': {
            const cut = characterBoundary(page.bytes, READ_LIMIT);
            const next = page.follows ? `; read with offset ${first + 1} to continue after it` : '';
            const note = `[line ${first} is longer than 32 KiB: showing its first ${cut} bytes; the rest of the line can be seen only through the shell${next}]`;

            return ok(`${decode(page.bytes.subarray(0, cut))}\n\n${note}`);
        }
        case 'past':
            return err(
                `offset ${first} is past the end of ${name}, which has ${page.lines} ${page.lines === 1 ? 'line' : 'lines'}.`,
            );
    }
};

const readLines = async (
    root: string,
    skillDirectories: readonly string[],
    path: string,
    first: number,
    limit: number,
): Promise<ToolOutcome> => {
    const name = JSON.stringify(path);

    try {
        const fenced = await fenceRead(root, skillDirectories, path);

        if (!fenced.ok) {
            return fenced;
        }

        const real = fenced.value;

        if ((await stat(real)).isDirectory()) {
            return err(`${name} is a directory.`);
        }

        if ((await readHead(real)).includes(0)) {
            return err(`${name} is a binary file.`);
        }

        return describePage(await readPage(real, first, limit), name, first);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return err(`No such file: ${name}.`);
        }

        return err(`Can't read ${name}: ${reasonOf(error)}`);
    }
};

export const readTool = (root: string, skillDirectories: readonly string[]): ToolHandler => {
    return defineTool(
        { name: 'read', description: DESCRIPTION, schema: ReadArgs },
        ({ path, offset, limit }) =>
            readLines(root, skillDirectories, path, offset ?? 1, limit ?? Number.POSITIVE_INFINITY),
    );
};
