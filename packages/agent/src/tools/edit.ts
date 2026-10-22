import type { Stats } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import { z } from 'zod';
import { errorCode, fenceWrite, reasonOf } from './fence.ts';
import { type ToolHandler, defineTool } from './tool-handler.ts';
import { counted } from './write.ts';

const DESCRIPTION =
    'Replace exact text in a file. old_string must match the file exactly, including whitespace and indentation, and occur once unless replace_all is true. Read the file first to copy the text. To create or replace a whole file, use the write tool.';

// OpenHands' limit.
const EDIT_LIMIT = 10 * 1024 * 1024;

// All four are required, as strict mode needs.
const EditArgs = z.strictObject({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean(),
});

type Edit = Readonly<z.infer<typeof EditArgs>>;

/**
 * The text of a file that a tool changes part of. It must exist, be at most 10 MiB, hold no NUL
 * byte and be valid UTF-8: a file decoded lossily would be corrupted where nothing was meant to
 * change. Other I/O errors reject, for the tool to report.
 */
export const readEditable = async (
    target: string,
    name: string,
): Promise<Result<string, string>> => {
    let info: Stats;

    try {
        info = await stat(target);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return err(`No such file: ${name}.`);
        }

        throw error;
    }

    if (info.isDirectory()) {
        return err(`${name} is a directory.`);
    }

    if (info.size > EDIT_LIMIT) {
        return err(`${name} is too large to edit: it's over 10 MiB.`);
    }

    const bytes = await readFile(target);

    if (bytes.includes(0)) {
        return err(`${name} is a binary file.`);
    }

    try {
        // ignoreBOM keeps a byte order mark in the text, so writing the text back keeps it too.
        return ok(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    } catch {
        return err(`${name} isn't valid UTF-8.`);
    }
};

// Cline normalises line endings before matching; pointing the difference out is enough here.
const notFound = (name: string, text: string, old: string): string => {
    const message = `old_string wasn't found in ${name}. It must match the file exactly, including whitespace and indentation: read the file again and copy the text.`;
    const bareNewline = old.split('\r\n').some((part) => part.includes('\n'));

    return text.includes('\r\n') && bareNewline
        ? `${message} The file uses CRLF line endings: end each line of old_string with \\r\\n, not \\n alone.`
        : message;
};

const edit = async (root: string, args: Edit): Promise<ToolOutcome> => {
    const { path, old_string: old, new_string: replacement, replace_all: replaceAll } = args;
    const name = JSON.stringify(path);

    try {
        const fenced = await fenceWrite(root, 'edit', path);

        if (!fenced.ok) {
            return fenced;
        }

        const text = await readEditable(fenced.value, name);

        if (!text.ok) {
            return text;
        }

        if (old === '') {
            return err(
                'old_string is empty. To create or replace a whole file, use the write tool.',
            );
        }

        if (old === replacement) {
            return err('old_string and new_string are the same, so there is nothing to change.');
        }

        const count = text.value.split(old).length - 1;

        if (count === 0) {
            return err(notFound(name, text.value, old));
        }

        if (count > 1 && !replaceAll) {
            return err(
                `old_string occurs ${count} times in ${name}. Include more of the surrounding text to make it unique, or set replace_all to true to replace every one.`,
            );
        }

        // A function's result goes in literally, where a string's $& and $1 would be patterns.
        await writeFile(
            fenced.value,
            text.value.replaceAll(old, () => replacement),
        );

        return ok(`Replaced ${counted(count, 'occurrence')} in ${path}.`);
    } catch (error) {
        return err(`Can't edit ${name}: ${reasonOf(error)}`);
    }
};

export const editTool = (root: string): ToolHandler => {
    return defineTool({ name: 'edit', description: DESCRIPTION, schema: EditArgs }, (args) =>
        edit(root, args),
    );
};
