import { describe, expect, test } from 'vitest';
import { err, ok } from '../src/result.ts';

describe('Result', () => {
    test('ok holds a value', () => {
        expect(ok(42)).toEqual({ ok: true, value: 42 });
    });

    test('err holds an error', () => {
        expect(err('no such file')).toEqual({ ok: false, error: 'no such file' });
    });
});
