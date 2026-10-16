## Why

The app runs on Bun, but its tests and mutation testing run on Node: Vitest's and Stryker's command-line tools start Node. So the tests never exercise the runtime production uses, and server code can't use Bun's APIs and still be tested. The next change, `skills-and-shell`, adds a shell whose process control depends on how the runtime spawns and signals processes, which makes the gap matter now. Measured on 2026-10-16, the whole suite and the full mutation run work on Bun with three small workarounds, at the same 100% score.

## What Changes

- **The tests run on Bun.**
  - `bun run test` and `bun run test:watch` start Vitest with Bun as the runtime (`bunx --bun vitest`).
  - Vitest inlines `zod`. Under Bun, Vitest's own import of `zod` comes back without its `z` export.
  - A server test checks that it runs on Bun, so the scripts can't slip back to Node unnoticed.
- **`core`'s tests also run on Node** (`bun run test:node`). `core` is meant to be published and used from Node, and its lint rules already keep `Bun` out of it.
- **Mutation testing runs on Bun,** still failing below 100%:
  - `bun run mutation` starts Stryker under Bun with a small preload. It works around an open Bun bug, oven-sh/bun#41151, which otherwise stops Stryker loading its Vitest runner.
  - Stryker's Vitest runner gets `related: false`, because finding related test files doesn't work under Bun.
- **CI:** the check job also runs `core`'s tests on Node; the mutation job no longer needs Node.
- **README:** where the tests run, the workarounds, and when each can go.
- **Not in this change:** lifting the Vitest 4 pin. Vitest 5.0.5 is out, but Stryker's Vitest runner 10.0.0 still fails on it (stryker-js#6210, open).

## Capabilities

### New Capabilities
- `dev-checks`: the repository's own checks, meaning tests, mutation testing and CI, and which runtime each runs on.

### Modified Capabilities

None.

## Impact

- **Code:**
  - `package.json`'s scripts, `vitest.config.ts` and `stryker.config.mjs`;
  - a new `stryker.preload.ts`;
  - `.github/workflows/ci.yml`;
  - one new server test;
  - the README.
- **Dependencies:** none added.
- **App behaviour:** unchanged. Server code may use Bun's APIs from now on, and they will be tested. `core` stays free of them.
- **Speed:** the full mutation run took 30 s on Bun against 36 s on Node, measured locally.
- **Brief:** R13 records the measurements.
