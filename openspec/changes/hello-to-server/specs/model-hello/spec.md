## MODIFIED Requirements

### Requirement: Carry out a task and log the answer
Running the server entry point, `bun run server [task…]` from the repository root, SHALL:
1. choose the model to use;
2. take the task from the arguments, joined with spaces. With no arguments, the task SHALL be "Use the playwright-cli skill to find the title of https://example.com";
3. load the skills `SKILLS_PATH` lists (`skills`);
4. run the agent loop, with a turn limit of `MAX_TURNS`, with:
   - the tools `read_file`, rooted at the working directory with the loaded skills' directories, then `shell`, in the working directory, then `activate_skill` when any skill is loaded;
   - a starting `developer` item that:
     - says the model carries out tasks on this computer with a shell and `read_file`;
     - gives the working directory's real path, and says that paths commands print are relative to it;
     - asks for a brief final answer;
     - ends with the skills catalog, when any skill is loaded;
   - a `user` item holding the task;
5. log the trimmed answer as an `info` record `answer` with the field `text`;
6. stop the session's processes, and exit with code 0.

Every turn SHALL go to the OpenAI-compatible Responses endpoint at `{MODEL_BASE_URL}/responses` with the chosen model and, when one is configured, `reasoning.effort`.

#### Scenario: Default task
- **WHEN** the server runs with no arguments
- **THEN** the first request's `user` item is "Use the playwright-cli skill to find the title of https://example.com"

#### Scenario: Task from the arguments
- **WHEN** the server runs with the arguments `Which`, `runtime` and `does README.md describe?`
- **THEN** the first request's `user` item is "Which runtime does README.md describe?"

#### Scenario: The tools offered
- **WHEN** `SKILLS_PATH` names a root holding the skill `pdf`
- **THEN** the first request's tools are `read_file`, `shell` and `activate_skill`, in that order, and its `developer` item ends with the catalog listing `pdf`

#### Scenario: Without skills
- **WHEN** `SKILLS_PATH` is unset
- **THEN** the first request's tools are `read_file` and `shell`, and its `developer` item mentions no skills

#### Scenario: The working directory
- **WHEN** `WORK_DIR` is a symbolic link to a directory holding `notes.txt`
- **THEN** the `developer` item and the `asking` record give that directory's real path, `read_file` reads `notes.txt` there, and `shell` runs its commands there

#### Scenario: Answer after running a command
- **WHEN** the first turn calls `shell` with `{"command":"echo 42"}`, and the second turn answers "\n\nIt printed 42."
- **THEN** the second request carries the command's output in a `function_call_output`, the `answer` record's `text` is "It printed 42.", and the exit code is 0

#### Scenario: The turn limit comes from the settings
- **WHEN** `MAX_TURNS` is 3, and every turn calls a tool
- **THEN** exactly 3 requests are sent

### Requirement: Log each tool call and turn
The server SHALL log, through the structured logger:
- when at least one skill is loaded, an `info` record `skills` with the field `names`, the loaded skills' names in sorted order;
- the `skill not loaded` and `skill warning` records that loading the skills produces (`skills`);
- before the first turn, an `info` record `asking` with the fields `model`, `baseUrl`, `run` (the session's run ID), `workDir` (the working directory's real path) and `task`;
- as each turn completes, an `info` record `turn`. Its fields are `number`, `seconds` (rounded to a tenth) and, when the server reports them, `inputTokens`, `cachedTokens`, `outputTokens` and `reasoningTokens`;
- then, for each of the turn's tool calls:
  - an `info` record `tool call` with the fields `tool` and `arguments`. The arguments are logged as JSON when they parse, and as the model sent them otherwise;
  - then an `info` record `tool result` with the fields `tool` and `bytes`, or a `warn` record `tool failed` with the fields `tool` and `error`.

#### Scenario: Records of a tool round trip
- **WHEN** no skill is loaded, the first turn calls `read_file` for `package.json`, and the second turn answers
- **THEN** the records are, in order: `asking`, `turn` 1 with its token counts, `tool call` with `arguments` `{ "path": "package.json" }`, `tool result` with the output's size in bytes, `turn` 2, and `answer`

#### Scenario: The asking record
- **WHEN** the run ID is a fresh random ID, `WORK_DIR` names a directory, and the task is "Say hi"
- **THEN** the `asking` record's `run` is that ID, its `workDir` is that directory's real path, and its `task` is "Say hi"

#### Scenario: The skills record
- **WHEN** the skills `pdf` and `browser` are loaded
- **THEN** a `skills` record, logged before the `asking` record, has the `names` `browser` and `pdf`

#### Scenario: Sizes are in bytes
- **WHEN** a tool's output holds characters that take more than one byte in UTF-8
- **THEN** the `tool result` record's `bytes` counts bytes, not characters

#### Scenario: A failed call
- **WHEN** `read_file` refuses `.env`
- **THEN** a `warn` record `tool failed` carries the tool's error

## REMOVED Requirements

### Requirement: Run on Bun or on Node
**Reason**: Replaced by "Run the server on Bun or on Node", which names the renamed scripts, `bun run server` and `bun run server:node`.
**Migration**: Run `bun run server` instead of `bun run hello`, and `bun run server:node` instead of `bun run hello:node`.

### Requirement: Stop the session's processes when the hello ends
**Reason**: Replaced by "Stop the session's processes when the server ends", with the same behaviour under the entry point's new name.
**Migration**: None needed: the behaviour is unchanged.

## ADDED Requirements

### Requirement: Run the server on Bun or on Node
The server SHALL run on Bun with `bun run server`, and on Node with `bun run server:node`, taking the same arguments and settings. `bun run server:node` SHALL load the `.env` file in the current directory when there is one, and SHALL start without one; other `.env` files that Bun reads, such as `.env.local`, are not read on Node. `packages/server/package.json` SHALL declare both runtimes in `engines`. CI SHALL start the server on Node.

#### Scenario: On Node
- **WHEN** `bun run server:node` runs with `MODEL_BASE_URL` set to `http://127.0.0.1:9/v1`, where nothing listens, and there is no `.env`
- **THEN** Node notes on stderr that `.env` wasn't found, an `error` record says LM Studio can't be reached at that URL, and the exit code is 1, as on Bun

#### Scenario: Settings from .env on Node
- **WHEN** the `.env` in the current directory sets `MODEL_PROVIDER` to `nonsense`, and the server runs on Node with `--env-file-if-exists=.env`
- **THEN** an `error` record names `MODEL_PROVIDER`, and the exit code is 1

#### Scenario: CI starts the server on Node
- **WHEN** CI's check job runs
- **THEN** it runs `bun run server:node` with `MODEL_BASE_URL` set to a port where nothing listens, and fails unless the exit code is 1 and the output says LM Studio can't be reached

### Requirement: Stop the session's processes when the server ends
The server SHALL await the shell's `dispose()` before it exits, whether the session answered or failed.
- When `dispose()` stopped any processes, the server SHALL log an `info` record `stopped` with the field `count`, once.
- When `dispose()` couldn't run its sweep, the server SHALL log a `warn` record `cleanup failed` with the field `error`, and keep its exit code.
- **Signal handlers:** it SHALL install handlers for SIGINT, SIGTERM and SIGHUP before the session starts, and SHALL remove them once `dispose()` has resolved.
- **The first signal** SHALL:
  - log a `warn` record `interrupted` with the field `signal`;
  - stop handling the session's steps;
  - await `dispose()`;
  - exit with code 130 for SIGINT, 143 for SIGTERM or 129 for SIGHUP.

  Signals that arrive while `dispose()` runs SHALL be ignored.

#### Scenario: A process left behind
- **WHEN** a command starts a process in a session of its own, and the model then answers
- **THEN** that process is stopped before the server exits, and a `stopped` record has `count` 1

#### Scenario: Ctrl-C
- **WHEN** the server receives SIGINT during the session
- **THEN** a `warn` record `interrupted` gives the signal `SIGINT`, the session's processes are stopped, and the exit code is 130

#### Scenario: SIGTERM
- **WHEN** the server receives SIGTERM during the session
- **THEN** a `warn` record `interrupted` gives the signal `SIGTERM`, the session's processes are stopped, and the exit code is 143

#### Scenario: The terminal closes
- **WHEN** the server receives SIGHUP during the session
- **THEN** a `warn` record `interrupted` gives the signal `SIGHUP`, the session's processes are stopped, and the exit code is 129

#### Scenario: Ctrl-C twice
- **WHEN** SIGINT arrives twice in quick succession
- **THEN** one `interrupted` record is logged, the processes are stopped once, and the exit code is 130

#### Scenario: No handler outlives the server
- **WHEN** the server ends after an answer
- **THEN** `process` has as many SIGINT, SIGTERM and SIGHUP listeners as before it started

#### Scenario: The sweep can't run
- **WHEN** the model answers, and the sweep can't list processes
- **THEN** a `warn` record `cleanup failed` gives the reason, and the exit code is 0
