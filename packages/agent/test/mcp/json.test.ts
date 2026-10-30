import { describe, expect, test } from 'vitest';
import { jsonOf, parseJson } from '../../src/mcp/json.ts';

const invalid = (what: string, line: number, column: number): string => {
    return `The entry isn't valid JSON: ${what} at line ${line}, column ${column}.`;
};

describe('Read an entry as strict JSON', () => {
    test('every kind of value', () => {
        const text =
            ' {"a": [1, -2.5, 3e2, 0, -0.5E-1, 12.25, 1e+10], "b": {"c": true, "d": false}, "e": null, "f": "x"} ';

        expect(parseJson(text)).toEqual({
            value: {
                a: [1, -2.5, 300, 0, -0.05, 12.25, 1e10],
                b: { c: true, d: false },
                e: null,
                f: 'x',
            },
            problems: [],
        });
    });

    test('empty containers, and whitespace of every kind', () => {
        expect(parseJson('\t\r\n{ "a" : [ ] ,\n"b":{ } }\n')).toEqual({
            value: { a: [], b: {} },
            problems: [],
        });
    });

    test('a value at the top that is not an object', () => {
        expect(parseJson('"text"')).toEqual({ value: 'text', problems: [] });
        expect(parseJson('[true]')).toEqual({ value: [true], problems: [] });
        expect(parseJson('12')).toEqual({ value: 12, problems: [] });
    });

    // Written with doubled backslashes: the formatter rewrites \u escapes even in String.raw.
    test('every escape', () => {
        expect(
            parseJson('"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u20AC \\u00e9 \\uD83D\\uDE00"'),
        ).toEqual({
            value: '" \\ / \b \f \n \r \t € é 😀',
            problems: [],
        });
    });

    test('objects have no prototype, so their own keys are all there is', () => {
        const value = parseJson('{"__proto__": {"x": 1}, "a": {}}').value as object;

        expect(Object.getPrototypeOf(value)).toBeNull();
        expect(Object.keys(value)).toEqual(['__proto__', 'a']);
        expect(Reflect.get(value, '__proto__')).toEqual({ x: 1 });
        expect(Object.getPrototypeOf(Reflect.get(value, 'a'))).toBeNull();
        expect(Reflect.get(value, 'constructor')).toBeUndefined();
    });
});

describe('Report what is wrong, by its line and column, without quoting it', () => {
    test.each([
        ['nothing at all', '', 'the text ends early', 1, 1],
        ['a text that ends inside an object', '{"a": 1', 'expected "," or "}"', 1, 8],
        ['a value that is missing', '{"a": }', 'expected a value', 1, 7],
        ['a bare word', '{"env": {"A": sk-secret123}}', 'expected a value', 1, 15],
        ['a key without quotes', '{\n  a: 1}', 'expected a key in double quotes', 2, 3],
        ['a key in single quotes', "{'a': 1}", 'expected a key in double quotes', 1, 2],
        ['a trailing comma in an object', '{"a": 1,}', 'expected a key in double quotes', 1, 9],
        ['a trailing comma in an array', '[1,]', 'expected a value', 1, 4],
        ['a missing colon', '{"a" 1}', 'expected ":"', 1, 6],
        ['a missing comma in an array', '[1 2]', 'expected "," or "]"', 1, 4],
        ['an array that ends early', '[1', 'expected "," or "]"', 1, 3],
        ['a string without its closing quote', '"abc', 'a string has no closing quote', 1, 5],
        ['a key without its closing quote', '{"ab', 'a string has no closing quote', 1, 5],
        ["a unicode escape that isn't hex", '"\\u12G4"', 'a string has an invalid escape', 1, 2],
        ['a line feed inside a string', '"a\nb"', 'a string holds a control character', 1, 3],
        ['an unknown escape', String.raw`"\x41"`, 'a string has an invalid escape', 1, 2],
        [
            'an unknown escape before hex digits',
            '"\\x0041"',
            'a string has an invalid escape',
            1,
            2,
        ],
        ['a short unicode escape', String.raw`"\u12"`, 'a string has an invalid escape', 1, 2],
        ['an escape at the end', '"\\', 'a string has an invalid escape', 1, 2],
        ['a comment', '{} // note', 'more text follows the value', 1, 4],
        ['a second value', '{}\n{}', 'more text follows the value', 2, 1],
        ['a number with a leading zero', '01', 'more text follows the value', 1, 2],
        ['a lone minus', '-', 'expected a value', 1, 1],
        ['a word that only starts like a literal', 'nul', 'expected a value', 1, 1],
    ])('%s', (_what, text, what, line, column) => {
        const parsed = parseJson(text);

        expect(parsed).toEqual({ value: undefined, problems: [invalid(what, line, column)] });
        expect(JSON.stringify(parsed)).not.toContain('secret');
    });

    test('a repeated key, at the second, keeping the first', () => {
        const text =
            '{\n    "url": "https://a.example/mcp",\n    "url": "https://b.example/mcp"\n}';

        expect(parseJson(text)).toEqual({
            value: { url: 'https://a.example/mcp' },
            problems: ['The key "url" is repeated, at line 3, column 5: give each key once.'],
        });
    });

    test('every repeated key, nested ones too', () => {
        expect(parseJson('{"a": {"b": 1, "b": 2}, "a": 3}').problems).toEqual([
            'The key "b" is repeated, at line 1, column 16: give each key once.',
            'The key "a" is repeated, at line 1, column 25: give each key once.',
        ]);
    });

    test('a byte-order mark, and what comes after it', () => {
        expect(parseJson('﻿{"a": 1}')).toEqual({
            value: { a: 1 },
            problems: [
                'The entry starts with a byte-order mark, at line 1, column 1: save it without one.',
            ],
        });
        expect(parseJson('﻿{"a" 1}')).toEqual({
            value: undefined,
            problems: [
                'The entry starts with a byte-order mark, at line 1, column 1: save it without one.',
                invalid('expected ":"', 1, 7),
            ],
        });
    });

    test('a repeated key before a syntax error', () => {
        expect(parseJson('{"a": 1, "a": 2, }').problems).toEqual([
            'The key "a" is repeated, at line 1, column 10: give each key once.',
            invalid('expected a key in double quotes', 1, 18),
        ]);
    });
});

describe('Read a value from elsewhere as JSON', () => {
    test('JSON values as they are, and anything else as null', () => {
        expect(
            jsonOf({
                text: 'a',
                number: 1,
                yes: true,
                no: false,
                none: null,
                list: [1, { nested: ['b'] }],
                missing: undefined,
                call: () => 1,
            }),
        ).toEqual({
            text: 'a',
            number: 1,
            yes: true,
            no: false,
            none: null,
            list: [1, { nested: ['b'] }],
            missing: null,
            call: null,
        });
        expect(jsonOf('a')).toBe('a');
        expect(jsonOf(undefined)).toBeNull();
    });
});
