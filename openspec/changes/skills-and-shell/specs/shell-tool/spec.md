## ADDED Requirements

### Requirement: Run a command with bash in the working directory
The server SHALL provide a `shell` tool, created for a working directory, a run ID and its limits: a timeout, a grace period, a pipe wait and an output cap, by default 120 seconds, 2 seconds, 1 second and 32 KiB. Its arguments SHALL be exactly one required string, `command`, and no other property SHALL be allowed. It SHALL run the command with `bash -c`, in the working directory, in a process group of its own, with stdin connected to nothing, so that reading it gives end-of-file at once.

#### Scenario: The model sees a closed schema
- **WHEN** `shell` is converted with `toFunctionTool`
- **THEN** its parameters require a string `command` and set `additionalProperties` to false

#### Scenario: Runs in the working directory
- **WHEN** `shell` is called with `{"command":"pwd"}`
- **THEN** stdout is the working directory's real path

#### Scenario: No input
- **WHEN** the command is `cat; echo done`
- **THEN** it succeeds with "exit code: 0" and stdout "done", without timing out

### Requirement: Report the exit code and both streams
When bash ran, the outcome SHALL succeed, whatever the exit code. Its text SHALL be, in order:
1. `exit code: N`, or `killed by` and the signal's name, such as `killed by SIGTERM`, when a signal ended bash;
2. `timed out after N s`, with N the timeout in seconds, when the timeout fired;
3. `stdout:` and the captured stdout, when it isn't empty;
4. `stderr:` and the captured stderr, when it isn't empty;
5. `(no output)`, when both streams are empty;
6. when either stream was cut, a line saying how to see the rest: write the output to a file in the working directory, then search it with `grep`, or print the part needed with `sed -n` or `tail -c`, because `read_file` shows only a file's first 32 KiB.

The outcome SHALL fail only when bash can't be started, or when the shell has been closed. When the working directory no longer exists, the error SHALL name it and say so.

#### Scenario: Success
- **WHEN** the command is `echo hi`
- **THEN** it succeeds with "exit code: 0", then "stdout:" and "hi"

#### Scenario: A failing command
- **WHEN** the command is `echo oops >&2; exit 3`
- **THEN** it succeeds with "exit code: 3", then "stderr:" and "oops"

#### Scenario: No output
- **WHEN** the command is `true`
- **THEN** it succeeds with "exit code: 0" and "(no output)"

#### Scenario: Ended by a signal
- **WHEN** the command is `kill -TERM $$`
- **THEN** it succeeds with "killed by SIGTERM"

#### Scenario: A cut stream
- **WHEN** the command writes more than the cap to stdout
- **THEN** the outcome ends with the line saying how to see the rest of the output

#### Scenario: bash can't be started
- **WHEN** the `PATH` given to the tool holds no `bash`
- **THEN** the outcome fails saying bash couldn't be started, and no signal is sent

#### Scenario: The working directory is gone
- **WHEN** the working directory has been deleted
- **THEN** the outcome fails with an error that names the working directory and says it doesn't exist

### Requirement: Build the command's environment from scratch
The command's environment SHALL NOT be the server's own. bash SHALL be started with only these variables, and bash adds its own, such as `PWD` and `SHLVL`:
- `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and `LC_ALL`, copied from the server's environment where they are set;
- `CI=1`, `NO_COLOR=1`, `TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `DEBIAN_FRONTEND=noninteractive` and `PLAYWRIGHT_MCP_IDLE_TIMEOUT=900000`;
- `GREMLIN_RUN_ID`, the run ID, and `PLAYWRIGHT_CLI_SESSION`, which is `gremlin-` followed by the run ID.

Before its first command, the tool SHALL create the directory `.playwright` in the working directory if it's missing, and SHALL ignore a failure to create it.

#### Scenario: The server's secrets stay out
- **WHEN** the server's environment holds `MODEL_API_KEY`, and the command is `env`
- **THEN** stdout doesn't mention `MODEL_API_KEY`

#### Scenario: The command's variables
- **WHEN** the run ID is `a1b2c3d4`, and the command is `env`
- **THEN** stdout holds `GREMLIN_RUN_ID=a1b2c3d4`, `PLAYWRIGHT_CLI_SESSION=gremlin-a1b2c3d4`, `PLAYWRIGHT_MCP_IDLE_TIMEOUT=900000`, `CI=1`, `PAGER=cat` and the server's `PATH`

#### Scenario: playwright-cli's workspace
- **WHEN** the working directory has no `.playwright` directory, and the tool's first command runs
- **THEN** the working directory then holds a `.playwright` directory

### Requirement: Stop the command's process group
- **Timeout:** when the command has run for the timeout, its process group SHALL get SIGTERM. When the grace period ends, the group SHALL get SIGKILL if any of it is still running, even if bash itself has already exited. The output read so far SHALL be returned.
- **After bash exits without a timeout,** the tool SHALL wait at most the pipe wait for stdout and stderr to close, then SIGKILL the command's process group, and return what it read.
- **A process that leaves the command's process group,** by starting a session of its own, through job control, or through a tool that makes a group of its own such as GNU `timeout`, SHALL NOT be stopped this way.
- **Handles:** when the tool returns, it SHALL have closed both streams and cleared every timer it set.
- **Group kills** SHALL only ever be sent to a process group above 1.

#### Scenario: A command that never ends
- **WHEN** the timeout is 1 second, and the command is `echo started $$; sleep 30`
- **THEN** it succeeds with "timed out after 1 s" and "started" followed by bash's process ID, and no process is left in the process group with that ID

#### Scenario: A command that ignores SIGTERM
- **WHEN** the timeout is 1 second, and the command is `trap '' TERM; echo ready; sleep 30`
- **THEN** it succeeds with "killed by SIGKILL", "timed out after 1 s" and "ready"

#### Scenario: A child cleans up after the timeout
- **WHEN** the command runs a child that, on SIGTERM, writes a file after a delay longer than the pipe wait and shorter than the grace period, then exits, and the timeout fires
- **THEN** the file is written: bash exits at once on SIGTERM, and the group's SIGKILL waits for the grace period

#### Scenario: A background job
- **WHEN** the command is `sleep 30 > /dev/null 2>&1 & echo $!`
- **THEN** it succeeds with "exit code: 0", stdout holds the job's process ID, and that process is no longer running

#### Scenario: A background job holding the output
- **WHEN** the command is `(sleep 30; echo late) & echo started`
- **THEN** it succeeds with "exit code: 0" and "started", without "late", and without timing out

#### Scenario: A process in a session of its own
- **WHEN** the command starts a process in a new session, as playwright-cli does with its browser daemon
- **THEN** that process is still running after the command returns

#### Scenario: A process outside the group holding the output
- **WHEN** the command prints "started", and starts a process in a new session that keeps stdout open
- **THEN** it succeeds with "exit code: 0" and "started" once the pipe wait ends, and the tool leaves no stream open and no timer set

### Requirement: Cap each stream
Each stream SHALL be captured through `core`'s output capture, with a limit of 32 KiB. The capture SHALL show:
- its first 16 KiB;
- when anything was dropped, a line of its own reading `[… N bytes omitted …]`, where N counts every byte not shown, including those dropped by moving a cut to a character boundary;
- its last 16 KiB.

Cuts SHALL move to UTF-8 character boundaries, invalid UTF-8 SHALL be decoded as U+FFFD, and every NUL byte SHALL be shown as `␀`. The capture SHALL keep memory bounded by its limit, however much the command writes, and adding a chunk SHALL NOT change the capture it is added to.

#### Scenario: Short output
- **WHEN** a stream holds 1,000 bytes
- **THEN** all of it is shown, with no note

#### Scenario: Long output
- **WHEN** the command writes "start", then 100,000 bytes of "x", then "end"
- **THEN** stdout is the first 16,384 bytes, which begin with "start", then the line `[… 67240 bytes omitted …]`, then the last 16,384 bytes, which end with "end"

#### Scenario: A character at the head's cut
- **WHEN** the head's limit falls inside a 3-byte character
- **THEN** the head ends before that character, and no U+FFFD appears

#### Scenario: A character at the tail's start
- **WHEN** the tail's first byte falls inside a 4-byte character
- **THEN** the tail starts after that character, and no U+FFFD appears

#### Scenario: Invalid UTF-8
- **WHEN** the command is `printf '\x80'`
- **THEN** stdout is "�"

#### Scenario: NUL bytes
- **WHEN** the command is `printf 'a\0b'`
- **THEN** stdout is "a␀b"

### Requirement: Stop every process a session started
The tool SHALL provide `dispose()`, for the server to call when the session ends. It SHALL:
1. close the shell, so that no command starts from then on, including one whose call began earlier and hasn't been spawned yet. Each such call SHALL fail, saying the session is stopping;
2. SIGKILL the process group of a command that is still running, and wait for that command to end;
3. list processes with `ps axeww -o pid=,ppid=,pgid=,command=`. A process matches when its line, its command line and environment as `ps` prints them, holds `GREMLIN_RUN_ID=` and the run ID, preceded by a space and followed by a space or the end of the line;
4. signal nothing, and report why, when a match is process 1 or below, is the server's own process or its parent, or when more than 32 processes match;
5. send each match SIGTERM, and when the grace period ends, SIGKILL the matches still running, and the process groups of their descendants that are still running, as recorded from the same listing. A group kill SHALL go only to a process group above 1 that isn't the server's own;
6. skip processes that have already exited, or belong to another user;
7. resolve to a `Result`: the number of matching processes it stopped, or why it couldn't run. It SHALL NOT reject, and every later call SHALL return the first call's result.

#### Scenario: A process that left the group
- **WHEN** a command started a process in a session of its own, and `dispose()` is called
- **THEN** that process is stopped, and `dispose()` resolves to `ok` with 1

#### Scenario: Another run's process
- **WHEN** a process carries `GREMLIN_RUN_ID` set to this run's ID followed by `-x`, or a variable `OLD_GREMLIN_RUN_ID` set to this run's ID
- **THEN** `dispose()` leaves it running

#### Scenario: A process that ignores SIGTERM
- **WHEN** a process carrying the run ID ignores SIGTERM
- **THEN** it is stopped by SIGKILL, and `dispose()` resolves to `ok` with 1

#### Scenario: A child left behind by a killed parent
- **WHEN** a process carrying the run ID ignores SIGTERM, and has a child in a process group of its own that doesn't carry the run ID
- **THEN** after `dispose()` both are gone

#### Scenario: A match too wide to trust
- **WHEN** the listing holds 33 processes carrying the run ID
- **THEN** `dispose()` signals none of them, and resolves to an error saying the match was too wide

#### Scenario: Nothing to stop
- **WHEN** no process carries the run ID
- **THEN** `dispose()` resolves to `ok` with 0

#### Scenario: No command after dispose
- **WHEN** `dispose()` has started, and the model then calls `shell`
- **THEN** the call fails saying the session is stopping, and starts no process

#### Scenario: A second call
- **WHEN** `dispose()` is called twice
- **THEN** both calls resolve to the same result, and the processes are listed once
