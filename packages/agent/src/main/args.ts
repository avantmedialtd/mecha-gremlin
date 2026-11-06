import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { errorCode, reasonOf } from '../tools/errors.ts';
import { isBinary } from '../tools/read.ts';
import { type TaskText, readFrontmatter } from './frontmatter.ts';
import { parse } from './options.ts';

export type Task = TaskText & {
    /** The task file's absolute path, not its real one; undefined for a task given inline. */
    readonly file: string | undefined;
};

const USAGE =
    "Give the task as a file, as in bun run agent task.md, or inline after --prompt or -p, as in bun run agent -p 'Say hi'.";

const REQUIRED = `A task is required. ${USAGE}`;

const OPTIONS = { prompt: { type: 'string', short: 'p' } } as const;

const HINTS = { unknown: USAGE, value: USAGE };

const taskOf = (text: string, file: string | undefined, where: string): Result<Task, string> => {
    const read = readFrontmatter(text, where);

    if (!read.ok) {
        return read;
    }

    return ok({ ...read.value, file });
};

const fromFile = async (path: string): Promise<Result<Task, string>> => {
    // As WORK_DIR is resolved, so that task.md is in the directory WORK_DIR=. names: under bun run,
    // the repository's root.
    const file = resolve(process.cwd(), path);
    const name = JSON.stringify(file);

    try {
        // Read once: a pipe can't be read twice, and nothing can change the file between the
        // probe and the text.
        const bytes = await readFile(file);

        if (isBinary(bytes)) {
            return err(`The task file ${name} is a binary file.`);
        }

        const text = new TextDecoder().decode(bytes).trim();

        if (!text) {
            return err(`The task file ${name} is blank.`);
        }

        return taskOf(text, file, `task file ${name}`);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return err(`No task file at ${name}. ${USAGE}`);
        }

        return err(`Can't read the task file ${name}: ${reasonOf(error)}`);
    }
};

export const readTask = async (args: readonly string[]): Promise<Result<Task, string>> => {
    const parsed = parse(args, OPTIONS, HINTS);

    if (!parsed.ok) {
        return parsed;
    }

    const { values, positionals, tokens } = parsed.value;
    // Strict parsing has refused every other option, and the values keep only the last --prompt.
    const prompts = tokens.filter((token) => token.kind === 'option').length;
    const [path] = positionals;

    if (prompts > 1) {
        return err(`--prompt can be given only once. ${USAGE}`);
    }

    // The shell splits an unquoted task into words, and -p takes only the first of them.
    if (positionals.length > 1) {
        return err(
            `A run takes one task file, and was given ${positionals.length}. A task given inline is one argument after -p, quoted. ${USAGE}`,
        );
    }

    if (values.prompt === undefined) {
        if (path === undefined) {
            return err(REQUIRED);
        }

        return fromFile(path);
    }

    if (path !== undefined) {
        return err(`A task file, ${JSON.stringify(path)}, and --prompt were both given. ${USAGE}`);
    }

    const text = values.prompt.trim();

    if (!text) {
        return err(REQUIRED);
    }

    return taskOf(text, undefined, 'task given with --prompt');
};
