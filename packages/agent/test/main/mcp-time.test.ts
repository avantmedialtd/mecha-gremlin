import { describe, expect, test } from 'vitest';
import { durationOf, readTime } from '../../src/main/mcp-time.ts';

describe('Read a time', () => {
    test.each([
        ['1h', 3_600_000],
        ['2m', 120_000],
        ['90s', 90_000],
        ['1500ms', 1500],
        ['090s', 90_000],
    ])('%s', (text, milliseconds) => {
        expect(readTime('--tool-timeout', text)).toEqual({ ok: true, value: milliseconds });
    });

    test('from 1s to 2147483647ms', () => {
        expect(readTime('--tool-timeout', '1s')).toEqual({ ok: true, value: 1000 });
        expect(readTime('--tool-timeout', '1000ms')).toEqual({ ok: true, value: 1000 });
        expect(readTime('--tool-timeout', '2147483647ms')).toEqual({
            ok: true,
            value: 2_147_483_647,
        });
    });

    test.each(['999ms', '0s', '2147483648ms', '600h', '99999999999999999999h'])(
        '%s is outside the range',
        (text) => {
            expect(readTime('--tool-timeout', text)).toEqual({
                ok: false,
                error: '--tool-timeout must be from 1s to 2147483647ms, about 24 days.',
            });
        },
    );

    test.each(['30', '0', '1000'])('%s needs a unit', (text) => {
        expect(readTime('--startup-timeout', text)).toEqual({
            ok: false,
            error: '--startup-timeout needs a unit, as in 30s: ms, s, m or h.',
        });
    });

    test.each([
        '',
        's',
        'ms',
        '1.5m',
        '-5s',
        '+5s',
        ' 5s',
        '5s ',
        '5 s',
        '5S',
        '5d',
        'a90s',
        '9as',
        '5sec',
    ])('%j is no time', (text) => {
        expect(readTime('--startup-timeout', text)).toEqual({
            ok: false,
            error: '--startup-timeout must be a whole number and a unit, ms, s, m or h, as in 90s.',
        });
    });
});

describe('Show a time in the largest unit that divides it', () => {
    test.each([
        [3_600_000, '1h'],
        [7_200_000, '2h'],
        [5_400_000, '90m'],
        [120_000, '2m'],
        [90_000, '90s'],
        [30_000, '30s'],
        [1000, '1s'],
        [1500, '1500ms'],
        [2_147_483_647, '2147483647ms'],
    ])('%d as %s', (milliseconds, text) => {
        expect(durationOf(milliseconds)).toBe(text);
    });

    test('a time that is not a whole number, as a row written by hand may hold', () => {
        expect(durationOf(1500.5)).toBe('1500.5ms');
    });
});
