## MODIFIED Requirements

### Requirement: Create a session from the configuration and a step limit
The agent SHALL provide an async `createSession(config, options)`. It takes validated configuration, a list of tools each paired with a handler, starting history, and a step limit `maxSteps`. It SHALL choose the explicitly configured `MODEL`; for LM Studio it SHALL first verify that model is loaded. It SHALL create the selected provider's adapter with the configured client settings and send the configured effort on every model call. It SHALL bind that provider for the session's lifetime and reject incompatible provider-tagged native history before a model request.

When the step limit isn't a positive integer, it SHALL resolve to `err(reason)` naming the limit before it chooses the model, so no request at all is sent. When no model can be chosen, it SHALL resolve to `err(reason)` and the model isn't called. Otherwise it SHALL resolve to `ok(session)`, where the session has the chosen `model`, an async generator `steps` and a `history` that starts as a copy of the supplied history, leaves that history unchanged and grows as the session runs.

#### Scenario: A configured model
- **WHEN** the provider is `openai` or `anthropic` and `MODEL` is `test-model`
- **THEN** the session's model is `test-model` and every model request names it

#### Scenario: LM Studio's configured loaded model
- **WHEN** `MODEL` names a model loaded in LM Studio
- **THEN** the session asks LM Studio's native models endpoint first and uses that named model

#### Scenario: No model to use
- **WHEN** LM Studio has no matching loaded model
- **THEN** `createSession` resolves to `ok: false` with an error suggesting `lms load`, and the model isn't called

#### Scenario: A step limit that isn't a positive integer
- **WHEN** the caller sets the step limit to 0, -1, 2.5, `NaN` or `Infinity`, or leaves it out
- **THEN** `createSession` resolves to `ok: false` with an error naming the limit and no request is sent, not even to LM Studio's models endpoint

#### Scenario: The client comes from the configuration
- **WHEN** the provider configuration specifies a base URL and key
- **THEN** every model request uses that provider's configured base URL and API key

#### Scenario: The reasoning effort comes from the configuration
- **WHEN** the configuration's effort is `low`
- **THEN** every Responses request carries `reasoning.effort` `low` and every Claude request carries `output_config.effort` `low`

#### Scenario: The starting history is copied
- **WHEN** a session runs to its end
- **THEN** the history passed at creation is unchanged

#### Scenario: Provider stays fixed
- **WHEN** a session starts with one provider
- **THEN** every step uses that provider and the session never falls back to another provider

### Requirement: Alternate model calls and tool calls until the model answers
In each step, the session SHALL call its bound provider with the model, full replayable history and the same ordered tools. It SHALL append the complete native replay data of the finished call to its history before running tools. It SHALL act on the adapter's Gremlin-owned reply view: `final` is yielded and ends the session; `calls` are handled in order; and `empty` is yielded and ends the session. Provider-specific data SHALL remain in the history as an opaque value to the loop.

#### Scenario: Answer without tools
- **WHEN** the model's first reply answers "42"
- **THEN** the session yields one `final` step with text "42", ends after one request, and history contains the native reply

#### Scenario: One tool round trip
- **WHEN** the model's first reply calls `read`, `call_1`, and its second answers
- **THEN** two requests are sent and the second replays the first request's input, the native first reply and the matching tool result in provider-valid order

#### Scenario: Tools are frozen for the session
- **WHEN** the session sends more than one request
- **THEN** every request offers the same tools in the same order

### Requirement: Run every tool call in order and answer each exactly once
When a reply is `calls`, the session SHALL handle calls one at a time in output order and record exactly one outcome for each call before the next model call. The adapter SHALL format those outcomes in its own protocol. The outcome SHALL be:
- **known tool, valid arguments** (they pass `validateArgs`): the handler's outcome;
- **invalid arguments:** a failure with the `validateArgs` error. The handler is not run;
- **unknown tool** (no tool has the call's name): a failure saying so and listing the available tool names;
- **the handler throws or rejects:** a failure containing the error's message. The session SHALL continue.

#### Scenario: Two calls in one reply
- **WHEN** a reply holds calls A then B
- **THEN** the handler for A runs before B, and the recorded outcomes follow the native reply in that order

#### Scenario: Unknown tool
- **WHEN** the model calls `delete` and only `read` exists
- **THEN** the call's outcome says `delete` is unknown and lists `read`, and the model is called again

#### Scenario: Invalid arguments
- **WHEN** the model calls `read` with arguments that fail validation
- **THEN** the handler doesn't run, and the call's outcome is the validation error

#### Scenario: Handler throws
- **WHEN** a handler throws an error whose message is "disk on fire"
- **THEN** the call's outcome contains "disk on fire", and the model is called again

### Requirement: Stop at the step limit
The session SHALL call the model at most as many times as its step limit. When the last allowed model call still replies with calls, the session SHALL NOT run them. It SHALL record for each one a failed outcome saying it wasn't run because the step limit was reached, then yield a `step_limit` step and end. The adapter SHALL be able to replay those outcomes in the provider's required format.

#### Scenario: The model never stops calling tools
- **WHEN** the step limit is 8 and every reply holds a call
- **THEN** exactly 8 requests are sent, the handler runs 7 times, the session yields 7 `calls` steps then a `step_limit` step, and history records a not-run outcome for the 8th call

### Requirement: End every session with a step, not a throw
The session SHALL NOT throw for model or tool failures. It SHALL yield a last step and end when:
- a model call fails: a `model_call_failed` step carrying its classified error, step number, elapsed time and any available complete or partial provider statistics;
- a reply is `empty`: the empty result with its statistics;
- the history can't be turned into input: a `history` step carrying the adapter's error.

#### Scenario: A later model call fails
- **WHEN** the first reply calls a tool and the second model call fails with HTTP 500
- **THEN** the last step is `model_call_failed`, its error has kind `server_error` and status 500, and history holds the first native reply and its call's outcome

#### Scenario: Failure retains available usage
- **WHEN** a model call reports partial usage before its stream breaks
- **THEN** the last step includes that partial usage, the call's step number and elapsed time

#### Scenario: No answer
- **WHEN** a completed reply holds only reasoning or thinking and no answer or call
- **THEN** the session yields an `empty` step and doesn't call the model again

### Requirement: Yield each step as it completes
The session's `steps` SHALL yield one step per model call as it completes and before the next model call starts:
- `calls`: the reply's calls, each with its outcome, after they have run;
- `final` or `empty`: the reply result, as the last step;
- `step_limit`, `model_call_failed` or `history`: why the session stopped, as the last step.

A step whose model call completed SHALL carry its step number, complete provider statistics when available, and elapsed time. A failed model-call step SHALL carry its number, elapsed time and any available partial or complete statistics. While the caller handles a step, the session SHALL be paused, so its history is the history as of that step.

#### Scenario: A step comes before the next model call
- **WHEN** the first reply calls a tool and the second answers, and the consumer asks for one step at a time
- **THEN** the first step is `calls` while only one request has been sent and history ends with its outcome; the second is `final` with the answer's native data in history; then the session ends

#### Scenario: Calls carry their outcomes
- **WHEN** a reply holds one call that succeeds and one whose arguments fail validation
- **THEN** its `calls` step lists both calls in order with their respective success and validation error
