## ADDED Requirements

### Requirement: Write to a process's stdin
With `stdin: 'pipe'`, the subprocess's `stdin` SHALL be a web `WritableStream` of bytes:
- a write SHALL resolve once the pipe has taken the bytes, and SHALL wait while the pipe is full;
- closing it SHALL give the process end-of-file, and SHALL resolve even when the process has exited;
- aborting it SHALL close the pipe at once;
- once the process has exited, whether by a signal or not, or has closed its stdin, every write SHALL fail with an error whose `code` is `EPIPE`;
- no error SHALL escape the promise of the write or close that caused it;
- an idle pipe SHALL NOT keep the caller running once both output streams are cancelled and `unref()` is called.

#### Scenario: Written and read
- **WHEN** `cat` is spawned with `stdin` `'pipe'`, and the caller writes "hi\n" and closes stdin
- **THEN** stdout reads "hi\n", and `exited` resolves to `{ exitCode: 0, signal: null }`

#### Scenario: A write waits while the pipe is full
- **WHEN** a process sleeps for a second before it reads its stdin, and the caller writes 4 MiB at once
- **THEN** the write hasn't resolved before the process starts reading, and all 4 MiB arrive

#### Scenario: Closing after the exit
- **WHEN** the process has exited, and the caller closes stdin
- **THEN** the close resolves

#### Scenario: Aborting
- **WHEN** the caller aborts stdin while the process is waiting to read
- **THEN** the process reads end-of-file at once

#### Scenario: A write after the exit
- **WHEN** the process has exited, and the caller writes twice
- **THEN** both writes fail with an error whose `code` is `EPIPE`

#### Scenario: A write after a signal
- **WHEN** the process was ended by SIGTERM, and the caller writes
- **THEN** the write fails with an error whose `code` is `EPIPE`

#### Scenario: A process that closed its stdin
- **WHEN** the process closes its stdin and keeps running, and the caller writes
- **THEN** the write fails with an error whose `code` is `EPIPE`

#### Scenario: Nothing escapes
- **WHEN** writes fail after the process has exited
- **THEN** no uncaught exception or unhandled rejection occurs

#### Scenario: An idle pipe and unref
- **WHEN** a script on the tests' runtime spawns `sleep 5` with `detached` true and `stdin` `'pipe'`, cancels both output streams, calls `unref()`, and returns
- **THEN** the script's process exits while the `sleep` is still running

## MODIFIED Requirements

### Requirement: Spawn a process with the runtime's own API
`@mecha-gremlin/process/spawn` SHALL provide `spawnProcess(argv, { cwd, env, detached, stdin })`, where `stdin` is `'ignore'` or `'pipe'`. `argv` SHALL hold the program, then its arguments, and its type SHALL NOT allow an empty list. `spawnProcess` SHALL resolve to a `Result`:
- when the program starts, a subprocess holding:
  - `pid`;
  - `stdin`: with `'pipe'`, a web `WritableStream` of bytes, and with `'ignore'`, `undefined`;
  - `stdout` and `stderr`, as web `ReadableStream`s of bytes;
  - `exited`, a promise of `{ exitCode, signal }`;
  - `unref()`;
- when it can't start, a failure holding the runtime's message: a thrown `Error`'s message, or any other value's text. Every way a start can fail SHALL come back as a failure, never as a thrown error.

It SHALL use `Bun.spawn` on Bun, and `node:child_process` elsewhere. The module SHALL also export:
- both implementations by name, `spawnWithBun` and `spawnWithNode`;
- `chooseSpawner(globals)`, which returns `spawnWithBun` when `globals.Bun` is defined, and `spawnWithNode` otherwise.

`spawnProcess` SHALL be the implementation that `chooseSpawner(globalThis)` returns, chosen once, when the module loads. Neither implementation SHALL write to stdout or stderr, or signal any process. The scenarios of this capability SHALL hold for `spawnWithNode` on Bun and on Node, and for `spawnWithBun` on Bun. The one exception is "A process that closed its stdin", which SHALL hold for `spawnWithNode` on Node and for `spawnWithBun` on Bun: on Bun, `node:child_process` drops those writes without an error.

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

### Requirement: The process gets only what the caller gives it
The process SHALL run in `cwd`, with exactly the variables in `env`: none of the caller's environment SHALL be added. A program named without a slash SHALL be looked up in `env`'s `PATH`. With `stdin: 'ignore'`, the process's stdin SHALL be empty, so a read gets end-of-file at once; with `'pipe'`, it SHALL read what the caller writes ("Write to a process's stdin"). With `detached`, the process SHALL lead a process group of its own; without it, the process SHALL stay in the caller's group.

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
- **WHEN** the command is `bash -c 'cat; echo done'`, with `stdin` `'ignore'`
- **THEN** stdout reads "done\n", and `exited` resolves to `{ exitCode: 0, signal: null }`

#### Scenario: A process group of its own
- **WHEN** the command is `bash -c 'ps -o pgid= -p $$'`, with `detached` true, and then with `detached` false
- **THEN** the first prints the process's own pid, and the second the caller's process group
