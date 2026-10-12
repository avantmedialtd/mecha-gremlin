## ADDED Requirements

### Requirement: Ask the model a question about a file and log the answer
Running the server entry point, `bun run hello [file] [question…]` from the repository root, SHALL:
1. choose the model to use;
2. take the file and the question from the arguments:
   - the file is the first argument, defaulting to `package.json`;
   - the question is the remaining arguments, joined with spaces;
   - with no arguments, the question SHALL be "What exact command does the check script run? Quote it.";
   - with only a file, the question SHALL be "What is this file for? Answer in two or three sentences.";
3. run the agent loop with:
   - the `read_file` tool, rooted at the working directory;
   - a starting `developer` item telling the model to read files with `read_file` before answering questions about them;
   - a `user` item naming the file and the question;
4. log the trimmed answer as an `info` record `answer` with the field `text`;
5. exit with code 0.

Every turn SHALL go to the OpenAI-compatible Responses endpoint at `{MODEL_BASE_URL}/responses` with the chosen model and, when one is configured, `reasoning.effort`.

#### Scenario: Default question
- **WHEN** the hello runs with no arguments
- **THEN** the first request's `user` item names `package.json` and asks what the check script runs

#### Scenario: File and question from the arguments
- **WHEN** the hello runs with the arguments `README.md`, `Which` and `runtime?`
- **THEN** the first request's `user` item names `README.md` and asks "Which runtime?"

#### Scenario: File only
- **WHEN** the hello runs with the single argument `README.md`
- **THEN** the first request's `user` item names `README.md` and asks what the file is for

#### Scenario: Answer after reading the file
- **WHEN** the working directory holds `package.json`, the first turn calls `read_file` for it, and the second turn answers "\n\nIt runs the checks."
- **THEN** the second request carries the file's contents in a `function_call_output`, the `answer` record's `text` is "It runs the checks.", and the exit code is 0

### Requirement: Log each tool call and turn
The hello SHALL log, through the structured logger:
- before the first turn, an `info` record `asking` with the fields `model`, `baseUrl`, `file` and `question`;
- as each turn completes, an `info` record `turn`. Its fields are `number`, `seconds` (rounded to a tenth) and, when the server reports them, `inputTokens`, `cachedTokens`, `outputTokens` and `reasoningTokens`;
- then, for each of the turn's tool calls:
  - an `info` record `tool call` with the fields `tool` and `arguments`. The arguments are logged as JSON when they parse, and as the model sent them otherwise;
  - then an `info` record `tool result` with the fields `tool` and `bytes`, or a `warn` record `tool failed` with the fields `tool` and `error`.

#### Scenario: Records of a tool round trip
- **WHEN** the first turn calls `read_file` for `package.json` and the second turn answers
- **THEN** the records are, in order: `asking`, `turn` 1 with its token counts, `tool call` with `arguments` `{ "path": "package.json" }`, `tool result` with the output's size in bytes, `turn` 2, and `answer`

#### Scenario: Sizes are in bytes
- **WHEN** a tool's output holds characters that take more than one byte in UTF-8
- **THEN** the `tool result` record's `bytes` counts bytes, not characters

#### Scenario: A failed call
- **WHEN** `read_file` refuses `.env`
- **THEN** a `warn` record `tool failed` carries the tool's error

## MODIFIED Requirements

### Requirement: Actionable failures
The server SHALL exit with code 1 and log an `error` record whose message names the cause and a next step, in each of these cases:
- the model server is unreachable;
- the server rejects the API key;
- LM Studio's models endpoint returns an unexpected shape;
- a turn fails;
- the model is still calling tools when the turn limit is reached;
- the model gives no answer.

No `answer` record SHALL be logged in these cases.

#### Scenario: LM Studio not running
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and the connection to LM Studio is refused
- **THEN** the error says LM Studio isn't reachable at the base URL and suggests starting its server (for example `lms server start`), and the exit code is 1

#### Scenario: Key rejected by LM Studio
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and LM Studio answers HTTP 401 or 403
- **THEN** the error says LM Studio requires a valid API key and names `MODEL_API_KEY`, and the exit code is 1

#### Scenario: Key rejected by another provider
- **WHEN** `MODEL_PROVIDER` is `openai` and the Responses endpoint answers HTTP 401
- **THEN** the error names `MODEL_API_KEY` without mentioning LM Studio, and the exit code is 1

#### Scenario: Turn fails
- **WHEN** a turn of the agent loop fails
- **THEN** the error reports the error kind and detail, no `answer` record is logged, and the exit code is 1

#### Scenario: Turn limit reached
- **WHEN** the model is still calling tools after the loop's last allowed turn
- **THEN** the error says the model didn't answer within the turn limit, no `answer` record is logged, and the exit code is 1

#### Scenario: No answer
- **WHEN** a turn returns neither tool calls nor text
- **THEN** the error says the model gave no answer, no `answer` record is logged, and the exit code is 1

## REMOVED Requirements

### Requirement: Say hi to the configured model and print the reply
**Reason**: The hello now asks the model a question about a file through the agent loop, instead of sending "Hi!".
**Migration**: Run `bun run hello` with no arguments for the default question, or `bun run hello <file> <question>`.
