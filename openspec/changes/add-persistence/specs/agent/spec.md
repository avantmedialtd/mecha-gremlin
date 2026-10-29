## MODIFIED Requirements

### Requirement: Carry out a task through the agent loop, and log the answer
Running the agent, `bun run agent [task…]` from the repository root, SHALL:
1. require a nonempty task from the arguments, joined with spaces; a missing or whitespace-only task SHALL fail with an actionable error and SHALL NOT start the example browsing task or make a network request;
2. validate the explicitly configured settings;
3. load the skills `SKILLS_PATH` lists (`skills`);
4. open the store in `DATA_DIR` (`store`) before any network request. When it can't be opened, the agent SHALL log the error and exit with code 1, having made no network request;
5. choose the named model;
6. run the provider-bound agent loop, with a step limit of `MAX_STEPS`, with:
   - the tools `read`, rooted at the working directory with the loaded skills' directories; then the file tools `FILE_TOOLS` chooses, rooted at the working directory: `write` and `edit` for `write-edit`, or `apply_patch` for `apply-patch`; then `shell`, in the working directory; then `activate_skill` when any skill is loaded;
   - starting instructions that say the model carries out tasks on this computer with a shell, `read` for reading text files and the offered file tools for writing and changing them; give the working directory's real path and say that paths commands print are relative to it; ask for a brief final answer; and end with the skills catalog when any skill is loaded;
   - a user input holding the task;
7. log the trimmed answer as an `info` record `answer` with the field `text`;
8. stop the session's processes, close the store and exit with code 0.

Responses providers SHALL send the instructions as a developer item to the configured Responses endpoint. Anthropic SHALL send the same instructions as system input to its configured Messages endpoint. Every request SHALL name the configured model and effort in the selected provider's format.

#### Scenario: No task
- **WHEN** the agent runs with no task arguments or only whitespace
- **THEN** it exits with code 1, reports that a task is required, makes no network call and does not launch the example browser task

#### Scenario: Task from the arguments
- **WHEN** the agent runs with the arguments `Which`, `runtime` and `does README.md describe?`
- **THEN** its first request's user input is "Which runtime does README.md describe?"

#### Scenario: The tools offered
- **WHEN** `SKILLS_PATH` names a root holding the skill `pdf` and `FILE_TOOLS` is `write-edit`
- **THEN** the first request offers `read`, `write`, `edit`, `shell` and `activate_skill` in that order, and the instructions end with the catalog listing `pdf`

#### Scenario: Without skills
- **WHEN** `SKILLS_PATH` is unset and `FILE_TOOLS` is `write-edit`
- **THEN** the first request offers `read`, `write`, `edit` and `shell`, and the instructions mention no skills

#### Scenario: The working directory
- **WHEN** `WORK_DIR` is a symbolic link to a directory holding `notes.txt`
- **THEN** the instructions and `asking` record give that directory's real path, `read` reads `notes.txt` there, `write` and `edit` write there, and `shell` runs its commands there

#### Scenario: Answer after running a command
- **WHEN** the model's first reply calls `shell` with `{"command":"echo 42"}`, and its second answers "\n\nIt printed 42."
- **THEN** the second request carries the command's output as that provider's tool result, the `answer` record's `text` is "It printed 42.", and the exit code is 0

#### Scenario: The step limit comes from the settings
- **WHEN** `MAX_STEPS` is 3 and every reply calls a tool
- **THEN** exactly 3 model requests are sent

#### Scenario: The patch tool set
- **WHEN** `FILE_TOOLS` is `apply-patch` and `SKILLS_PATH` is unset
- **THEN** the first request offers `read`, `apply_patch` and `shell` in that order, no request offers `write` or `edit`, and the instructions name `apply_patch`

#### Scenario: The write-edit tool set
- **WHEN** `FILE_TOOLS` is `write-edit`
- **THEN** the instructions name `read`, `write` and `edit`, and don't name `apply_patch`

#### Scenario: The store opens before any network request
- **WHEN** `DATA_DIR` names an empty directory, and nothing listens at the configured LM Studio URL
- **THEN** `db.sqlite` exists in that directory with its migrations applied, and the agent exits with code 1, saying LM Studio can't be reached

#### Scenario: A data folder the store can't open
- **WHEN** `DATA_DIR` names a directory in which `db.sqlite` is itself a directory
- **THEN** an error names the database's path and the reason, no network request is made, and the exit code is 1

### Requirement: Log each model call and tool call
The agent SHALL log, through the structured logger:
- when at least one skill is loaded, an `info` record `skills` with `names`, the loaded skills' names in sorted order;
- the `skill not loaded` and `skill warning` records that loading skills produces (`skills`);
- when opening the store applied migrations, an `info` record `migrated` with `names`, the migrations' names in the order they ran, logged before `asking`;
- before the first model call, an `info` record `asking` with `model`, `baseUrl`, `run` (the session's run ID), `workDir` (the working directory's real path), `dataDir` (the data folder's real path) and `task`;
- for every attempted model call, including an incomplete or failed call, an `info` record `model call` with `step`, `seconds` rounded to a tenth, and the selected provider's complete typed reported statistics as `providerStats`, including available usage, diagnostics and documented rate-limit headers. An unavailable statistic SHALL not be invented; partial usage SHALL be identified as partial. Both pretty and JSON output SHALL show the complete `providerStats` fields. Any common token summary SHALL be additional and SHALL use the correct provider-specific accounting;
- then, for each of the step's tool calls:
  - an `info` record `tool call` with `tool` and `arguments`. Arguments are logged as JSON when they parse, and as the model sent them otherwise;
  - an `info` record `tool result` with `tool` and `bytes`, or a `warn` record `tool failed` with `tool` and `error`.

Native replay data, API keys and authorization headers SHALL NOT be logged as statistics.

#### Scenario: Records of a tool round trip
- **WHEN** no skill is loaded, `DATA_DIR` holds a database already migrated, the model's first reply calls `read` for `package.json`, and its second answers
- **THEN** the records are, in order: `asking`, `model call` with `step` 1 and its provider stats, `tool call` with `arguments` `{ "path": "package.json" }`, `tool result` with the output's size in bytes, `model call` with `step` 2 and `answer`

#### Scenario: Complete provider statistics in each format
- **WHEN** the model reports cache reads, cache writes and a provider-specific usage breakdown
- **THEN** the `model call` record exposes all those typed fields in both pretty and JSON output

#### Scenario: Failed call statistics
- **WHEN** a call fails after the provider reports partial usage
- **THEN** a `model call` record gives the step, elapsed time and partial reported stats before the final error record

#### Scenario: The asking record
- **WHEN** the run ID is a fresh random ID, `WORK_DIR` and `DATA_DIR` name directories, and the task is "Say hi"
- **THEN** the `asking` record's `run` is that ID, its `workDir` and `dataDir` are those directories' real paths, and its `task` is "Say hi"

#### Scenario: The skills record
- **WHEN** the skills `pdf` and `browser` are loaded
- **THEN** a `skills` record, logged before `asking`, has `names` `browser` and `pdf`

#### Scenario: Sizes are in bytes
- **WHEN** a tool's output holds characters that take more than one byte in UTF-8
- **THEN** the `tool result` record's `bytes` counts bytes, not characters

#### Scenario: A failed call
- **WHEN** `read` refuses `.env`
- **THEN** a `warn` record `tool failed` carries the tool's error

#### Scenario: The migrated record
- **WHEN** the agent runs twice with the same `DATA_DIR`, which starts empty
- **THEN** the first run logs a `migrated` record naming the migration that creates the `credential` table, before `asking`, and the second run logs no `migrated` record

### Requirement: Read the configuration from the environment, and validate it at start-up
The agent SHALL validate settings with provider-discriminated Zod schemas in `loadConfig`. Trimmed blank values SHALL count as unset. `MODEL_PROVIDER` SHALL be explicitly set to `lmstudio`, `openai` or `anthropic`; each provider SHALL require `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL` and `MODEL_REASONING_EFFORT`. There SHALL be no fallback provider, URL, key, model or effort. A trailing slash on `MODEL_BASE_URL` SHALL be removed; the URL SHALL be HTTP(S) without query or fragment. LM Studio's base URL SHALL retain the existing requirement for a path such as `/v1`. The API key SHALL be passed explicitly to the selected client; LM Studio's models endpoint SHALL receive it as a bearer token.

For `openai` and `lmstudio`, effort SHALL be one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. For `anthropic`, it SHALL be one of `low`, `medium`, `high`, `xhigh` or `max`; `none` and `minimal` SHALL be refused, not silently mapped or ignored. The Anthropic schema SHALL also require `MODEL_MAX_OUTPUT_TOKENS`, a positive safe integer written in decimal digits, and MAY accept `ANTHROPIC_WORKSPACE_ID`. `MODEL_MAX_OUTPUT_TOKENS` SHALL be invalid when a Responses provider is selected. A model-specific restriction on an otherwise valid effort or token limit SHALL be reported from the provider's error rather than guessed from a model catalog.

The agent SHALL also require and validate, whatever the provider:
- `WORK_DIR`, the working directory of `read`, the file tools and `shell`; a relative path resolves against the current directory, it SHALL name an existing directory, and its real path SHALL be used;
- `DATA_DIR`, the data folder that holds the store's database (`store`); a relative path resolves against the current directory, it SHALL name an existing directory, its real path SHALL be used, and it SHALL NOT be the working directory or contain it;
- `MAX_STEPS`, a positive whole number in decimal digits;
- `FILE_TOOLS`, `write-edit` for `write` and `edit`, or `apply-patch` for `apply_patch`;
- `LOG_FORMAT`, `pretty` or `json` (`structured-log`).

`SKILLS_PATH` is optional: when unset no skill is loaded and no other directory is searched. `MAX_TURNS`, the former step-limit name, SHALL be invalid whenever set, whatever its value, with an error saying it is now `MAX_STEPS`. The agent SHALL check all independently checkable settings before a network call. For every invalid or missing required setting it SHALL log an actionable error naming that setting and exit with code 1. It SHALL NOT use the Anthropic SDK's environment defaults in place of validated Gremlin configuration. The only provider default introduced here is Anthropic's explicit five-minute caching policy.

#### Scenario: Nothing configured
- **WHEN** no settings are supplied
- **THEN** configuration fails, errors name `MODEL_PROVIDER`, `MAX_STEPS`, `FILE_TOOLS`, `LOG_FORMAT`, `WORK_DIR` and `DATA_DIR`, and no network call is made

#### Scenario: Provider is required
- **WHEN** all other common settings are supplied but `MODEL_PROVIDER` is unset
- **THEN** an error names `MODEL_PROVIDER`, no default provider is chosen and no network call is made

#### Scenario: Required model settings are missing
- **WHEN** a valid provider is selected but its base URL, key, model or reasoning effort is missing or blank
- **THEN** configuration fails with an error for each missing setting before any network call

#### Scenario: Claude requires an output limit
- **WHEN** `MODEL_PROVIDER` is `anthropic` and `MODEL_MAX_OUTPUT_TOKENS` is absent, zero, negative, fractional, non-decimal or larger than the safe integer range
- **THEN** configuration fails with an error naming `MODEL_MAX_OUTPUT_TOKENS` before any network call

#### Scenario: Claude rejects unsupported effort values
- **WHEN** `MODEL_PROVIDER` is `anthropic` and effort is `none` or `minimal`
- **THEN** configuration fails with an error naming `MODEL_REASONING_EFFORT`; no request is sent

#### Scenario: Claude accepts a supported effort
- **WHEN** the other required Anthropic settings are valid and effort is `medium`
- **THEN** configuration succeeds and the Claude request carries `output_config.effort` `medium`

#### Scenario: Responses output limit is not silently ignored
- **WHEN** `MODEL_PROVIDER` is `openai` or `lmstudio` and `MODEL_MAX_OUTPUT_TOKENS` is set
- **THEN** configuration fails with an error naming that setting and its Anthropic-only scope

#### Scenario: Invalid base URL
- **WHEN** `MODEL_BASE_URL` is not an HTTP or HTTPS URL without a query or fragment
- **THEN** no network call is made, an error names `MODEL_BASE_URL`, and the exit code is 1

#### Scenario: LM Studio's base URL lacks a path
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL_BASE_URL` has no path, such as `http://127.0.0.1:1234`
- **THEN** an error explains that LM Studio's base URL has a path such as `/v1`, and no network call is made

#### Scenario: Unknown provider
- **WHEN** `MODEL_PROVIDER` is not `lmstudio`, `openai` or `anthropic`
- **THEN** an error names `MODEL_PROVIDER` and no network call is made

#### Scenario: An invalid step limit
- **WHEN** `MAX_STEPS` is `0`, `-1`, `2.5` or `lots`
- **THEN** no network call is made, an error names `MAX_STEPS`, and the exit code is 1

#### Scenario: The step limit's former name
- **WHEN** `MAX_TURNS` is set, with or without `MAX_STEPS`
- **THEN** no network call is made, and an error says `MAX_TURNS` is now `MAX_STEPS`

#### Scenario: A working directory that doesn't exist
- **WHEN** `WORK_DIR` names a path that doesn't exist, or a file
- **THEN** no network call is made and an error names `WORK_DIR`

#### Scenario: Every independently checkable problem is reported
- **WHEN** `MODEL_PROVIDER` is `anthropic`, the API key and model are missing, the output limit is invalid, and `WORK_DIR` doesn't exist
- **THEN** the startup errors name each of those problems and no network call is made

#### Scenario: An invalid file tools setting
- **WHEN** `FILE_TOOLS` is `both`
- **THEN** an error names `FILE_TOOLS` and its valid values, `write-edit` and `apply-patch`, before any network call

#### Scenario: A data folder that doesn't exist
- **WHEN** `DATA_DIR` names a path that doesn't exist, or a file
- **THEN** no network call is made, and an error names `DATA_DIR`

#### Scenario: A data folder given through a link
- **WHEN** `DATA_DIR` is a symbolic link to a directory
- **THEN** the store opens in that directory's real path, and the `asking` record's `dataDir` is that path

#### Scenario: A data folder holding the working directory
- **WHEN** `DATA_DIR` names the working directory, or a directory that contains it
- **THEN** no network call is made, and an error says `DATA_DIR` must not be or contain `WORK_DIR`

### Requirement: Run the agent on Bun or on Node
The agent SHALL run on Bun with `bun run agent`, and on Node with `bun run agent:node`, taking the same task and settings. `bun run agent:node` SHALL load `.env` in the current directory when present and SHALL start without it; other `.env` files that Bun reads are not read on Node. `packages/agent/package.json` SHALL declare both runtimes in `engines`: Bun 1.4.4 or later, which better-sqlite3 13 needs, and Node 26 or later. CI SHALL start the agent on Node with an explicit task and all required settings.

#### Scenario: On Node
- **WHEN** the required LM Studio settings, an explicit task and `MODEL_BASE_URL=http://127.0.0.1:9/v1` are supplied with no `.env`
- **THEN** Node notes that `.env` wasn't found, an error says LM Studio can't be reached at that URL, and the exit code is 1, as on Bun

#### Scenario: Settings from .env on Node
- **WHEN** `.env` sets `MODEL_PROVIDER` to `nonsense` and the agent runs on Node with `--env-file-if-exists=.env`
- **THEN** an error names `MODEL_PROVIDER` and the exit code is 1

#### Scenario: CI starts the agent on Node
- **WHEN** CI's check job runs
- **THEN** it supplies the explicit LM Studio settings, `DATA_DIR` and the task to `bun run agent:node`, uses a port where nothing listens, and fails unless the exit code is 1 and the output says LM Studio can't be reached

#### Scenario: The runtimes' floors
- **WHEN** `packages/agent/package.json` is read
- **THEN** its `engines` require Bun 1.4.4 or later and Node 26 or later

### Requirement: Stop the session's processes when the agent ends
The agent SHALL await the shell's `dispose()` before it exits, whether the session answered or failed, and SHALL then close the store, on every path, signals included.
- When `dispose()` stopped any processes, the agent SHALL log an `info` record `stopped` with the field `count`, once.
- When `dispose()` couldn't run its sweep, the agent SHALL log a `warn` record `cleanup failed` with the field `error`, and keep its exit code.
- **Signal handlers:** it SHALL install handlers for SIGINT, SIGTERM and SIGHUP before the session starts, and SHALL remove them once `dispose()` has resolved.
- **The first signal** SHALL:
  - log a `warn` record `interrupted` with the field `signal`;
  - stop handling the session's steps;
  - await `dispose()`;
  - exit with code 130 for SIGINT, 143 for SIGTERM or 129 for SIGHUP.

  Signals that arrive while `dispose()` runs SHALL be ignored.

#### Scenario: A process left behind
- **WHEN** a command starts a process in a session of its own, and the model then answers
- **THEN** that process is stopped before the agent exits, and a `stopped` record has `count` 1

#### Scenario: Ctrl-C
- **WHEN** the agent receives SIGINT during the session
- **THEN** a `warn` record `interrupted` gives the signal `SIGINT`, the session's processes are stopped, and the exit code is 130

#### Scenario: SIGTERM
- **WHEN** the agent receives SIGTERM during the session
- **THEN** a `warn` record `interrupted` gives the signal `SIGTERM`, the session's processes are stopped, and the exit code is 143

#### Scenario: The terminal closes
- **WHEN** the agent receives SIGHUP during the session
- **THEN** a `warn` record `interrupted` gives the signal `SIGHUP`, the session's processes are stopped, and the exit code is 129

#### Scenario: Ctrl-C twice
- **WHEN** SIGINT arrives twice in quick succession
- **THEN** one `interrupted` record is logged, the processes are stopped once, and the exit code is 130

#### Scenario: No handler outlives the agent
- **WHEN** the agent ends after an answer
- **THEN** `process` has as many SIGINT, SIGTERM and SIGHUP listeners as before it started

#### Scenario: The sweep can't run
- **WHEN** the model answers, and the sweep can't list processes
- **THEN** a `warn` record `cleanup failed` gives the reason, and the exit code is 0

#### Scenario: The store is closed
- **WHEN** the agent ends, after an answer, after a failure, or after SIGINT
- **THEN** its store is closed: the data folder holds no `-wal` or `-shm` file, and a new store opens there without error
