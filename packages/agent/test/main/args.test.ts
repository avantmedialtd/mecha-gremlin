import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { readTask } from '../../src/main/args.ts';

const USAGE =
    "Give the task as a file, as in bun run agent task.md, or inline after --prompt or -p, as in bun run agent -p 'Say hi'.";

const REQUIRED = `A task is required. ${USAGE}`;

const QUESTION = 'Which runtime does README.md describe?';

const needs = (option: string): string => {
    return `The option ${option} needs a value; one that starts with - is given as --prompt=<value>. ${USAGE}`;
};

// The directory a run starts in, as process.cwd() gives it.
let directory: string;

beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'args-'));
    await mkdir(join(directory, 'data'));
    await mkdir(join(directory, 'docs'));
    await writeFile(join(directory, 'task.md'), `\n  ${QUESTION}\n\n`);
    await writeFile(
        join(directory, 'kept.txt'),
        '---\ntags: [work]\n---\nSay hi\r\n\r\n  and bye\r\n',
    );
    await writeFile(join(directory, 'bom.md'), '﻿Say hi\n');
    await writeFile(join(directory, 'TASK'), 'Say hi');
    await writeFile(join(directory, 'latin1.txt'), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x21]));
    await writeFile(join(directory, 'late-nul.txt'), `${'a'.repeat(8 * 1024)}\0tail`);
    await writeFile(join(directory, 'edge-nul.txt'), `${'a'.repeat(8 * 1024 - 1)}\0`);
    await writeFile(
        join(directory, 'logo.png'),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]),
    );
    await writeFile(join(directory, 'empty.md'), '');
    await writeFile(join(directory, 'blank.md'), ' \n\t\r\n﻿\n');
    await writeFile(join(directory, '.env'), 'Say hi\n');
    await symlink(join(directory, '.env'), join(directory, 'innocent.md'));
    await symlink(join(directory, 'task.md'), join(directory, 'alias.md'));
    await writeFile(join(directory, 'data', 'notes.md'), 'Say hi\n');
    await writeFile(join(directory, 'locked.md'), 'locked');
    await chmod(join(directory, 'locked.md'), 0o000);
});

afterAll(async () => {
    await chmod(join(directory, 'locked.md'), 0o600);
    await rm(directory, { recursive: true, force: true });
});

const taskOf = (...args: readonly string[]) => {
    vi.spyOn(process, 'cwd').mockReturnValue(directory);

    return readTask(args);
};

const nameOf = (path: string): string => {
    return JSON.stringify(join(directory, path));
};

describe('Take the task from a file, or from --prompt', () => {
    test('requires an actual task', async () => {
        expect(await taskOf()).toEqual({ ok: false, error: REQUIRED });
        expect(await taskOf('-p', ' \t\n ')).toEqual({ ok: false, error: REQUIRED });
        expect(await taskOf('--prompt=')).toEqual({ ok: false, error: REQUIRED });
        expect(await taskOf('-p', 'What runs?')).toEqual({
            ok: true,
            value: { text: 'What runs?', file: undefined },
        });
    });

    test.each([
        [['-p', '  Say hi\n']],
        [['--prompt', 'Say hi']],
        [['--prompt=Say hi']],
        [['-pSay hi']],
    ])('inline, trimmed: %j', async (args) => {
        expect(await taskOf(...args)).toEqual({
            ok: true,
            value: { text: 'Say hi', file: undefined },
        });
    });

    test.each([
        ['its text, trimmed', 'task.md', QUESTION],
        [
            'its frontmatter, line endings and inner whitespace as written',
            'kept.txt',
            '---\ntags: [work]\n---\nSay hi\r\n\r\n  and bye',
        ],
        ['without its byte-order mark', 'bom.md', 'Say hi'],
        ['whatever its extension, or none', 'TASK', 'Say hi'],
        ['invalid UTF-8 replaced with U+FFFD', 'latin1.txt', 'caf�!'],
        ['a NUL byte after the first 8 KiB', 'late-nul.txt', `${'a'.repeat(8 * 1024)}\0tail`],
        ['through a link, which keeps its own path', 'alias.md', QUESTION],
        ['named like an environment file', '.env', 'Say hi'],
        ['through a link to an environment file', 'innocent.md', 'Say hi'],
        ['in a data folder', 'data/notes.md', 'Say hi'],
    ])('a task file: %s', async (_what, name, text) => {
        expect(await taskOf(name)).toEqual({
            ok: true,
            value: { text, file: join(directory, name) },
        });
    });

    test('a relative path resolves against the current directory, and an absolute one stays', async () => {
        const read = { ok: true, value: { text: QUESTION, file: join(directory, 'task.md') } };

        expect(await taskOf('docs/../task.md')).toEqual(read);
        expect(await taskOf(join(directory, 'task.md'))).toEqual(read);
    });

    test('-p given a value that starts with -: --prompt=<value> takes it', async () => {
        expect(await taskOf('-p', '-x')).toEqual({ ok: false, error: needs('-p') });
        expect(await taskOf('--prompt', '--verbose')).toEqual({
            ok: false,
            error: needs('--prompt'),
        });
        expect(await taskOf('-p')).toEqual({ ok: false, error: needs('-p') });
        expect(await taskOf('--prompt=-x')).toEqual({
            ok: true,
            value: { text: '-x', file: undefined },
        });
        expect(await taskOf('-p', '-')).toEqual({
            ok: true,
            value: { text: '-', file: undefined },
        });
    });

    test('a task file named like an option, after --', async () => {
        expect(await taskOf('--', '-p')).toEqual({
            ok: false,
            error: `No task file at ${nameOf('-p')}. ${USAGE}`,
        });
    });
});

describe('Refuse a task given more than one way', () => {
    const several = `A run takes one task file, and was given 2. A task given inline is one argument after -p, quoted. ${USAGE}`;

    test.each([
        [
            ['task.md', '-p', 'Say hi'],
            `A task file, "task.md", and --prompt were both given. ${USAGE}`,
        ],
        [['-p', 'Say', 'hi'], `A task file, "hi", and --prompt were both given. ${USAGE}`],
        [['Say', 'hi'], several],
        [['-p', 'Say', 'hi', 'there'], several],
        [['-p', 'Say', '-p', 'hi'], `--prompt can be given only once. ${USAGE}`],
        [['--prompt=Say', '-phi', 'task.md'], `--prompt can be given only once. ${USAGE}`],
        [['--verbose'], `The option --verbose isn't known. ${USAGE}`],
        [['-P', 'Say hi'], `The option -P isn't known. ${USAGE}`],
        [['-xp', 'Say hi'], `The option -x isn't known. ${USAGE}`],
    ])('%j', async (args, error) => {
        expect(await taskOf(...args)).toEqual({ ok: false, error });
    });
});

describe("Refuse a task file that can't be read, or isn't text", () => {
    test("a file that doesn't exist: the absolute path looked at, and both ways", async () => {
        expect(await taskOf('Say hi')).toEqual({
            ok: false,
            error: `No task file at ${nameOf('Say hi')}. ${USAGE}`,
        });
    });

    test.each([
        ['logo.png', 'is a binary file.'],
        ['edge-nul.txt', 'is a binary file.'],
        ['empty.md', 'is blank.'],
        ['blank.md', 'is blank.'],
    ])('%s', async (name, why) => {
        expect(await taskOf(name)).toEqual({
            ok: false,
            error: `The task file ${nameOf(name)} ${why}`,
        });
    });

    test("a directory: the system's reason", async () => {
        expect(await taskOf('docs')).toEqual({
            ok: false,
            error: expect.stringContaining(
                `Can't read the task file ${nameOf('docs')}: EISDIR: illegal operation on a directory`,
            ),
        });
    });

    test.skipIf(process.getuid?.() === 0)('an unreadable file', async () => {
        expect(await taskOf('locked.md')).toEqual({
            ok: false,
            error: expect.stringContaining(
                `Can't read the task file ${nameOf('locked.md')}: EACCES`,
            ),
        });
    });
});
