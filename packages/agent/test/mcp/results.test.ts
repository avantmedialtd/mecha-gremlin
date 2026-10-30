import { describe, expect, test } from 'vitest';
import { RESULT_LIMIT, capped, flatten } from '../../src/mcp/results.ts';

describe('Flatten a result', () => {
    test('content that is not a list counts as none', () => {
        expect(flatten('text', undefined)).toBe('(no output)');
        expect(flatten(undefined, { a: 1 })).toBe('{"a":1}');
    });

    test('structured content of null is still structured content', () => {
        expect(flatten([], null)).toBe('null');
    });

    test('structured content follows blocks that are not text blocks', () => {
        const blocks = [
            { type: 'resource_link', name: 'doc', uri: 'file:///doc' },
            { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } },
            { type: 'video' },
        ];

        expect(flatten(blocks, { a: 1 })).toBe(
            '[resource link: doc file:///doc]\n[resource file:///a.txt]\nhello\n[video block, not shown]\n{"a":1}',
        );
    });

    test('a block that is null, or not an object, is of an unknown type', () => {
        expect(flatten([null, 'text', 5], undefined)).toBe(
            '[unknown block, not shown]\n[unknown block, not shown]\n[unknown block, not shown]',
        );
    });
});

describe('Cap a result', () => {
    test('32 KiB is kept whole', () => {
        const text = 'a'.repeat(RESULT_LIMIT);

        expect(capped(text)).toBe(text);
        expect(RESULT_LIMIT).toBe(32_768);
    });

    test('one byte more is cut, with a note', () => {
        expect(capped('a'.repeat(RESULT_LIMIT + 1))).toBe(
            `${'a'.repeat(RESULT_LIMIT)}\n[The result is 32769 bytes, so it was cut: these are its first 32768.]`,
        );
    });

    test('the cut moves back to where a character starts', () => {
        const text = `${'a'.repeat(RESULT_LIMIT - 1)}€`;

        expect(capped(text)).toBe(
            `${'a'.repeat(RESULT_LIMIT - 1)}\n[The result is 32770 bytes, so it was cut: these are its first 32767.]`,
        );
    });
});
