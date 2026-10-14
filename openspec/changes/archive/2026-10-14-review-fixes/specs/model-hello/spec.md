## MODIFIED Requirements

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
