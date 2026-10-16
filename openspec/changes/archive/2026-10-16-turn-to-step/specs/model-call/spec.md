## ADDED Requirements

### Requirement: Call the model once, streamed and stateless
The `core` package SHALL provide a `callModel(client, request, options?)` function, exported as `@mecha-gremlin/core/model-call`. It SHALL send `request` to the Responses API of the given `openai` client as a streamed request (`stream: true`), with `store` defaulting to `false` when the request doesn't set it. It SHALL resolve to a result value rather than throwing for model, HTTP or transport failures.

#### Scenario: Request is streamed and stateless by default
- **WHEN** `callModel` is called with a request that sets neither `stream` nor `store`
- **THEN** the HTTP request it sends to `/responses` has `stream: true` and `store: false`

#### Scenario: Caller's explicit store setting is kept
- **WHEN** `callModel` is called with `store: true`
- **THEN** the HTTP request it sends has `store: true`

### Requirement: Return the reply text and usage when the call completes
When the stream ends with a `response.completed` event, `callModel` SHALL resolve to `ok(value)`. The value SHALL carry: `text`, the concatenation of every `output_text` part of every `message` item in the completed response, in order; `response`, the completed response; and `usage`, the response's usage.

#### Scenario: Completed call
- **WHEN** the endpoint streams a response that completes with the message text "Hello there!" and usage of 12 output tokens
- **THEN** `callModel` resolves to `ok: true` with `value.text` equal to "Hello there!" and `value.usage.output_tokens` equal to 12

#### Scenario: Reasoning items are not part of the text
- **WHEN** the completed response contains a `reasoning` item followed by a `message` item with text "Hi!"
- **THEN** `value.text` is "Hi!"

### Requirement: Classify a call's failures as values
`callModel` SHALL resolve to `err(error)` instead of throwing, where `error` is `{ kind, detail }`. `kind` SHALL be one of `unreachable`, `timeout`, `auth`, `rate_limit`, `bad_request`, `server_error`, `incomplete`, `failed`, `aborted` or `fatal`. HTTP failures SHALL also carry `status`. Classification SHALL use the error's HTTP status, the error's class name (including inherited classes), and the caller's abort signal, not `instanceof` checks.

#### Scenario: Endpoint not reachable
- **WHEN** the connection to the endpoint fails before any HTTP response
- **THEN** `callModel` resolves to `ok: false` with `error.kind` equal to `unreachable`

#### Scenario: Authentication rejected
- **WHEN** the endpoint answers HTTP 401
- **THEN** `callModel` resolves to `ok: false` with `error.kind` equal to `auth` and `error.status` equal to 401

#### Scenario: Server error
- **WHEN** the endpoint answers HTTP 500
- **THEN** `callModel` resolves to `ok: false` with `error.kind` equal to `server_error` and `error.status` equal to 500

#### Scenario: Response ends incomplete
- **WHEN** the stream ends with a `response.incomplete` event
- **THEN** `callModel` resolves to `ok: false` with `error.kind` equal to `incomplete`, and `error.detail` names the incomplete reason when one is given

#### Scenario: Response fails mid-stream
- **WHEN** the stream ends with a `response.failed` event carrying an error message
- **THEN** `callModel` resolves to `ok: false` with `error.kind` equal to `failed`, and `error.detail` contains that message

#### Scenario: Stream ends without a terminal event
- **WHEN** the event stream ends without a `response.completed`, `response.incomplete` or `response.failed` event
- **THEN** `callModel` resolves to `ok: false` with `error.kind` equal to `failed`

#### Scenario: Caller aborts
- **WHEN** the caller's abort signal fires while the call is in progress
- **THEN** `callModel` resolves to `ok: false` with `error.kind` equal to `aborted`

## REMOVED Requirements

### Requirement: Run one streamed, stateless model turn
**Reason**: Replaced by "Call the model once, streamed and stateless": `runTurn` is now `callModel`, in `@mecha-gremlin/core/model-call`.
**Migration**: Import `callModel` from `@mecha-gremlin/core/model-call` where `runTurn` was imported from `@mecha-gremlin/core/turn`.

### Requirement: Return the reply text and usage on completion
**Reason**: Replaced by "Return the reply text and usage when the call completes", which names `callModel` and retitles its scenario.
**Migration**: None.

### Requirement: Classify failures as values
**Reason**: Replaced by "Classify a call's failures as values". The error is a `ModelCallError` of a `ModelCallErrorKind`, with the same kinds as before.
**Migration**: Use `ModelCallError` and `ModelCallErrorKind` where `TurnError` and `TurnErrorKind` were used.
