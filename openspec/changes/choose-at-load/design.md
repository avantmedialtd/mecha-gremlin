## Context

- **Today,** `spawnProcess` and `parseYaml` call `chooseSpawner(globalThis)` and `chooseParser(globalThis)` each time they run. `bun-or-node`'s decision 2 gave the reason for the `globals` parameter: `globalThis.Bun` can't be hidden on Bun, so tests pass `{ Bun: {} }` and `{}` to reach both branches in one run, and mutation testing runs only on Bun. It gave no reason for choosing on every call.
- **The answer can't change while the process runs.** Bun defines its global before any module runs, and `globalThis.Bun` is neither writable nor configurable (`bun-or-node`'s Context).
- **These two packages** hold the only code that chooses by runtime.

**Measured on 2026-10-17:**
- **Stryker 10.0.0's planner** (`@stryker-mutator/core`, `mutant-test-planner.js`):
  - a mutant that runs outside any test, as during an import, is static. One that tests reach as well is hybrid, and is planned like a static one;
  - with `ignoreStatic` off, as in `stryker.config.mjs`, a static mutant runs against the whole suite, after a reload, and is never hot-swapped;
  - with `ignoreStatic` on, a purely static mutant is ignored, and a hybrid one runs only the tests that reach it, active only while they run.
- **Stryker's Vitest runner** declares `reloadEnvironment: true`, so a static mutant's modules load again with the mutant active.
- **CI's last mutation report on `main`** (run 38972435967):
  - 1724 mutants, 60 of them static: 5 purely static and 55 hybrid;
  - a static mutant ran a median of 25 of the 565 tests before one failed, and any other mutant a median of 1;
  - each chooser has four mutants: the emptied body, the condition forced to `true` and to `false`, and `!==` for `===`. Each is reached by 3 tests and caught by the first;
  - each export's body has one mutant, the emptied body, caught by the one test that reaches it;
  - the job took 8 min 51 s, and its limit is 30 minutes.
- **The suite:** `bun run test` runs 565 tests in 13.5 s.
- **OpenSpec 1.6.0** won't archive a MODIFIED requirement that leaves out a scenario of the current spec (`specs-apply.js`). A MODIFIED block can change a scenario's steps, but can't drop or retitle the scenario. `hello-to-server`'s design found the retitling half.

## Goals / Non-Goals

**Goals:**
- `spawnProcess` and `parseYaml` are the chosen implementations themselves, chosen once, when their modules load.
- One test run on Bun still reaches both branches of each chooser.
- Mutation testing stays at 100%, with `stryker.config.mjs` unchanged.

**Non-Goals:**
- **Changing what callers see.** Both exports keep their signatures and results.
- **Keeping mutation runs exactly as long.** The 8 new static mutants cost a little (Risks).

## Decisions

**1. Each export is its implementation, chosen when the module loads.**
- **`spawn.ts`:** `export const spawnProcess: Spawner = chooseSpawner(globalThis);` replaces the `spawnProcess` function, after `chooseSpawner`.
- **`parse.ts`:** `export const parseYaml: Parser = chooseParser(globalThis);` replaces the `parseYaml` function, after `chooseParser`.
- **The annotations** name the types callers get, as the functions' parameter and return types did.
- **Comments:** the one above each chooser still holds, and the new lines need none.
- **Alternatives:**
  - **Keep choosing on every call, with a comment saying why.** Mutation runs stay a little shorter, but the code keeps suggesting that the runtime can change between calls.
  - **A `typeof Bun` check at the top level.** On Bun, a mutant that always picks Bun's implementation would behave exactly like the code, and survive. `bun-or-node` rejected the same check inside the function for this reason. Calling the chooser keeps both of its branches within a test's reach.
  - **Choosing on the first call and keeping the result.** The chooser would then run inside a test, and its mutants wouldn't be static, but the module would gain state, and a mutant of its own, to save a few tests per mutation run.

**2. The tests.**
- **"this runtime's global object"** keeps its name in both packages, and checks the export itself:
  - `expect(spawnProcess).toBe(typeof Bun === 'undefined' ? spawnWithNode : spawnWithBun)`;
  - `expect(parseYaml).toBe(typeof Bun === 'undefined' ? parseYamlWithPackage : parseYamlWithBun)`.

  The expected implementation still comes from `typeof Bun`, not from the chooser.
- **Unchanged:**
  - the tests that give the choosers `{ Bun: {} }` and `{}`;
  - "spawnProcess runs the chosen implementation" and "parseYaml parses with the chosen parser". Calling each export still spawns and parses for real, and the specs keep those scenarios (decision 4).

**3. Mutation testing.**
- **The choosers' 8 mutants become hybrid:** they run at import, and in the chooser tests. Each runs against the whole suite after a reload, until a test fails. The chooser tests call the choosers directly, so they still catch all 8.
- **The exports' 2 mutants go,** since the `const` lines hold none.
- **`ignoreStatic` stays off.** Turning it on would let the hybrid mutants run only the tests that reach them, but would ignore the 5 purely static mutants, which are tested today. An ignored mutant doesn't count against the score, so the 100% threshold would no longer mean that every mutant was caught.

**4. The spec deltas.** Both are MODIFIED, so each requirement keeps its place, and nothing needs reordering after archiving:
- **`process-spawning`,** "Spawn a process with the runtime's own API": `spawnProcess` SHALL be the implementation that `chooseSpawner(globalThis)` returns, chosen once, when the module loads, where it called that implementation on every call. "The choice on each runtime" checks `spawnProcess`, where it checked `chooseSpawner(globalThis)`.
- **`yaml-parsing`,** "Parse YAML with the runtime's own parser": the same, with `parseYaml` and `chooseParser`.
- **Every other scenario** keeps its title and steps. OpenSpec couldn't drop one from a MODIFIED block anyway (Context), and "spawnProcess runs the chosen implementation" and "A mapping" still hold.

**5. The README.** "`yaml` and `process` choose their implementation on every call, from the global object" becomes "`yaml` and `process` choose their implementation once, when each module loads, from the global object".

## Risks / Trade-offs

- **[Mutation runs take longer]** → The 8 new static mutants join 60. Today's static mutants run a median of 25 tests before one fails, so the 8 should cost well under 8 full runs; at worst, 8 runs of the 13.5 s suite add about 2 minutes. The verification records the static count and the run's duration.
- **[A static mutant survives]** → Each of the 8 changes what a chooser returns for `{ Bun: {} }` or `{}`, and the chooser tests call the choosers directly, whatever the modules loaded with.
