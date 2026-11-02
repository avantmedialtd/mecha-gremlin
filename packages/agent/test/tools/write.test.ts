import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import { toFunctionTool } from '../../src/model/responses-tools.ts';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { writeTool } from '../../src/tools/write.ts';

// Everything a test touches is under a directory of its own, so what a test writes outside the
// root, through `..` too, goes when the test ends.
let base: string;
let root: string;
let outside: string;
let skill: string;

beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'write-'));
    root = join(base, 'root');
    outside = join(base, 'outside');
    skill = join(base, 'skill');
    await mkdir(root);
    await mkdir(outside);
    await mkdir(skill);
    await writeFile(join(outside, 'secret.txt'), 'top secret');
    await writeFile(join(skill, 'SKILL.md'), '# Skill\n');
    await writeFile(join(root, 'notes.txt'), 'hello');
    await mkdir(join(root, 'docs'));
    await mkdir(join(root, 'config'));
    await mkdir(join(root, 'data'));
    await writeFile(join(root, '.env'), 'MODEL_API_KEY=sk-live-secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'alias.txt'));
    await symlink(join(outside, 'created-by-link.txt'), join(root, 'dangling.txt'));
});

afterEach(async () => {
    await rm(base, { recursive: true, force: true });
});

const write = (path: string, content: string): Promise<ToolOutcome> => {
    return writeTool(root).invoke(JSON.stringify({ path, content }));
};

const contentsOf = (path: string): Promise<string> => {
    return readFile(join(root, path), 'utf8');
};

describe('Write a UTF-8 text file', () => {
    test('creates a file', async () => {
        const outcome = await write('new.txt', 'one\ntwo\n');

        expect(outcome).toEqual({ ok: true, value: 'Created new.txt (2 lines, 8 bytes).' });
        expect(await contentsOf('new.txt')).toBe('one\ntwo\n');
    });

    test('creates parent directories', async () => {
        const outcome = await write('docs/plans/q4.md', '# Q4\n');

        expect(outcome).toEqual({ ok: true, value: 'Created docs/plans/q4.md (1 line, 5 bytes).' });
        expect(await contentsOf('docs/plans/q4.md')).toBe('# Q4\n');
    });

    test('replaces a file, which keeps its mode', async () => {
        await chmod(join(root, 'notes.txt'), 0o600);

        const outcome = await write('notes.txt', 'new');

        expect(outcome).toEqual({ ok: true, value: 'Replaced notes.txt (1 line, 3 bytes).' });
        expect(await contentsOf('notes.txt')).toBe('new');
        expect((await stat(join(root, 'notes.txt'))).mode & 0o777).toBe(0o600);
    });

    test('empty content', async () => {
        const outcome = await write('empty.txt', '');

        expect(outcome).toEqual({ ok: true, value: 'Created empty.txt (0 lines, 0 bytes).' });
        expect(await contentsOf('empty.txt')).toBe('');
    });

    test('text after the last line break is a line too', async () => {
        expect(await write('two.txt', 'a\nb')).toEqual({
            ok: true,
            value: 'Created two.txt (2 lines, 3 bytes).',
        });
        expect(await write('one.txt', 'a')).toEqual({
            ok: true,
            value: 'Created one.txt (1 line, 1 byte).',
        });
    });

    test('multi-byte characters are counted in bytes', async () => {
        const outcome = await write('euro.txt', '€');

        expect(outcome).toEqual({ ok: true, value: 'Created euro.txt (1 line, 3 bytes).' });
        expect(await readFile(join(root, 'euro.txt'))).toEqual(Buffer.from([0xe2, 0x82, 0xac]));
    });

    test('the model sees a closed schema', () => {
        const tool = toFunctionTool(writeTool(root).tool);

        expect(tool).toMatchObject({ type: 'function', name: 'write', strict: true });
        expect(tool.parameters).toEqual({
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false,
        });
    });

    test('the model is told what the tool writes, and what it leaves to edit', () => {
        expect(writeTool(root).tool.description).toBe(
            "Create or replace a UTF-8 text file with the given content, creating missing directories. The path is relative to the working directory. To change part of a file, use the edit tool; files over 32 KiB can't be replaced whole.",
        );
    });

    test('extra arguments are rejected, and nothing is written', async () => {
        const outcome = await writeTool(root).invoke(
            '{"path":"notes.txt","content":"x","append":true}',
        );

        expect(outcome).toEqual({
            ok: false,
            error: expect.stringContaining('(root): Unrecognized key: "append"'),
        });
        expect(await contentsOf('notes.txt')).toBe('hello');
    });

    test('outside the root, by .. and by an absolute path', async () => {
        const absolute = join(outside, 'elsewhere.txt');

        expect(await write('../outside/notes.txt', 'x')).toEqual({
            ok: true,
            value: 'Created ../outside/notes.txt (1 line, 1 byte).',
        });
        expect(await write(absolute, 'x')).toEqual({
            ok: true,
            value: `Created ${absolute} (1 line, 1 byte).`,
        });
        expect(await readFile(join(outside, 'notes.txt'), 'utf8')).toBe('x');
        expect(await readFile(absolute, 'utf8')).toBe('x');
    });

    test('an absolute path inside the root', async () => {
        const outcome = await write(join(root, 'notes.txt'), 'new');

        expect(outcome).toEqual({
            ok: true,
            value: `Replaced ${join(root, 'notes.txt')} (1 line, 3 bytes).`,
        });
        expect(await contentsOf('notes.txt')).toBe('new');
    });

    test('through a symbolic link to a file outside the root, which stays a link', async () => {
        const outcome = await write('alias.txt', 'new');

        expect(outcome).toEqual({ ok: true, value: 'Replaced alias.txt (1 line, 3 bytes).' });
        expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('new');
        expect((await lstat(join(root, 'alias.txt'))).isSymbolicLink()).toBe(true);
    });

    test('through a broken link, which creates its target where it points', async () => {
        const outcome = await write('dangling.txt', 'x');

        expect(outcome).toEqual({ ok: true, value: 'Created dangling.txt (1 line, 1 byte).' });
        expect(await readFile(join(outside, 'created-by-link.txt'), 'utf8')).toBe('x');
        expect((await lstat(join(root, 'dangling.txt'))).isSymbolicLink()).toBe(true);
    });

    test.each([
        ['.env', 'Replaced'],
        ['config/.env.local', 'Created'],
        ['data/notes.txt', 'Created'],
    ])('environment files and the data folder: %s', async (path, done) => {
        expect(await write(path, 'X=1\n')).toEqual({
            ok: true,
            value: `${done} ${path} (1 line, 4 bytes).`,
        });
        expect(await contentsOf(path)).toBe('X=1\n');
    });

    test("a skill's file", async () => {
        const path = join(skill, 'SKILL.md');

        expect(await write(path, '# Changed\n')).toEqual({
            ok: true,
            value: `Replaced ${path} (1 line, 10 bytes).`,
        });
        expect(await readFile(path, 'utf8')).toBe('# Changed\n');
    });
});

describe('Refuse directories and large files', () => {
    test('a directory', async () => {
        expect(await write('docs', 'x')).toEqual({ ok: false, error: '"docs" is a directory.' });
    });

    test('a file larger than one read returns', async () => {
        await writeFile(join(root, 'big.log'), 'b'.repeat(40_000));

        expect(await write('big.log', 'short')).toEqual({
            ok: false,
            error: '"big.log" is larger than one read returns (32 KiB), so replacing it whole could drop what you haven\'t read. Change part of it with the edit tool.',
        });
        expect(await contentsOf('big.log')).toBe('b'.repeat(40_000));
    });

    test('a file one byte over the limit', async () => {
        await writeFile(join(root, 'over.txt'), 'o'.repeat(32_769));

        expect(await write('over.txt', 'short')).toMatchObject({ ok: false });
        expect(await contentsOf('over.txt')).toBe('o'.repeat(32_769));
    });

    test('a file at the limit', async () => {
        await writeFile(join(root, 'exact.txt'), 'e'.repeat(32_768));

        expect(await write('exact.txt', 'short')).toEqual({
            ok: true,
            value: 'Replaced exact.txt (1 line, 5 bytes).',
        });
        expect(await contentsOf('exact.txt')).toBe('short');
    });

    test.skipIf(process.getuid?.() === 0)('a parent directory that is not writable', async () => {
        await mkdir(join(root, 'locked'));
        await chmod(join(root, 'locked'), 0o555);

        try {
            expect(await write('locked/new.txt', 'x')).toEqual({
                ok: false,
                error: expect.stringMatching(/^Can't write "locked\/new.txt": EACCES/),
            });
        } finally {
            await chmod(join(root, 'locked'), 0o755);
        }
    });
});
