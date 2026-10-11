## ADDED Requirements

### Requirement: Run one streamed, stateless model turn
The `core` package SHALL provide a `runTurn(client, request, options?)` function. It SHALL send `request` to the Responses API of the given `openai` client as a streamed request (`stream: true`), with `store` defaulting to `false` when the request doesn't set it. It SHALL resolve to a result value rather than throwing for model, HTTP or transport failures.

#### Scenario: Request is streamed and stateless by default
- **WHEN** `runTurn` is called with a request that sets neither `stream` nor `store`
- **THEN** the HTTP request it sends to `/responses` has `stream: true` and `store: false`

#### Scenario: Caller's explicit store setting is kept
- **WHEN** `runTurn` is called with `store: true`
- **THEN** the HTTP request it sends has `store: true`

### Requirement: Return the reply text and usage on completion
When the stream ends with a `response.completed` event, `runTurn` SHALL resolve to `{ ok: true }`. The result SHALL carry: `text`, the concatenation of every `output_text` part of every `message` item in the completed response, in order; `response`, the completed response; and `usage`, the response's usage.

#### Scenario: Completed turn
- **WHEN** the endpoint streams a turn that completes with the message text "Hello there!" and usage of 12 output tokens
- **THEN** `runTurn` resolves to `ok: true` with `text` equal to "Hello there!" and `usage.output_tokens` equal to 12

#### Scenario: Reasoning items are not part of the text
- **WHEN** the completed response contains a `reasoning` item followed by a `message` item with text "Hi!"
- **THEN** `text` is "Hi!"

### Requirement: Classify failures as values
`runTurn` SHALL resolve to `{ ok: false, error, detail }` instead of throwing. `error` SHALL be one of `unreachable`, `timeout`, `auth`, `rate_limit`, `bad_request`, `server_error`, `incomplete`, `failed`, `aborted` or `fatal`. HTTP failures SHALL also carry `status`. Classification SHALL use the error's HTTP status, the error's class name (including inherited classes), and the caller's abort signal, not `instanceof` checks.

#### Scenario: Endpoint not reachable
- **WHEN** the connection to the endpoint fails before any HTTP response
- **THEN** `runTurn` resolves to `ok: false` with `error` equal to `unreachable`

#### Scenario: Authentication rejected
- **WHEN** the endpoint answers HTTP 401
- **THEN** `runTurn` resolves to `ok: false` with `error` equal to `auth` and `status` equal to 401

#### Scenario: Server error
- **WHEN** the endpoint answers HTTP 500
- **THEN** `runTurn` resolves to `ok: false` with `error` equal to `server_error` and `status` equal to 500

#### Scenario: Turn ends incomplete
- **WHEN** the stream ends with a `response.incomplete` event
- **THEN** `runTurn` resolves to `ok: false` with `error` equal to `incomplete`, and `detail` names the incomplete reason when one is given

#### Scenario: Turn fails mid-stream
- **WHEN** the stream ends with a `response.failed` event carrying an error message
- **THEN** `runTurn` resolves to `ok: false` with `error` equal to `failed`, and `detail` contains that message

#### Scenario: Stream ends without a terminal event
- **WHEN** the event stream ends without a `response.completed`, `response.incomplete` or `response.failed` event
- **THEN** `runTurn` resolves to `ok: false` with `error` equal to `failed`

#### Scenario: Caller aborts
- **WHEN** the caller's abort signal fires while the turn is in progress
- **THEN** `runTurn` resolves to `ok: false` with `error` equal to `aborted`

### Requirement: Core stays free of configuration and side effects
The `core` package SHALL NOT read environment variables, write to stdout or stderr, or construct API clients. It SHALL declare `openai` as a peer dependency.

#### Scenario: Core has no environment or console access
- **WHEN** the `core` package source is inspected
- **THEN** it contains no references to `process.env`, `Bun.env` or `console`, and its `package.json` lists `openai` under `peerDependencies`
