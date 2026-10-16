import { describe, expect, test } from 'vitest';

// Vitest's and Stryker's command-line scripts name Node in their shebang, so a package.json
// script that stops overriding it would quietly change the runtime.
describe('The tests', () => {
    test('run on the runtime TEST_RUNTIME names', () => {
        const named = process.env.TEST_RUNTIME;
        const actual = process.versions.bun === undefined ? 'node' : 'bun';

        expect(
            ['bun', 'node'],
            'TEST_RUNTIME must name bun or node: run the tests with `bun run test` or `bun run test:node`',
        ).toContain(named);
        expect(actual, `TEST_RUNTIME names ${named}, but the tests run on ${actual}`).toBe(named);
    });
});
