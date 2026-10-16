## 1. The tests run on Bun (`dev-checks`)

- [ ] 1.1 `vitest.config.ts`: add `server: { deps: { inline: ['zod'] } }`, with a comment saying why: under Bun, Vitest's own import of `zod` comes back without its `z` export
- [ ] 1.2 `package.json`:
  - `test` becomes `bunx --bun vitest run`, and `test:watch` becomes `bunx --bun vitest`;
  - add `test:node`, `vitest run packages/core`;
  - `check` runs `test:node` after `test`.
- [ ] 1.3 A server test that fails unless `process.versions.bun` is set, with a message saying the tests must run on Bun. Put it where the server's tests live (for example `packages/server/test/runtime.test.ts`)
- [ ] 1.4 `bun run test` passes, and the runtime test with it. `bun run test:node` runs only `core`'s tests, on Node, and passes

## 2. Mutation testing runs on Bun (`dev-checks`)

- [ ] 2.1 `stryker.preload.ts`: sets `Error.prepareStackTrace` to a function that formats any object, not only an `Error`. Its comment says:
  - Babel 8's stack-trace rewriter, which Stryker loads, wraps Bun's native `prepareStackTrace`;
  - Vite calls `Error.captureStackTrace` on objects that aren't errors, and Bun's native function throws for those (oven-sh/bun#41151);
  - remove this file, and the `--preload` flag, once that issue is fixed.

  It passes format, lint and type-check.
- [ ] 2.2 `stryker.config.mjs`: add `related: false` to the `vitest` options, with a comment: under Bun the runner finds no related test files, so no test would run; per-test coverage still picks each mutant's tests
- [ ] 2.3 `package.json`: `mutation` becomes `bun --bun --preload ./stryker.preload.ts node_modules/.bin/stryker run`. A shorter form is fine if it loads the preload the same way
- [ ] 2.4 `bun run mutation` reaches 100%, and the report shows killed mutants, not only a passing run (about 879 mutants, measured on 2026-10-16). Check also that a mutant surviving fails the run: for example, run once in a scratch copy with one test removed

## 3. CI

- [ ] 3.1 `.github/workflows/ci.yml`:
  - the check job runs `bun run test:node` after `bun run test`;
  - the `NODE_VERSION` comment says Node is there for `core`'s tests;
  - the mutation job drops `actions/setup-node`.

  Push with gh's credential, `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push`, because the keychain's token can't push workflow files.
- [ ] 3.2 CI passes on the branch: both jobs, with the mutation job at 100%

## 4. Docs

- [ ] 4.1 README:
  - "Tests run on Bun", replacing "Tests run on Node";
  - `bun run test:node` for `core`;
  - the three workarounds (the `zod` inline, the Stryker preload, `related: false`), each with when it can go;
  - the CI section's runtimes;
  - the note that Vitest stays on 4.x until stryker-js#6210 is fixed.
