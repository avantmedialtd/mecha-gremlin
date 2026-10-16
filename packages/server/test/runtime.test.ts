import { describe, expect, test } from 'vitest';

// Vitest's and Stryker's command-line scripts name Node in their shebang, so a package.json
// script that stops overriding it would quietly run the tests on Node.
describe('The tests', () => {
    test('run on Bun, the runtime the app runs on', () => {
        expect(
            process.versions.bun,
            'The tests must run on Bun, as the app does; `bun run test` runs them there',
        ).toBeDefined();
    });
});
