import { describe, expect, test } from 'vitest';
import { isInside } from '../../src/mcp/run-directory.ts';

describe('isInside', () => {
    test.each([
        ['the directory itself', '/home/me/work'],
        ['a path below it', '/home/me/work/docs/guide.md'],
        ['a name that starts with two dots', '/home/me/work/..notes.txt'],
    ])('%s is inside', (_what, target) => {
        expect(isInside('/home/me/work', target)).toBe(true);
    });

    test.each([
        ['its parent', '/home/me'],
        ["a sibling whose name starts with the directory's", '/home/me/work-data'],
        ['a path elsewhere', '/etc/hosts'],
    ])('%s is outside', (_what, target) => {
        expect(isInside('/home/me/work', target)).toBe(false);
    });
});
