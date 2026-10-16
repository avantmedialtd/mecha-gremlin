import { describe, expect, test } from 'vitest';
import { type Capture, appendCapture, renderCapture, startCapture, wasCut } from '../src/output.ts';

const encode = (text: string): Uint8Array => {
    return new TextEncoder().encode(text);
};

const capture = (limit: number, ...chunks: readonly Uint8Array[]): Capture => {
    return chunks.reduce(appendCapture, startCapture(limit));
};

const render = (limit: number, ...chunks: readonly Uint8Array[]): string => {
    return renderCapture(capture(limit, ...chunks));
};

const bytesOf = (bytes: Uint8Array): Uint8Array[] => {
    return Array.from(bytes, (byte) => Uint8Array.of(byte));
};

describe('Short output', () => {
    test('is shown whole, with no note', () => {
        const output = 'x'.repeat(1000);

        expect(render(32 * 1024, encode(output))).toBe(output);
    });

    test('nothing at all', () => {
        expect(render(8)).toBe('');
    });

    test('exactly the limit is not cut', () => {
        const full = capture(8, encode('abcdefgh'));

        expect(renderCapture(full)).toBe('abcdefgh');
        expect(wasCut(full)).toBe(false);
    });

    test('a character split between the head and the tail is whole', () => {
        expect(render(8, encode('abc€de'))).toBe('abc€de');
    });

    test('an odd limit keeps the same at each end, and leaves its last byte unused', () => {
        const kept = capture(33, encode('x'.repeat(32)));
        const over = capture(33, encode('x'.repeat(33)));

        expect(renderCapture(kept)).toBe('x'.repeat(32));
        expect(wasCut(kept)).toBe(false);
        expect(renderCapture(over)).toBe(
            `${'x'.repeat(16)}\n[… 1 bytes omitted …]\n${'x'.repeat(16)}`,
        );
        expect(wasCut(over)).toBe(true);
    });

    test.each([2, 1, 0, -4])('a limit of %d keeps a byte at each end', (limit) => {
        expect(render(limit, encode('abc'))).toBe('a\n[… 1 bytes omitted …]\nc');
    });
});

describe('Long output', () => {
    test("the spec's example: the first and last 16,384 bytes, and what was left out", () => {
        const output = encode(`start${'x'.repeat(100_000)}end`);

        expect(
            render(
                32 * 1024,
                output.subarray(0, 65_536),
                output.subarray(65_536, 70_000),
                output.subarray(70_000),
            ),
        ).toBe(`start${'x'.repeat(16_379)}\n[… 67240 bytes omitted …]\n${'x'.repeat(16_381)}end`);
    });

    test('one byte over the limit', () => {
        const over = capture(8, encode('abcdefghi'));

        expect(renderCapture(over)).toBe('abcd\n[… 1 bytes omitted …]\nfghi');
        expect(wasCut(over)).toBe(true);
    });

    test('chunks of any size give the same text', () => {
        const output = encode(`aaa€${'z'.repeat(10)}`);

        expect(render(8, ...bytesOf(output))).toBe(render(8, output));
    });
});

describe('Cuts move to character boundaries', () => {
    test("a 3-byte character at the head's cut", () => {
        expect(render(8, encode(`aaa€${'z'.repeat(10)}`))).toBe('aaa\n[… 9 bytes omitted …]\nzzzz');
    });

    test("a 4-byte character at the head's cut", () => {
        expect(render(8, encode(`aa😀${'z'.repeat(10)}`))).toBe('aa\n[… 10 bytes omitted …]\nzzzz');
    });

    test("a 3-byte character at the tail's start", () => {
        expect(render(8, encode(`${'z'.repeat(10)}€aa`))).toBe('zzzz\n[… 9 bytes omitted …]\naa');
    });

    test("a 4-byte character at the tail's start", () => {
        expect(render(8, encode(`${'z'.repeat(10)}😀a`))).toBe('zzzz\n[… 10 bytes omitted …]\na');
    });

    test("in invalid UTF-8, the head's cut moves back no more than 3 bytes", () => {
        const output = Uint8Array.of(0x61, ...Array(6).fill(0x80), ...encode('z'.repeat(10)));

        expect(render(10, output)).toBe('a�\n[… 10 bytes omitted …]\nzzzzz');
    });

    test("in invalid UTF-8, the tail's start moves on no more than 3 bytes", () => {
        const output = Uint8Array.of(...encode('zzzzzyyy'), 0x80, 0x80, 0x80, 0x80, 0x62);

        expect(render(10, output)).toBe('zzzzz\n[… 6 bytes omitted …]\n�b');
    });
});

describe('Decoding', () => {
    test('invalid UTF-8 reads as U+FFFD', () => {
        expect(render(8, Uint8Array.of(0x80))).toBe('�');
    });

    test('NUL shows as ␀', () => {
        expect(render(8, encode('a\0b'))).toBe('a␀b');
    });

    test('NUL in the head and the tail of a cut stream', () => {
        expect(render(4, encode('a\0cdef\0h'))).toBe('a␀\n[… 4 bytes omitted …]\n␀h');
    });
});

describe('Captures are immutable', () => {
    test('adding a chunk leaves the earlier capture unchanged', () => {
        const first = capture(8, encode('abc'));
        const snapshot = structuredClone(first);

        const second = appendCapture(first, encode('defghijk'));

        expect(first).toEqual(snapshot);
        expect(renderCapture(first)).toBe('abc');
        expect(renderCapture(second)).toBe('abcd\n[… 3 bytes omitted …]\nhijk');
    });

    test('the chunk is copied, not kept', () => {
        const chunk = encode('abcdefghij');
        const cut = capture(8, chunk);

        chunk.fill(0x21);

        expect(renderCapture(cut)).toBe('abcd\n[… 2 bytes omitted …]\nghij');
    });
});
