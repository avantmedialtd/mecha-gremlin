import { expect, test } from 'vitest';
import { REDACTED, redactor } from '../../src/mcp/redact.ts';

test('each value, wherever it is', () => {
    expect(redactor(['t0k', 'abc'])('t0k and abc, then t0k again')).toBe(
        '[redacted] and [redacted], then [redacted] again',
    );
    expect(REDACTED).toBe('[redacted]');
});

test('longest first, so that no part of a longer value is left', () => {
    expect(redactor(['ab', 'abcd'])('abcd ab')).toBe('[redacted] [redacted]');
    expect(redactor(['abcd', 'ab'])('abcd ab')).toBe('[redacted] [redacted]');
    expect(redactor(['art', 'start'])('restarted')).toBe('re[redacted]ed');
});

test('an empty value redacts nothing, and no values leave the text as it is', () => {
    expect(redactor(['', 'a'])('a b')).toBe('[redacted] b');
    expect(redactor([])('a b')).toBe('a b');
});

test('a value given twice', () => {
    expect(redactor(['x', 'x'])('x')).toBe('[redacted]');
});
