## Context

`bun run test` runs `vitest run`, and `bun run mutation` runs `stryker run`. Both tools' command-line scripts start with `#!/usr/bin/env node`, so the tests run on Node, today Node 26.11, while the app runs on Bun 1.4.3. CI installs Node only for them. The README says so: "Tests run on Node … so Bun-specific behaviour needs checks run with bun itself".

**Measured on 2026-10-16** (throwaway probes in a worktree, since removed):
- **Vitest under Bun** (`bunx --bun vitest run`): the tests ran on Bun 1.4.3, by `process.versions.bun`. 55 tests in 3 server files failed, all with the same error, `z.strictObject` undefined.
  - Under Bun, Vitest's externalised import of `zod` came back with 258 exports instead of 260: everything but `z` itself.
  - Plain Bun imports `zod` with all 260.
- **Inlining `zod`** (`server.deps.inline: ['zod']`) makes Vite transform it instead. All 228 tests then pass on Bun.
- **Stryker under Bun** failed to load its Vitest runner: "First argument must be an Error object".
  - Stryker loads Babel 8, whose `rewrite-stack-trace.js` wraps `Error.prepareStackTrace` around Bun's native one.
  - Vite's bundled `CustomError` calls `Error.captureStackTrace` on an object that isn't an `Error`. V8 accepts that, but Bun's native function throws. This is oven-sh/bun#41151, open.
  - Importing the runner in a fresh Bun process works. It fails only after Stryker's core has loaded.
- **A preload** that sets a lenient `Error.prepareStackTrace` before anything else (`bun --bun --preload <file> …/stryker run`) lets the runner load, in Stryker's process and in the test-runner processes it forks.
- **Related tests:** Stryker's Vitest runner then found no "test files related to mutated files", so no tests ran. With `vitest: { related: false }` the dry run passes.
- **The full mutation run on Bun** instrumented 879 mutants: 871 killed, 4 timed out, 0 survived, a 100% score in 30 s. Every test run logged Bun 1.4.3. The same run on Node scores 100% (870 killed, 5 timed out) in 36 s.
- **A trap worth recording:** a Vitest config with an absolute `root` points Stryker's sandbox back at the original, unmutated files. Every mutant then "survives", and the score reads 0% while everything appears to work. The Vitest 5 failure (stryker-js#6210) looks the same.

## Goals / Non-Goals

**Goals:**
- `bun run test` runs every test on Bun, the runtime production uses.
- `core`'s tests also run on Node, locally and in CI.
- `bun run mutation` runs on Bun and still fails below 100%.
- Each workaround is written down where it's applied, with the condition for removing it.

**Non-Goals:**
- **Moving to `bun test`.** It's a different runner, every test would need rewriting, and Stryker has no runner for it with per-test coverage.
- **Lifting the Vitest 4 pin.** stryker-js#6210 is still open.
- **Using Bun's APIs in the server.** That's now possible and tested, but no code changes here.

## Decisions

**1. The tests run on Bun.**
- `test` becomes `bunx --bun vitest run`, and `test:watch` becomes `bunx --bun vitest`. `--bun` makes Bun run a script that names Node in its shebang.
- `vitest.config.ts` adds `server: { deps: { inline: ['zod'] } }`. Under Bun, Vitest's externalised import of `zod` loses its `z` export. If another package is hit the same way, it joins the list.
- **A guard test in the server** checks that `process.versions.bun` is set, so a script that slipped back to Node fails at once. It runs in the mutation run's tests too.
- **Alternatives:**
  - `import * as z from 'zod'` everywhere, the style zod 4's own documentation uses. It avoids the config line but fixes only `zod`, and a later `import { z }` would break only under Bun.
  - Leaving the tests on Node. Then the next change's process-control tests would run on a runtime production doesn't use.

**2. `core`'s tests also run on Node.**
- A `test:node` script runs `vitest run packages/core`, which starts on Node through Vitest's own shebang.
- `check` runs it after `test`, and so does CI's check job.
- **Why:** `core` is meant to be published and used from Node, and its lint override already keeps `process`, `Bun` and `console` out of it. Running its tests on Node keeps that promise checked.
- **Only `core`:** the server runs on Bun only, so it doesn't need to work on Node.

**3. Mutation testing runs on Bun.**
- `mutation` becomes `bun --bun --preload ./stryker.preload.ts node_modules/.bin/stryker run`.
- **`stryker.preload.ts`** sets `Error.prepareStackTrace` to a function that formats any object, as V8's does. Babel's wrapper then delegates to it rather than to Bun's native one. Its comment cites oven-sh/bun#41151 and says to remove the file, and the flag, once that is fixed.
  - Only the mutation script loads it, never the app.
  - Forked test-runner processes get it as well; the probe saw them load the runner.
- **`stryker.config.mjs`** adds `related: false` to its `vitest` options, with a comment: under Bun, the runner finds no related test files, so no test would run. With per-test coverage, Stryker still runs only the tests that reach each mutant. Only the dry run runs everything, about a second.
- **Unchanged:** the 100% threshold, per-test coverage and the plugin path.
- **Checking it works:** a run must report killed mutants, not just a passing exit. A 0% score with everything "survived" means the tests ran against unmutated files.

**4. CI.**
- **Check job:** `bun run test` now runs on Bun, and a new step runs `bun run test:node`, which keeps `actions/setup-node`.
- **The `NODE_VERSION` comment** says Node is there for `core`'s tests.
- **Mutation job:** drops `setup-node`. With `--bun`, Bun stands in for `node` for the scripts it starts.
- **Pushing:** a change to `.github/workflows/` must be pushed with gh's credential (`git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push`), because the keychain's token lacks the `workflow` scope.

**5. README.**
- The "Tests run on Node" note becomes "Tests run on Bun". It covers `test:node` for `core`, and the three workarounds:
  - the `zod` inline;
  - the Stryker preload, until bun#41151 is fixed;
  - `related: false`.

  Each comes with the condition for removing it.
- The CI section names the runtime each job uses.

## Risks / Trade-offs

- **Vitest doesn't officially support Bun as its runtime.** A Vitest or Bun release could break it. → CI runs on every push, and the app's code stays Node-compatible unless a later change decides otherwise, so going back would only mean reverting the scripts.
- **The preload works around a Bun bug.** → It's written down with the issue number, and loaded only by the mutation script.
- **Server tests no longer run on Node.** → The server runs only on Bun, and `core`, which must run on Node, still does.
- **The `zod` workaround could hide a broader Bun interop problem.** → A failing import shows up as a failing test, and the inline list is the place to extend.

## Migration Plan

Developers run the same commands: `bun run test`, `bun run check` and `bun run mutation`. `bun run test:node` is new. Rolling back means reverting the change.

## Open Questions

None. When bun#41151 is fixed, the preload goes. When stryker-js#6210 is fixed, Vitest's pin goes. These are independent of each other.
