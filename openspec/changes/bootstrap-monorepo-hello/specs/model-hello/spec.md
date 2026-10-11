## ADDED Requirements

### Requirement: Say hi to the configured model and print the reply
Running the server entry point (`bun run hello` from the repository root) SHALL:
1. choose the model to use;
2. send the input "Hi!" through `core`'s `runTurn` to the OpenAI-compatible Responses endpoint at `{MODEL_BASE_URL}/responses`;
3. print the reply text to stdout, followed by a newline;
4. exit with code 0.

Progress and usage information SHALL go to stderr, not stdout.

#### Scenario: Successful hello
- **WHEN** the model server is reachable, a model is chosen, and the turn answers "Hi there!"
- **THEN** stdout is exactly "Hi there!" followed by a newline, stderr names the model used, and the exit code is 0

#### Scenario: Usage is reported on stderr
- **WHEN** the turn completes with usage information
- **THEN** stderr includes the output token count and the elapsed time, and stdout contains only the reply

### Requirement: Choose the model according to the provider
The server SHALL choose the model according to `MODEL_PROVIDER`.
- With `lmstudio`, the default, it SHALL ask LM Studio's native `GET {origin of MODEL_BASE_URL}/api/v1/models` which models are loaded, and SHALL NOT request a model that isn't currently loaded. A loaded model is an entry of type `llm` with at least one loaded instance.
  - When `MODEL` is set, it SHALL match a loaded instance id or a loaded model key.
  - When it isn't set, the server SHALL use the first loaded instance. If more than one LLM instance is loaded, it SHALL say on stderr which one it chose.
- With any other provider, it SHALL use `MODEL` and SHALL NOT call LM Studio's native API.

#### Scenario: No model configured, one loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio`, `MODEL` is unset, and exactly one LLM instance, `prism-ml/bonsai-27b`, is loaded
- **THEN** the turn is sent with model `prism-ml/bonsai-27b`

#### Scenario: Several models loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio`, `MODEL` is unset, and two LLM instances are loaded
- **THEN** the first instance is used, and stderr says it was chosen out of two, and how to pick another

#### Scenario: Configured model is loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL` names a loaded instance id or a loaded model key
- **THEN** the turn is sent with that model

#### Scenario: Configured model is not loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL` names a model that has no loaded instance
- **THEN** no turn is sent, stderr lists the loaded models and suggests `lms load <model>`, and the exit code is 1

#### Scenario: No model loaded
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and no LLM instance is loaded
- **THEN** no turn is sent, stderr explains that a model must be loaded (suggesting `lms load <model>`), and the exit code is 1

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
- The server SHALL validate all settings before any network call. If any is invalid or missing, it SHALL exit with code 1 and a message naming each invalid or missing variable.

#### Scenario: Defaults apply
- **WHEN** none of the variables is set
- **THEN** the provider is `lmstudio`, the base URL is `http://127.0.0.1:1234/v1`, the key is `lm-studio`, no model is configured, and the reasoning effort is `none`

#### Scenario: Another provider's defaults
- **WHEN** `MODEL_PROVIDER` is `openai` and `MODEL_API_KEY` and `MODEL` are set
- **THEN** the base URL is `https://api.openai.com/v1`, and the turn is sent without `reasoning`

#### Scenario: Required settings are missing
- **WHEN** `MODEL_PROVIDER` is `openai` and neither `MODEL_API_KEY` nor `MODEL` is set
- **THEN** no network call is made, stderr names both variables, and the exit code is 1

#### Scenario: Invalid base URL
- **WHEN** `MODEL_BASE_URL` is set to a value that isn't an http or https URL
- **THEN** no network call is made, stderr names `MODEL_BASE_URL`, and the exit code is 1

#### Scenario: LM Studio's base URL lacks /v1
- **WHEN** `MODEL_PROVIDER` is `lmstudio` and `MODEL_BASE_URL` has no path, such as `http://127.0.0.1:1234`
- **THEN** no network call is made, stderr explains that LM Studio's base URL ends in `/v1`, and the exit code is 1

#### Scenario: Unknown provider
- **WHEN** `MODEL_PROVIDER` is neither `lmstudio` nor `openai`
- **THEN** no network call is made, stderr names `MODEL_PROVIDER`, and the exit code is 1

#### Scenario: Reasoning effort is passed through
- **WHEN** `MODEL_REASONING_EFFORT` is `low`
- **THEN** the turn is sent with `reasoning.effort` equal to `low`

### Requirement: Actionable failures
The server SHALL exit with code 1 and a message on stderr that names the cause and a next step, in each of these cases:
- the model server is unreachable;
- the server rejects the API key;
- LM Studio's models endpoint returns an unexpected shape;
- the turn fails.

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
- **WHEN** `runTurn` resolves to `ok: false`
- **THEN** stderr reports the error kind and detail, nothing is printed to stdout, and the exit code is 1
