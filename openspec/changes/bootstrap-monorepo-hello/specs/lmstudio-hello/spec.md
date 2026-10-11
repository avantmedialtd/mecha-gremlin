## ADDED Requirements

### Requirement: Say hi to the loaded LM Studio model and print the reply
Running the server entry point (`bun run hello` from the repository root) SHALL:
1. resolve the LM Studio model to use;
2. send the input "Hi!" through `core`'s `runTurn` to LM Studio's OpenAI-compatible Responses endpoint at `{LMSTUDIO_BASE_URL}/v1`;
3. print the reply text to stdout, followed by a newline;
4. exit with code 0.

Progress and usage information SHALL go to stderr, not stdout.

#### Scenario: Successful hello
- **WHEN** LM Studio is reachable, has an LLM loaded, and answers the turn with "Hi there!"
- **THEN** stdout is exactly "Hi there!" followed by a newline, stderr names the model used, and the exit code is 0

#### Scenario: Usage is reported on stderr
- **WHEN** the turn completes with usage information
- **THEN** stderr includes the output token count and the elapsed time, and stdout contains only the reply

### Requirement: Use only a model that is already loaded
The server SHALL resolve the model from LM Studio's native `GET {LMSTUDIO_BASE_URL}/api/v1/models` endpoint, and SHALL NOT request a model that isn't currently loaded. A loaded model is an entry of type `llm` with at least one loaded instance.
- When `LMSTUDIO_MODEL` is set, it SHALL match a loaded instance id or a loaded model key.
- When it isn't set, the server SHALL use the first loaded instance. If more than one LLM instance is loaded, it SHALL say on stderr which one it chose.

#### Scenario: No model configured, one loaded
- **WHEN** `LMSTUDIO_MODEL` is unset and exactly one LLM instance, `prism-ml/bonsai-27b`, is loaded
- **THEN** the turn is sent with model `prism-ml/bonsai-27b`

#### Scenario: Several models loaded
- **WHEN** `LMSTUDIO_MODEL` is unset and two LLM instances are loaded
- **THEN** the first instance is used, and stderr says it was chosen out of two, and how to pick another

#### Scenario: Configured model is loaded
- **WHEN** `LMSTUDIO_MODEL` names a loaded instance id or a loaded model key
- **THEN** the turn is sent with that model

#### Scenario: Configured model is not loaded
- **WHEN** `LMSTUDIO_MODEL` names a model that has no loaded instance
- **THEN** no turn is sent, stderr lists the loaded models and suggests `lms load <model>`, and the exit code is 1

#### Scenario: No model loaded
- **WHEN** no LLM instance is loaded
- **THEN** no turn is sent, stderr explains that a model must be loaded (suggesting `lms load <model>`), and the exit code is 1

#### Scenario: Embedding models are ignored
- **WHEN** only an embedding model is loaded
- **THEN** it is treated as "no model loaded"

### Requirement: Configuration from the environment, validated at start-up
The server SHALL read:
- `LMSTUDIO_BASE_URL` (default `http://127.0.0.1:1234`, with any trailing slash removed);
- `LMSTUDIO_API_TOKEN` (default `lm-studio`), sent as a bearer token to both the native and the OpenAI-compatible endpoints;
- `LMSTUDIO_MODEL` (optional);
- `LMSTUDIO_REASONING_EFFORT` (default `none`), sent as `reasoning.effort`.

It SHALL validate them before any network call, and exit with code 1 and a message naming each invalid variable.

#### Scenario: Defaults apply
- **WHEN** none of the variables is set
- **THEN** the base URL is `http://127.0.0.1:1234`, the token is `lm-studio`, no model is configured, and the reasoning effort is `none`

#### Scenario: Invalid base URL
- **WHEN** `LMSTUDIO_BASE_URL` is set to a value that isn't an http or https URL
- **THEN** no network call is made, stderr names `LMSTUDIO_BASE_URL`, and the exit code is 1

#### Scenario: Reasoning effort is passed through
- **WHEN** `LMSTUDIO_REASONING_EFFORT` is `low`
- **THEN** the turn is sent with `reasoning.effort` equal to `low`

### Requirement: Actionable failures
The server SHALL exit with code 1 and a message on stderr that names the cause and a next step, in each of these cases:
- LM Studio is unreachable;
- LM Studio rejects the token;
- the models endpoint returns an unexpected shape;
- the turn fails.

#### Scenario: LM Studio not running
- **WHEN** the connection to `LMSTUDIO_BASE_URL` is refused
- **THEN** stderr says LM Studio isn't reachable at that URL and suggests starting its server (for example `lms server start`), and the exit code is 1

#### Scenario: Token rejected
- **WHEN** LM Studio answers HTTP 401 or 403
- **THEN** stderr says LM Studio requires a valid API token and names `LMSTUDIO_API_TOKEN`, and the exit code is 1

#### Scenario: Turn fails
- **WHEN** `runTurn` resolves to `ok: false`
- **THEN** stderr reports the error kind and detail, nothing is printed to stdout, and the exit code is 1
