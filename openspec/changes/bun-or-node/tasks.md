## 1. `@mecha-gremlin/yaml` (`yaml-parsing`)

- [ ] 1.1 `packages/yaml`:
  - `package.json`: `@mecha-gremlin/yaml`, version `0.0.0`, a description, `"type": "module"`, exports `"./*": "./src/*.ts"`, and the dependencies `@mecha-gremlin/core` (`workspace:*`) and `yaml` (`^2.9.1`, the newest);
  - `tsconfig.json`, extending the root's like `core`'s.

  Run `bun install`, which updates `bun.lock`.
- [ ] 1.2 `src/parse.ts` (design decisions 2 and 3):
  - `parseYamlWithBun(text)`: `Bun.YAML.parse`;
  - `parseYamlWithPackage(text)`: `parse(text, { logLevel: 'error', uniqueKeys: false, merge: true })` from `yaml`.
    - A comment above the options says why each is there.
    - The `'error'` line carries `// Stryker disable next-line StringLiteral`, and the comment above it says why: `''` behaves the same, because only `'silent'` stops errors.
  - one helper, shared by both, turns what was thrown into the failure's message: an `Error`'s message or any other value's text, its first line, without a trailing colon;
  - `chooseParser(globals)` and `parseYaml(text)`, which calls `chooseParser(globalThis)` on every call.
- [ ] 1.3 `test/parse.test.ts`, covering every `yaml-parsing` scenario:
  - **Each implementation:** the expectations are written once, as a function of the implementation, and run for each. `parseYamlWithBun`'s run sits under `describe.runIf(typeof Bun !== 'undefined')`.
  - **The choice:**
    - `chooseParser({ Bun: {} })` and `chooseParser({})`;
    - one test that runs on both runtimes: `chooseParser(globalThis)` is `typeof Bun === 'undefined' ? parseYamlWithPackage : parseYamlWithBun`;
    - `parseYaml` itself parses a mapping.
  - **Messages:** each implementation's exact first line for `name: [pdf`. A Bun-only test assigns a `Bun.YAML.parse` that throws the string "broken", and restores it afterwards.
  - **The known differences** are pinned for each implementation: several documents, a collection as a key, and the key order of an overridden merge key, through `Object.keys`.
  - **Quiet:** spies on `process.emitWarning`, `process.stdout.write` and `process.stderr.write` show nothing is written.

## 2. `@mecha-gremlin/process` (`process-spawning`)

- [ ] 2.1 `packages/process`:
  - `package.json`: `@mecha-gremlin/process`, version `0.0.0`, a description, `"type": "module"`, exports `"./*": "./src/*.ts"`, and the dependency `@mecha-gremlin/core` (`workspace:*`);
  - `tsconfig.json`, extending the root's.
- [ ] 2.2 `src/spawn.ts` (design decision 4):
  - the types `SpawnOptions` (`cwd`, `env`, `detached`), `Exit` (`exitCode`, and `signal` as text or null) and `Subprocess`;
  - `argv` typed as a non-empty list, the program first;
  - **`spawnWithBun`:** `Bun.spawn([...argv], …)` with stdin `'ignore'` and both outputs piped. A throw becomes the failure. `exited` maps `exitCode`, and `signal` from `signalCode === null ? null : String(signalCode)`;
  - **`spawnWithNode`:** `spawn` from `node:child_process` with stdio `['ignore', 'pipe', 'pipe']`.
    - It resolves on `spawn`, and fails on the first `error` event or a throw from `spawn`.
    - An `error` listener stays for the child's life.
    - `pid` is `Number(child.pid)`.
    - The streams come from `Readable.toWeb`, and `exited` from the `exit` event.
    - `unref()` calls the child's `unref()`.
  - one helper, shared by both, turns what was thrown or emitted into the failure's message: an `Error`'s message, or any other value's text;
  - `chooseSpawner(globals)`, and `spawnProcess(argv, options)`, which calls `chooseSpawner(globalThis)` on every call.
- [ ] 2.3 `test/spawn.test.ts`, covering every `process-spawning` scenario:
  - **Each implementation:** the expectations are written once and run for each, `spawnWithBun`'s under `describe.runIf(typeof Bun !== 'undefined')`.
  - **The choice:**
    - `chooseSpawner({ Bun: {} })` and `chooseSpawner({})`;
    - one test that runs on both runtimes: `chooseSpawner(globalThis)` is `typeof Bun === 'undefined' ? spawnWithNode : spawnWithBun`;
    - `spawnProcess` itself runs `bash -c 'echo out'`.
  - **Messages:** the exact message for a program that isn't found, on each runtime. A Bun-only test assigns a `Bun.spawn` that throws the string "broken", and restores it afterwards.
  - **Cancelling closes the pipe:** a detached command leaves a background `node` process that writes to stdout after a delay and records the error code in a temporary file. The test reads "started", cancels both streams, and expects `EPIPE` in the file.
  - **Group kills:** a helper signals a group only when its id is above 1, it was spawned by the test, and `ps -o pgid= -p <pid>` shows it leading its group. An `afterEach` ends any group a test left running.
  - **Delegation, with spies:** `unref()` calls the Bun subprocess's `unref()`, through a wrapper on `Bun.spawn`, and the child process's, through `ChildProcess.prototype.unref`.
  - **Quiet:** spies on `process.emitWarning`, `process.stdout.write` and `process.stderr.write` show a failed start writes nothing.
- [ ] 2.4 `test/unref-script.ts`, not a test file itself:
  - takes `bun` or `node` as its argument;
  - spawns `sleep 5` with that implementation, with `detached` true;
  - cancels both streams, calls `unref()`, prints the pid, and returns.

  A test runs it with `process.execPath`, so on the tests' own runtime, for each implementation that runtime can run. It expects:
  - the script to exit with 0;
  - the `sleep` to be still running, checked with `process.kill(pid, 0)`.

  It never signals the `sleep` otherwise, and leaves it to end on its own. The `sleep` isn't the test's own child, so `skills-and-shell`'s guard on `process.kill` couldn't vouch for it.

## 3. Lint

- [ ] 3.1 `.oxlintrc.json`: an override for `packages/yaml/src/**` and `packages/process/src/**` that bans `console` and the `process` global.
  - The message for `process` says these packages report only through their results, and a spawned process gets only the environment it's given.
  - If `prefer-readonly-parameter-types` flags Bun's or Node's types, allow them by name, as `bun-types`' are now.

## 4. Tests on both runtimes (`dev-checks`)

- [ ] 4.1 `package.json` scripts:
  - `test`: `TEST_RUNTIME=bun bunx --bun vitest run`;
  - `test:watch`: `TEST_RUNTIME=bun bunx --bun vitest`;
  - `test:node`: `TEST_RUNTIME=node vitest run`, the whole suite;
  - `mutation`: `TEST_RUNTIME=bun bun --bun --preload ./stryker.preload.ts node_modules/.bin/stryker run`;
  - `hello:node`: `node --env-file-if-exists=.env packages/server/src/main/main.ts`.
- [ ] 4.2 `packages/server/test/runtime.test.ts`: the tests run on the runtime `TEST_RUNTIME` names.
  - When `TEST_RUNTIME` is unset or names something else, the test fails, saying to run the tests with `bun run test` or `bun run test:node`.
  - When it names the other runtime, the message names both.
  - Its comment keeps the reason: Vitest's and Stryker's command-line scripts name Node in their shebang, so a script that stops overriding it would quietly change the runtime.
- [ ] 4.3 The test runs:
  - `bun run test` passes, with no test skipped;
  - `bun run test:node` runs every package's tests on Node, reports only the Bun-only tests as skipped, and passes;
  - the runtime test fails with `TEST_RUNTIME` unset (`bunx --bun vitest run packages/server/test/runtime.test.ts`), and with the other runtime's name.
- [ ] 4.4 `bun run mutation` reaches 100%, and the report shows killed mutants in both new packages.

## 5. The server on Node (`model-hello`)

- [ ] 5.1 `packages/server/package.json`: `"engines": { "bun": ">=1.4.3", "node": ">=26" }`
- [ ] 5.2 Try `bun run hello:node`. Never write, move or delete a `.env` in the repository: a developer's own may be there.
  - **No `.env`:** with `MODEL_BASE_URL=http://127.0.0.1:9/v1`:
    - stderr notes that `.env` wasn't found;
    - an `error` record says LM Studio can't be reached;
    - the exit code is 1.

    If the repository has a `.env`, run the same command from an empty temporary directory instead: `node --env-file-if-exists=.env <repository>/packages/server/src/main/main.ts`.
  - **With a `.env`:** in a temporary directory holding a `.env` that sets `MODEL_PROVIDER=nonsense`, run `node --env-file-if-exists=.env <repository>/packages/server/src/main/main.ts`. An `error` record names `MODEL_PROVIDER`, and the exit code is 1.

## 6. CI

- [ ] 6.1 `.github/workflows/ci.yml`:
  - the `NODE_VERSION` comment says Node runs every test again, and starts the hello;
  - the comment on `bun run test:node` says the whole suite runs on Node, since the server runs there too;
  - **a new step after it, "Start the hello on Node":**
    - it runs `bun run hello:node` with `MODEL_BASE_URL=http://127.0.0.1:9/v1`;
    - it keeps the exit code without ending the step, because Actions runs `bash -e`: `status=0; output=$(bun run hello:node 2>&1) || status=$?`;
    - it prints the output, and passes only when `status` is 1 and the output holds "Can't reach LM Studio";
    - its comment says it's the one check that Node's own type stripping loads the server, because the tests go through Vite.

  Push with gh's credential, `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push`, because the keychain's token can't push workflow files.
- [ ] 6.2 CI passes on the branch: both jobs, with the mutation job at 100%

## 7. Docs

- [ ] 7.1 README:
  - **the layout table:** `packages/yaml` and `packages/process`, and what each uses on each runtime. "Neither package has index files" becomes "No package has index files";
  - **Prerequisites:** Node 26 or later, for `bun run hello:node`, `bun run test:node` and so `bun run check`;
  - **Run:** `bun run hello:node`;
  - **Configuration:**
    - on Node, only `.env` is read, through the script's flag. Bun also reads `.env.local`, and a file for `NODE_ENV`;
    - without a `.env`, Node prints ".env not found. Continuing without it." to stderr;
  - **Develop:**
    - `test:node` runs every test, and `TEST_RUNTIME` names the runtime;
    - "Tests run on Bun" becomes "Tests run on Bun and on Node";
    - without Node, Bun stands in for `node`, and the runtime test fails;
    - three disable comments now, not two;
    - the lint override for the two packages;
  - **CI:** Node runs the whole suite, and starts the hello.

## 8. After archiving

- [ ] 8.1 After `openspec archive`, which is the archiving session's step, not the implementer's (design decision 9):
  - replace the placeholder Purposes of `openspec/specs/yaml-parsing/spec.md` and `openspec/specs/process-spawning/spec.md`;
  - move "The tests run on Bun and on Node" to the top of `dev-checks`;
  - add to `model-hello`'s Purpose that the hello runs on Bun or Node;
  - run `openspec validate --all --strict`.
