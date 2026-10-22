## MODIFIED Requirements

### Requirement: Carry out a task through the agent loop, and log the answer
Running the agent, `bun run agent [task…]` from the repository root, SHALL:
1. choose the model to use;
2. take the task from the arguments, joined with spaces. With no arguments, the task SHALL be "Use the playwright-cli skill to find the title of https://example.com";
3. load the skills `SKILLS_PATH` lists (`skills`);
4. run the agent loop, with a step limit of `MAX_STEPS`, with:
   - the tools `read`, rooted at the working directory with the loaded skills' directories; then the file tools `FILE_TOOLS` chooses, rooted at the working directory: `write` and `edit` for `write-edit`, or `apply_patch` for `apply-patch`; then `shell`, in the working directory; then `activate_skill` when any skill is loaded;
   - a starting `developer` item that:
     - says the model carries out tasks on this computer with a shell, `read` for reading text files, and the file tools on offer for writing and changing them;
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
- **THEN** the first request's tools are `read`, `write`, `edit`, `shell` and `activate_skill`, in that order, and its `developer` item ends with the catalog listing `pdf`

#### Scenario: Without skills
- **WHEN** `SKILLS_PATH` is unset
- **THEN** the first request's tools are `read`, `write`, `edit` and `shell`, and its `developer` item mentions no skills

#### Scenario: The working directory
- **WHEN** `WORK_DIR` is a symbolic link to a directory holding `notes.txt`
- **THEN** the `developer` item and the `asking` record give that directory's real path, `read` reads `notes.txt` there, `write` and `edit` write there, and `shell` runs its commands there

#### Scenario: Answer after running a command
- **WHEN** the model's first reply calls `shell` with `{"command":"echo 42"}`, and its second answers "\n\nIt printed 42."
- **THEN** the second request carries the command's output in a `function_call_output`, the `answer` record's `text` is "It printed 42.", and the exit code is 0

#### Scenario: The step limit comes from the settings
- **WHEN** `MAX_STEPS` is 3, and every reply calls a tool
- **THEN** exactly 3 requests are sent

#### Scenario: The patch tool set
- **WHEN** `FILE_TOOLS` is `apply-patch` and `SKILLS_PATH` is unset
- **THEN** the first request's tools are `read`, `apply_patch` and `shell`, in that order, no request offers `write` or `edit`, and the `developer` item names `apply_patch`

#### Scenario: The developer item names the default file tools
- **WHEN** `FILE_TOOLS` is unset
- **THEN** the `developer` item names `read`, `write` and `edit`, and doesn't name `apply_patch`

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
- `WORK_DIR`, the working directory of `read`, the file tools and `shell`. It defaults to the current directory, and a relative path resolves against the current directory. It SHALL name an existing directory, and SHALL be used by its real path, with symbolic links resolved.
- `SKILLS_PATH`, the skills roots (`skills`). When it's unset, no skill is loaded.
- `MAX_STEPS`, the session's step limit: a positive whole number written in decimal digits, defaulting to 30.
- `FILE_TOOLS`, which file tools the model gets: `write-edit` (the default) for `write` and `edit`, or `apply-patch` for `apply_patch`.

`MAX_TURNS`, the step limit's former name, SHALL be invalid whenever it is set, whatever its value, with an `error` record saying that it is now `MAX_STEPS`.

#### Scenario: Defaults apply
- **WHEN** none of the variables is set
- **THEN** the provider is `lmstudio`, the base URL is `http://127.0.0.1:1234/v1`, the key is `lm-studio`, no model is configured, the reasoning effort is `none`, the working directory is the current directory, no skill is loaded, the step limit is 30, and the file tools are `write` and `edit`

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

#### Scenario: An invalid file tools setting
- **WHEN** `FILE_TOOLS` is `both`
- **THEN** no network call is made, an `error` record names `FILE_TOOLS` and its valid values, `write-edit` and `apply-patch`, and the exit code is 1

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
- **WHEN** no skill is loaded, the model's first reply calls `read` for `package.json`, and its second answers
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
- **WHEN** `read` refuses `.env`
- **THEN** a `warn` record `tool failed` carries the tool's error
