import type { Result } from '@mecha-gremlin/core/result';
import { describe, expect, test, vi } from 'vitest';
import {
    type Parser,
    chooseParser,
    parseYaml,
    parseYamlWithBun,
    parseYamlWithPackage,
} from '../src/parse.ts';

// What each parser gives for the texts where the two differ.
type Differences = {
    readonly invalid: string;
    readonly severalDocuments: Result<unknown, string>;
    readonly collectionKey: unknown;
    readonly overriddenMergeKeys: readonly string[];
};

const FRONTMATTER = [
    'name: pdf',
    'description: "Use `pdftotext`: it extracts the text."',
    'homepage: https://example.com/pdf',
    'metadata: { "openclaw": { "requires": { "bins": ["pdftotext",], }, }, }',
].join('\n');

// A process warning prints on stderr, so it counts as output too.
const watchOutput = (): (() => unknown[]) => {
    const warnings = vi.spyOn(process, 'emitWarning');
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');

    return () => [...warnings.mock.calls, ...stdout.mock.calls, ...stderr.mock.calls];
};

const behaves = (parse: Parser, differences: Differences): void => {
    test('a mapping', () => {
        expect(parse('name: pdf\ndescription: Work with PDFs.')).toEqual({
            ok: true,
            value: { name: 'pdf', description: 'Work with PDFs.' },
        });
    });

    test('frontmatter as skills write it', () => {
        expect(parse(FRONTMATTER)).toEqual({
            ok: true,
            value: {
                name: 'pdf',
                description: 'Use `pdftotext`: it extracts the text.',
                homepage: 'https://example.com/pdf',
                metadata: { openclaw: { requires: { bins: ['pdftotext'] } } },
            },
        });
    });

    test('sequences and scalars, in block and flow style', () => {
        const text = [
            'tags:',
            '  - pdf',
            '  - text',
            'flow: [pdf, text,]',
            'count: 3',
            'ratio: 0.5',
            'ready: true',
            'nothing: ~',
        ].join('\n');

        expect(parse(text)).toEqual({
            ok: true,
            value: {
                tags: ['pdf', 'text'],
                flow: ['pdf', 'text'],
                count: 3,
                ratio: 0.5,
                ready: true,
                nothing: null,
            },
        });
    });

    test('empty frontmatter', () => {
        expect(parse('')).toEqual({ ok: true, value: null });
        expect(parse('# only a comment')).toEqual({ ok: true, value: null });
    });

    test('a repeated key keeps the last value', () => {
        expect(parse('description: First.\ndescription: Second.')).toEqual({
            ok: true,
            value: { description: 'Second.' },
        });
    });

    test('a merge key', () => {
        expect(parse('base: &b { x: 1 }\nderived:\n  <<: *b\n  y: 2')).toEqual({
            ok: true,
            value: { base: { x: 1 }, derived: { x: 1, y: 2 } },
        });
    });

    test("YAML 1.2's scalars", () => {
        expect(parse('a: yes\nb: on\nd: 2024-01-01')).toEqual({
            ok: true,
            value: { a: 'yes', b: 'on', d: '2024-01-01' },
        });
    });

    test.each(['name: [pdf', 'description: Use it: now', 'a:\n\tb: 1'])(
        'invalid YAML fails: %j',
        (text) => {
            expect(parse(text)).toEqual({ ok: false, error: expect.any(String) });
        },
    );

    test("the message is the first line of the parser's, without a trailing colon", () => {
        expect(parse('name: [pdf')).toEqual({ ok: false, error: differences.invalid });
    });

    test('several documents', () => {
        expect(parse('a: 1\n---\nb: 2')).toEqual(differences.severalDocuments);
    });

    test('a collection as a key', () => {
        expect(parse('? [a, b]\n: c')).toEqual({ ok: true, value: differences.collectionKey });
    });

    test('a key that overrides a merged one', () => {
        const result = parse('base: &b { x: 1, y: 1 }\nderived:\n  <<: *b\n  y: 2');

        expect(result).toEqual({
            ok: true,
            value: { base: { x: 1, y: 1 }, derived: { x: 1, y: 2 } },
        });
        expect(Object.keys((result as { value: { derived: object } }).value.derived)).toEqual(
            differences.overriddenMergeKeys,
        );
    });

    test('an unresolved tag gives the text after it, quietly', () => {
        const output = watchOutput();

        const result = parse('description: !thing Work with PDFs.');

        expect(result).toEqual({ ok: true, value: { description: 'Work with PDFs.' } });
        expect(output()).toEqual([]);
    });

    test('invalid YAML is reported only in the result', () => {
        const output = watchOutput();

        const result = parse('name: [pdf');

        expect(result.ok).toBe(false);
        expect(output()).toEqual([]);
    });
};

describe('parseYamlWithPackage', () => {
    behaves(parseYamlWithPackage, {
        invalid:
            'Flow sequence in block collection must be sufficiently indented and end with a ] at line 1, column 11',
        severalDocuments: { ok: false, error: expect.any(String) },
        collectionKey: { '[ a, b ]': 'c' },
        overriddenMergeKeys: ['x', 'y'],
    });
});

describe.runIf(typeof Bun !== 'undefined')('parseYamlWithBun', () => {
    behaves(parseYamlWithBun, {
        invalid: 'YAML Parse error: Unexpected token',
        severalDocuments: { ok: true, value: [{ a: 1 }, { b: 2 }] },
        collectionKey: { 'a,b': 'c' },
        overriddenMergeKeys: ['y', 'x'],
    });

    test('a parser that throws something other than an error', () => {
        vi.spyOn(Bun.YAML, 'parse').mockImplementation(() => {
            throw 'broken';
        });

        expect(parseYamlWithBun('name: pdf')).toEqual({ ok: false, error: 'broken' });
    });
});

describe('The choice of parser', () => {
    test('the Bun parser when the global object has Bun, the package otherwise', () => {
        expect(chooseParser({ Bun: {} })).toBe(parseYamlWithBun);
        expect(chooseParser({})).toBe(parseYamlWithPackage);
    });

    test("this runtime's global object", () => {
        expect(chooseParser(globalThis)).toBe(
            typeof Bun === 'undefined' ? parseYamlWithPackage : parseYamlWithBun,
        );
    });

    test('parseYaml parses with the chosen parser', () => {
        expect(parseYaml('name: pdf\ndescription: Work with PDFs.')).toEqual({
            ok: true,
            value: { name: 'pdf', description: 'Work with PDFs.' },
        });
    });
});
