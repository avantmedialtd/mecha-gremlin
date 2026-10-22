import type { Stats } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import { z } from 'zod';
import { fenceWrite, reasonOf } from './fence.ts';
import { READ_LIMIT } from './read.ts';
import { type ToolHandler, defineTool } from './tool-handler.ts';

const DESCRIPTION =
    "Create or replace a UTF-8 text file with the given content, creating missing directories. The path is relative to the working directory. To change part of a file, use the edit tool; files over 32 KiB can't be replaced whole.";

const WriteArgs = z.strictObject({ path: z.string(), content: z.string() });

/**
 * Whether a file may be replaced whole, and whether it exists to be replaced. A file larger than
 * one call of the read tool returns may not have been read in full, and replacing it would drop
 * the unread part silently. Nothing records what the model has read, so the rule goes by size
 * alone. `instead` says how to change such a file.
 */
export const checkReplaceable = async (
    target: string,
    name: string,
    instead: string,
): Promise<Result<boolean, string>> => {
    let info: Stats;

    try {
        info = await stat(target);
    } catch {
        // A missing file is created. Any other problem shows again when the file is written.
        return ok(false);
    }

    if (info.isDirectory()) {
        return err(`${name} is a directory.`);
    }

    if (info.size > READ_LIMIT) {
        return err(
            `${name} is larger than one read returns (32 KiB), so replacing it whole could drop what you haven't read. ${instead}`,
        );
    }

    return ok(true);
};

/** Each `\n` ends a line, and text after the last one is a line too. */
const lineCount = (text: string): number => {
    const parts = text.split('\n');

    return parts.at(-1) === '' ? parts.length - 1 : parts.length;
};

export const counted = (count: number, unit: string): string => {
    return `${count} ${unit}${count === 1 ? '' : 's'}`;
};

// In place, not through a temporary file and a rename, which would replace a link and reset the
// file's mode.
const write = async (root: string, path: string, content: string): Promise<ToolOutcome> => {
    const name = JSON.stringify(path);

    try {
        const fenced = await fenceWrite(root, 'write', path);

        if (!fenced.ok) {
            return fenced;
        }

        const target = fenced.value;
        const existing = await checkReplaceable(
            target,
            name,
            'Change part of it with the edit tool.',
        );

        if (!existing.ok) {
            return existing;
        }

        const bytes = new TextEncoder().encode(content);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        const done = existing.value ? 'Replaced' : 'Created';

        return ok(
            `${done} ${path} (${counted(lineCount(content), 'line')}, ${counted(bytes.length, 'byte')}).`,
        );
    } catch (error) {
        return err(`Can't write ${name}: ${reasonOf(error)}`);
    }
};

export const writeTool = (root: string): ToolHandler => {
    return defineTool(
        { name: 'write', description: DESCRIPTION, schema: WriteArgs },
        ({ path, content }) => write(root, path, content),
    );
};
