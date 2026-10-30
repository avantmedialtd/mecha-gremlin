// A strict JSON reader for MCP server entries. JSON.parse keeps the last of two equal keys
// without a word, refuses a byte-order mark with no position on Bun, and quotes the text around
// an error, which may hold a secret (Brief R18.1). This reports every repeated key and a
// byte-order mark, gives each problem's line and column, and never quotes the text.
import { type Err, type Result, err, ok } from '@mecha-gremlin/core/result';

export type JsonValue =
    | string
    | number
    | boolean
    | null
    | readonly JsonValue[]
    | { readonly [key: string]: JsonValue };

export type ParsedJson = {
    /** Undefined when the text isn't JSON. */
    readonly value: JsonValue | undefined;
    readonly problems: readonly string[];
};

type Reader = () => Result<JsonValue, string>;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// Applied to the four characters after \u, at most.
const HEX = /[0-9A-Fa-f]{4}/;

const ESCAPES = new Map([
    ['"', '"'],
    ['\\', '\\'],
    ['/', '/'],
    ['b', '\b'],
    ['f', '\f'],
    ['n', '\n'],
    ['r', '\r'],
    ['t', '\t'],
]);

const LITERALS = [
    ['true', true],
    ['false', false],
    ['null', null],
] as const;

const isWhitespace = (character: string | undefined): boolean => {
    return character === ' ' || character === '\t' || character === '\n' || character === '\r';
};

const positionOf = (text: string, index: number): string => {
    const before = text.slice(0, index);
    const lineStart = before.lastIndexOf('\n') + 1;

    return `line ${before.split('\n').length}, column ${index - lineStart + 1}`;
};

// Without a prototype, a `__proto__` key is a key like any other, and `constructor` isn't
// inherited.
const objectOf = (entries: ReadonlyMap<string, JsonValue>): JsonValue => {
    const object: { [key: string]: JsonValue } = Object.fromEntries(entries);
    Object.setPrototypeOf(object, null);

    return object;
};

/** A value read from elsewhere, such as the store, as JSON: anything else becomes null. */
export const jsonOf = (value: unknown): JsonValue => {
    if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
    ) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(jsonOf);
    }

    return typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonOf(item)]))
        : null;
};

export const parseJson = (text: string): ParsedJson => {
    const problems: string[] = [];
    let index = 0;

    const failure = (what: string): Err<string> => {
        return err(`The entry isn't valid JSON: ${what} at ${positionOf(text, index)}.`);
    };

    const skipWhitespace = (): void => {
        while (isWhitespace(text[index])) {
            index++;
        }
    };

    const readString = (): Result<string, string> => {
        let value = '';
        index++;

        for (;;) {
            const character = text[index];

            if (character === undefined) {
                return failure('a string has no closing quote');
            }

            if (character === '"') {
                index++;

                return ok(value);
            }

            if (character < ' ') {
                return failure('a string holds a control character');
            }

            if (character === '\\') {
                const escape = text.charAt(index + 1);
                const escaped = ESCAPES.get(escape);
                const unicode = text.slice(index + 2, index + 6);

                if (escaped !== undefined) {
                    value += escaped;
                    index += 2;
                } else if (escape === 'u' && HEX.test(unicode)) {
                    value += String.fromCharCode(Number.parseInt(unicode, 16));
                    index += 6;
                } else {
                    return failure('a string has an invalid escape');
                }
            } else {
                value += character;
                index++;
            }
        }
    };

    const readArray = (readValue: Reader): Result<JsonValue, string> => {
        const items: JsonValue[] = [];
        index++;
        skipWhitespace();

        if (text[index] === ']') {
            index++;

            return ok(items);
        }

        for (;;) {
            const item = readValue();

            if (!item.ok) {
                return item;
            }

            items.push(item.value);
            skipWhitespace();

            if (text[index] === ']') {
                index++;

                return ok(items);
            }

            if (text[index] !== ',') {
                return failure('expected "," or "]"');
            }

            index++;
        }
    };

    // The first of two equal keys is kept, and the second reported.
    const readObject = (readValue: Reader): Result<JsonValue, string> => {
        const entries = new Map<string, JsonValue>();
        index++;
        skipWhitespace();

        if (text[index] === '}') {
            index++;

            return ok(objectOf(entries));
        }

        for (;;) {
            skipWhitespace();

            if (text[index] !== '"') {
                return failure('expected a key in double quotes');
            }

            const keyAt = index;
            const key = readString();

            if (!key.ok) {
                return key;
            }

            skipWhitespace();

            if (text[index] !== ':') {
                return failure('expected ":"');
            }

            index++;
            const value = readValue();

            if (!value.ok) {
                return value;
            }

            if (entries.has(key.value)) {
                problems.push(
                    `The key ${JSON.stringify(key.value)} is repeated, at ${positionOf(text, keyAt)}: give each key once.`,
                );
            } else {
                entries.set(key.value, value.value);
            }

            skipWhitespace();

            if (text[index] === '}') {
                index++;

                return ok(objectOf(entries));
            }

            if (text[index] !== ',') {
                return failure('expected "," or "}"');
            }

            index++;
        }
    };

    const readValue = (): Result<JsonValue, string> => {
        skipWhitespace();
        const character = text[index];

        if (character === undefined) {
            return failure('the text ends early');
        }

        if (character === '{') {
            return readObject(readValue);
        }

        if (character === '[') {
            return readArray(readValue);
        }

        if (character === '"') {
            return readString();
        }

        for (const [word, value] of LITERALS) {
            if (text.startsWith(word, index)) {
                index += word.length;

                return ok(value);
            }
        }

        NUMBER.lastIndex = index;
        const number = NUMBER.exec(text)?.[0];

        if (number === undefined) {
            return failure('expected a value');
        }

        index += number.length;

        return ok(Number(number));
    };

    if (text.startsWith('﻿')) {
        problems.push(
            'The entry starts with a byte-order mark, at line 1, column 1: save it without one.',
        );
        index = 1;
    }

    const value = readValue();

    if (!value.ok) {
        return { value: undefined, problems: [...problems, value.error] };
    }

    skipWhitespace();

    if (index < text.length) {
        return {
            value: undefined,
            problems: [...problems, failure('more text follows the value').error],
        };
    }

    return { value: value.value, problems };
};
