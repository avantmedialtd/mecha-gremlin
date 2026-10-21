## MODIFIED Requirements

### Requirement: Carry out a task through the agent loop, and log the answer
Running the agent, `bun run agent [task…]` from the repository root, SHALL:
1. choose the model to use;
2. take the task from the arguments, joined with spaces. With no arguments, the task SHALL be "Use the playwright-cli skill to find the title of https://example.com";
3. load the skills `SKILLS_PATH` lists (`skills`);
4. run the agent loop, with a step limit of `MAX_STEPS`, with:
   - the tools `read_file`, rooted at the working directory with the loaded skills' directories, then `shell`, in the working directory, then `activate_skill` when any skill is loaded;
   - a starting `developer` item that:
     - says the model carries out tasks on this computer with a shell and `read_file`;
     - gives the working directory's real path, and says that paths commands print are relative to it;
     - asks for a brief final answer;
     - ends with the skills catalog, when any skill is loaded;
   - a `user` item holding the task;
5. log the trimmed answer as an `info` record `answer` with the field `text`;
6. stop the session's processes, and exit with code 0.

Every model call SHALL go to the OpenAI-compatible Responses endpoint at `{MODEL_BASE_URL}/responses` with the chosen model and, when one is configured, `reasoning.effort`.

#### Scenario: Default task
- **WHEN** the agent runs with no arguments
- **THEN** the first request's `user` item is "Use the playwright-cli skill to find the title of https://example.com"

#### Scenario: Task from the arguments
- **WHEN** the agent runs with the arguments `Which`, `runtime` and `does README.md describe?`
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
- **WHEN** the model's first reply calls `shell` with `{"command":"echo 42"}`, and its second answers "\n\nIt printed 42."
- **THEN** the second request carries the command's output in a `function_call_output`, the `answer` record's `text` is "It printed 42.", and the exit code is 0

#### Scenario: The step limit comes from the settings
- **WHEN** `MAX_STEPS` is 3, and every reply calls a tool
- **THEN** exactly 3 requests are sent

### Requirement: Log each model call and tool call
The agent SHALL log, through the structured logger:
- when at least one skill is loaded, an `info` record `skills` with the field `names`, the loaded skills' names in sorted order;
- the `skill not loaded` and `skill warning` records that loading the skills produces (`skills`);
- before the first model call, an `info` record `asking` with the fields `model`, `baseUrl`, `run` (the session's run ID), `workDir` (the working directory's real path) and `task`;
- as each step completes, an `info` record `model call`. Its fields are `step`, the step's number; `inputTokens`, `cachedTokens`, `outputTokens` and `reasoningTokens`, when the model server reports them; and `seconds`, the model call's, rounded to a tenth;
- then, for each of the step's tool calls:
  - an `info` record `tool call` with the fields `tool` and `arguments`. The arguments are logged as JSON when they parse, and as the model sent them otherwise;
  - then an `info` record `tool result` with the fields `tool` and `bytes`, or a `warn` record `tool failed` with the fields `tool` and `error`.

#### Scenario: Records of a tool round trip
- **WHEN** no skill is loaded, the model's first reply calls `read_file` for `package.json`, and its second answers
- **THEN** the records are, in order: `asking`, `model call` with `step` 1 and its token counts, `tool call` with `arguments` `{ "path": "package.json" }`, `tool result` with the output's size in bytes, `model call` with `step` 2, and `answer`

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

### Requirement: Choose the model according to the provider
The agent SHALL choose the model according to `MODEL_PROVIDER`.
- With `lmstudio`, the default, it SHALL ask LM Studio's native `GET {origin of MODEL_BASE_URL}/api/v1/models` which models are loaded, and SHALL NOT request a model that isn't currently loaded. A loaded model is an entry of type `llm` with at least one loaded instance.
  - When `MODEL` is set, it SHALL match a loaded instance id or a loaded model key.
  - When it isn't set, the agent SHALL use the first loaded instance. If more than one LLM instance is loaded, it SHALL say which one it chose in an `info` record.
- With any other provider, it SHALL use `MODEL` and SHALL NOT call LM Studio's native API.

#### Scenario: No model configured, one loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio`, `MODEL` is unset, and exactly one LLM instance, `prism-ml/bonsai-27b`, is loaded
- **THEN** the requests name the model `prism-ml/bonsai-27b`

#### Scenario: Several models loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio`, `MODEL` is unset, and two LLM instances are loaded
- **THEN** the first instance is used, and an `info` record says it was chosen out of two, and how to pick another

#### Scenario: Configured model is loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL` names a loaded instance id or a loaded model key
- **THEN** the requests name that model

#### Scenario: Configured model is not loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL` names a model that has no loaded instance
- **THEN** the model isn't called, an `error` record lists the loaded models and suggests `lms load <model>`, and the exit code is 1

#### Scenario: No model loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and no LLM instance is loaded
- **THEN** the model isn't called, an `error` record explains that a model must be loaded (suggesting `lms load <model>`), and the exit code is 1

#### Scenario: Embedding models are ignored
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and only an embedding model is loaded
- **THEN** it is treated as "no model loaded"

#### Scenario: Another provider uses the named model
- **WHEN** `MODEL_PROVIDER` is `openai` and `MODEL` is `gpt-test`
- **THEN** the requests name the model `gpt-test`, and no request goes to `/api/v1/models`

### Requirement: Read the configuration from the environment, and validate it at start-up
The agent SHALL read `MODEL_PROVIDER` (`lmstudio` or `openai`; default `lmstudio`), `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL` and `MODEL_REASONING_EFFORT`, with these defaults per provider:

| Variable | `lmstudio` | `openai` |
|---|---|---|
| `MODEL_BASE_URL` | `http://127.0.0.1:1234/v1` | `https://api.openai.com/v1` |
| `MODEL_API_KEY` | `lm-studio` | required |
| `MODEL` | optional | required |
| `MODEL_REASONING_EFFORT` | `none` | unset, so the request carries no `reasoning.effort` |

- A trailing slash on `MODEL_BASE_URL` SHALL be removed.
- The API key SHALL be sent as a bearer token to every endpoint the agent calls.
- The agent SHALL validate all settings before any network call. If any is invalid or missing, it SHALL exit with code 1 and log an `error` record for each invalid or missing variable, naming it.

It SHALL also read, whatever the provider:
- `WORK_DIR`, the working directory of `read_file` and `shell`. It defaults to the current directory, and a relative path resolves against the current directory. It SHALL name an existing directory, and SHALL be used by its real path, with symbolic links resolved.
- `SKILLS_PATH`, the skills roots (`skills`). When it's unset, no skill is loaded.
- `MAX_STEPS`, the session's step limit: a positive whole number written in decimal digits, defaulting to 30.

`MAX_TURNS`, the step limit's former name, SHALL be invalid whenever it is set, whatever its value, with an `error` record saying that it is now `MAX_STEPS`.

#### Scenario: Defaults apply
- **WHEN** none of the variables is set
- **THEN** the provider is `lmstudio`, the base URL is `http://127.0.0.1:1234/v1`, the key is `lm-studio`, no model is configured, the reasoning effort is `none`, the working directory is the current directory, no skill is loaded, and the step limit is 30

#### Scenario: Another provider's defaults
- **WHEN** `MODEL_PROVIDER` is `openai` and `MODEL_API_KEY` and `MODEL` are set
- **THEN** the base URL is `https://api.openai.com/v1`, and the requests carry no `reasoning`

#### Scenario: Required settings are missing
- **WHEN** `MODEL_PROVIDER` is `openai` and neither `MODEL_API_KEY` nor `MODEL` is set
- **THEN** no network call is made, one `error` record names `MODEL_API_KEY` and another names `MODEL`, and the exit code is 1

#### Scenario: Invalid base URL
- **WHEN** `MODEL_BASE_URL` is set to a value that isn't an http or https URL
- **THEN** no network call is made, an `error` record names `MODEL_BASE_URL`, and the exit code is 1

#### Scenario: LM Studio's base URL lacks /v1
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL_BASE_URL` has no path, such as `http://127.0.0.1:1234`
- **THEN** no network call is made, an `error` record explains that LM Studio's base URL ends in `/v1`, and the exit code is 1

#### Scenario: Unknown provider
- **WHEN** `MODEL_PROVIDER` is neither `lmstudio` nor `openai`
- **THEN** no network call is made, an `error` record names `MODEL_PROVIDER`, and the exit code is 1

#### Scenario: Reasoning effort is passed through
- **WHEN** `MODEL_REASONING_EFFORT` is `low`
- **THEN** the requests carry `reasoning.effort` equal to `low`

#### Scenario: An invalid step limit
- **WHEN** `MAX_STEPS` is `0`, `-1`, `2.5` or `lots`
- **THEN** no network call is made, an `error` record names `MAX_STEPS`, and the exit code is 1

#### Scenario: The step limit's former name
- **WHEN** `MAX_TURNS` is set, with or without `MAX_STEPS`
- **THEN** no network call is made, an `error` record says that `MAX_TURNS` is now `MAX_STEPS`, and the exit code is 1

#### Scenario: A working directory that doesn't exist
- **WHEN** `WORK_DIR` names a path that doesn't exist, or a file
- **THEN** no network call is made, an `error` record names `WORK_DIR`, and the exit code is 1

#### Scenario: Every problem is reported
- **WHEN** `MODEL_PROVIDER` is `openai` with neither `MODEL_API_KEY` nor `MODEL` set, and `WORK_DIR` doesn't exist
- **THEN** no network call is made, three `error` records name `MODEL_API_KEY`, `MODEL` and `WORK_DIR`, and the exit code is 1

### Requirement: Actionable failure messages
The agent SHALL exit with code 1 and log an `error` record whose message names the cause and a next step, in each of these cases:
- the model server is unreachable;
- the model server rejects the API key;
- LM Studio's models endpoint returns an unexpected shape;
- a model call fails;
- the model is still calling tools when the session's step limit is reached;
- the model gives no answer.

No `answer` record SHALL be logged in these cases.

When a model call fails, the message SHALL include the failure's detail, such as the model server's own message, and its next step SHALL depend on why the call failed:

| The model call failed because | Next step |
|---|---|
| the model server is unreachable | with `lmstudio`, start LM Studio's server (`lms server start`) or set `MODEL_BASE_URL`; otherwise, check `MODEL_BASE_URL` |
| the model server rejected the API key (HTTP 401 or 403) | set `MODEL_API_KEY`, as for a key rejected at start-up |
| the model server didn't answer in time | try again, or narrow the task |
| the model server is limiting requests (HTTP 429) | wait a minute and try again; if it keeps happening, check the account's quota |
| the model server rejected the request (any other HTTP 4xx) | check that `MODEL` and `MODEL_REASONING_EFFORT` suit the model server |
| the model server failed (HTTP 5xx), or the response failed or broke off | try again; if it keeps failing, check the model server |
| the response is incomplete | narrow the task |
| the model call was aborted | run the command again |
| anything else | try again; if it keeps happening, report it as a bug |

#### Scenario: LM Studio not running
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and the connection to LM Studio is refused
- **THEN** the error says LM Studio isn't reachable at the base URL and suggests starting its server (for example `lms server start`), and the exit code is 1

#### Scenario: LM Studio stops during the session
- **WHEN** `MODEL_PROVIDER` is `lmstudio`, LM Studio lists a loaded model, and then the connection for the first model call is refused
- **THEN** the error is the same as when LM Studio isn't running: it says LM Studio isn't reachable at the base URL and suggests `lms server start`

#### Scenario: Another provider is unreachable
- **WHEN** `MODEL_PROVIDER` is `openai` and the connection to the base URL is refused
- **THEN** the error says the base URL can't be reached and suggests checking `MODEL_BASE_URL`, without mentioning LM Studio

#### Scenario: Key rejected by LM Studio
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and LM Studio answers HTTP 401 or 403
- **THEN** the error says LM Studio requires a valid API key and names `MODEL_API_KEY`, and the exit code is 1

#### Scenario: Key rejected by another provider
- **WHEN** `MODEL_PROVIDER` is `openai` and the Responses endpoint answers HTTP 401
- **THEN** the error names `MODEL_API_KEY` without mentioning LM Studio, and the exit code is 1

#### Scenario: A model call fails
- **WHEN** a model call of the agent loop fails, for any of the reasons in the table
- **THEN** the error names the cause, includes the failure's detail and gives that reason's next step, no `answer` record is logged, and the exit code is 1

#### Scenario: Rate limited
- **WHEN** the Responses endpoint answers HTTP 429 with the message "slow down"
- **THEN** the error says the model server is limiting requests, includes "429 slow down", and says to wait a minute and try again

#### Scenario: Step limit reached
- **WHEN** the model is still calling tools after the loop's last allowed step
- **THEN** the error says the model didn't answer within the session's step limit, names its number of steps, and suggests a narrower task or a higher `MAX_STEPS`; no `answer` record is logged, and the exit code is 1

#### Scenario: No answer
- **WHEN** a reply holds neither tool calls nor text
- **THEN** the error says the model gave no answer, no `answer` record is logged, and the exit code is 1

## REMOVED Requirements

### Requirement: Run the server on Bun or on Node
**Reason**: Replaced by "Run the agent on Bun or on Node", which names the renamed scripts, `bun run agent` and `bun run agent:node`.
**Migration**: Run `bun run agent` instead of `bun run server`, and `bun run agent:node` instead of `bun run server:node`.

### Requirement: Stop the session's processes when the server ends
**Reason**: Replaced by "Stop the session's processes when the agent ends", with the same behaviour under the program's new name.
**Migration**: None needed: the behaviour is unchanged.

## ADDED Requirements

### Requirement: Run the agent on Bun or on Node
The agent SHALL run on Bun with `bun run agent`, and on Node with `bun run agent:node`, taking the same arguments and settings. `bun run agent:node` SHALL load the `.env` file in the current directory when there is one, and SHALL start without one; other `.env` files that Bun reads, such as `.env.local`, are not read on Node. `packages/agent/package.json` SHALL declare both runtimes in `engines`. CI SHALL start the agent on Node.

#### Scenario: On Node
- **WHEN** `bun run agent:node` runs with `MODEL_BASE_URL` set to `http://127.0.0.1:9/v1`, where nothing listens, and there is no `.env`
- **THEN** Node notes on stderr that `.env` wasn't found, an `error` record says LM Studio can't be reached at that URL, and the exit code is 1, as on Bun

#### Scenario: Settings from .env on Node
- **WHEN** the `.env` in the current directory sets `MODEL_PROVIDER` to `nonsense`, and the agent runs on Node with `--env-file-if-exists=.env`
- **THEN** an `error` record names `MODEL_PROVIDER`, and the exit code is 1

#### Scenario: CI starts the agent on Node
- **WHEN** CI's check job runs
- **THEN** it runs `bun run agent:node` with `MODEL_BASE_URL` set to a port where nothing listens, and fails unless the exit code is 1 and the output says LM Studio can't be reached

### Requirement: Stop the session's processes when the agent ends
The agent SHALL await the shell's `dispose()` before it exits, whether the session answered or failed.
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
