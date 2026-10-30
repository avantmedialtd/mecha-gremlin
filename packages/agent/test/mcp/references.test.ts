import { describe, expect, test } from 'vitest';
import { hasReference, parseTemplate, render, resolve } from '../../src/mcp/references.ts';

describe('Read the references in a text', () => {
    test('literal text, references of both forms, and a doubled $', () => {
        expect(parseTemplate('a ${ONE}-${env:TWO_2} $$5 ${_x}')).toEqual({
            template: [
                'a ',
                { variable: 'ONE' },
                '-',
                { variable: 'TWO_2' },
                ' $5 ',
                { variable: '_x' },
            ],
            problems: [],
        });
    });

    test('a text without references, and an empty one', () => {
        expect(parseTemplate('plain')).toEqual({ template: ['plain'], problems: [] });
        expect(parseTemplate('')).toEqual({ template: [], problems: [] });
        expect(parseTemplate('${A}${B}')).toEqual({
            template: [{ variable: 'A' }, { variable: 'B' }],
            problems: [],
        });
    });

    test.each([
        [
            '${TOKEN:-abc123}',
            "a reference with a default, ${TOKEN…}, and defaults aren't supported: set TOKEN itself",
        ],
        [
            '${TOKEN-abc123}',
            "a reference with a default, ${TOKEN…}, and defaults aren't supported: set TOKEN itself",
        ],
        [
            '${env:TOKEN:=abc123}',
            "a reference with a default, ${TOKEN…}, and defaults aren't supported: set TOKEN itself",
        ],
        [
            '${TOKEN?abc123}',
            "a reference with a default, ${TOKEN…}, and defaults aren't supported: set TOKEN itself",
        ],
        [
            '${TOKEN:+abc123}',
            "a reference with a default, ${TOKEN…}, and defaults aren't supported: set TOKEN itself",
        ],
        [
            '${input:token}',
            "a reference of a kind that isn't supported: only ${NAME} and ${env:NAME} are",
        ],
        ['${1A}', "a reference to something that isn't a variable name: write ${NAME}"],
        ['${}', "a reference to something that isn't a variable name: write ${NAME}"],
        ['${1x:y}', "a reference to something that isn't a variable name: write ${NAME}"],
        ['${1A:-x}', "a reference to something that isn't a variable name: write ${NAME}"],
        ['$5x', 'a $ that starts no reference: write ${NAME} for a variable, or $$ for a $'],
        ['${env:}', "a reference of a kind that isn't supported: only ${NAME} and ${env:NAME} are"],
        ['$HOME/x', "$HOME, which isn't a reference: write ${HOME}"],
        ['$_x1 y', "$_x1, which isn't a reference: write ${_x1}"],
        ['$5', 'a $ that starts no reference: write ${NAME} for a variable, or $$ for a $'],
        ['a$', 'a $ that starts no reference: write ${NAME} for a variable, or $$ for a $'],
        ['${OPEN', 'a reference without its closing }'],
        [
            '${MODEL_API_KEY}',
            "a reference to MODEL_API_KEY, the model's key, which no server is given",
        ],
        [
            '${env:MODEL_API_KEY}',
            "a reference to MODEL_API_KEY, the model's key, which no server is given",
        ],
    ])('%s', (text, problem) => {
        const parsed = parseTemplate(text);

        expect(parsed.problems).toEqual([problem]);
        expect(parsed.problems.join()).not.toContain('abc123');
    });

    test('every problem, and the text around them kept', () => {
        expect(parseTemplate('$A ${B} $')).toEqual({
            template: [' ', { variable: 'B' }, ' '],
            problems: [
                "$A, which isn't a reference: write ${A}",
                'a $ that starts no reference: write ${NAME} for a variable, or $$ for a $',
            ],
        });
    });
});

describe('Resolve the references', () => {
    test('from own properties of the environment, trimmed', () => {
        const env = { ONE: ' 1 ', TWO: 'two' };

        expect(resolve(parseTemplate('${ONE}+${env:TWO}=$$').template, env)).toEqual({
            text: '1+two=$',
            values: ['1', 'two'],
            missing: [],
        });
    });

    test('unset and blank variables, each named once, and inherited names count as unset', () => {
        const template = parseTemplate('${A}${B}${A}${constructor}${toString}${C}').template;

        expect(resolve(template, { B: '  ', C: 'c' })).toEqual({
            text: 'c',
            values: ['c'],
            missing: ['A', 'B', 'constructor', 'toString'],
        });
        expect(
            resolve(template, { A: undefined, B: 'b-', C: 'c', constructor: 'x-', toString: 'y-' }),
        ).toEqual({
            text: 'b-x-y-c',
            values: ['b-', 'x-', 'y-', 'c'],
            missing: ['A'],
        });
    });

    test('a text without references', () => {
        expect(resolve(['plain'], {})).toEqual({ text: 'plain', values: [], missing: [] });
    });
});

describe('Render and inspect a template', () => {
    test('render fills each reference with a text', () => {
        expect(render(parseTemplate('a${B}c${D}').template, '-')).toBe('a-c-');
    });

    test('render fills each reference by its variable', () => {
        expect(
            render(parseTemplate('a${B}c${D}').template, (variable) => variable.toLowerCase()),
        ).toBe('abcd');
    });

    test('hasReference', () => {
        expect(hasReference(parseTemplate('a ${B}').template)).toBe(true);
        expect(hasReference(parseTemplate('a $$B').template)).toBe(false);
        expect(hasReference([])).toBe(false);
    });
});
