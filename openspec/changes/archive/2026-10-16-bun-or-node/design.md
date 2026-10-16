## Context

The server runs on Bun, and so do its tests since `tests-on-bun`; `core`'s tests run on Node as well. The next change, `skills-and-shell`, spawns processes and parses skills' YAML frontmatter. Bun has both built in (`Bun.spawn`, `Bun.YAML`); Node has `node:child_process` and needs a package for YAML. Calling Bun's built-ins directly would make the server Bun-only. The user chose to keep it running on both, through one small package per concern.

**Measured on 2026-10-16** (throwaway probes), with Bun 1.4.3, Node 26.11 and `yaml` 2.9.1, the newest:
- **The server already runs on Node.**
  - `node packages/server/src/main/main.ts`, pointed at a closed port, got as far as "Can't reach LM Studio". Node's type stripping handled the workspace's `.ts` imports.
  - `vitest run packages/server` on Node passed 171 of 172 tests. The failure is the runtime test, which asserts Bun.
  - Vitest runs the server's code through Vite's transform, not Node's type stripping, so passing tests on Node don't show that Node itself can load the server.
- **`.env` on Node.**
  - `--env-file-if-exists=.env` reads that one file.
  - When the file is missing, Node prints ".env not found. Continuing without it." to stderr, and carries on.
  - Bun also reads `.env.local`, and `.env.development` or `.env.production` according to `NODE_ENV` (`.env.development` when it's unset).
- **The two YAML parsers.**
  - **Every installed skill:** with the options below, both gave equal values, keys in the same order, for the frontmatter of every skill installed on the development Mac.
  - **They agree on:**
    - an empty text or a comment alone, which give `null`;
    - mappings, sequences and scalars;
    - flow collections with trailing commas;
    - a custom tag such as `!thing`, which gives the text after it;
    - anchors, and quoted values holding colons and backticks;
    - YAML 1.2's scalars: `yes` and `on` stay strings, and so does a date.
  - **With `yaml`'s default options they differ on two plausible inputs:**
    - a key given twice: Bun keeps the last value, `yaml` throws "Map keys must be unique";
    - a merge key `<<`: Bun merges, `yaml` keeps `<<` as a key.

    `uniqueKeys: false` and `merge: true` make `yaml` give the same values as Bun for both.
  - **What still differs:**
    - a text holding several documents: Bun returns an array of them, `yaml` throws;
    - a collection used as a key: Bun gives `a,b`, `yaml` `[ a, b ]`;
    - a key that overrides a merged one: the same values, but Bun lists the overriding key first;
    - the messages. Bun's are one line, such as "YAML Parse error: Unexpected token". `yaml`'s first line ends with the position and a colon, such as "… at line 1, column 11:", and a code frame follows.
  - **Warnings.** With its default options, `yaml` sends warnings, such as an unresolved tag, to `process.emitWarning`, which prints to stderr.
    - `logLevel: 'error'` stops that and still throws on errors, while `'silent'` would stop errors too.
    - Changing `'error'` to `''` makes no observable difference, so that Stryker mutant is equivalent.
    - `Bun.YAML` writes nothing.
  - **Under Vitest on Bun,** `yaml` keeps every export it has on Node, unlike `zod` (R13). The one missing key is CommonJS's `module.exports`.
- **Spawning.** The same checks ran against `Bun.spawn` on Bun, and against `node:child_process` on Bun and on Node. All three paths agreed on these:
  - exit codes;
  - a signal that ends the process, which shows as the signal's name with a null exit code;
  - the environment, which holds only what's passed, plus bash's own `PWD`, `SHLVL` and `_`;
  - the working directory;
  - a program named without a slash, which is looked up in the given environment's `PATH`, or in a default path when the environment has none;
  - stdin: with `'ignore'`, a read gets end-of-file at once;
  - `detached: true`, which makes the process lead a group of its own. Without it, the process stays in the caller's group;
  - a megabyte of output, read whole;
  - **a background child holding stdout:**
    - the exit is reported within 11–26 ms;
    - cancelling the stream resolves at once and ends a pending read;
    - cancelling also closes the pipe, so the child's next write fails with `EPIPE`;
    - a group kill then ends the child.
- **Where spawning differs:**
  - **Messages.** For a program that isn't found:
    - on Bun, with either API: `Executable not found in $PATH: "bash"`;
    - on Node: `spawn bash ENOENT`.

    Both runtimes blame the program when the working directory is missing.
  - **How a failed start is reported.** `Bun.spawn` throws. `node:child_process` mostly emits an `error` event, but throws at once when the working directory is a file, on both runtimes.
  - **What frees the caller.** A `sleep` holding unread pipes kept the runtime running until the `sleep` ended:
    - **on every path:** after `unref()` alone, or after cancelling both streams alone;
    - **on every path, the runtime exited at once:** after cancelling both streams and then calling `unref()`;
    - **with `node:child_process` only:** after `unref()` on the child and on both pipes.
  - **Types.**
    - Bun's `signalCode` is a signal's name, or a number for a signal without one.
    - Node's `child.pid` is typed as possibly undefined. It's set once the `spawn` event has fired.
    - `Bun.spawn` takes a mutable array.
- **The `Bun` global can't be hidden.** `globalThis.Bun` is neither writable nor configurable, so `vi.stubGlobal('Bun', undefined)` throws. `Bun.YAML.parse` and `Bun.spawn` are writable, so tests can wrap them. So are `ChildProcess.prototype`'s methods, `process.emitWarning` and `process.stderr.write`.
- **Export conditions.** Vite 8.3.4 resolves with the conditions `module`, `node` and `development|production`, never `bun`.
- **`engines` isn't enforced by Bun.** A package declaring `"bun": ">=99.0.0"` installed and ran on 1.4.3 without a word.

## Goals / Non-Goals

**Goals:**
- `@mecha-gremlin/yaml` and `@mecha-gremlin/process` use Bun's built-ins on Bun and Node's modules elsewhere, behind one interface each.
- Both implementations of each are tested against the same expectations: the Node fallbacks on Bun and on Node, the Bun ones on Bun.
- The server runs on Bun or Node, and every test runs on both.
- Mutation testing still reaches 100%.

**Non-Goals:**
- **Using the packages.** That's `skills-and-shell`'s job.
- **Choosing an implementation by configuration.** The global object says which runtime this is.
- **Making the parsers agree on every input.** They agree on everything frontmatter uses, and the remaining differences are listed above.
- **Reading every `.env` file Bun reads, on Node.** The README documents only `.env`.
- **Runtimes other than Bun and Node,** and Windows.
- **Mutation testing on Node.** Bun runs both implementations, so every mutant is reachable there.

## Decisions

**1. Two packages, one per concern.**
- **`packages/yaml`** is `@mecha-gremlin/yaml`, with one module, `parse` (`@mecha-gremlin/yaml/parse`).
- **`packages/process`** is `@mecha-gremlin/process`, with one module, `spawn` (`@mecha-gremlin/process/spawn`).
- **Like `core`:**
  - each exposes its modules through `"./*": "./src/*.ts"`, with no index files;
  - each has a `tsconfig.json` that extends the root's;
  - each returns `core`'s `Result`, so each depends on `@mecha-gremlin/core`;
  - the tests sit in `test/` and import their own package's modules by relative path.
- **Dependencies:** `yaml` (`^2.9.1`) in `@mecha-gremlin/yaml` only. `@mecha-gremlin/process` needs nothing outside the workspace.
- **Why two:** a package that only spawns needn't carry `yaml`, and each stays one small concern. Brief 4.2 keeps `core` one package; these are adapters to the runtime, not parts of `core`.
- **Their boundaries are enforced by the linter.** An override in `.oxlintrc.json` bans `console` and the `process` global in both packages' `src`, as it does for `core`. So they report only through their results, and a spawned process gets only the environment it's given.
- **Alternative:** one `runtime` package with both modules. Every user of either would then carry `yaml`.

**2. Each package chooses its implementation from the global object.**
- **Exported by name:**
  - both implementations: `parseYamlWithBun` and `parseYamlWithPackage`, and `spawnWithBun` and `spawnWithNode`;
  - `chooseParser(globals)` and `chooseSpawner(globals)`, which return the Bun implementation when `globals.Bun` is defined, and the other otherwise;
  - `parseYaml` and `spawnProcess`, which call the chosen implementation with `globalThis` on every call.
- **Why a function of the global object:** `globalThis.Bun` can't be hidden on Bun (Context), so a test can't make the real global look like Node's. A test can pass `chooseParser` an object without `Bun` instead, so one test run reaches both branches. That also matters because mutation testing runs only on Bun.
- **Why Node's modules are exported too:** they also run on Bun, so a test run on Bun covers both implementations.
- **Alternatives:**
  - **`typeof Bun` inside `parseYaml`.** On Bun, a mutant that always picks Bun behaves exactly like the code, so it would survive. Only a disable comment would get past that.
  - **Export conditions** (`"bun"` in `package.json`). They choose a file when the module is resolved, so a test run sees one implementation. Which one depends on the resolver: Bun's own applies `bun`, and Vite's doesn't (Context).
  - **A setting.** Nothing needs to choose by hand.

**3. `parseYaml`.**
- **Signature:** `parseYaml(text)` returns `Result<unknown, string>`.
- **On Bun:** `Bun.YAML.parse(text)`. What it throws becomes the failure.
- **Elsewhere:** `parse(text, { logLevel: 'error', uniqueKeys: false, merge: true })` from `yaml`.
  - `logLevel: 'error'` keeps warnings off stderr, and errors still throw. Its equivalent `''` mutant gets a `// Stryker disable next-line StringLiteral` comment, with the reason above it.
  - `uniqueKeys: false` keeps the last of a repeated key, and `merge: true` merges `<<` keys, as Bun does.
- **A failure's message** comes from one helper that both implementations share:
  - it takes what was thrown: an `Error`'s message, or anything else as a string;
  - it keeps the first line, without a trailing colon.

  Sharing it lets either implementation's tests catch its mutants. Bun's message has a colon mid-line, so a mutant that strips the wrong colon fails there. A Bun-only test makes `Bun.YAML.parse` throw a string, which no `Error` check can pass.
- **Where they differ:** several documents in one text, a collection used as a key, the order of a key that overrides a merged one, and the wording of errors. Frontmatter uses none of these, and the tests pin each one's current behaviour, so a change in either parser shows up.

**4. `spawnProcess`: one shape on both runtimes.**
- **Signature:** `spawnProcess(argv, { cwd, env, detached })` resolves to `Result<Subprocess, string>`.
  - `argv` is typed as a non-empty list, the program first.
  - `env` is the whole environment, never merged with the caller's.
- **A `Subprocess` has:**
  - `pid`;
  - `stdout` and `stderr`, as web `ReadableStream<Uint8Array>`s;
  - `exited`, a promise of `{ exitCode, signal }`. When a signal ended the process, `exitCode` is null and `signal` is its name, such as `'SIGTERM'`, or its number as a string when it has no name. Otherwise `signal` is null;
  - `unref()`, which stops the process keeping the caller running once both streams have been cancelled. That's the contract every path meets (Context). Callers that stop reading cancel the streams anyway.

  stdin is always connected to nothing.
- **Cancelling a stream** closes the pipe, so the process's next write to it fails with `EPIPE` (Context).
- **On Bun:** `Bun.spawn([...argv], { cwd, env, detached, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })`.
  - What it throws becomes the failure.
  - `exited` maps Bun's `exited` to `exitCode` and `signal`. `signal` is `proc.signalCode === null ? null : String(proc.signalCode)`.
- **Elsewhere:** `spawn(program, args, { cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'] })` from `node:child_process`.
  - It resolves on the `spawn` event, or fails on the first `error` event or when `spawn` throws.
  - A listener stays on `error` for the child's whole life, so a later error can't crash the caller.
  - `pid` is `Number(child.pid)`, which is set once `spawn` has fired.
  - The streams come from `Readable.toWeb`.
  - `exited` comes from the `exit` event's code and signal. Like Bun's `exited`, that fires when the process exits, before its pipes close.
  - `unref()` calls the child's `unref()`.
- **A failure's message is the runtime's own,** through a helper both implementations share: an `Error`'s message, or anything else as a string.
  - A Bun-only test makes `Bun.spawn` throw a string, which no `Error` check can pass.
  - For a program that isn't found, the tests pin the exact messages: `Executable not found in $PATH: "no-such-program-gremlin"` on Bun, with either implementation, and `spawn no-such-program-gremlin ENOENT` on Node.
  - Both runtimes blame the program when the working directory is missing, so a caller that needs a clear message checks the directory first, as `skills-and-shell`'s runner does.
- **Why it's async:** Node reports most failed starts through an event, and Bun by throwing. Awaiting both makes each a `Result`.
- **No `kill`:** callers signal with `process.kill`, which behaves the same with either implementation, including `process.kill(-pid, …)` for a whole group (R8). The package itself never signals anything.

**5. The server runs on Bun or Node.**
- **Scripts:**
  - `bun run hello` stays on Bun.
  - `bun run hello:node` runs `node --env-file-if-exists=.env packages/server/src/main/main.ts`.
- **`.env` on Node:**
  - the flag reads `.env` and no other file. Bun also reads `.env.local` and a file for `NODE_ENV` (Context), but the README documents only `.env`;
  - without a `.env`, Node prints ".env not found. Continuing without it." to stderr. The README says so.
- **`packages/server/package.json`** gains `"engines": { "bun": ">=1.4.3", "node": ">=26" }`, the versions CI runs. Neither runtime enforces `engines`, but people and tools read it.
- **No start-up check:** the server runs on both. This replaces the Bun-only check `skills-and-shell` had planned.
- **CI starts the hello on Node.**
  - The check job runs `bun run hello:node` with `MODEL_BASE_URL` set to a port where nothing listens.
  - The step passes when the hello exits with 1 and its output holds "Can't reach LM Studio".
  - Actions runs steps with `bash -e`, so the step keeps the exit code without ending: `status=0; output=$(… 2>&1) || status=$?`.
  - It's the one check that Node's own type stripping can load the server, because the tests go through Vite (Context).

**6. Every test runs on both runtimes.**
- **Scripts:**
  - `test` becomes `TEST_RUNTIME=bun bunx --bun vitest run`, and `test:watch` likewise;
  - `test:node` becomes `TEST_RUNTIME=node vitest run`, the whole suite;
  - `mutation` sets `TEST_RUNTIME=bun` before its command;
  - `check` runs both test scripts, as now. It now needs Node 26: without it, Bun stands in for `node`, and the runtime test fails.
- **The runtime test** fails unless the tests run on the runtime `TEST_RUNTIME` names, and its message names both. It also fails when `TEST_RUNTIME` is unset or names something else, telling the reader to run the tests with `bun run test` or `bun run test:node`. A script that slipped to the other runtime is caught either way.
- **The same expectations for each implementation.** Each package's test file defines its expectations once, as a function of the implementation, and runs them for each. Bun's implementation runs under `describe.runIf(typeof Bun !== 'undefined')`, so Node's run reports those tests as skipped.
- **The choice:**
  - plain objects reach both branches: `chooseParser({})` and `chooseParser({ Bun: {} })`;
  - one test, which runs on both runtimes, checks what `globalThis` chooses: `typeof Bun === 'undefined' ? parseYamlWithPackage : parseYamlWithBun`;
  - `parseYaml` and `spawnProcess` themselves each run once, so their own mutants are caught.
- **Delegation is checked with spies,** where the outcome alone can't show it: `unref()` calling the runtime's own. `Bun.spawn` is writable, and `ChildProcess.prototype.unref` is a plain method.
- **`unref()` is also checked for real.**
  - A small script under `test/` runs on the test's own runtime, `process.execPath`.
  - It spawns `sleep 5`, detached, cancels both streams, calls `unref()`, prints the pid, and returns.
  - The test expects the script to exit while the `sleep` is still running, checked with signal 0. It leaves the `sleep` to end on its own.
  - It never signals the `sleep`. The `sleep` belongs to the script, not to the test, so `skills-and-shell`'s guard on `process.kill` couldn't vouch for it.
- **Group kills in tests.** A test sends a group signal only to a process it spawned itself, after checking that the process leads the group. A mutant can then never signal anyone else's group, or the test runner's.
- **Quiet output.** Both packages' tests spy on `process.emitWarning`, `process.stdout.write` and `process.stderr.write`. The spies can't see Bun's own native writes; `emitWarning` is the one `yaml`'s warnings use, and the lint override keeps `console` out.
- **Mutation testing** stays on Bun. Both implementations and both branches of each choice run there.
- **CI:** the check job already runs both scripts. Its comments change: Node runs the whole suite now, not only `core`'s tests.

**7. README.** It covers:
- running on Node with `bun run hello:node`, which reads `.env` only, and the stderr line without one;
- the tests running on both runtimes, with `TEST_RUNTIME`, and `check` needing Node 26;
- the two packages, and what each uses on each runtime;
- the layout table, "No package has index files", and the CI section.

**8. Brief,** updated with this proposal:
- **R14** records the measurements above.
- **D19** records the choice: the server runs on Bun or Node, through the two packages. The recommendation had been Bun only, declared and checked at start-up.
- **3.0, and Part 1's ▸ line,** say the runtime decision has been widened.
- **4.2's layout** lists the two packages.

**9. When archiving.** OpenSpec gives new specs a placeholder Purpose and appends added requirements at the end, so:
- **`yaml-parsing`'s Purpose:** "`@mecha-gremlin/yaml`: parsing YAML with Bun's built-in parser on Bun and the `yaml` package elsewhere, and where the two agree."
- **`process-spawning`'s Purpose:** "`@mecha-gremlin/process`: spawning a process with `Bun.spawn` on Bun and `node:child_process` elsewhere, in one shape."
- **`dev-checks`:** "The tests run on Bun and on Node" moves back to the top, above mutation testing.
- **`model-hello`'s Purpose** adds that the hello runs on Bun or Node.

## Risks / Trade-offs

- **Two implementations can drift,** whether through a new Bun release or a new `yaml`. → Both run the same expectations, the Node fallback on Bun and on Node. The parsers' known differences and the exact messages are pinned, so a change in either shows up as a failing test.
- **Node's type stripping is fairly new.** → CI starts the hello on Node on every push.
- **Web streams from `Readable.toWeb` may differ from Bun's in edge cases.** → The shared expectations cover reading, cancelling, a closed pipe, and a pipe held by a background child.
- **`.env` differs between runtimes:** Node reads `.env` only. → The README says so.
- **The tests take twice as long.** → Each run takes a few seconds.
- **The `unref()` test spawns a runtime.** That takes about 50 ms on Bun and 300 ms on Node. → It's one test per implementation.

## Migration Plan

- `bun run hello` and `bun run test` behave as before.
- `bun run hello:node` is new, and `bun run test:node` now runs every test.
- `bun run check` now needs Node 26. Without it, `test:node` fails, because Bun stands in for `node`.
- Rolling back means reverting the change.

## Open Questions

None.
