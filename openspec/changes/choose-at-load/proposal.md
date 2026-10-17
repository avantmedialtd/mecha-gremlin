## Why

`spawnProcess` and `parseYaml` call `chooseSpawner(globalThis)` and `chooseParser(globalThis)` each time they run, which suggests the runtime could change between calls. It can't: Bun defines its global before any module runs, and `globalThis.Bun` is neither writable nor configurable (`bun-or-node`'s design). That design gave a reason for the `globals` parameter, which lets tests reach both branches, but none for choosing on every call, and the parameter serves a choice made once just as well.

## What Changes

- **Chosen once, when the module loads:**
  - `spawnProcess` becomes the implementation that `chooseSpawner(globalThis)` returns;
  - `parseYaml` becomes the one that `chooseParser(globalThis)` returns.

  Callers see no difference: `spawnProcess(argv, options)` and `parseYaml(text)` take and return what they did.
- **`chooseSpawner(globals)` and `chooseParser(globals)` stay,** and their tests still give them `{ Bun: {} }` and `{}`.
- **The test of each runtime's choice checks the export itself:** `spawnProcess` and `parseYaml` must be Bun's implementations on Bun, and the others on Node.
- **The README** says the two packages choose once, when each module loads.
- **Mutation runs take a little longer.** The two choosers now run at import, outside any test, so Stryker counts their 8 mutants as static. Each of those runs against the whole suite after a reload, rather than against the 3 tests that reach it. Every mutant must still be caught.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `process-spawning`: `spawnProcess` is the implementation chosen when the module loads, not a call to the chooser on every call. "The choice on each runtime" checks `spawnProcess`.
- `yaml-parsing`: the same for `parseYaml`.

## Impact

- **Code:**
  - `packages/process/src/spawn.ts` and `packages/yaml/src/parse.ts`, where a `const` replaces each function;
  - one test in each package's tests;
  - the README.
- **Mutation testing:**
  - 8 more static mutants, on top of today's 60;
  - a static mutant stops at its first failing test, and today's ran a median of 25 of the 565;
  - at worst, 8 full runs of the 13.5 s suite add about 2 minutes. CI's last mutation job on `main` took 8 min 51 s, under its 30-minute limit;
  - `stryker.config.mjs` doesn't change.
- **Dependencies:** none.
- **Callers and the Brief:** no change.
