# model-hello Specification

## Purpose

The server entry point that chooses a model by provider (the model loaded in LM Studio by default, or a named model from any OpenAI-compatible service), asks it a question about a file through the agent loop, and logs the answer, with its configuration and failure behaviour. It runs on Bun or Node.
## Requirements
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

### Requirement: Choose the model according to the provider
The server SHALL choose the model according to `MODEL_PROVIDER`.
- With `lmstudio`, the default, it SHALL ask LM Studio's native `GET {origin of MODEL_BASE_URL}/api/v1/models` which models are loaded, and SHALL NOT request a model that isn't currently loaded. A loaded model is an entry of type `llm` with at least one loaded instance.
  - When `MODEL` is set, it SHALL match a loaded instance id or a loaded model key.
  - When it isn't set, the server SHALL use the first loaded instance. If more than one LLM instance is loaded, it SHALL say which one it chose in an `info` record.
- With any other provider, it SHALL use `MODEL` and SHALL NOT call LM Studio's native API.

#### Scenario: No model configured, one loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio`, `MODEL` is unset, and exactly one LLM instance, `prism-ml/bonsai-27b`, is loaded
- **THEN** the turn is sent with model `prism-ml/bonsai-27b`

#### Scenario: Several models loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio`, `MODEL` is unset, and two LLM instances are loaded
- **THEN** the first instance is used, and an `info` record says it was chosen out of two, and how to pick another

#### Scenario: Configured model is loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL` names a loaded instance id or a loaded model key
- **THEN** the turn is sent with that model

#### Scenario: Configured model is not loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL` names a model that has no loaded instance
- **THEN** no turn is sent, an `error` record lists the loaded models and suggests `lms load <model>`, and the exit code is 1

#### Scenario: No model loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and no LLM instance is loaded
- **THEN** no turn is sent, an `error` record explains that a model must be loaded (suggesting `lms load <model>`), and the exit code is 1

#### Scenario: Embedding models are ignored
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and only an embedding model is loaded
- **THEN** it is treated as "no model loaded"

#### Scenario: Another provider uses the named model
- **WHEN** `MODEL_PROVIDER` is `openai` and `MODEL` is `gpt-test`
- **THEN** the turn is sent with model `gpt-test`, and no request goes to `/api/v1/models`

### Requirement: Configuration from the environment, validated at start-up
The server SHALL read `MODEL_PROVIDER` (`lmstudio` or `openai`; default `lmstudio`), `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL` and `MODEL_REASONING_EFFORT`, with these defaults per provider:

| Variable | `lmstudio` | `openai` |
|---|---|---|
| `MODEL_BASE_URL` | `http://127.0.0.1:1234/v1` | `https://api.openai.com/v1` |
| `MODEL_API_KEY` | `lm-studio` | required |
| `MODEL` | optional | required |
| `MODEL_REASONING_EFFORT` | `none` | unset, so the request carries no `reasoning.effort` |

- A trailing slash on `MODEL_BASE_URL` SHALL be removed.
- The API key SHALL be sent as a bearer token to every endpoint the server calls.
- The server SHALL validate all settings before any network call. If any is invalid or missing, it SHALL exit with code 1 and log an `error` record for each invalid or missing variable, naming it.

#### Scenario: Defaults apply
- **WHEN** none of the variables is set
- **THEN** the provider is `lmstudio`, the base URL is `http://127.0.0.1:1234/v1`, the key is `lm-studio`, no model is configured, and the reasoning effort is `none`

#### Scenario: Another provider's defaults
- **WHEN** `MODEL_PROVIDER` is `openai` and `MODEL_API_KEY` and `MODEL` are set
- **THEN** the base URL is `https://api.openai.com/v1`, and the turn is sent without `reasoning`

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
- **THEN** the turn is sent with `reasoning.effort` equal to `low`

### Requirement: Actionable failures
The server SHALL exit with code 1 and log an `error` record whose message names the cause and a next step, in each of these cases:
- the model server is unreachable;
- the server rejects the API key;
- LM Studio's models endpoint returns an unexpected shape;
- a turn fails;
- the model is still calling tools when the session's turn limit is reached;
- the model gives no answer.

No `answer` record SHALL be logged in these cases.

When a turn fails, the message SHALL include the failure's detail, such as the server's own message, and its next step SHALL depend on why the turn failed:

| The turn failed because | Next step |
|---|---|
| the model server is unreachable | with `lmstudio`, start LM Studio's server (`lms server start`) or set `MODEL_BASE_URL`; otherwise, check `MODEL_BASE_URL` |
| the server rejected the API key (HTTP 401 or 403) | set `MODEL_API_KEY`, as for a key rejected at start-up |
| the server didn't answer in time | try again, or ask about a smaller file |
| the server is limiting requests (HTTP 429) | wait a minute and try again; if it keeps happening, check the account's quota |
| the server rejected the request (any other HTTP 4xx) | check that `MODEL` and `MODEL_REASONING_EFFORT` suit the server |
| the server failed (HTTP 5xx), or the response failed or broke off | try again; if it keeps failing, check the model server |
| the response is incomplete | try a narrower question or a smaller file |
| the turn was aborted | run the command again |
| anything else | try again; if it keeps happening, report it as a bug |

#### Scenario: LM Studio not running
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and the connection to LM Studio is refused
- **THEN** the error says LM Studio isn't reachable at the base URL and suggests starting its server (for example `lms server start`), and the exit code is 1

#### Scenario: LM Studio stops during the session
- **WHEN** `MODEL_PROVIDER` is `lmstudio`, LM Studio lists a loaded model, and then the connection for the first turn is refused
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

#### Scenario: Turn fails
- **WHEN** a turn of the agent loop fails, for any of the reasons in the table
- **THEN** the error names the cause, includes the failure's detail and gives that reason's next step, no `answer` record is logged, and the exit code is 1

#### Scenario: Rate limited
- **WHEN** the Responses endpoint answers HTTP 429 with the message "slow down"
- **THEN** the error says the server is limiting requests, includes "429 slow down", and says to wait a minute and try again

#### Scenario: Turn limit reached
- **WHEN** the model is still calling tools after the loop's last allowed turn
- **THEN** the error says the model didn't answer within the session's turn limit, naming its number of turns, no `answer` record is logged, and the exit code is 1

#### Scenario: No answer
- **WHEN** a turn returns neither tool calls nor text
- **THEN** the error says the model gave no answer, no `answer` record is logged, and the exit code is 1

### Requirement: Run on Bun or on Node
The hello SHALL run on Bun with `bun run hello`, and on Node with `bun run hello:node`, taking the same arguments and settings. `bun run hello:node` SHALL load the `.env` file in the current directory when there is one, and SHALL start without one; other `.env` files that Bun reads, such as `.env.local`, are not read on Node. `packages/server/package.json` SHALL declare both runtimes in `engines`. CI SHALL start the hello on Node.

#### Scenario: On Node
- **WHEN** `bun run hello:node` runs with `MODEL_BASE_URL` set to `http://127.0.0.1:9/v1`, where nothing listens, and there is no `.env`
- **THEN** Node notes on stderr that `.env` wasn't found, an `error` record says LM Studio can't be reached at that URL, and the exit code is 1, as on Bun

#### Scenario: Settings from .env on Node
- **WHEN** the `.env` in the current directory sets `MODEL_PROVIDER` to `nonsense`, and the hello runs on Node with `--env-file-if-exists=.env`
- **THEN** an `error` record names `MODEL_PROVIDER`, and the exit code is 1

#### Scenario: CI starts the hello on Node
- **WHEN** CI's check job runs
- **THEN** it runs `bun run hello:node` with `MODEL_BASE_URL` set to a port where nothing listens, and fails unless the exit code is 1 and the output says LM Studio can't be reached

