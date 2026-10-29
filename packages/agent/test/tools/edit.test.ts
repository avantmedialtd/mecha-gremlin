import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    truncate,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import { toFunctionTool } from '../../src/model/responses-tools.ts';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { editTool } from '../../src/tools/edit.ts';

const TEN_MIB = 10 * 1024 * 1024;

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'edit-root-'));
    await writeFile(join(root, 'app.ts'), 'const a = 1;\nconst b = 2;\n');
    await writeFile(join(root, '.env'), 'MODEL_API_KEY=sk-live-secret');
    await mkdir(join(root, 'docs'));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const edit = (
    path: string,
    oldString: string,
    newString: string,
    replaceAll = false,
): Promise<ToolOutcome> => {
    return editTool(root).invoke(
        JSON.stringify({
            path,
            old_string: oldString,
            new_string: newString,
            replace_all: replaceAll,
        }),
    );
};

const contentsOf = (path: string): Promise<string> => {
    return readFile(join(root, path), 'utf8');
};

const NOT_FOUND =
    'It must match the file exactly, including whitespace and indentation: read the file again and copy the text.';

const CRLF_HINT =
    'The file uses CRLF line endings: end each line of old_string with \\r\\n, not \\n alone.';

describe('Replace exact text in a file', () => {
    test('replaces a unique snippet', async () => {
        const outcome = await edit('app.ts', 'const b = 2;', 'const b = 3;');

        expect(outcome).toEqual({ ok: true, value: 'Replaced 1 occurrence in app.ts.' });
        expect(await contentsOf('app.ts')).toBe('const a = 1;\nconst b = 3;\n');
    });

    test('replaces every occurrence', async () => {
        await writeFile(join(root, 'names.txt'), 'foo bar foo baz foo');

        const outcome = await edit('names.txt', 'foo', 'qux', true);

        expect(outcome).toEqual({ ok: true, value: 'Replaced 3 occurrences in names.txt.' });
        expect(await contentsOf('names.txt')).toBe('qux bar qux baz qux');
    });

    test('replace_all with a single occurrence', async () => {
        await writeFile(join(root, 'one.txt'), 'a foo b');

        const outcome = await edit('one.txt', 'foo', 'qux', true);

        expect(outcome).toEqual({ ok: true, value: 'Replaced 1 occurrence in one.txt.' });
        expect(await contentsOf('one.txt')).toBe('a qux b');
    });

    test('deletes text', async () => {
        const outcome = await edit('app.ts', 'const a = 1;\n', '');

        expect(outcome).toEqual({ ok: true, value: 'Replaced 1 occurrence in app.ts.' });
        expect(await contentsOf('app.ts')).toBe('const b = 2;\n');
    });

    test('replacement patterns are literal', async () => {
        await writeFile(join(root, 'price.txt'), 'The price is right.');

        await edit('price.txt', 'price', '$& and $1');

        expect(await contentsOf('price.txt')).toBe('The $& and $1 is right.');
    });

    test('occurrences are counted without overlaps', async () => {
        await writeFile(join(root, 'aaa.txt'), 'aaa');

        const outcome = await edit('aaa.txt', 'aa', 'b', true);

        expect(outcome).toEqual({ ok: true, value: 'Replaced 1 occurrence in aaa.txt.' });
        expect(await contentsOf('aaa.txt')).toBe('ba');
    });

    test('the bytes outside the replacement are left as they were', async () => {
        const before = '﻿line one  \r\ntwo → three\ttab\nend without a break';
        await writeFile(join(root, 'mixed.txt'), before);

        await edit('mixed.txt', 'three', '3');

        expect(await readFile(join(root, 'mixed.txt'))).toEqual(
            Buffer.from(before.replace('three', '3')),
        );
    });

    test('the file keeps its mode', async () => {
        await chmod(join(root, 'app.ts'), 0o640);

        await edit('app.ts', 'const b = 2;', 'const b = 3;');

        expect((await stat(join(root, 'app.ts'))).mode & 0o777).toBe(0o640);
    });

    test('the model sees a closed schema', () => {
        const tool = toFunctionTool(editTool(root).tool);

        expect(tool).toMatchObject({ type: 'function', name: 'edit', strict: true });
        expect(tool.parameters).toEqual({
            type: 'object',
            properties: {
                path: { type: 'string' },
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' },
            },
            required: ['path', 'old_string', 'new_string', 'replace_all'],
            additionalProperties: false,
        });
    });

    test('the model is told how to match, and what it leaves to write', () => {
        expect(editTool(root).tool.description).toBe(
            'Replace exact text in a file. old_string must match the file exactly, including whitespace and indentation, and occur once unless replace_all is true. Read the file first to copy the text. To create or replace a whole file, use the write tool.',
        );
    });

    test('a missing replace_all is rejected, and the file is unchanged', async () => {
        const outcome = await editTool(root).invoke(
            JSON.stringify({ path: 'app.ts', old_string: 'a', new_string: 'b' }),
        );

        expect(outcome).toEqual({
            ok: false,
            error: expect.stringContaining('- replace_all: '),
        });
        expect(await contentsOf('app.ts')).toBe('const a = 1;\nconst b = 2;\n');
    });
});

describe('Explain a failed match', () => {
    test('not found', async () => {
        const outcome = await edit('app.ts', 'const c = 3;', 'const c = 4;');

        expect(outcome).toEqual({
            ok: false,
            error: `old_string wasn't found in "app.ts". ${NOT_FOUND}`,
        });
        expect(await contentsOf('app.ts')).toBe('const a = 1;\nconst b = 2;\n');
    });

    test.each([
        ['bare line breaks', 'one\ntwo'],
        ['one bare line break among CRLF ones', 'one\r\ntwo\nthree'],
    ])('not found in a CRLF file, with %s', async (_kind, oldString) => {
        await writeFile(join(root, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');

        expect(await edit('crlf.txt', oldString, 'x')).toEqual({
            ok: false,
            error: `old_string wasn't found in "crlf.txt". ${NOT_FOUND} ${CRLF_HINT}`,
        });
    });

    test('no CRLF note when old_string already uses CRLF', async () => {
        await writeFile(join(root, 'crlf.txt'), 'one\r\ntwo\r\n');

        expect(await edit('crlf.txt', 'one\r\nthree', 'x')).toEqual({
            ok: false,
            error: `old_string wasn't found in "crlf.txt". ${NOT_FOUND}`,
        });
    });

    test('no CRLF note for a file without CRLF', async () => {
        expect(await edit('app.ts', 'const a = 1;\nconst c', 'x')).toEqual({
            ok: false,
            error: `old_string wasn't found in "app.ts". ${NOT_FOUND}`,
        });
    });

    test('ambiguous', async () => {
        await writeFile(join(root, 'x.py'), 'x = 1\nx = 1\nx = 1\n');

        const outcome = await edit('x.py', 'x = 1', 'x = 2');

        expect(outcome).toEqual({
            ok: false,
            error: 'old_string occurs 3 times in "x.py". Include more of the surrounding text to make it unique, or set replace_all to true to replace every one.',
        });
        expect(await contentsOf('x.py')).toBe('x = 1\nx = 1\nx = 1\n');
    });

    test('an empty old_string', async () => {
        expect(await edit('app.ts', '', 'x')).toEqual({
            ok: false,
            error: 'old_string is empty. To create or replace a whole file, use the write tool.',
        });
    });

    test('nothing to change', async () => {
        const outcome = await edit('app.ts', 'const a = 1;', 'const a = 1;');

        expect(outcome).toEqual({
            ok: false,
            error: 'old_string and new_string are the same, so there is nothing to change.',
        });
        expect(await contentsOf('app.ts')).toBe('const a = 1;\nconst b = 2;\n');
    });
});

describe('Edit only text files under the working directory', () => {
    test('a missing file', async () => {
        expect(await edit('missing.txt', 'a', 'b')).toEqual({
            ok: false,
            error: 'No such file: "missing.txt".',
        });
        await expect(lstat(join(root, 'missing.txt'))).rejects.toThrow('ENOENT');
    });

    test('outside the working directory', async () => {
        expect(await edit('../other/app.ts', 'a', 'b')).toEqual({
            ok: false,
            error: '"../other/app.ts" is outside the working directory, the only place the edit tool may write.',
        });
    });

    test('an environment file', async () => {
        expect(await edit('.env', 'sk-live-secret', 'x')).toEqual({
            ok: false,
            error: '".env" is an environment file. The edit tool doesn\'t write those: they hold secrets.',
        });
        expect(await contentsOf('.env')).toBe('MODEL_API_KEY=sk-live-secret');
    });

    test('a directory', async () => {
        expect(await edit('docs', 'a', 'b')).toEqual({
            ok: false,
            error: '"docs" is a directory.',
        });
    });

    test('a file over 10 MiB', async () => {
        await writeFile(join(root, 'huge.txt'), '');
        await truncate(join(root, 'huge.txt'), TEN_MIB + 1);

        expect(await edit('huge.txt', 'a', 'b')).toEqual({
            ok: false,
            error: '"huge.txt" is too large to edit: it\'s over 10 MiB.',
        });
    });

    test('a file of exactly 10 MiB', async () => {
        await writeFile(join(root, 'limit.txt'), `${'a'.repeat(TEN_MIB - 3)}end`);

        expect(await edit('limit.txt', 'end', 'END')).toEqual({
            ok: true,
            value: 'Replaced 1 occurrence in limit.txt.',
        });
    });

    test('a binary file', async () => {
        await writeFile(join(root, 'logo.png'), new Uint8Array([0x89, 0x50, 0x00, 0x0d]));

        expect(await edit('logo.png', 'P', 'Q')).toEqual({
            ok: false,
            error: '"logo.png" is a binary file.',
        });
    });

    test('invalid UTF-8', async () => {
        await writeFile(join(root, 'latin1.txt'), new Uint8Array([0x63, 0x61, 0x66, 0xff]));

        expect(await edit('latin1.txt', 'ca', 'Ca')).toEqual({
            ok: false,
            error: '"latin1.txt" isn\'t valid UTF-8.',
        });
        expect(await readFile(join(root, 'latin1.txt'))).toEqual(
            Buffer.from([0x63, 0x61, 0x66, 0xff]),
        );
    });

    test('a path through a file', async () => {
        expect(await edit('app.ts/inner.ts', 'a', 'b')).toEqual({
            ok: false,
            error: expect.stringMatching(/^Can't edit "app.ts\/inner.ts": ENOTDIR/),
        });
    });

    test.skipIf(process.getuid?.() === 0)('a file that is not writable', async () => {
        await chmod(join(root, 'app.ts'), 0o444);

        expect(await edit('app.ts', 'const b = 2;', 'const b = 3;')).toEqual({
            ok: false,
            error: expect.stringMatching(/^Can't edit "app.ts": EACCES/),
        });
    });
});
