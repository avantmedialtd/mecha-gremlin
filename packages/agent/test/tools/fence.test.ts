import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fenceWrite, reasonOf } from '../../src/tools/fence.ts';

let root: string;
// On macOS the temporary directory is reached through a link, and the fence gives real paths.
let realRoot: string;
let outside: string;
let skill: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'fence-root-'));
    realRoot = await realpath(root);
    outside = await mkdtemp(join(tmpdir(), 'fence-outside-'));
    skill = await realpath(await mkdtemp(join(tmpdir(), 'fence-skill-')));
    await writeFile(join(outside, 'secret.txt'), 'top secret');
    await writeFile(join(skill, 'SKILL.md'), '# Skill\n');

    await writeFile(join(root, 'notes.txt'), 'hello');
    await mkdir(join(root, 'docs'));
    await mkdir(join(root, 'config'));
    await writeFile(join(root, '.env'), 'MODEL_API_KEY=sk-live-secret');
    await symlink(join(root, '.env'), join(root, 'innocent.txt'));
    await symlink(join(root, 'notes.txt'), join(root, '.env.link'));
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await symlink(join(root, 'notes.txt'), join(root, 'alias.txt'));
    await symlink(join(root, 'nowhere.txt'), join(root, 'dangling.txt'));
    await symlink(outside, join(root, 'out'));
    await symlink(join(root, 'docs'), join(root, 'inner'));
    await symlink(root, join(outside, 'into-root'));
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(skill, { recursive: true, force: true });
});

const fence = (path: string, tool = 'write') => {
    return fenceWrite(root, tool, path);
};

const outsideError = (path: string, tool = 'write') => {
    return {
        ok: false,
        error: `${JSON.stringify(path)} is outside the working directory, the only place the ${tool} tool may write.`,
    };
};

const secretError = (path: string) => {
    return {
        ok: false,
        error: `${JSON.stringify(path)} is an environment file. The write tool doesn't write those: they hold secrets.`,
    };
};

describe('The write check gives the real path of a target inside the root', () => {
    test('an existing file', async () => {
        expect(await fence('notes.txt')).toEqual({ ok: true, value: join(realRoot, 'notes.txt') });
    });

    test('a file that does not exist yet', async () => {
        expect(await fence('new.txt')).toEqual({ ok: true, value: join(realRoot, 'new.txt') });
    });

    test('below directories that do not exist yet', async () => {
        expect(await fence('fresh/plans/q4.md')).toEqual({
            ok: true,
            value: join(realRoot, 'fresh', 'plans', 'q4.md'),
        });
    });

    test('an absolute path inside the root', async () => {
        expect(await fence(join(root, 'notes.txt'))).toEqual({
            ok: true,
            value: join(realRoot, 'notes.txt'),
        });
    });

    test('a symbolic link pointing inside', async () => {
        expect(await fence('alias.txt')).toEqual({ ok: true, value: join(realRoot, 'notes.txt') });
    });

    test('a missing path below a linked directory inside', async () => {
        expect(await fence('inner/new/file.txt')).toEqual({
            ok: true,
            value: join(realRoot, 'docs', 'new', 'file.txt'),
        });
    });

    test('the root itself', async () => {
        expect(await fence('.')).toEqual({ ok: true, value: realRoot });
    });

    test('a name that only starts with two dots is inside', async () => {
        expect(await fence('..notes.txt')).toEqual({
            ok: true,
            value: join(realRoot, '..notes.txt'),
        });
    });
});

describe('The write check refuses targets outside the root', () => {
    test.each(['..', '../escape.txt', 'docs/../../escape.txt', '/etc/hosts'])(
        '%s',
        async (path) => {
            expect(await fence(path)).toEqual(outsideError(path));
        },
    );

    test('an absolute path in another directory', async () => {
        const path = join(outside, 'secret.txt');

        expect(await fence(path)).toEqual(outsideError(path));
    });

    test("a skill's file, since skill directories are read-only", async () => {
        const path = join(skill, 'SKILL.md');

        expect(await fence(path)).toEqual(outsideError(path));
    });

    test('a linked directory pointing outside, with a missing path below it', async () => {
        expect(await fence('out/new/file.txt')).toEqual(outsideError('out/new/file.txt'));
    });

    test('a link to a file outside', async () => {
        expect(await fence('link.txt')).toEqual(outsideError('link.txt'));
    });

    test('a broken link', async () => {
        expect(await fence('dangling.txt')).toEqual(outsideError('dangling.txt'));
    });

    test('a path outside, through a link that leads into the root', async () => {
        const path = join(outside, 'into-root', 'notes.txt');

        expect(await fence(path)).toEqual(outsideError(path));
    });

    test('the message names the tool', async () => {
        expect(await fence('../escape.txt', 'edit')).toEqual(outsideError('../escape.txt', 'edit'));
    });
});

describe('The write check refuses environment files', () => {
    test.each(['.env', 'config/.env.local', 'docs/.envrc'])('%s', async (path) => {
        expect(await fence(path)).toEqual(secretError(path));
    });

    test('a link to an environment file', async () => {
        expect(await fence('innocent.txt')).toEqual(secretError('innocent.txt'));
    });

    test('a link named as an environment file', async () => {
        expect(await fence('.env.link')).toEqual(secretError('.env.link'));
    });

    test('the message names the tool', async () => {
        expect(await fence('.env', 'apply_patch')).toEqual({
            ok: false,
            error: '".env" is an environment file. The apply_patch tool doesn\'t write those: they hold secrets.',
        });
    });
});

describe('reasonOf', () => {
    test("an error's message", () => {
        expect(reasonOf(new Error('disk on fire'))).toBe('disk on fire');
    });

    test('anything else thrown, as text', () => {
        expect(reasonOf('disk on fire')).toBe('disk on fire');
    });
});
