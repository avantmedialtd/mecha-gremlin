# agent Specification

## Purpose

The agent's entry point, which calls the configured model through its provider (LM Studio, an OpenAI-compatible Responses service or Claude's Messages API), has it carry out a task through the agent loop with a shell, `read`, the file tools `FILE_TOOLS` chooses, skills and its MCP servers' tools, and logs the answer, with its configuration, the store it opens in the data folder, its failure behaviour, and how it closes the MCP servers, stops the session's processes and closes the store. It runs on Bun, with `bun run agent`, or on Node, with `bun run agent:node`.
## Requirements
### Requirement: Carry out a task through the agent loop, and log the answer
Running the agent from the repository root, as `bun run agent <task file>` or `bun run agent --prompt <task>`, SHALL:
1. take the task from exactly one of:
   - a task file, given as the one positional argument: the file's text, decoded as UTF-8, with leading and trailing whitespace trimmed, whatever its extension. A relative path SHALL resolve against the directory the agent was started in;
   - `--prompt <task>`, or `-p <task>`: that one argument, trimmed.

   From either, the agent SHALL then read the task's frontmatter. A block is frontmatter when the trimmed text's first line is `---`, a later line is `---`, and the lines between parse as a YAML mapping or are empty. The task SHALL be the text after the block's closing line, trimmed, and the block SHALL NOT reach the model. A block whose lines parse as anything else, such as a sentence after a horizontal rule, SHALL stay in the task, and so SHALL a text whose opening `---` no later line closes.
   - The key `mcp`, when present, SHALL be a list of server names, each optionally followed by `?`, and SHALL choose the MCP servers the run connects (`mcp-client`).
   - Any other key SHALL be ignored, with a `warn` record ("Log each model call and tool call").

   The agent SHALL fail with an actionable error, and SHALL NOT start the example browsing task or make a network request:
   - when it gets no task, a task file and `--prompt` together, more than one positional argument, `--prompt` more than once, an unknown option, or a `--prompt` value of only whitespace;
   - when the task file can't be read, has a NUL byte in its first 8 KiB, or holds only whitespace;
   - when the frontmatter's lines aren't valid YAML. The error SHALL name the task file, or `--prompt`, give the lines the frontmatter takes, and give the parser's reason;
   - when `mcp` isn't a list of names: a single name, an empty value, or an item that isn't a server name with an optional `?`. The error SHALL show `mcp: [docs]`, and `mcp: []` for no servers;
   - when `mcp` names a server twice, with or without its `?`;
   - when the task, once its frontmatter is stripped, holds only whitespace.

   A task file SHALL NOT be refused for its name or for where it is: an `.env` file, or a file in the data folder, is a task file like any other. An error about how the task was given SHALL name both ways to give it. One for a task file that doesn't exist SHALL give the absolute path the agent looked at, and name `--prompt`. These errors SHALL be reported together with the configuration's, before the store opens;
2. validate the explicitly configured settings;
3. load the skills `SKILLS_PATH` lists (`skills`);
4. open the store in `DATA_DIR` (`store`) before any network request. When it can't be opened, the agent SHALL log the error and exit with code 1, having made no network request;
5. connect to the MCP servers the task chooses (`mcp-client`), with the signal handlers installed ("Stop the session's processes when the agent ends"). When a required server fails, the agent SHALL exit with code 1 before the first model call;
6. choose the named model;
7. run the provider-bound agent loop, with a step limit of `MAX_STEPS`, with:
   - the tools `read`; then the file tools `FILE_TOOLS` chooses, `write` and `edit` for `write-edit`, or `apply_patch` for `apply-patch`, which, like `read`, resolve a relative path against the working directory; then `shell`, in the working directory; then `activate_skill` when any skill is loaded; then the connected MCP servers' tools (`mcp-client`);
   - starting instructions that say the model carries out tasks on this computer with a shell, `read` for reading text files and the offered file tools for writing and changing them; give the working directory's real path and say that paths commands print are relative to it; ask for a brief final answer; then give the skills catalog when any skill is loaded; and end, when an optional MCP server was left out, with a paragraph naming each left-out server, in name order, with its reason (`mcp-client`);
   - a user input holding the task;
8. log the trimmed answer as an `info` record `answer` with the field `text`;
9. close the MCP servers, stop the session's processes, close the store and exit with code 0.

Responses providers SHALL send the instructions as a developer item to the configured Responses endpoint. Anthropic SHALL send the same instructions as system input to its configured Messages endpoint. Every request SHALL name the configured model and effort in the selected provider's format.

#### Scenario: No task
- **WHEN** the agent runs with no arguments, or with only `-p` and a value of whitespace
- **THEN** it exits with code 1, reports that a task is required, naming a task file and `--prompt`, makes no network call and does not launch the example browser task

#### Scenario: Task from the arguments
- **WHEN** the agent runs with the arguments `-p` and `Which runtime does README.md describe?`, or with `--prompt` and the same text
- **THEN** its first request's user input is "Which runtime does README.md describe?"

#### Scenario: Task from a file
- **WHEN** the agent runs with the argument `task.md`, a file in the directory it was started in that holds "\n  Which runtime does README.md describe?\n\n"
- **THEN** its first request's user input is "Which runtime does README.md describe?"

#### Scenario: Frontmatter is stripped from the task
- **WHEN** the task file holds "---\ntags: [work]\n---\nSay hi\n"
- **THEN** the first request's user input is "Say hi", and a `warn` record `frontmatter key ignored` names `tags`

#### Scenario: A block that isn't frontmatter
- **WHEN** the task file holds "---\nA rule above and below\n---\nSay hi\n"
- **THEN** the first request's user input is "---\nA rule above and below\n---\nSay hi"

#### Scenario: An opening line that nothing closes
- **WHEN** the task file holds "---\nSay hi\n"
- **THEN** the first request's user input is "---\nSay hi"

#### Scenario: Frontmatter that isn't valid YAML
- **WHEN** the task file holds "---\ntitle: Meeting: Q3 plan\n---\nSay hi\n"
- **THEN** it exits with code 1, an error names the file, says that its frontmatter on line 2 isn't valid YAML and gives the parser's reason, and no network call is made

#### Scenario: An mcp value that isn't a list of names
- **WHEN** the task file's frontmatter holds `mcp: docs`, `mcp:`, `mcp: [1]` or `mcp: [docs/x]`
- **THEN** it exits with code 1, the error shows `mcp: [docs]` and `mcp: []`, and no network call is made

#### Scenario: A server named twice
- **WHEN** the task file's frontmatter holds `mcp: [docs, docs?]`
- **THEN** it exits with code 1, the error names `docs`, and no network call is made

#### Scenario: A task that is only frontmatter
- **WHEN** the task file holds "---\nmcp: [docs]\n---\n"
- **THEN** it exits with code 1, reports that the task is blank once its frontmatter is stripped, and makes no network call

#### Scenario: Frontmatter in an inline task
- **WHEN** the agent runs with the argument "--prompt=---\nmcp: []\n---\nSay hi", and the server `docs` is enabled
- **THEN** the first request's user input is "Say hi", and `docs` isn't started

#### Scenario: A task file that doesn't exist
- **WHEN** the agent runs with the argument `Say hi`, and the directory it was started in holds no file of that name
- **THEN** it exits with code 1, the error gives the absolute path of `Say hi` in that directory and names `--prompt`, and no network call is made

#### Scenario: A task file that isn't text
- **WHEN** the task file has a NUL byte in its first 8 KiB, or holds only whitespace
- **THEN** it exits with code 1, an error names the file and why it was refused, and no network call is made

#### Scenario: Any text file is a task file
- **WHEN** the task file is `.env`, a link to `.env`, or a text file inside `DATA_DIR`, holding "Say hi\n"
- **THEN** its first request's user input is "Say hi"

#### Scenario: One way to give the task
- **WHEN** the agent runs with a task file and `-p`, with two positional arguments, with `-p` twice, or with the option `--verbose`
- **THEN** it exits with code 1, an error names both ways to give the task, and no network call is made

#### Scenario: The task's problems come with the configuration's
- **WHEN** `WORK_DIR` doesn't exist, and neither does the task file
- **THEN** the startup errors name both problems, and no network call is made

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

#### Scenario: MCP tools after the built-in ones
- **WHEN** an enabled MCP server named `docs` offers the tool `search`, `SKILLS_PATH` is unset and `FILE_TOOLS` is `write-edit`
- **THEN** the first request offers `read`, `write`, `edit`, `shell` and `mcp__docs__search`, in that order

#### Scenario: A left-out server in the instructions
- **WHEN** the task's list is `[docs, github?]`, and `github` can't start because it needs a new login
- **THEN** the instructions end with a paragraph naming `github` and `bun run mcp login github`, and the first request offers `docs`'s tools and none of `github`'s

#### Scenario: Instructions when every server starts
- **WHEN** the task's list is `[docs, github?]`, and both servers start
- **THEN** the instructions are the same as a run's whose list is `[docs, github]`

### Requirement: Log each model call and tool call
The agent SHALL log, through the structured logger:
- for each key in the task's frontmatter other than `mcp`, in the block's order, a `warn` record `frontmatter key ignored` with `key`, logged before `asking`;
- when at least one skill is loaded, an `info` record `skills` with `names`, the loaded skills' names in sorted order;
- the `skill not loaded` and `skill warning` records that loading skills produces (`skills`);
- when opening the store applied migrations, an `info` record `migrated` with `names`, the migrations' names in the order they ran, logged before `asking`;
- for each MCP server the run chose, in the servers' name order: for one it connected to, its `warn` records and its `info` record `mcp server`; for an optional one it left out, its `warn` record `mcp server left out` (`mcp-client`); logged before `asking`;
- before the first model call, an `info` record `asking` with `model`, `baseUrl`, `run` (the session's run ID), `workDir` (the working directory's real path), `dataDir` (the data folder's real path), `task` (the task's text, as sent), when the task came from a file, `taskFile` (that file's absolute path) and, when the task's frontmatter has an `mcp` list, `mcp` (the list as written, with each name's `?`);
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
- **WHEN** the run ID is a fresh random ID, `WORK_DIR` and `DATA_DIR` name directories, and the task is "Say hi", given with `-p`
- **THEN** the `asking` record's `run` is that ID, its `workDir` and `dataDir` are those directories' real paths, its `task` is "Say hi", and it has no `taskFile` and no `mcp`

#### Scenario: The asking record of a task file
- **WHEN** the task file `task.md`, in the directory the agent was started in, holds "Say hi\n"
- **THEN** the `asking` record's `task` is "Say hi", and its `taskFile` is that file's absolute path

#### Scenario: The asking record of a task with a list
- **WHEN** the task file holds "---\nmcp: [docs, github?]\n---\nSay hi\n", and both servers start
- **THEN** the `asking` record's `task` is "Say hi", and its `mcp` is `docs` and `github?`

#### Scenario: Ignored frontmatter keys
- **WHEN** the task file holds "---\ntags: [work]\nmcps: [docs]\n---\nSay hi\n"
- **THEN** a `warn` record `frontmatter key ignored` with `key` `tags`, then one with `key` `mcps`, come before `asking`

#### Scenario: The skills record
- **WHEN** the skills `pdf` and `browser` are loaded
- **THEN** a `skills` record, logged before `asking`, has `names` `browser` and `pdf`

#### Scenario: Sizes are in bytes
- **WHEN** a tool's output holds characters that take more than one byte in UTF-8
- **THEN** the `tool result` record's `bytes` counts bytes, not characters

#### Scenario: A failed call
- **WHEN** `read` is called for a file that doesn't exist
- **THEN** a `warn` record `tool failed` carries the tool's error

#### Scenario: The migrated record
- **WHEN** the agent runs twice with the same `DATA_DIR`, which starts empty
- **THEN** the first run logs a `migrated` record naming the migrations that create the `credential` table and the `mcp_server` table, in that order, before `asking`, and the second run logs no `migrated` record

#### Scenario: The MCP servers' records
- **WHEN** the MCP servers `b` and `a` are enabled, no skill is loaded, and `DATA_DIR` holds a database already migrated
- **THEN** the records begin with an `mcp server` record for `a`, then one for `b`, then `asking`

### Requirement: Choose the model according to the provider
The agent SHALL require `MODEL` and choose it according to `MODEL_PROVIDER`.
- With `lmstudio`, it SHALL ask LM Studio's native `GET {origin of MODEL_BASE_URL}/api/v1/models` which models are loaded and SHALL NOT request a model that isn't currently loaded. A loaded model is an entry of type `llm` with at least one loaded instance; `MODEL` SHALL match a loaded instance ID or a loaded model key.
- With `openai` or `anthropic`, it SHALL use `MODEL` and SHALL NOT call LM Studio's native API.

#### Scenario: Model is required for LM Studio
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL` is unset
- **THEN** configuration fails before any request, even if LM Studio has a loaded model

#### Scenario: Configured model is loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL` names a loaded instance ID or a loaded model key
- **THEN** the model requests name that configured model

#### Scenario: Configured model is not loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL` names a model with no loaded instance
- **THEN** the model isn't called, an `error` record lists the loaded models and suggests `lms load <model>`, and the exit code is 1

#### Scenario: No model loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio`, `MODEL` is configured and no LLM instance is loaded
- **THEN** the model isn't called, an `error` record explains that the named model must be loaded and suggests `lms load <model>`, and the exit code is 1

#### Scenario: Embedding models are ignored
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and only an embedding model is loaded
- **THEN** no LLM model is considered loaded

#### Scenario: Another provider uses the named model
- **WHEN** `MODEL_PROVIDER` is `openai` or `anthropic` and `MODEL` is `model-test`
- **THEN** the model requests name `model-test` and no request goes to LM Studio's `/api/v1/models`

### Requirement: Read the configuration from the environment, and validate it at start-up
The agent SHALL validate settings with provider-discriminated Zod schemas in `loadConfig`. Trimmed blank values SHALL count as unset. `MODEL_PROVIDER` SHALL be explicitly set to `lmstudio`, `openai` or `anthropic`; each provider SHALL require `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL` and `MODEL_REASONING_EFFORT`. There SHALL be no fallback provider, URL, key, model or effort. A trailing slash on `MODEL_BASE_URL` SHALL be removed; the URL SHALL be HTTP(S) without query or fragment. LM Studio's base URL SHALL retain the existing requirement for a path such as `/v1`. The API key SHALL be passed explicitly to the selected client; LM Studio's models endpoint SHALL receive it as a bearer token.

For `openai` and `lmstudio`, effort SHALL be one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. For `anthropic`, it SHALL be one of `low`, `medium`, `high`, `xhigh` or `max`; `none` and `minimal` SHALL be refused, not silently mapped or ignored. The Anthropic schema SHALL also require `MODEL_MAX_OUTPUT_TOKENS`, a positive safe integer written in decimal digits, and MAY accept `ANTHROPIC_WORKSPACE_ID`. `MODEL_MAX_OUTPUT_TOKENS` SHALL be invalid when a Responses provider is selected. A model-specific restriction on an otherwise valid effort or token limit SHALL be reported from the provider's error rather than guessed from a model catalog.

The agent SHALL also require and validate, whatever the provider:
- `WORK_DIR`, the working directory of `read`, the file tools and `shell`; a relative path resolves against the current directory, it SHALL name an existing directory, and its real path SHALL be used;
- `DATA_DIR`, the data folder that holds the store's database (`store`); a relative path resolves against the current directory, it SHALL name an existing directory, and its real path SHALL be used, whether or not it is the working directory, contains it or lies inside it;
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
- **THEN** configuration succeeds, and the store opens in that directory

### Requirement: Actionable failure messages
The agent SHALL exit with code 1 and log an error naming the cause and a next step if the model server is unreachable, rejects the API key, returns an invalid LM Studio model list, fails a model call, is still calling tools at the step limit, or gives no answer. It SHALL not log an `answer` record in these cases. A model-call failure SHALL include the provider's detail and an appropriate next step:

| Cause | Next step |
|---|---|
| Unreachable | With `lmstudio`, start its server or check `MODEL_BASE_URL`; otherwise check `MODEL_BASE_URL` |
| HTTP 401 or 403 | Check `MODEL_API_KEY` and any required Anthropic workspace ID |
| Timeout | Try again or narrow the task |
| HTTP 429 | Wait and retry; if it persists, check the account's quota |
| Other HTTP 4xx | Check that `MODEL`, effort and any output limit suit the provider |
| HTTP 5xx or broken stream | Try again; if it persists, check the model server |
| Incomplete | Narrow the task or, for an output-token limit, adjust the configured limit |
| Aborted | Run the command again |
| Other | Try again; if it persists, report a bug |

#### Scenario: LM Studio not running
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and the connection is refused
- **THEN** the error says LM Studio isn't reachable at the base URL, suggests starting its server, and the exit code is 1

#### Scenario: LM Studio stops during the session
- **WHEN** LM Studio lists the configured loaded model and then refuses the first model call
- **THEN** the error says LM Studio isn't reachable and suggests `lms server start`

#### Scenario: Another provider is unreachable
- **WHEN** `MODEL_PROVIDER` is `openai` or `anthropic` and the connection is refused
- **THEN** the error names the base URL and suggests checking `MODEL_BASE_URL`, without mentioning LM Studio

#### Scenario: Key rejected by LM Studio
- **WHEN** LM Studio answers HTTP 401 or 403
- **THEN** the error names `MODEL_API_KEY` and the exit code is 1

#### Scenario: Key rejected by another provider
- **WHEN** OpenAI or Anthropic answers HTTP 401
- **THEN** the error names `MODEL_API_KEY` without suggesting an LM Studio fix

#### Scenario: A model call fails
- **WHEN** any model call fails for one of the reasons in the table
- **THEN** the error names the cause, includes its detail and gives its next step, no `answer` record is logged, and the exit code is 1

#### Scenario: Rate limited
- **WHEN** the model endpoint answers HTTP 429 with the message "slow down"
- **THEN** the error says the model server is limiting requests, includes the message and says to wait and try again

#### Scenario: Step limit reached
- **WHEN** the model is still calling tools after the loop's last allowed step
- **THEN** the error names the step limit and suggests a narrower task or higher `MAX_STEPS`, no answer is logged and the exit code is 1

#### Scenario: No answer
- **WHEN** a completed reply holds neither tool calls nor answer text
- **THEN** the error says the model gave no answer, no answer is logged and the exit code is 1

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
Before it exits, whether the session answered or failed or an MCP server failed to start, the agent SHALL close every MCP server, in parallel (`mcp-client`), then await the shell's `dispose()`, then close the store and remove the directory it made for stdio servers, on every path, signals included.
- When `dispose()` stopped any processes, the agent SHALL log an `info` record `stopped` with the field `count`, once.
- When `dispose()` couldn't run its sweep, the agent SHALL log a `warn` record `cleanup failed` with the field `error`, and keep its exit code.
- **Signal handlers:** it SHALL install handlers for SIGINT, SIGTERM and SIGHUP before it connects the MCP servers, and SHALL remove them once it has closed the store.
- **The first signal** SHALL:
  - log a `warn` record `interrupted` with the field `signal`;
  - stop handling the session's steps, or, while the MCP servers are connecting, abort their connections and log no error for them;
  - close the MCP servers, those still connecting included, await `dispose()`, close the store and remove the directory made for stdio servers;
  - exit with code 130 for SIGINT, 143 for SIGTERM or 129 for SIGHUP.

  Signals that arrive while the agent is closing the MCP servers, running `dispose()` or closing the store SHALL be ignored.

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
- **WHEN** the agent ends, after an answer, after a failure, after an MCP server failed to start, or after SIGINT
- **THEN** its store is closed: the data folder holds no `-wal` or `-shm` file, and a new store opens there without error

#### Scenario: A signal while the servers connect
- **WHEN** SIGTERM arrives while a stdio MCP server is starting
- **THEN** an `interrupted` record is logged and no error about the server, none of its processes is left, the directory made for stdio servers is gone, and the exit code is 143

#### Scenario: MCP servers are closed first
- **WHEN** a stdio MCP server is running when the agent answers, and in another run when SIGINT arrives
- **THEN** in both runs none of the server's processes is left, the directory made for stdio servers is gone, and no `stopped` record counts the server's processes

