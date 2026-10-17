## MODIFIED Requirements

### Requirement: Spawn a process with the runtime's own API
`@mecha-gremlin/process/spawn` SHALL provide `spawnProcess(argv, { cwd, env, detached })`. `argv` SHALL hold the program, then its arguments, and its type SHALL NOT allow an empty list. `spawnProcess` SHALL resolve to a `Result`:
- when the program starts, a subprocess holding:
  - `pid`;
  - `stdout` and `stderr`, as web `ReadableStream`s of bytes;
  - `exited`, a promise of `{ exitCode, signal }`;
  - `unref()`;
- when it can't start, a failure holding the runtime's message: a thrown `Error`'s message, or any other value's text. Every way a start can fail SHALL come back as a failure, never as a thrown error.

It SHALL use `Bun.spawn` on Bun, and `node:child_process` elsewhere. The module SHALL also export:
- both implementations by name, `spawnWithBun` and `spawnWithNode`;
- `chooseSpawner(globals)`, which returns `spawnWithBun` when `globals.Bun` is defined, and `spawnWithNode` otherwise.

`spawnProcess` SHALL be the implementation that `chooseSpawner(globalThis)` returns, chosen once, when the module loads. Neither implementation SHALL write to stdout or stderr, or signal any process. The scenarios of this capability SHALL hold for `spawnWithNode` on Bun and on Node, and for `spawnWithBun` on Bun.

#### Scenario: The choice
- **WHEN** `chooseSpawner` is given `{ Bun: {} }`, and then `{}`
- **THEN** it returns `spawnWithBun`, and then `spawnWithNode`

#### Scenario: The choice on each runtime
- **WHEN** the module loads on Bun, and on Node
- **THEN** `spawnProcess` is `spawnWithBun` on Bun, and `spawnWithNode` on Node

#### Scenario: spawnProcess runs the chosen implementation
- **WHEN** `spawnProcess` runs `bash -c 'echo out'`
- **THEN** stdout reads "out\n", and `exited` resolves to `{ exitCode: 0, signal: null }`

#### Scenario: Output and exit code
- **WHEN** the command is `bash -c 'echo out; echo err >&2; exit 3'`
- **THEN** stdout reads "out\n", stderr reads "err\n", and `exited` resolves to `{ exitCode: 3, signal: null }`

#### Scenario: A program that isn't found
- **WHEN** the command is `no-such-program-gremlin`
- **THEN** the result is a failure, and nothing is written to stdout or stderr. The message is `Executable not found in $PATH: "no-such-program-gremlin"` on Bun, with either implementation, and `spawn no-such-program-gremlin ENOENT` on Node

#### Scenario: A spawn that throws something other than an error
- **WHEN** `Bun.spawn` throws the string "broken" on Bun
- **THEN** `spawnWithBun`'s result is a failure with the message "broken"

#### Scenario: A working directory that can't be used
- **WHEN** the command is `pwd`, with a `cwd` that doesn't exist, and then with a `cwd` that is a file
- **THEN** both results are failures, and neither call throws
