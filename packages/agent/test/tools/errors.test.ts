import { describe, expect, test } from 'vitest';
import { reasonOf } from '../../src/tools/errors.ts';

describe('reasonOf', () => {
    test("an error's message", () => {
        expect(reasonOf(new Error('disk on fire'))).toBe('disk on fire');
    });

    test('anything else thrown, as text', () => {
        expect(reasonOf('disk on fire')).toBe('disk on fire');
    });
});
