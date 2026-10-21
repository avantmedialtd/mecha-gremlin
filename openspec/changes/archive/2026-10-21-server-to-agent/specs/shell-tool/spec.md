## MODIFIED Requirements

### Requirement: Run a command with bash in the working directory
The agent SHALL provide a `shell` tool, created for a working directory, a run ID and its limits: a timeout, a grace period, a pipe wait and an output cap, by default 120 seconds, 2 seconds, 1 second and 32 KiB. Its arguments SHALL be exactly one required string, `command`, and no other property SHALL be allowed. It SHALL run the command with `bash -c`, in the working directory, in a process group of its own, with stdin connected to nothing, so that reading it gives end-of-file at once.

#### Scenario: The model sees a closed schema
- **WHEN** `shell` is converted with `toFunctionTool`
- **THEN** its parameters require a string `command` and set `additionalProperties` to false

#### Scenario: Runs in the working directory
- **WHEN** `shell` is called with `{"command":"pwd"}`
- **THEN** stdout is the working directory's real path

#### Scenario: No input
- **WHEN** the command is `cat; echo done`
- **THEN** it succeeds with "exit code: 0" and stdout "done", without timing out

### Requirement: Build the command's environment from scratch
The command's environment SHALL NOT be the agent process's own. bash SHALL be started with only these variables, and bash adds its own, such as `PWD` and `SHLVL`:
- `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and `LC_ALL`, copied from the agent process's environment where they are set;
- `CI=1`, `NO_COLOR=1`, `TERM=dumb`, `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `DEBIAN_FRONTEND=noninteractive` and `PLAYWRIGHT_MCP_IDLE_TIMEOUT=900000`;
- `GREMLIN_RUN_ID`, the run ID, and `PLAYWRIGHT_CLI_SESSION`, which is `gremlin-` followed by the run ID.

Before each command, the tool SHALL create the directory `.playwright` in the working directory if it's missing, and SHALL ignore a failure to create it.

#### Scenario: The server's secrets stay out
- **WHEN** the agent process's environment holds `MODEL_API_KEY`, and the command is `env`
- **THEN** stdout doesn't mention `MODEL_API_KEY`

#### Scenario: The command's variables
- **WHEN** the run ID is `a1b2c3d4`, and the command is `env`
- **THEN** stdout holds `GREMLIN_RUN_ID=a1b2c3d4`, `PLAYWRIGHT_CLI_SESSION=gremlin-a1b2c3d4`, `PLAYWRIGHT_MCP_IDLE_TIMEOUT=900000`, `CI=1`, `PAGER=cat` and the agent process's `PATH`

#### Scenario: playwright-cli's workspace
- **WHEN** the working directory has no `.playwright` directory, and the tool's first command runs
- **THEN** the working directory then holds a `.playwright` directory

### Requirement: Stop every process a session started
The tool SHALL provide `dispose()`, for the agent to call when the session ends. It SHALL:
1. close the shell, so that no command starts from then on, including one whose call began earlier and hasn't been spawned yet. Each such call SHALL fail, saying the session is stopping;
2. SIGKILL the process group of a command that is still running, and wait for that command to end;
3. list processes with `ps axeww -o pid=,ppid=,pgid=,command=`, run from `/` with only `PATH` in its environment. A process matches when its line, its command line and environment as `ps` prints them, holds `GREMLIN_RUN_ID=` and the run ID, preceded by a space and followed by a space or the end of the line;
4. signal nothing, and report why, when:
   - `ps` doesn't list the processes within 10 seconds. It SHALL then be killed;
   - the listing doesn't show the agent's own process with a `PATH` in its environment, so `ps` can't show environments;
   - a match is process 1 or below, or is the agent's own process or its parent;
   - more than 32 processes match;
5. send each match SIGTERM, and when the grace period ends, SIGKILL the matches still running, and the process groups of their descendants that are still running, as recorded from the same listing. A group kill SHALL go only to a process group above 1 that isn't the agent process's own;
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

#### Scenario: A ps that hangs
- **WHEN** `ps` doesn't finish within the listing's time limit
- **THEN** it is killed, `dispose()` resolves to an error saying `ps` didn't list the processes in time, and nothing is signalled

#### Scenario: A ps that can't show environments
- **WHEN** the listing shows the agent's own process without its environment
- **THEN** `dispose()` resolves to an error saying so, and nothing is signalled

#### Scenario: No command after dispose
- **WHEN** `dispose()` has started, and the model then calls `shell`
- **THEN** the call fails saying the session is stopping, and starts no process

#### Scenario: A second call
- **WHEN** `dispose()` is called twice
- **THEN** both calls resolve to the same result, and the processes are listed once
