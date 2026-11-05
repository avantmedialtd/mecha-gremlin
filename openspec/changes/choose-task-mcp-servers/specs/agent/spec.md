## MODIFIED Requirements

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
