## ADDED Requirements

### Requirement: Ask the model a question about a file and print the answer
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
4. print the answer to stdout, trimmed and followed by a newline;
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
- **THEN** the second request carries the file's contents in a `function_call_output`, stdout is exactly "It runs the checks." followed by a newline, and the exit code is 0

### Requirement: Report each tool call and turn on stderr
The hello SHALL write to stderr, as they happen:
- before the first turn, the model, the endpoint and the file being asked about;
- each tool call's name and arguments before it runs, and afterwards the size of its output in bytes, or its error;
- after each turn, the turn number, the input tokens with the cached count, the output tokens with the reasoning count, and the elapsed seconds.

stdout SHALL contain only the answer.

#### Scenario: Progress of a tool round trip
- **WHEN** the first turn calls `read_file` for `package.json` and the second turn answers
- **THEN**:
  - stderr names the model and `package.json`;
  - stderr shows the `read_file` call, its arguments and the size of its output;
  - stderr has one usage line per turn, including the cached token count;
  - stdout contains only the answer.

## MODIFIED Requirements

### Requirement: Actionable failures
The server SHALL exit with code 1 and a message on stderr that names the cause and a next step, in each of these cases:
- the model server is unreachable;
- the server rejects the API key;
- LM Studio's models endpoint returns an unexpected shape;
- a turn fails;
- the model is still calling tools when the turn limit is reached;
- the model gives no answer.

Nothing SHALL be printed to stdout in these cases.

#### Scenario: LM Studio not running
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and the connection to LM Studio is refused
- **THEN** stderr says LM Studio isn't reachable at the base URL and suggests starting its server (for example `lms server start`), and the exit code is 1

#### Scenario: Key rejected by LM Studio
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and LM Studio answers HTTP 401 or 403
- **THEN** stderr says LM Studio requires a valid API key and names `MODEL_API_KEY`, and the exit code is 1

#### Scenario: Key rejected by another provider
- **WHEN** `MODEL_PROVIDER` is `openai` and the Responses endpoint answers HTTP 401
- **THEN** stderr names `MODEL_API_KEY` without mentioning LM Studio, and the exit code is 1

#### Scenario: Turn fails
- **WHEN** a turn of the agent loop fails
- **THEN** stderr reports the error kind and detail, nothing is printed to stdout, and the exit code is 1

#### Scenario: Turn limit reached
- **WHEN** the model is still calling tools after the loop's last allowed turn
- **THEN** stderr says the model didn't answer within the turn limit, nothing is printed to stdout, and the exit code is 1

#### Scenario: No answer
- **WHEN** a turn returns neither tool calls nor text
- **THEN** stderr says the model gave no answer, nothing is printed to stdout, and the exit code is 1

## REMOVED Requirements

### Requirement: Say hi to the configured model and print the reply
**Reason**: The hello now asks the model a question about a file through the agent loop, instead of sending "Hi!".
**Migration**: Run `bun run hello` with no arguments for the default question, or `bun run hello <file> <question>`.
