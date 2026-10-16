## Why

The next change, `skills-and-shell`, needs two things Bun has built in and Node doesn't: spawning processes (`Bun.spawn`) and parsing YAML (`Bun.YAML`). Calling them directly would tie the server to Bun. Instead, two small packages each use Bun's built-in on Bun and fall back to Node's modules elsewhere, and the server keeps running on both.

Measured on 2026-10-16:
- the hello already starts on Node 26.11;
- 171 of the server's 172 tests pass there. The one failure is the Bun-only runtime test from `tests-on-bun`.

## What Changes

- **`@mecha-gremlin/yaml`** (new package): `parseYaml(text)` returns a `Result` with the parsed value, or the parser's message.
  - On Bun it uses `Bun.YAML`. Elsewhere it uses the `yaml` package, with its warnings kept off stderr. Like Bun, it keeps the last of a repeated key and merges `<<` keys.
  - The two agree on everything frontmatter uses, and gave equal values for every skill installed on the development Mac. Their remaining differences are pinned by tests: several documents in one text, a collection used as a key, and the key order when a key overrides a merged one.
  - Its only dependency outside the workspace is `yaml`.
- **`@mecha-gremlin/process`** (new package): `spawnProcess(argv, options)` resolves to a `Result` holding the same shape on both runtimes:
  - the pid;
  - stdout and stderr as web streams;
  - an `exited` promise with the exit code or the signal;
  - `unref()`.

  stdin is always connected to nothing, and cancelling a stream closes its pipe. On Bun it uses `Bun.spawn`, elsewhere `node:child_process`. Every failed start comes back as a failure, never a thrown error. It needs no dependency outside the workspace.
- **Both packages:**
  - export both implementations by name, so the tests cover each on the runtime that has it;
  - choose one on every call, from the global object, through a function that tests can give any object;
  - never write to stdout or stderr.
- **The server runs on Bun or Node:**
  - `bun run hello` runs it on Bun, as now;
  - the new `bun run hello:node` runs it on Node, loading `.env`. Bun also reads `.env.local` and a file for `NODE_ENV`; on Node only `.env` is read;
  - `packages/server/package.json` declares both runtimes in `engines`.
- **Every test runs on both runtimes:**
  - `bun run test` runs on Bun, and `bun run test:node` now runs the whole suite on Node;
  - tests of a Bun-only implementation are skipped on Node;
  - each script names its runtime in `TEST_RUNTIME`, and the runtime test fails unless the tests run there;
  - mutation testing stays on Bun, where both implementations can run;
  - `bun run check` now needs Node 26.
- **CI:**
  - the Node step now runs the whole suite;
  - a new step starts the hello on Node against a closed port. The tests go through Vite, so this is the one check that Node's own type stripping loads the server.
- **README:** running on Node, and the two packages.
- **Not in this change:**
  - using the packages, which `skills-and-shell` does;
  - a check that refuses other runtimes, since the server now runs on both.

## Capabilities

### New Capabilities
- `yaml-parsing`: `@mecha-gremlin/yaml`, and which parser it uses on each runtime.
- `process-spawning`: `@mecha-gremlin/process`, the shape it gives a spawned process on both runtimes, and which implementation it uses.

### Modified Capabilities
- `dev-checks`:
  - every test runs on Bun and on Node, not only `core`'s;
  - the runtime test checks the runtime each script names;
  - mutation testing sets that name too.
- `model-hello`: the hello runs on Node too, with `bun run hello:node`, and CI starts it there.

## Impact

- **Code:**
  - two new packages, `packages/yaml` and `packages/process`, each with its own `package.json` and tests;
  - the root scripts;
  - `packages/server/package.json`'s `engines`;
  - the runtime test;
  - `.oxlintrc.json`, to keep `console` and the `process` global out of the new packages;
  - the CI workflow: its comments, and the step that starts the hello on Node;
  - the README;
  - `bun.lock`.
- **Dependencies:** `yaml` 2.9 (the newest), in `@mecha-gremlin/yaml` only.
- **Brief:**
  - R14 records the measurements, and D19 the choice to support both runtimes;
  - 3.0 and Part 1's ▸ line say the runtime decision has been widened;
  - 4.2's layout lists the two packages.
- **`skills-and-shell`** builds on this change. It uses the two packages instead of calling `Bun.YAML` and `Bun.spawn` itself, and drops its planned Bun-only start-up check.
