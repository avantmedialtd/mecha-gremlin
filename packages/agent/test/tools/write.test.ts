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

// Everything a test touches is under a directory of its own, so whatever a mutant's broken fence
// writes outside the root, through `..` too, goes when the test ends.
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
    await writeFile(join(root, '.env'), 'MODEL_API_KEY=sk-live-secret');
    await symlink(join(root, '.env'), join(root, 'innocent.txt'));
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await symlink(join(root, 'notes.txt'), join(root, 'alias.txt'));
    await symlink(join(outside, 'created-by-link.txt'), join(root, 'dangling.txt'));
    await symlink(outside, join(root, 'out'));
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

const exists = async (path: string): Promise<boolean> => {
    return lstat(path).then(
        () => true,
        () => false,
    );
};

const outsideError = (path: string) => {
    return {
        ok: false,
        error: `${JSON.stringify(path)} is outside the working directory, the only place the write tool may write.`,
    };
};

const secretError = (path: string) => {
    return {
        ok: false,
        error: `${JSON.stringify(path)} is an environment file. The write tool doesn't write those: they hold secrets.`,
    };
};

describe('Write a UTF-8 text file under the working directory', () => {
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
});

describe('Never write outside the working directory', () => {
    test('a parent directory', async () => {
        expect(await write('../escape.txt', 'x')).toEqual(outsideError('../escape.txt'));
        expect(await exists(join(root, '..', 'escape.txt'))).toBe(false);
    });

    test('an absolute path outside the root', async () => {
        const path = join(outside, 'elsewhere.txt');

        expect(await write(path, 'x')).toEqual(outsideError(path));
        expect(await exists(path)).toBe(false);
    });

    test('an absolute path inside the root', async () => {
        const outcome = await write(join(root, 'notes.txt'), 'new');

        expect(outcome).toEqual({
            ok: true,
            value: `Replaced ${join(root, 'notes.txt')} (1 line, 3 bytes).`,
        });
        expect(await contentsOf('notes.txt')).toBe('new');
    });

    test("a skill's file", async () => {
        const path = join(skill, 'SKILL.md');

        expect(await write(path, 'x')).toEqual(outsideError(path));
        expect(await readFile(path, 'utf8')).toBe('# Skill\n');
    });

    test('a linked directory pointing outside', async () => {
        expect(await write('out/new/file.txt', 'x')).toEqual(outsideError('out/new/file.txt'));
        expect(await exists(join(outside, 'new'))).toBe(false);
    });

    test('a link to a file outside', async () => {
        expect(await write('link.txt', 'x')).toEqual(outsideError('link.txt'));
        expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('top secret');
    });

    test('a broken link', async () => {
        expect(await write('dangling.txt', 'x')).toEqual(outsideError('dangling.txt'));
        expect(await exists(join(outside, 'created-by-link.txt'))).toBe(false);
    });

    test('a link inside the root', async () => {
        const outcome = await write('alias.txt', 'new');

        expect(outcome).toEqual({ ok: true, value: 'Replaced alias.txt (1 line, 3 bytes).' });
        expect(await contentsOf('notes.txt')).toBe('new');
        expect((await lstat(join(root, 'alias.txt'))).isSymbolicLink()).toBe(true);
    });
});

describe('Refuse secrets, directories and large files', () => {
    test.each(['.env', 'config/.env.local'])('environment file %s', async (path) => {
        expect(await write(path, 'STOLEN=1')).toEqual(secretError(path));
    });

    test('nothing is written to an environment file', async () => {
        await write('.env', 'STOLEN=1');
        await write('config/.env.local', 'STOLEN=1');

        expect(await contentsOf('.env')).toBe('MODEL_API_KEY=sk-live-secret');
        expect(await exists(join(root, 'config', '.env.local'))).toBe(false);
    });

    test('a link to an environment file', async () => {
        expect(await write('innocent.txt', 'STOLEN=1')).toEqual(secretError('innocent.txt'));
        expect(await contentsOf('.env')).toBe('MODEL_API_KEY=sk-live-secret');
    });

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
