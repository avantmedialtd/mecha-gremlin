// Mutation testing with Stryker, through its Vitest runner. With per-test coverage, each
// mutant runs only the tests that reach it, and the report shows which test killed it.
//
// Vitest is pinned to 4.x in package.json: with Vitest 5, @stryker-mutator/vitest-runner 10.0.0
// never activates mutants, so every mutant "survives" and the score reads 0%
// (stryker-mutator/stryker-js#6210). Lift the pin once the runner supports Vitest 5, and check
// that the score is still non-zero.

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
    // Stryker looks for its plugins next to its own package, but Bun's isolated installs keep
    // them apart; resolving the runner from the project root works with any install layout.
    plugins: [import.meta.resolve('@stryker-mutator/vitest-runner')],
    testRunner: 'vitest',
    vitest: { configFile: 'vitest.config.ts' },
    coverageAnalysis: 'perTest',
    mutate: ['packages/*/src/**/*.ts'],
    reporters: ['clear-text', 'progress', 'html'],
    // Stryker rewrites tsconfig `extends` paths in its sandbox through the TypeScript JS API,
    // which TypeScript 7 no longer ships. Our tsconfigs only point inside the repo, so there is
    // nothing to rewrite: naming a file that doesn't exist turns the rewrite off.
    tsconfigFile: 'no-tsconfig-rewrite.json',
};
