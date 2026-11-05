import { describe, expect, test } from 'vitest';
import { readFrontmatter } from '../../src/main/frontmatter.ts';

const WHERE = 'task file "/tasks/daily.md"';

const HINT =
    'List each server once, as in mcp: [docs], or give mcp: [] for none; a ? after a name marks a server the task can go without.';

const notNames = `In the frontmatter of the task file "/tasks/daily.md", mcp isn't a list of MCP server names. ${HINT}`;

const readOf = (text: string) => {
    return readFrontmatter(text, WHERE);
};

describe("Read a task's frontmatter", () => {
    test('a task without frontmatter stays as it is', () => {
        expect(readOf('Say hi\r\n\r\n  and bye')).toEqual({
            ok: true,
            value: { text: 'Say hi\r\n\r\n  and bye', mcp: undefined, ignored: [] },
        });
    });

    test('frontmatter is stripped, and its other keys ignored, in their order', () => {
        expect(readOf('---\ntags: [work]\nmcps: [docs]\n---\n\nSay hi\n  and bye')).toEqual({
            ok: true,
            value: { text: 'Say hi\n  and bye', mcp: undefined, ignored: ['tags', 'mcps'] },
        });
    });

    test('a key that is a whole number comes first, as in any object', () => {
        expect(readOf('---\ntags: [work]\n2026: notes\n---\nSay hi')).toMatchObject({
            value: { ignored: ['2026', 'tags'] },
        });
    });

    test('the mcp list as written, each name with its ?', () => {
        expect(readOf('---\nmcp: [docs, github?, pw_1-x]\ntags: [work]\n---\nSay hi')).toEqual({
            ok: true,
            value: { text: 'Say hi', mcp: ['docs', 'github?', 'pw_1-x'], ignored: ['tags'] },
        });
    });

    test('a list one item a line, and an empty one', () => {
        expect(readOf('---\nmcp:\n  - docs\n  - github?\n---\nSay hi')).toMatchObject({
            value: { mcp: ['docs', 'github?'] },
        });
        expect(readOf('---\nmcp: []\n---\nSay hi')).toEqual({
            ok: true,
            value: { text: 'Say hi', mcp: [], ignored: [] },
        });
    });

    test.each([
        ['empty', '---\n---\nSay hi'],
        ['a comment alone', '---\n# from a template\n---\nSay hi'],
    ])('a block that is %s is frontmatter', (_what, text) => {
        expect(readOf(text)).toEqual({
            ok: true,
            value: { text: 'Say hi', mcp: undefined, ignored: [] },
        });
    });

    test.each([
        ['a sentence between two horizontal rules', '---\nA rule above and below\n---\nSay hi'],
        ['a list', '---\n- one\n- two\n---\nSay hi'],
        ['a number', '---\n42\n---\nSay hi'],
        ['an opening line that nothing closes', '---\nSay hi'],
    ])("a block that isn't frontmatter stays in the task: %s", (_what, text) => {
        expect(readOf(text)).toEqual({
            ok: true,
            value: { text, mcp: undefined, ignored: [] },
        });
    });

    test.each([
        ['line 2', '---\ntitle: Meeting: Q3 plan\n---\nSay hi'],
        ['lines 2 to 3', '---\ntags: [work]\nauthor: @someone\n---\nSay hi'],
    ])(
        "frontmatter that isn't valid YAML: the task, %s, and the parser's reason",
        (lines, text) => {
            const read = readOf(text);

            expect(read).toEqual({
                ok: false,
                error: expect.stringMatching(
                    new RegExp(
                        `^The frontmatter of the task file "/tasks/daily.md", on ${lines}, isn't valid YAML: \\S`,
                    ),
                ),
            });
        },
    );

    test.each([
        ['a name alone', 'mcp: docs'],
        ['no value', 'mcp:'],
        ['a mapping', 'mcp: { docs: true }'],
        ['a number in it', 'mcp: [docs, 1]'],
        ['a name with a slash', 'mcp: [docs/x]'],
        ['an empty name', "mcp: ['']"],
        ['a ? alone', "mcp: ['?']"],
        ['two ?s', 'mcp: [docs??]'],
        ['a ? inside a name', 'mcp: [do?cs]'],
        ['a name with a space', "mcp: ['docs x']"],
    ])("an mcp value that isn't a list of names: %s", (_what, line) => {
        expect(readOf(`---\n${line}\n---\nSay hi`)).toEqual({ ok: false, error: notNames });
    });

    test.each([
        ['as written', 'mcp: [docs, github, docs]'],
        ['once with its ?', 'mcp: [docs, docs?]'],
        ['twice with its ?', 'mcp: [docs?, docs?]'],
    ])('a server named twice: %s', (_what, line) => {
        expect(readOf(`---\n${line}\n---\nSay hi`)).toEqual({
            ok: false,
            error: `In the frontmatter of the task file "/tasks/daily.md", mcp names docs twice. ${HINT}`,
        });
    });

    test('a task that is only frontmatter', () => {
        expect(readOf('---\nmcp: [docs]\n---')).toEqual({
            ok: false,
            error: 'The task file "/tasks/daily.md" is blank once its frontmatter is stripped.',
        });
        expect(readOf('---\n---')).toEqual({
            ok: false,
            error: 'The task file "/tasks/daily.md" is blank once its frontmatter is stripped.',
        });
    });

    test('a broken list comes before a blank task', () => {
        expect(readOf('---\nmcp: docs\n---')).toEqual({ ok: false, error: notNames });
    });
});
