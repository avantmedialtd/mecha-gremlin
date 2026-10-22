import { describe, expect, test } from 'vitest';
import { type Chunk, applyChunks, parsePatch } from '../src/patch.ts';

const patch = (...lines: readonly string[]): string => {
    return lines.join('\n');
};

const chunkOf = (fields: Partial<Chunk>): Chunk => {
    return {
        context: undefined,
        oldLines: [],
        newLines: [],
        contextLines: [],
        endOfFile: false,
        ...fields,
    };
};

/** The one Update hunk's chunks of a patch, which must parse. */
const chunksOf = (...lines: readonly string[]): readonly Chunk[] => {
    const parsed = parsePatch(
        patch('*** Begin Patch', '*** Update File: f.txt', ...lines, '*** End Patch'),
    );

    if (!parsed.ok || parsed.value[0]?.type !== 'update') {
        throw new Error(`the test's patch doesn't parse: ${JSON.stringify(parsed)}`);
    }

    return parsed.value[0].chunks;
};

/** Applies an update made of `lines` to `contents`. */
const update = (contents: string, ...lines: readonly string[]) => {
    return applyChunks(contents, chunksOf(...lines), 'f.txt');
};

const HEADERS =
    "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

const UNEXPECTED =
    "Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)";

describe("Accept a patch in Codex's V4A format", () => {
    test('parses every kind of hunk', () => {
        const parsed = parsePatch(
            patch(
                '*** Begin Patch',
                '*** Add File: new.txt',
                '+hello',
                '+world',
                '*** Delete File: old.txt',
                '*** Update File: app.ts',
                '@@ function first() {',
                '-    return 0;',
                '+    return 1;',
                '@@',
                ' const a = 1;',
                '-const b = 2;',
                '+const b = 3;',
                '*** End Patch',
            ),
        );

        expect(parsed).toStrictEqual({
            ok: true,
            value: [
                { type: 'add', path: 'new.txt', contents: 'hello\nworld\n' },
                { type: 'delete', path: 'old.txt' },
                {
                    type: 'update',
                    path: 'app.ts',
                    moveTo: undefined,
                    chunks: [
                        chunkOf({
                            context: 'function first() {',
                            oldLines: ['    return 0;'],
                            newLines: ['    return 1;'],
                        }),
                        chunkOf({
                            oldLines: ['const a = 1;', 'const b = 2;'],
                            newLines: ['const a = 1;', 'const b = 3;'],
                            contextLines: [[0, 0]],
                        }),
                    ],
                },
            ],
        });
    });

    test('a move, and a first chunk without a header', () => {
        const parsed = parsePatch(
            patch(
                '*** Begin Patch',
                '*** Update File: src/a.ts',
                '*** Move to: lib/b.ts',
                ' import foo',
                '+bar',
                '*** End Patch',
            ),
        );

        expect(parsed).toStrictEqual({
            ok: true,
            value: [
                {
                    type: 'update',
                    path: 'src/a.ts',
                    moveTo: 'lib/b.ts',
                    chunks: [
                        chunkOf({
                            oldLines: ['import foo'],
                            newLines: ['import foo', 'bar'],
                            contextLines: [[0, 0]],
                        }),
                    ],
                },
            ],
        });
    });

    test("each hunk's move is its own", () => {
        const parsed = parsePatch(
            patch(
                '*** Begin Patch',
                '*** Update File: a.ts',
                '*** Move to: b.ts',
                '+x',
                '*** Update File: c.ts',
                '+y',
                '*** End Patch',
            ),
        );

        expect(parsed).toMatchObject({
            ok: true,
            value: [{ moveTo: 'b.ts' }, { path: 'c.ts', moveTo: undefined }],
        });
    });

    test("an add's empty + line is an empty line", () => {
        expect(
            parsePatch(
                patch(
                    '*** Begin Patch',
                    '*** Add File: a.txt',
                    '+one',
                    '+',
                    '+two',
                    '*** End Patch',
                ),
            ),
        ).toStrictEqual({
            ok: true,
            value: [{ type: 'add', path: 'a.txt', contents: 'one\n\ntwo\n' }],
        });
    });

    test('paths are taken as written, absolute ones too', () => {
        expect(
            parsePatch(
                patch('*** Begin Patch', '*** Delete File: /work/my notes.txt', '*** End Patch'),
            ),
        ).toStrictEqual({ ok: true, value: [{ type: 'delete', path: '/work/my notes.txt' }] });
    });

    test.each(['<<EOF', "<<'EOF'", '<<"EOF"'])('a heredoc wrapper opened with %s', (opening) => {
        expect(
            parsePatch(
                patch(
                    opening,
                    '*** Begin Patch',
                    '*** Delete File: a.txt',
                    '*** End Patch',
                    'EOF',
                    '',
                ),
            ),
        ).toStrictEqual({ ok: true, value: [{ type: 'delete', path: 'a.txt' }] });
    });

    test('a heredoc whose last line only ends with EOF', () => {
        expect(
            parsePatch(
                patch(
                    '<<EOF',
                    '*** Begin Patch',
                    '*** Delete File: a.txt',
                    '*** End Patch',
                    'PATCH_EOF',
                ),
            ),
        ).toMatchObject({ ok: true });
    });

    test("whitespace around the heredoc's lines is ignored", () => {
        expect(
            parsePatch(
                patch(
                    "  <<'EOF' ",
                    '*** Begin Patch',
                    '*** Delete File: a.txt',
                    '*** End Patch',
                    'EOF \t',
                ),
            ),
        ).toStrictEqual({ ok: true, value: [{ type: 'delete', path: 'a.txt' }] });
    });

    test('a heredoc with mismatched quotes is not one', () => {
        expect(
            parsePatch(
                patch(
                    '<<"EOF\'',
                    '*** Begin Patch',
                    '*** Delete File: a.txt',
                    '*** End Patch',
                    'EOF',
                ),
            ),
        ).toStrictEqual({
            ok: false,
            error: "invalid patch: The first line of the patch must be '*** Begin Patch'",
        });
    });

    test('a heredoc without a closing line is not one', () => {
        expect(
            parsePatch(
                patch('<<EOF', '*** Begin Patch', '*** Delete File: a.txt', '*** End Patch'),
            ),
        ).toStrictEqual({
            ok: false,
            error: "invalid patch: The first line of the patch must be '*** Begin Patch'",
        });
    });

    test('whitespace around markers is ignored', () => {
        expect(
            parsePatch(
                patch(
                    '\t*** Begin Patch ',
                    ' *** Add File: a.txt  ',
                    '+hi',
                    '  *** Update File: b.txt',
                    '@@  ',
                    '-x',
                    '+y',
                    '*** End of File  ',
                    ' *** End Patch\t',
                ),
            ),
        ).toMatchObject({
            ok: true,
            value: [
                { type: 'add', path: 'a.txt' },
                {
                    type: 'update',
                    path: 'b.txt',
                    chunks: [{ context: undefined, endOfFile: true }],
                },
            ],
        });
    });

    test('blank lines around the patch, and CRLF line breaks', () => {
        expect(
            parsePatch(
                '\n  \r\n*** Begin Patch\r\n*** Add File: a.txt\r\n+hello\r\n*** End Patch\r\n\r\n \t\r\n',
            ),
        ).toStrictEqual({ ok: true, value: [{ type: 'add', path: 'a.txt', contents: 'hello\n' }] });
    });

    test('no hunks', () => {
        expect(parsePatch(patch('*** Begin Patch', '*** End Patch'))).toStrictEqual({
            ok: false,
            error: "invalid patch: The patch has no hunks: it needs at least one '*** Add File: {path}', '*** Delete File: {path}' or '*** Update File: {path}' section",
        });
    });

    test.each([
        ['an empty patch', ''],
        ['a patch without its first marker', patch('*** Add File: a.txt', '+x', '*** End Patch')],
        ['a patch that ends where it begins', '*** End Patch'],
    ])('%s', (_kind, text) => {
        expect(parsePatch(text)).toStrictEqual({
            ok: false,
            error: "invalid patch: The first line of the patch must be '*** Begin Patch'",
        });
    });

    test.each([
        ['without its last marker', patch('*** Begin Patch', '*** Add File: a.txt', '+x')],
        ['of one line', '*** Begin Patch'],
    ])('a patch %s', (_kind, text) => {
        expect(parsePatch(text)).toStrictEqual({
            ok: false,
            error: "invalid patch: The last line of the patch must be '*** End Patch'",
        });
    });

    test('text after an end marker', () => {
        expect(
            parsePatch(
                patch(
                    '*** Begin Patch',
                    '*** Delete File: a.txt',
                    '*** End Patch',
                    'extra',
                    '*** End Patch',
                ),
            ),
        ).toStrictEqual({
            ok: false,
            error: "invalid patch: The last line of the patch must be '*** End Patch'",
        });
    });

    test('blank lines after an end marker', () => {
        expect(
            parsePatch(
                patch(
                    '*** Begin Patch',
                    '*** Delete File: a.txt',
                    '*** End Patch',
                    ' \t',
                    '*** End Patch',
                ),
            ),
        ).toStrictEqual({ ok: true, value: [{ type: 'delete', path: 'a.txt' }] });
    });

    test('a malformed hunk', () => {
        expect(
            parsePatch(
                patch(
                    '*** Begin Patch',
                    '*** Update File: a.txt',
                    '@@',
                    '-old',
                    'bad',
                    '*** End Patch',
                ),
            ),
        ).toStrictEqual({
            ok: false,
            error: "invalid hunk at line 5, Expected update hunk to start with a @@ context marker, got: 'bad'",
        });
    });

    test('line numbers count the lines as written, blank ones and the heredoc included', () => {
        expect(
            parsePatch(patch('', '<<EOF', '*** Begin Patch', 'bad', '*** End Patch', 'EOF')),
        ).toStrictEqual({
            ok: false,
            error: `invalid hunk at line 4, 'bad' is not a valid hunk header. ${HEADERS}`,
        });
    });

    test.each([
        ['an add', ['*** Add File: a.txt', '+x', 'bad']],
        ['a delete', ['*** Delete File: a.txt', 'bad']],
    ])('a line that is no header after %s', (_kind, lines) => {
        expect(parsePatch(patch('*** Begin Patch', ...lines, '*** End Patch'))).toStrictEqual({
            ok: false,
            error: `invalid hunk at line ${lines.length + 1}, 'bad' is not a valid hunk header. ${HEADERS}`,
        });
    });

    test('an added line before any hunk', () => {
        expect(parsePatch(patch('*** Begin Patch', '+x', '*** End Patch'))).toStrictEqual({
            ok: false,
            error: `invalid hunk at line 2, '+x' is not a valid hunk header. ${HEADERS}`,
        });
    });

    test('an add without lines', () => {
        expect(
            parsePatch(
                patch(
                    '*** Begin Patch',
                    '*** Add File: a.txt',
                    '*** Delete File: b.txt',
                    '*** End Patch',
                ),
            ),
        ).toStrictEqual({
            ok: false,
            error: "invalid hunk at line 2, Add file hunk for path 'a.txt' is empty",
        });
    });

    test.each([
        ['', ['*** Update File: a.txt']],
        [' with a move', ['*** Update File: a.txt', '*** Move to: b.txt']],
    ])('an update without chunks%s', (_kind, lines) => {
        expect(parsePatch(patch('*** Begin Patch', ...lines, '*** End Patch'))).toStrictEqual({
            ok: false,
            error: "invalid hunk at line 2, Update file hunk for path 'a.txt' is empty",
        });
    });

    test.each([
        ['the end', '*** End Patch', 'Update hunk does not contain any lines'],
        ['an end of file marker', '*** End of File', 'Update hunk does not contain any lines'],
        ['another header', '@@', `Unexpected line found in update hunk: '@@'. ${UNEXPECTED}`],
        [
            "another hunk's header",
            '*** Update File: b.txt',
            `Unexpected line found in update hunk: '*** Update File: b.txt'. ${UNEXPECTED}`,
        ],
    ])('a chunk header followed by %s', (_kind, line, message) => {
        expect(
            parsePatch(
                patch('*** Begin Patch', '*** Update File: a.txt', '@@', line, '*** End Patch'),
            ),
        ).toStrictEqual({ ok: false, error: `invalid hunk at line 4, ${message}` });
    });

    test('a line that is no part of an update, before any chunk', () => {
        expect(
            parsePatch(patch('*** Begin Patch', '*** Update File: a.txt', 'bad', '*** End Patch')),
        ).toStrictEqual({
            ok: false,
            error: `invalid hunk at line 3, Unexpected line found in update hunk: 'bad'. ${UNEXPECTED}`,
        });
    });

    test('empty lines in an update are empty context lines', () => {
        expect(chunksOf('@@', ' before', '', ' after')).toStrictEqual([
            chunkOf({
                oldLines: ['before', '', 'after'],
                newLines: ['before', '', 'after'],
                contextLines: [
                    [0, 0],
                    [1, 1],
                    [2, 2],
                ],
            }),
        ]);
    });

    test('an indented marker in an update is a context line', () => {
        expect(chunksOf('@@', '-old a', '+new a', ' *** Update File: b.txt')).toStrictEqual([
            chunkOf({
                oldLines: ['old a', '*** Update File: b.txt'],
                newLines: ['new a', '*** Update File: b.txt'],
                contextLines: [[1, 1]],
            }),
        ]);
    });

    test('blank lines after an end of file marker are skipped', () => {
        expect(
            chunksOf('@@', '+quux', '*** End of File', '', '  ', '@@ next', '+more'),
        ).toStrictEqual([
            chunkOf({ newLines: ['quux'], endOfFile: true }),
            chunkOf({ context: 'next', newLines: ['more'] }),
        ]);
    });

    test('a line after an end of file marker must open a chunk', () => {
        expect(
            parsePatch(
                patch(
                    '*** Begin Patch',
                    '*** Update File: a.txt',
                    '+x',
                    '*** End of File',
                    ' y',
                    '*** End Patch',
                ),
            ),
        ).toStrictEqual({
            ok: false,
            error: "invalid hunk at line 5, Expected update hunk to start with a @@ context marker, got: ' y'",
        });
    });

    test('an end of file marker before any chunk is ignored', () => {
        expect(chunksOf('*** End of File', '+x')).toStrictEqual([chunkOf({ newLines: ['x'] })]);
    });

    test('a second move', () => {
        expect(
            parsePatch(
                patch(
                    '*** Begin Patch',
                    '*** Update File: a.txt',
                    '*** Move to: b.txt',
                    '*** Move to: c.txt',
                    '*** End Patch',
                ),
            ),
        ).toStrictEqual({
            ok: false,
            error: `invalid hunk at line 4, Unexpected line found in update hunk: '*** Move to: c.txt'. ${UNEXPECTED}`,
        });
    });

    test('a move after a chunk', () => {
        expect(
            parsePatch(
                patch(
                    '*** Begin Patch',
                    '*** Update File: a.txt',
                    '+x',
                    '*** Move to: b.txt',
                    '*** End Patch',
                ),
            ),
        ).toStrictEqual({
            ok: false,
            error: "invalid hunk at line 4, Expected update hunk to start with a @@ context marker, got: '*** Move to: b.txt'",
        });
    });
});

describe('Find each chunk as Codex does', () => {
    test('an exact update', () => {
        expect(update('a\nb\nc\n', '@@', ' a', '-b', '+B')).toStrictEqual({
            ok: true,
            value: 'a\nB\nc\n',
        });
    });

    test('a context header picks the place', () => {
        const file =
            'function first() {\n    return 0;\n}\nfunction second() {\n    return 0;\n}\n';

        expect(
            update(file, '@@ function second() {', '-    return 0;', '+    return 2;'),
        ).toStrictEqual({
            ok: true,
            value: 'function first() {\n    return 0;\n}\nfunction second() {\n    return 2;\n}\n',
        });
    });

    test('the context header is found leniently too', () => {
        expect(update('  head  \nx\n', '@@ head', '-x', '+y')).toStrictEqual({
            ok: true,
            value: '  head  \ny\n',
        });
    });

    test('the old lines are found after the context header only', () => {
        expect(update('x\nhead\ny\n', '@@ head', '-x', '+z')).toStrictEqual({
            ok: false,
            error: 'Failed to find expected lines in f.txt:\nx',
        });
    });

    test('context not found', () => {
        expect(update('a\nb\n', '@@ nope', '-a', '+b')).toStrictEqual({
            ok: false,
            error: "Failed to find context 'nope' in f.txt",
        });
    });

    test('lines not found', () => {
        expect(update('a\nb\n', '@@', ' a', '-x', '-y')).toStrictEqual({
            ok: false,
            error: 'Failed to find expected lines in f.txt:\na\nx\ny',
        });
    });

    test('appending at the end', () => {
        expect(update('a\nb\n', '@@', '+c', '+d')).toStrictEqual({
            ok: true,
            value: 'a\nb\nc\nd\n',
        });
    });

    test('appending after a context header still appends at the end', () => {
        expect(update('a\nb\n', '@@ a', '+c')).toStrictEqual({ ok: true, value: 'a\nb\nc\n' });
    });

    test('CRLF is kept', () => {
        expect(update('a\r\nb\r\n', '@@', ' a', '-b', '+B', '+C')).toStrictEqual({
            ok: true,
            value: 'a\r\nB\r\nC\r\n',
        });
    });

    test('each line keeps its own line ending', () => {
        expect(update('a\r\nb\nc\r', '@@', '-a', '+A', ' b', ' c')).toStrictEqual({
            ok: true,
            value: 'A\r\nb\nc\r',
        });
    });

    test('a lone CR ends a line', () => {
        expect(update('a\rb\r', '@@', '-b', '+B')).toStrictEqual({ ok: true, value: 'a\rB\r' });
    });

    test('a file without line breaks gets LF ones', () => {
        expect(update('a', '@@', ' a', '+b')).toStrictEqual({ ok: true, value: 'a\nb\n' });
    });

    test('the last line gains a line break, as in Codex', () => {
        expect(update('a\nb', '@@', '-a', '+A')).toStrictEqual({ ok: true, value: 'A\nb\n' });
    });

    test('an empty file', () => {
        expect(update('', '@@', '+x')).toStrictEqual({ ok: true, value: 'x\n' });
    });

    test('the first match is used', () => {
        expect(update('x\ny\nx\ny\n', '@@', '-x', '+z')).toStrictEqual({
            ok: true,
            value: 'z\ny\nx\ny\n',
        });
    });

    test('every old line must match, not only the first', () => {
        expect(update('a\nb\na\nc\n', '@@', '-a', '-c', '+x')).toStrictEqual({
            ok: true,
            value: 'a\nb\nx\n',
        });
    });

    test('chunks apply in order, each after the one before', () => {
        expect(update('a\nb\na\nb\n', '@@', '-a', '+1', '@@', '-a', '+2')).toStrictEqual({
            ok: true,
            value: '1\nb\n2\nb\n',
        });
    });

    test('a chunk that appends, before one that changes', () => {
        expect(update('a\nb\n', '@@', '+z', '@@', '-a', '+A')).toStrictEqual({
            ok: true,
            value: 'A\nb\nz\n',
        });
    });

    test('a match that ends the file', () => {
        expect(update('a\nb\nc\n', '@@', '-b', '-c', '+d')).toStrictEqual({
            ok: true,
            value: 'a\nd\n',
        });
    });

    test('context lines keep the file’s text when they match leniently', () => {
        expect(update('  foo  \nbar\n', '@@', ' foo', '-bar', '+baz')).toStrictEqual({
            ok: true,
            value: '  foo  \nbaz\n',
        });
    });

    test('a chunk that only removes lines', () => {
        expect(update('a\nb\n', '@@', '-b')).toStrictEqual({ ok: true, value: 'a\n' });
    });

    test('a removal between context lines', () => {
        expect(update('a\nb\nc\n', '@@', ' a', '-b', ' c')).toStrictEqual({
            ok: true,
            value: 'a\nc\n',
        });
    });

    test('an insertion between context lines', () => {
        expect(update('a\nb\n', '@@', ' a', '+x', ' b')).toStrictEqual({
            ok: true,
            value: 'a\nx\nb\n',
        });
    });

    test('changes around context lines', () => {
        expect(update('a\nb\nc\nd\n', '@@', '-a', '+A', ' b', '-c', '+C', ' d')).toStrictEqual({
            ok: true,
            value: 'A\nb\nC\nd\n',
        });
    });

    test('a chunk of context only changes nothing', () => {
        expect(update('a\nb\n', '@@', ' a', ' b')).toStrictEqual({ ok: true, value: 'a\nb\n' });
    });

    test('an end of file marker anchors the search at the end', () => {
        expect(update('a\nb\na\nb\n', '@@', '-a', '-b', '+c', '*** End of File')).toStrictEqual({
            ok: true,
            value: 'a\nb\nc\n',
        });
    });

    test('an end of file marker still searches after the context header', () => {
        expect(update('a\nhead\n', '@@ head', '-head', '+x', '*** End of File')).toStrictEqual({
            ok: false,
            error: 'Failed to find expected lines in f.txt:\nhead',
        });
    });

    test('an end of file marker on old lines that do not end the file', () => {
        expect(update('a\nb\n', '@@', '-a', '+c', '*** End of File')).toStrictEqual({
            ok: false,
            error: 'Failed to find expected lines in f.txt:\na',
        });
    });
});

describe('Retry without a trailing empty line', () => {
    test("one that stands for the file's final line break", () => {
        expect(update('x\ny\nz\n', '@@', ' x', ' y', '-z', '+Z', '')).toStrictEqual({
            ok: true,
            value: 'x\ny\nZ\n',
        });
    });

    test('an empty removed line', () => {
        expect(update('w\nx\n', '@@', ' w', '-x', '-')).toStrictEqual({ ok: true, value: 'w\n' });
    });

    test('an empty context line followed by added lines', () => {
        expect(update('a\n', '@@', ' a', '', '+b')).toStrictEqual({ ok: true, value: 'a\n\nb\n' });
    });

    test('an empty context line, then an empty removed one', () => {
        expect(update('a\n\nb\n', '@@', '', '-')).toStrictEqual({ ok: true, value: 'a\nb\n' });
    });

    test('only when the old lines are not found as they are', () => {
        expect(update('a\nx\na\n\n', '@@', '-a', '+A', '')).toStrictEqual({
            ok: true,
            value: 'a\nx\nA\n\n',
        });
    });

    test('only when the old lines end with an empty one', () => {
        expect(update('x\ny\n', '@@', ' x', '-q', '+r')).toStrictEqual({
            ok: false,
            error: 'Failed to find expected lines in f.txt:\nx\nq',
        });
    });

    test('and it can still fail', () => {
        expect(update('x\ny\nz\n', '@@', ' x', '-q', '')).toStrictEqual({
            ok: false,
            error: 'Failed to find expected lines in f.txt:\nx\nq\n',
        });
    });
});

describe('Each pass alone, and the first pass that matches wins', () => {
    test('exact, before ignoring trailing whitespace', () => {
        expect(update('foo  \nx\nfoo\n', '@@', '-foo', '+bar')).toStrictEqual({
            ok: true,
            value: 'foo  \nx\nbar\n',
        });
    });

    test('ignoring trailing whitespace', () => {
        expect(update('foo  \t\nx\n', '@@', ' foo', '-x', '+y')).toStrictEqual({
            ok: true,
            value: 'foo  \t\ny\n',
        });
    });

    test('ignoring trailing whitespace, before ignoring leading whitespace', () => {
        expect(update('  foo\nfoo  \n', '@@', '-foo', '+bar')).toStrictEqual({
            ok: true,
            value: '  foo\nbar\n',
        });
    });

    test('ignoring leading and trailing whitespace', () => {
        expect(update('\t foo  \nx\n', '@@', ' foo', '-x', '+y')).toStrictEqual({
            ok: true,
            value: '\t foo  \ny\n',
        });
    });

    test('ignoring whitespace, before folding punctuation', () => {
        expect(update("it’s\n  it's\n", '@@', "-it's", '+done')).toStrictEqual({
            ok: true,
            value: 'it’s\ndone\n',
        });
    });

    test('typographic punctuation is tolerated', () => {
        expect(update('it’s – done\n', '@@', "-it's - done", '+ok')).toStrictEqual({
            ok: true,
            value: 'ok\n',
        });
    });

    test('folding applies to the old lines too', () => {
        expect(update("it's - done\n", '@@', '-it’s – done', '+ok')).toStrictEqual({
            ok: true,
            value: 'ok\n',
        });
    });

    test('folding trims first', () => {
        expect(update(' “x” \n', '@@', '-"x"', '+ok')).toStrictEqual({ ok: true, value: 'ok\n' });
    });
});

describe("Codex's Unicode folds", () => {
    test.each([
        ['‐', '-'],
        ['‑', '-'],
        ['‒', '-'],
        ['–', '-'],
        ['—', '-'],
        ['―', '-'],
        ['−', '-'],
        ['‘', "'"],
        ['’', "'"],
        ['‚', "'"],
        ['‛', "'"],
        ['“', '"'],
        ['”', '"'],
        ['„', '"'],
        ['‟', '"'],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        [' ', ' '],
        ['　', ' '],
    ])('U+%s reads as %j', (character, ascii) => {
        const line = `a${character}b`;

        expect(update(`${line}\n`, '@@', `-a${ascii}b`, '+ok')).toStrictEqual({
            ok: true,
            value: 'ok\n',
        });
    });

    test.each([' ', ' ', '‖', '†', '­'])('U+%s is not folded', (character) => {
        expect(update(`a${character}b\n`, '@@', '-a b', '+ok')).toMatchObject({ ok: false });
        expect(update(`a${character}b\n`, '@@', '-a-b', '+ok')).toMatchObject({ ok: false });
    });

    test('every character on the line is folded', () => {
        expect(
            update('“it’s” – ‘a’ – x  y\n', '@@', "-\"it's\" - 'a' - x  y", '+ok'),
        ).toStrictEqual({ ok: true, value: 'ok\n' });
    });
});
