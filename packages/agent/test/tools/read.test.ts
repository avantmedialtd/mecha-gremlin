import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ToolOutcome, toFunctionTool } from '@mecha-gremlin/core/tools';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { READ_LIMIT, readTool } from '../../src/tools/read.ts';

let root: string;
let outside: string;
// A skill's directory is given by its real path, as loadSkills records it.
let skill: string;

/** Line `n` of `hundred.txt`: 99 ASCII characters, its number first, and a `\n`. */
const hundredLine = (n: number): string => {
    return `${String(n).padStart(4, '0')}${'.'.repeat(95)}\n`;
};

const hundredLines = (from: number, to: number): string => {
    return Array.from({ length: to - from + 1 }, (_, index) => hundredLine(from + index)).join('');
};

const TEN_LINES = Array.from({ length: 10 }, (_, index) => `${index + 1}\n`).join('');

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'read-root-'));
    outside = await mkdtemp(join(tmpdir(), 'read-outside-'));
    skill = await realpath(await mkdtemp(join(tmpdir(), 'read-skill-')));
    await writeFile(join(outside, 'secret.txt'), 'top secret');
    await mkdir(join(skill, 'references'));
    await writeFile(join(skill, 'references', 'forms.md'), '# Forms\n');
    await writeFile(join(skill, '.env'), 'SKILL_SECRET=1');
    await symlink(join(outside, 'secret.txt'), join(skill, 'leak.md'));

    await writeFile(join(root, 'notes.txt'), 'hello');
    await writeFile(join(root, 'latin1.txt'), new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x21]));
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n');
    await writeFile(join(root, '.env'), 'MODEL_API_KEY=sk-live-secret');
    await writeFile(join(root, '.env.local'), 'OTHER_SECRET=1');
    await symlink(join(root, '.env'), join(root, 'innocent.txt'));
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    await symlink(join(root, 'notes.txt'), join(root, 'alias.txt'));
    await writeFile(join(root, 'logo.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]));
    await writeFile(join(root, 'late-nul.txt'), `${'a'.repeat(8 * 1024)}\0tail`);
    await writeFile(join(root, 'nul-first.txt'), '\0\nplain text\n');
    await writeFile(join(root, 'small.txt'), 's'.repeat(1000));
    await writeFile(join(root, 'exact.txt'), 'e'.repeat(READ_LIMIT));
    await writeFile(join(root, 'big.txt'), 'b'.repeat(40_000));
    await writeFile(join(root, 'euro.txt'), '€'.repeat(20_000));
    await writeFile(join(root, 'emoji.txt'), `a${'😀'.repeat(10_000)}`);
    // ASCII, with 20 UTF-8 continuation bytes, which can't stand alone, around the limit.
    await writeFile(
        join(root, 'broken.txt'),
        new Uint8Array(33_780).fill(0x61).fill(0x80, 32_760, 32_780),
    );
    await writeFile(join(root, 'locked.txt'), 'locked');
    await chmod(join(root, 'locked.txt'), 0o000);

    await writeFile(join(root, 'lines.txt'), TEN_LINES);
    await writeFile(join(root, 'hundred.txt'), hundredLines(1, 1000));
    await writeFile(join(root, 'unended.txt'), 'a\nb');
    await writeFile(join(root, 'crlf.txt'), 'a\r\nb\r\nc\r\n');
    await writeFile(join(root, 'empty.txt'), '');
    await writeFile(join(root, 'one.txt'), 'only\n');
    await writeFile(join(root, 'long-first.txt'), `${'l'.repeat(40_000)}\nshort\nlines\n`);
    await writeFile(join(root, 'long-last.txt'), `${'z'.repeat(40_000)}\n`);
    await writeFile(join(root, 'long-second.txt'), `first\n${'s'.repeat(40_000)}\nthird\n`);
    // Longer than one 64 KiB chunk of the stream, so the line arrives in pieces.
    await writeFile(join(root, 'long-chunks.txt'), 'c'.repeat(100_000));
    // Line 30001 starts 5536 bytes before the first chunk ends.
    await writeFile(join(root, 'long-later.txt'), `${'x\n'.repeat(30_000)}${'L'.repeat(40_000)}`);
    await writeFile(join(root, 'exact-line.txt'), `${'e'.repeat(READ_LIMIT - 1)}\nnext\n`);
});

afterAll(async () => {
    await chmod(join(root, 'locked.txt'), 0o600);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(skill, { recursive: true, force: true });
});

type Paging = { readonly offset?: number | null; readonly limit?: number | null };

const read = (path: string, paging: Paging = {}): Promise<ToolOutcome> => {
    return readTool(root, [skill]).invoke(JSON.stringify({ path, ...paging }));
};

const OUTSIDE = 'is outside the directories the read tool may read.';

const errorOf = (outcome: ToolOutcome): string => {
    expect(outcome.ok).toBe(false);

    return (outcome as Extract<ToolOutcome, { ok: false }>).error;
};

const LINE_NUMBER = {
    anyOf: [{ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: 'null' }],
};

describe('Read a UTF-8 text file under a root directory', () => {
    test('reads a file', async () => {
        expect(await read('notes.txt')).toEqual({ ok: true, value: 'hello' });
    });

    test('reads a nested file', async () => {
        expect(await read('docs/guide.md')).toEqual({ ok: true, value: '# Guide\n' });
    });

    test('replaces invalid UTF-8 with U+FFFD', async () => {
        // "café!" in Latin-1: the lone 0xE9 isn't valid UTF-8.
        expect(await read('latin1.txt')).toEqual({ ok: true, value: 'caf�!' });
    });

    test('reads an absolute path inside the root', async () => {
        expect(await read(join(root, 'notes.txt'))).toEqual({ ok: true, value: 'hello' });
    });

    test("reads a skill's file by its absolute path", async () => {
        expect(await read(join(skill, 'references', 'forms.md'))).toEqual({
            ok: true,
            value: '# Forms\n',
        });
    });

    test('without skill directories, only the root', async () => {
        const tool = readTool(root, []);
        const inRoot = await tool.invoke(JSON.stringify({ path: 'notes.txt' }));
        const inSkill = await tool.invoke(
            JSON.stringify({ path: join(skill, 'references', 'forms.md') }),
        );

        expect(inRoot).toEqual({ ok: true, value: 'hello' });
        expect(errorOf(inSkill)).toBe(
            `${JSON.stringify(join(skill, 'references', 'forms.md'))} ${OUTSIDE}`,
        );
    });

    test('the model sees a closed schema', () => {
        const tool = toFunctionTool(readTool(root, []).tool);

        expect(tool).toMatchObject({ type: 'function', name: 'read', strict: true });
        expect(tool.parameters).toEqual({
            type: 'object',
            properties: {
                path: { type: 'string', description: expect.any(String) },
                offset: LINE_NUMBER,
                limit: LINE_NUMBER,
            },
            required: ['path', 'offset', 'limit'],
            additionalProperties: false,
        });
    });

    test('the model is told what the tool reads, and how to page', () => {
        const tool = toFunctionTool(readTool(root, []).tool);

        expect(tool.description).toBe(
            "Read a UTF-8 text file and return its contents. The path is relative to the working directory, or absolute inside a skill's directory. offset is the first line to read, from 1, and limit the most lines; pass null for both to read from the start. Each call returns at most 32 KiB in whole lines, with a note giving the offset to continue from.",
        );
        expect(tool.parameters).toMatchObject({
            properties: {
                path: {
                    description:
                        "The file's path: relative to the working directory, such as README.md or docs/guide.md, or absolute inside a skill's directory",
                },
            },
        });
    });

    test('extra arguments are rejected before any file is read', async () => {
        // Had the file been looked up, a missing one would say so.
        const error = errorOf(
            await readTool(root, []).invoke(
                '{"path":"missing.txt","offset":null,"limit":null,"encoding":"utf8"}',
            ),
        );

        expect(error).toContain('(root): Unrecognized key: "encoding"');
        expect(error).not.toContain('No such file');
    });

    test('null paging arguments read the whole file, as left-out ones do', async () => {
        expect(await read('lines.txt', { offset: null, limit: null })).toEqual({
            ok: true,
            value: TEN_LINES,
        });
        expect(await read('lines.txt')).toEqual({ ok: true, value: TEN_LINES });
    });

    test('either paging argument may be left out alone', async () => {
        expect(await read('lines.txt', { offset: 9 })).toEqual({ ok: true, value: '9\n10\n' });
        expect(await read('lines.txt', { limit: 1 })).toEqual({
            ok: true,
            value: '1\n\n[showing line 1; read with offset 2 to continue]',
        });
    });

    test.each([
        ['offset', 0],
        ['offset', -1],
        ['offset', 1.5],
        ['offset', '5'],
        ['limit', 0],
        ['limit', -1],
        ['limit', 1.5],
        ['limit', '5'],
    ])('an invalid %s of %j is rejected before any file is read', async (key, value) => {
        const error = errorOf(
            await readTool(root, []).invoke(JSON.stringify({ path: 'missing.txt', [key]: value })),
        );

        expect(error).toMatch(
            new RegExp(`^The arguments for read don't match its schema:\\n- ${key}: `),
        );
        expect(error).not.toContain('No such file');
    });
});

describe('Never read outside the root and the skill directories', () => {
    test.each(['..', '../secret.txt', '/etc/hosts', 'docs/../../secret.txt'])(
        '%s',
        async (path) => {
            expect(errorOf(await read(path))).toBe(`${JSON.stringify(path)} ${OUTSIDE}`);
        },
    );

    test('a symbolic link pointing outside', async () => {
        const error = errorOf(await read('link.txt'));

        expect(error).toBe(`"link.txt" ${OUTSIDE}`);
        expect(error).not.toContain('top secret');
    });

    test('a link out of a skill directory', async () => {
        const path = join(skill, 'leak.md');
        const error = errorOf(await read(path));

        expect(error).toBe(`${JSON.stringify(path)} ${OUTSIDE}`);
        expect(error).not.toContain('top secret');
    });

    test('a relative path stays in the root', async () => {
        expect(errorOf(await read('references/forms.md'))).toBe(
            'No such file: "references/forms.md".',
        );
    });

    test("a path that leaves a skill's directory", async () => {
        const path = join(skill, '..', 'elsewhere.md');

        expect(errorOf(await read(path))).toBe(`${JSON.stringify(path)} ${OUTSIDE}`);
    });

    test('a symbolic link pointing inside', async () => {
        expect(await read('alias.txt')).toEqual({ ok: true, value: 'hello' });
    });

    test('a name that only starts with two dots is inside', async () => {
        expect(errorOf(await read('..notes.txt'))).toBe('No such file: "..notes.txt".');
    });
});

describe('Refuse secrets, directories and binary files', () => {
    test.each(['.env', '.env.local', 'docs/.env.missing'])('environment file %s', async (path) => {
        const error = errorOf(await read(path));

        expect(error).toBe(
            `${JSON.stringify(path)} is an environment file. The read tool doesn't read those: they hold secrets.`,
        );
    });

    test('an environment file inside a skill directory', async () => {
        const path = join(skill, '.env');
        const error = errorOf(await read(path));

        expect(error).toBe(
            `${JSON.stringify(path)} is an environment file. The read tool doesn't read those: they hold secrets.`,
        );
        expect(error).not.toContain('SKILL_SECRET');
    });

    test('a link to an environment file', async () => {
        const error = errorOf(await read('innocent.txt'));

        expect(error).toContain('"innocent.txt" is an environment file.');
        expect(error).not.toContain('sk-live-secret');
    });

    test('a directory', async () => {
        expect(errorOf(await read('docs'))).toBe('"docs" is a directory.');
    });

    test('a binary file', async () => {
        expect(errorOf(await read('logo.png'))).toBe('"logo.png" is a binary file.');
    });

    test('the first 8 KiB decide, whatever the offset asks for', async () => {
        expect(errorOf(await read('nul-first.txt', { offset: 2 }))).toBe(
            '"nul-first.txt" is a binary file.',
        );
    });

    test("a NUL byte after the first 8 KiB doesn't make a file binary", async () => {
        expect(await read('late-nul.txt')).toEqual({
            ok: true,
            value: `${'a'.repeat(8 * 1024)}\0tail`,
        });
    });

    test('a missing file', async () => {
        expect(errorOf(await read('missing.txt'))).toBe('No such file: "missing.txt".');
    });

    test.skipIf(process.getuid?.() === 0)('an unreadable file', async () => {
        expect(errorOf(await read('locked.txt'))).toMatch(/^Can't read "locked.txt": EACCES/);
    });
});

describe('Cap what it returns', () => {
    test('a small file is returned whole', async () => {
        expect(await read('small.txt')).toEqual({ ok: true, value: 's'.repeat(1000) });
    });

    test('a file of exactly the limit is returned whole', async () => {
        expect(await read('exact.txt')).toEqual({ ok: true, value: 'e'.repeat(READ_LIMIT) });
    });

    test('a line of exactly the limit, with its line break, is returned whole', async () => {
        expect(await read('exact-line.txt')).toEqual({
            ok: true,
            value: `${'e'.repeat(READ_LIMIT - 1)}\n\n[showing line 1; read with offset 2 to continue]`,
        });
    });

    test('a large file on one line is cut, with a note', async () => {
        expect(await read('big.txt')).toEqual({
            ok: true,
            value: `${'b'.repeat(32_768)}\n\n[line 1 is longer than 32 KiB: showing its first 32768 bytes; the rest of the line can be seen only through the shell]`,
        });
    });

    test('the cut never splits a character', async () => {
        expect(await read('euro.txt')).toEqual({
            ok: true,
            value: `${'€'.repeat(10_922)}\n\n[line 1 is longer than 32 KiB: showing its first 32766 bytes; the rest of the line can be seen only through the shell]`,
        });
    });

    test('nor a four-byte character, which takes the cut back 3 bytes', async () => {
        expect(await read('emoji.txt')).toEqual({
            ok: true,
            value: `a${'😀'.repeat(8191)}\n\n[line 1 is longer than 32 KiB: showing its first 32765 bytes; the rest of the line can be seen only through the shell]`,
        });
    });

    test('in invalid UTF-8, the cut moves back no more than 3 bytes', async () => {
        // The 5 continuation bytes left before the cut read as U+FFFD each.
        expect(await read('broken.txt')).toEqual({
            ok: true,
            value: `${'a'.repeat(32_760)}${'�'.repeat(5)}\n\n[line 1 is longer than 32 KiB: showing its first 32765 bytes; the rest of the line can be seen only through the shell]`,
        });
    });

    test('the cut ends on a whole line', async () => {
        expect(await read('hundred.txt')).toEqual({
            ok: true,
            value: `${hundredLines(1, 327)}\n[showing lines 1–327; read with offset 328 to continue]`,
        });
    });

    test('reading on from the note', async () => {
        expect(await read('hundred.txt', { offset: 328 })).toEqual({
            ok: true,
            value: `${hundredLines(328, 654)}\n[showing lines 328–654; read with offset 655 to continue]`,
        });
    });

    test('a line that leaves the cap in the next piece of the stream is left out whole', async () => {
        // Line 656 starts 36 bytes before the stream's first 64 KiB end.
        expect(await read('hundred.txt', { offset: 329 })).toEqual({
            ok: true,
            value: `${hundredLines(329, 655)}\n[showing lines 329–655; read with offset 656 to continue]`,
        });
    });

    test('a long line followed by others', async () => {
        expect(await read('long-first.txt')).toEqual({
            ok: true,
            value: `${'l'.repeat(32_768)}\n\n[line 1 is longer than 32 KiB: showing its first 32768 bytes; the rest of the line can be seen only through the shell; read with offset 2 to continue after it]`,
        });
        expect(await read('long-first.txt', { offset: 2 })).toEqual({
            ok: true,
            value: 'short\nlines\n',
        });
    });

    test('a long line that ends the file, with a line break', async () => {
        expect(await read('long-last.txt')).toEqual({
            ok: true,
            value: `${'z'.repeat(32_768)}\n\n[line 1 is longer than 32 KiB: showing its first 32768 bytes; the rest of the line can be seen only through the shell]`,
        });
    });

    test('a long line that arrives in several pieces', async () => {
        expect(await read('long-chunks.txt')).toEqual({
            ok: true,
            value: `${'c'.repeat(32_768)}\n\n[line 1 is longer than 32 KiB: showing its first 32768 bytes; the rest of the line can be seen only through the shell]`,
        });
    });

    test('a long line that starts in one piece and is cut in the next', async () => {
        expect(await read('long-later.txt', { offset: 30_001 })).toEqual({
            ok: true,
            value: `${'L'.repeat(32_768)}\n\n[line 30001 is longer than 32 KiB: showing its first 32768 bytes; the rest of the line can be seen only through the shell]`,
        });
    });

    test('a long line after a short one waits for its own call', async () => {
        expect(await read('long-second.txt')).toEqual({
            ok: true,
            value: 'first\n\n[showing line 1; read with offset 2 to continue]',
        });
        expect(await read('long-second.txt', { offset: 2 })).toEqual({
            ok: true,
            value: `${'s'.repeat(32_768)}\n\n[line 2 is longer than 32 KiB: showing its first 32768 bytes; the rest of the line can be seen only through the shell; read with offset 3 to continue after it]`,
        });
    });
});

describe('Read part of a file by lines', () => {
    test('a window of lines', async () => {
        expect(await read('lines.txt', { offset: 3, limit: 2 })).toEqual({
            ok: true,
            value: '3\n4\n\n[showing lines 3–4; read with offset 5 to continue]',
        });
    });

    test('a window reaching the end', async () => {
        expect(await read('lines.txt', { offset: 9, limit: 5 })).toEqual({
            ok: true,
            value: '9\n10\n',
        });
    });

    test('a window that ends exactly at the end', async () => {
        expect(await read('lines.txt', { offset: 9, limit: 2 })).toEqual({
            ok: true,
            value: '9\n10\n',
        });
    });

    test('an offset alone', async () => {
        expect(await read('lines.txt', { offset: 8, limit: null })).toEqual({
            ok: true,
            value: '8\n9\n10\n',
        });
    });

    test('a limit alone', async () => {
        expect(await read('lines.txt', { offset: null, limit: 2 })).toEqual({
            ok: true,
            value: '1\n2\n\n[showing lines 1–2; read with offset 3 to continue]',
        });
    });

    test('an offset past the end', async () => {
        expect(errorOf(await read('lines.txt', { offset: 11 }))).toBe(
            'offset 11 is past the end of "lines.txt", which has 10 lines.',
        );
    });

    test('past the end of a file whose last line has no line break', async () => {
        expect(errorOf(await read('unended.txt', { offset: 3 }))).toBe(
            'offset 3 is past the end of "unended.txt", which has 2 lines.',
        );
    });

    test('past the end of a file of one line', async () => {
        expect(errorOf(await read('one.txt', { offset: 2 }))).toBe(
            'offset 2 is past the end of "one.txt", which has 1 line.',
        );
    });

    test('a last line without a line break', async () => {
        expect(await read('unended.txt', { offset: 2 })).toEqual({ ok: true, value: 'b' });
    });

    test('CRLF line endings are kept', async () => {
        expect(await read('crlf.txt', { offset: 2, limit: 1 })).toEqual({
            ok: true,
            value: 'b\r\n\n[showing line 2; read with offset 3 to continue]',
        });
    });

    test.each([null, 1])('an empty file, with an offset of %j', async (offset) => {
        expect(await read('empty.txt', { offset })).toEqual({ ok: true, value: '' });
    });

    test('past the end of an empty file', async () => {
        expect(errorOf(await read('empty.txt', { offset: 2 }))).toBe(
            'offset 2 is past the end of "empty.txt", which has 0 lines.',
        );
    });

    test("lines past the stream's first piece", async () => {
        expect(await read('hundred.txt', { offset: 999 })).toEqual({
            ok: true,
            value: hundredLines(999, 1000),
        });
    });
});
