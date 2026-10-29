// Mutation testing with Stryker, through its Vitest runner. With per-test coverage, each
// mutant runs only the tests that reach it, and the report shows which test killed it.

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
    // Stryker looks for its plugins next to its own package, but Bun's isolated installs keep
    // them apart; resolving the runner from the project root works with any install layout.
    plugins: [import.meta.resolve('@stryker-mutator/vitest-runner')],
    testRunner: 'vitest',
    // Under Bun, the runner finds no test files related to the mutated files, so no test would
    // run; this can go once it does. Per-test coverage still picks the tests each mutant runs.
    // The dry run runs every test, including the agent's runtime test, which imports no source.
    vitest: { configFile: 'vitest.config.ts', related: false },
    coverageAnalysis: 'perTest',
    mutate: ['packages/*/src/**/*.ts'],
    reporters: ['clear-text', 'progress', 'html'],
    // Every mutant must be caught. Only an equivalent or unreachable one may be disabled, with a
    // `// Stryker disable next-line` comment that says why.
    thresholds: { break: 100 },
    // Stryker rewrites tsconfig `extends` paths in its sandbox through the TypeScript JS API,
    // which TypeScript 7 no longer ships. Our tsconfigs only point inside the repo, so there is
    // nothing to rewrite: naming a file that doesn't exist turns the rewrite off.
    tsconfigFile: 'no-tsconfig-rewrite.json',
};
