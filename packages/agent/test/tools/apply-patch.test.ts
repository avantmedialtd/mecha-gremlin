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
import { type ToolOutcome, toFunctionTool } from '@mecha-gremlin/core/tools';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { applyPatchTool } from '../../src/tools/apply-patch.ts';

// The root has a parent of its own, so whatever a mutant's broken fence writes through `..` goes
// when the test ends.
let base: string;
let root: string;

const APP = 'const a = 1;\nconst b = 2;\n';

beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'apply-patch-'));
    root = join(base, 'root');
    await mkdir(root);
    await writeFile(join(root, 'app.ts'), APP);
    await writeFile(join(root, 'old.txt'), 'old\n');
    await writeFile(join(root, '.env'), 'MODEL_API_KEY=sk-live-secret');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    await mkdir(join(root, 'docs'));
});

afterEach(async () => {
    await rm(base, { recursive: true, force: true });
});

const apply = (...lines: readonly string[]): Promise<ToolOutcome> => {
    return applyPatchTool(root).invoke(
        JSON.stringify({ patch: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }),
    );
};

const contentsOf = (path: string): Promise<string> => {
    return readFile(join(root, path), 'utf8');
};

const exists = async (path: string): Promise<boolean> => {
    return lstat(join(root, path)).then(
        () => true,
        () => false,
    );
};

const expectAppUnchanged = async (): Promise<void> => {
    expect(await contentsOf('app.ts')).toBe(APP);
};

const CHANGE_APP = ['*** Update File: app.ts', '@@', '-const b = 2;', '+const b = 3;'];

describe("Accept a patch in Codex's V4A format", () => {
    test('the model sees a closed schema', () => {
        const tool = toFunctionTool(applyPatchTool(root).tool);

        expect(tool).toMatchObject({ type: 'function', name: 'apply_patch', strict: true });
        expect(tool.parameters).toEqual({
            type: 'object',
            properties: { patch: { type: 'string' } },
            required: ['patch'],
            additionalProperties: false,
        });
    });

    test('the description explains the format, with an example', () => {
        expect(applyPatchTool(root).tool.description).toBe(
            `Add, change, move or delete files with a patch. Nothing is changed unless the whole patch applies. The patch is text in this envelope:

*** Begin Patch
[one or more file sections]
*** End Patch

Each section starts with one of these headers:
*** Add File: <path> creates a file, or replaces one. Every line after it starts with +.
*** Delete File: <path> removes a file. Nothing follows it.
*** Update File: <path> changes a file in place. To rename it too, put *** Move to: <new path> on the next line. Then come one or more chunks, each starting with @@. A chunk's lines start with a space for an unchanged line, - for a removed one and + for an added one. Show 3 unchanged lines above and below each change, copied exactly. When the lines a chunk changes occur more than once, write the line that comes before them, such as a function's first line, after the @@, as in @@ def greet():, to pick the place.

Paths are relative to the working directory. Name each file in one section only.

Example:
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch`,
        );
    });

    test('a patch that does not parse changes nothing', async () => {
        const outcome = await applyPatchTool(root).invoke(
            JSON.stringify({ patch: '*** Begin Patch\n*** Add File: new.txt\n+x\n' }),
        );

        expect(outcome).toEqual({
            ok: false,
            error: "invalid patch: The last line of the patch must be '*** End Patch'",
        });
        expect(await exists('new.txt')).toBe(false);
    });
});

describe('Add, delete, update and move files under the working directory', () => {
    test('adds a file in a new directory', async () => {
        const outcome = await apply('*** Add File: docs/new/new.md', '+# Title', '+text');

        expect(outcome).toEqual({
            ok: true,
            value: 'Success. Updated the following files:\nA docs/new/new.md',
        });
        expect(await contentsOf('docs/new/new.md')).toBe('# Title\ntext\n');
    });

    test('an added file replaces a small one', async () => {
        expect(await apply('*** Add File: old.txt', '+new')).toMatchObject({ ok: true });
        expect(await contentsOf('old.txt')).toBe('new\n');
    });

    test('deletes a file', async () => {
        expect(await apply('*** Delete File: old.txt')).toEqual({
            ok: true,
            value: 'Success. Updated the following files:\nD old.txt',
        });
        expect(await exists('old.txt')).toBe(false);
    });

    test('deleting a link removes the link, not what it points to', async () => {
        await symlink(join(root, 'old.txt'), join(root, 'alias.txt'));

        expect(await apply('*** Delete File: alias.txt')).toMatchObject({ ok: true });
        expect(await exists('alias.txt')).toBe(false);
        expect(await contentsOf('old.txt')).toBe('old\n');
    });

    test('deleting a missing file', async () => {
        expect(await apply('*** Add File: new.txt', '+x', '*** Delete File: gone.txt')).toEqual({
            ok: false,
            error: 'No such file: "gone.txt".',
        });
        expect(await exists('new.txt')).toBe(false);
    });

    test('deleting a directory', async () => {
        expect(await apply('*** Delete File: docs')).toEqual({
            ok: false,
            error: '"docs" is a directory.',
        });
    });

    test('updates a file in place', async () => {
        await chmod(join(root, 'app.ts'), 0o640);

        expect(await apply(...CHANGE_APP)).toEqual({
            ok: true,
            value: 'Success. Updated the following files:\nM app.ts',
        });
        expect(await contentsOf('app.ts')).toBe('const a = 1;\nconst b = 3;\n');
        expect((await stat(join(root, 'app.ts'))).mode & 0o777).toBe(0o640);
    });

    test('an update keeps CRLF line endings', async () => {
        await writeFile(join(root, 'crlf.txt'), 'a\r\nb\r\n');

        await apply('*** Update File: crlf.txt', '@@', ' a', '-b', '+B', '+C');

        expect(await contentsOf('crlf.txt')).toBe('a\r\nB\r\nC\r\n');
    });

    test('moves and updates a file', async () => {
        const outcome = await apply(
            '*** Update File: src/a.ts',
            '*** Move to: lib/b.ts',
            '@@',
            '-export const a = 1;',
            '+export const b = 2;',
        );

        expect(outcome).toEqual({
            ok: true,
            value: 'Success. Updated the following files:\nM lib/b.ts',
        });
        expect(await contentsOf('lib/b.ts')).toBe('export const b = 2;\n');
        expect(await exists('src/a.ts')).toBe(false);
    });

    test('a move may replace a small file', async () => {
        await writeFile(join(root, 'target.ts'), 'old\n');

        expect(
            await apply('*** Update File: src/a.ts', '*** Move to: target.ts', '@@', '+// moved'),
        ).toMatchObject({ ok: true });
        expect(await contentsOf('target.ts')).toBe('export const a = 1;\n// moved\n');
    });

    test('updating a missing file', async () => {
        expect(await apply('*** Update File: missing.ts', '@@', '+x')).toEqual({
            ok: false,
            error: 'No such file: "missing.ts".',
        });
    });

    test('updating a file that edit would refuse', async () => {
        await writeFile(join(root, 'logo.png'), new Uint8Array([0x89, 0x50, 0x00, 0x0d]));

        expect(await apply('*** Update File: logo.png', '@@', '+x')).toEqual({
            ok: false,
            error: '"logo.png" is a binary file.',
        });
    });

    test('a chunk that does not match', async () => {
        expect(await apply('*** Update File: app.ts', '@@ class Nope', '-x', '+y')).toEqual({
            ok: false,
            error: "Failed to find context 'class Nope' in app.ts",
        });
    });

    test('outside the working directory', async () => {
        expect(
            await apply('*** Add File: new.txt', '+x', '*** Add File: ../escape.txt', '+x'),
        ).toEqual({
            ok: false,
            error: '"../escape.txt" is outside the working directory, the only place the apply_patch tool may write.',
        });
        expect(await exists('new.txt')).toBe(false);
        expect(await exists('../escape.txt')).toBe(false);
    });

    test('a move to outside the working directory', async () => {
        expect(
            await apply('*** Update File: src/a.ts', '*** Move to: ../b.ts', '@@', '+x'),
        ).toEqual({
            ok: false,
            error: '"../b.ts" is outside the working directory, the only place the apply_patch tool may write.',
        });
        expect(await exists('src/a.ts')).toBe(true);
    });

    test('an environment file', async () => {
        expect(
            await apply(
                ...CHANGE_APP,
                '*** Update File: .env',
                '@@',
                '-MODEL_API_KEY=sk-live-secret',
                '+X=1',
            ),
        ).toEqual({
            ok: false,
            error: '".env" is an environment file. The apply_patch tool doesn\'t write those: they hold secrets.',
        });
        expect(await contentsOf('.env')).toBe('MODEL_API_KEY=sk-live-secret');
        await expectAppUnchanged();
    });

    test('adding over a large file', async () => {
        await writeFile(join(root, 'big.log'), 'b'.repeat(40_000));

        expect(await apply('*** Add File: big.log', '+short')).toEqual({
            ok: false,
            error: '"big.log" is larger than one read returns (32 KiB), so replacing it whole could drop what you haven\'t read. Change part of it with an *** Update File section instead.',
        });
        expect(await contentsOf('big.log')).toBe('b'.repeat(40_000));
    });

    test('moving onto a large file', async () => {
        await writeFile(join(root, 'big.log'), 'b'.repeat(40_000));

        expect(
            await apply('*** Update File: src/a.ts', '*** Move to: big.log', '@@', '+x'),
        ).toMatchObject({
            ok: false,
            error: expect.stringContaining('"big.log" is larger than one read returns'),
        });
        expect(await contentsOf('big.log')).toBe('b'.repeat(40_000));
        expect(await exists('src/a.ts')).toBe(true);
    });

    test('adding over a directory', async () => {
        expect(await apply('*** Add File: docs', '+x')).toEqual({
            ok: false,
            error: '"docs" is a directory.',
        });
    });

    test('a path named twice', async () => {
        expect(
            await apply(
                ...CHANGE_APP,
                '*** Update File: app.ts',
                '@@',
                '-const a = 1;',
                '+const a = 0;',
            ),
        ).toEqual({
            ok: false,
            error: 'The patch names "app.ts" more than once. Put all of a file\'s changes in one section.',
        });
        await expectAppUnchanged();
    });

    test('a path named twice, spelled differently', async () => {
        expect(
            await apply('*** Delete File: old.txt', `*** Add File: ${join(root, 'old.txt')}`, '+x'),
        ).toEqual({
            ok: false,
            error: `The patch names ${JSON.stringify(join(root, 'old.txt'))} more than once. Put all of a file's changes in one section.`,
        });
        expect(await contentsOf('old.txt')).toBe('old\n');
    });

    test('a move onto the file it moves', async () => {
        expect(
            await apply('*** Update File: src/a.ts', '*** Move to: src/a.ts', '@@', '+x'),
        ).toEqual({
            ok: false,
            error: 'The patch names "src/a.ts" more than once. Put all of a file\'s changes in one section.',
        });
        expect(await contentsOf('src/a.ts')).toBe('export const a = 1;\n');
    });

    test('a path through a file', async () => {
        expect(await apply('*** Delete File: old.txt/inner.txt')).toEqual({
            ok: false,
            error: expect.stringMatching(
                /^Can't apply the patch: ENOTDIR.*\. No file was changed\.$/,
            ),
        });
    });
});

describe('Change nothing unless the whole patch applies, and report each file', () => {
    test('a later hunk fails', async () => {
        const outcome = await apply(
            '*** Add File: new.txt',
            '+x',
            '*** Update File: app.ts',
            '@@',
            '-const c = 3;',
            '+const c = 4;',
        );

        expect(outcome).toEqual({
            ok: false,
            error: 'Failed to find expected lines in app.ts:\nconst c = 3;',
        });
        expect(await exists('new.txt')).toBe(false);
        await expectAppUnchanged();
    });

    test('the success report', async () => {
        await writeFile(join(root, 'b.txt'), 'b\n');
        await writeFile(join(root, 'c.txt'), 'c\n');

        const outcome = await apply(
            '*** Add File: a.txt',
            '+a',
            '*** Update File: b.txt',
            '@@',
            '-b',
            '+B',
            '*** Delete File: c.txt',
        );

        expect(outcome).toEqual({
            ok: true,
            value: 'Success. Updated the following files:\nA a.txt\nM b.txt\nD c.txt',
        });
        expect(await contentsOf('a.txt')).toBe('a\n');
        expect(await contentsOf('b.txt')).toBe('B\n');
        expect(await exists('c.txt')).toBe(false);
    });

    test('the report follows the patch, and gives paths as written', async () => {
        const absolute = join(root, 'old.txt');

        expect(await apply(`*** Delete File: ${absolute}`, '*** Add File: z.txt', '+z')).toEqual({
            ok: true,
            value: `Success. Updated the following files:\nD ${absolute}\nA z.txt`,
        });
    });

    test.skipIf(process.getuid?.() === 0)('a write that fails partway', async () => {
        await writeFile(join(root, 'locked.txt'), 'locked\n');
        await chmod(join(root, 'locked.txt'), 0o444);

        const outcome = await apply(
            '*** Add File: a.txt',
            '+a',
            '*** Delete File: old.txt',
            '*** Update File: locked.txt',
            '@@',
            '-locked',
            '+open',
        );

        expect(outcome).toEqual({
            ok: false,
            error: expect.stringMatching(
                /^Applying M locked.txt failed \(EACCES.*\)\. Changed before it, and still changed: A a.txt, D old.txt\.$/,
            ),
        });
        expect(await contentsOf('a.txt')).toBe('a\n');
        expect(await exists('old.txt')).toBe(false);
    });

    test.skipIf(process.getuid?.() === 0)('a write that fails first', async () => {
        await writeFile(join(root, 'locked.txt'), 'locked\n');
        await chmod(join(root, 'locked.txt'), 0o444);

        expect(await apply('*** Update File: locked.txt', '@@', '-locked', '+open')).toEqual({
            ok: false,
            error: expect.stringMatching(
                /^Applying M locked.txt failed \(EACCES.*\)\. No file was changed before it\.$/,
            ),
        });
    });
});
