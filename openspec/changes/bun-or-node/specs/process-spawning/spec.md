## ADDED Requirements

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

`spawnProcess` SHALL call the implementation that `chooseSpawner(globalThis)` returns, on every call. Neither implementation SHALL write to stdout or stderr, or signal any process. The scenarios of this capability SHALL hold for `spawnWithNode` on Bun and on Node, and for `spawnWithBun` on Bun.

#### Scenario: The choice
- **WHEN** `chooseSpawner` is given `{ Bun: {} }`, and then `{}`
- **THEN** it returns `spawnWithBun`, and then `spawnWithNode`

#### Scenario: The choice on each runtime
- **WHEN** `chooseSpawner(globalThis)` runs on Bun, and on Node
- **THEN** it returns `spawnWithBun` on Bun, and `spawnWithNode` on Node

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

### Requirement: The process gets only what the caller gives it
The process SHALL run in `cwd`, with exactly the variables in `env`: none of the caller's environment SHALL be added. A program named without a slash SHALL be looked up in `env`'s `PATH`. The process's stdin SHALL be empty, so a read gets end-of-file at once. With `detached`, the process SHALL lead a process group of its own; without it, the process SHALL stay in the caller's group.

#### Scenario: The working directory
- **WHEN** the command is `pwd`, with `cwd` set to a temporary directory
- **THEN** stdout reads the directory's real path

#### Scenario: Only the given environment
- **WHEN** bash lists its environment's names, and `env` holds only `PATH` and `FOO=bar`
- **THEN** the names are `FOO` and `PATH`, plus `PWD`, `SHLVL` and `_`, which bash sets itself

#### Scenario: The program is looked up in the given PATH
- **WHEN** the command is `bash -c 'echo found'`, with `env` holding only `PATH=/nonexistent-gremlin`, and then `/bin/bash -c 'echo found'` with the same `env`
- **THEN** the first result is a failure, and the second prints "found"

#### Scenario: Empty stdin
- **WHEN** the command is `bash -c 'cat; echo done'`
- **THEN** stdout reads "done\n", and `exited` resolves to `{ exitCode: 0, signal: null }`

#### Scenario: A process group of its own
- **WHEN** the command is `bash -c 'ps -o pgid= -p $$'`, with `detached` true, and then with `detached` false
- **THEN** the first prints the process's own pid, and the second the caller's process group

### Requirement: Exits, streams and unref behave the same on both runtimes
`exited` SHALL resolve when the process exits, even while a process it started keeps its stdout open. When a signal ended the process, `exitCode` SHALL be null, and `signal` SHALL be the signal's name, or its number as text when it has no name. Otherwise `signal` SHALL be null. Cancelling a stream SHALL resolve without waiting for the pipe's other end. It SHALL end a pending read, and close the pipe, so the next write to it fails. Once both streams have been cancelled, `unref()` SHALL stop the process from keeping the caller running.

#### Scenario: Ended by a signal
- **WHEN** the command is `bash -c 'kill -TERM $$'`
- **THEN** `exited` resolves to `{ exitCode: null, signal: 'SIGTERM' }`

#### Scenario: A group signalled by the caller
- **WHEN** the command is `bash -c 'sleep 30'`, with `detached` true, and the caller sends SIGTERM to its group with `process.kill(-pid, 'SIGTERM')`
- **THEN** `exited` resolves to `{ exitCode: null, signal: 'SIGTERM' }`

#### Scenario: A background child holds stdout
- **WHEN** the command is `bash -c 'sleep 30 & echo started'`, with `detached` true
- **THEN**:
  - stdout's first chunk reads "started\n";
  - `exited` resolves to `{ exitCode: 0, signal: null }` while the `sleep` still holds stdout;
  - cancelling stdout's reader ends its pending read;
  - a SIGKILL to the group ends the `sleep`

#### Scenario: Cancelling closes the pipe
- **WHEN** the command, detached, prints "started" and leaves a background `node` process that writes to stdout after a delay, and the caller reads "started", then cancels both streams
- **THEN** the background process's write fails with `EPIPE`

#### Scenario: unref lets the caller exit
- **WHEN** a script on the tests' runtime spawns `sleep 5` with `detached` true, cancels both streams, calls `unref()`, and returns
- **THEN** the script's process exits while the `sleep` is still running
