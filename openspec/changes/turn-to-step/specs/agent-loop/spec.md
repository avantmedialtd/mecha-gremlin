## ADDED Requirements

### Requirement: Create a session from the configuration and a step limit
The server SHALL provide an async `createSession(config, options)`. It takes the server's configuration, plus a list of tools each paired with a handler, a starting history, and a step limit, `maxSteps`. It SHALL:
- choose the model as the server's model choice describes: LM Studio's loaded model, or `MODEL` for another provider;
- build its own `openai` client from the configuration's base URL and API key;
- send the configured reasoning effort, when there is one, with every model call.

When the step limit isn't a positive integer, it SHALL resolve to `err(reason)` naming the limit, before it chooses the model, so no request at all is sent. When no model can be chosen, it SHALL resolve to `err(reason)`, and the model isn't called. Otherwise it SHALL resolve to `ok(session)`, where the session has:
- `model`: the chosen model;
- `note`: when the model was picked out of several, which one, and how to pick another;
- `steps`: an async generator of the session's steps;
- `history`: the session's history. It starts as a copy of the starting history, which is left unchanged, and grows as the session runs.

#### Scenario: Another provider's configured model
- **WHEN** the provider is `openai` and `MODEL` is `test-model`
- **THEN** the session's model is `test-model`, and every request names it

#### Scenario: LM Studio's loaded model
- **WHEN** the provider is `lmstudio` and LM Studio has `prism-ml/bonsai-27b` loaded
- **THEN** the session asks LM Studio's native models endpoint first, its model is `prism-ml/bonsai-27b`, and every request names it

#### Scenario: No model to use
- **WHEN** the provider is `lmstudio` and LM Studio has no model loaded
- **THEN** `createSession` resolves to `ok: false` with an error that suggests `lms load`, and the model isn't called

#### Scenario: A step limit that isn't a positive integer
- **WHEN** the caller sets the step limit to 0, -1, 2.5, `NaN` or `Infinity`, or leaves it out
- **THEN** `createSession` resolves to `ok: false` with an error naming the limit, and no request is sent, not even to LM Studio's models endpoint

#### Scenario: The client comes from the configuration
- **WHEN** a session runs with a configuration whose base URL is `http://model.test/v1` and whose key is `test-key`
- **THEN** every request goes to `http://model.test/v1/responses` with the bearer key `test-key`

#### Scenario: The reasoning effort comes from the configuration
- **WHEN** the configuration's reasoning effort is `low`
- **THEN** every request carries `reasoning.effort` `low`, and with no effort configured no request carries `reasoning`

#### Scenario: The starting history is copied
- **WHEN** a session runs to its end
- **THEN** the array passed as its starting history is unchanged

### Requirement: Alternate model calls and tool calls until the model answers
In each step, the session SHALL:
1. call the model through `core`'s `callModel` with:
   - the model;
   - `input` from `toInput(history)`;
   - `tools` from `toFunctionTool` of every tool, identical in every model call;
2. append every output item of the completed model call to the history, in order;
3. classify the reply with `classify`. When it is `final`, the session SHALL yield that result as a step, and end.

#### Scenario: Answer without tools
- **WHEN** the model's first reply answers "42"
- **THEN** the session yields one `final` step with the text "42" and ends, one request was sent, and its history ends with that reply's `message` item

#### Scenario: One tool round trip
- **WHEN** the model's first reply calls `read_file`, `call_1`, and its second answers
- **THEN** two requests were sent. The second request's `input` is:
  1. the first request's `input`;
  2. then the first reply's output items;
  3. then a `function_call_output` for `call_1` holding the handler's output.

#### Scenario: Tools are frozen for the session
- **WHEN** the session sends more than one request
- **THEN** every request carries the same `tools`

### Requirement: Run every tool call in order and answer each exactly once
When a reply is `calls`, the session SHALL handle the calls one at a time, in output order. Before its next model call, it SHALL append exactly one `function_call_output` per call, carrying the call's `call_id`, built with `toOutputItem` from the call's outcome. The outcome SHALL be:
- **known tool, valid arguments** (they pass `validateArgs`): the handler's outcome;
- **invalid arguments:** a failure with the `validateArgs` error. The handler is not run;
- **unknown tool** (no tool has the call's name): a failure saying so and listing the available tool names;
- **the handler throws or rejects:** a failure containing the error's message. The session SHALL continue.

#### Scenario: Two calls in one reply
- **WHEN** a reply holds the calls `call_a` then `call_b`
- **THEN** the handler runs for `call_a` before `call_b`, and their outputs follow the reply's items in the history, in that order

#### Scenario: Unknown tool
- **WHEN** the model calls `write_file` and only `read_file` exists
- **THEN** the call's output says `write_file` is unknown and lists `read_file`, and the model is called again

#### Scenario: Invalid arguments
- **WHEN** the model calls `read_file` with arguments that fail validation
- **THEN** the handler doesn't run, and the call's output is the validation error

#### Scenario: Handler throws
- **WHEN** a handler throws an error whose message is "disk on fire"
- **THEN** the call's output contains "disk on fire", and the model is called again

### Requirement: Stop at the step limit
The session SHALL call the model at most as many times as its step limit. When the last allowed model call still replies with calls, the session SHALL NOT run them. It SHALL append for each one a failed output saying it wasn't run because the step limit was reached, then yield a `step_limit` step, and end.

#### Scenario: The model never stops calling tools
- **WHEN** the step limit is 8, and every reply holds a call
- **THEN**:
  - exactly 8 requests are sent;
  - the handler runs 7 times;
  - the session yields 7 `calls` steps and then a `step_limit` step;
  - in the session's history, the 8th reply's call has an output saying it wasn't run.

### Requirement: End every session with a step, not a throw
The session SHALL NOT throw for model or tool failures. It SHALL yield a last step, and end, when:
- a model call fails: a `model_call_failed` step carrying `callModel`'s error as it is: its kind, detail and HTTP status;
- a reply is `empty`: `classify`'s `empty` result;
- the history can't be turned into input: a `history` step carrying `toInput`'s error.

#### Scenario: A later model call fails
- **WHEN** the model's first reply calls a tool, and the second model call fails with HTTP 500
- **THEN** the last step is `model_call_failed`, its error has the kind `server_error` and status 500, and the session's history holds the first reply's items and the call's output

#### Scenario: No answer
- **WHEN** a reply holds only a `reasoning` item
- **THEN** the session yields an `empty` step, and doesn't call the model again

### Requirement: Yield each step as it completes
The session's `steps` SHALL yield one step per model call, as the step completes and before the next model call starts:
- `calls`: the reply's calls, each with its outcome, after they have run;
- `final` or `empty`: `classify`'s result, as it is. It is the last step;
- `step_limit`, `model_call_failed` or `history`: why the session stopped. It is the last step.

A step whose model call completed SHALL carry its `stats`: the step's number, the model call's usage, and its elapsed time. While the caller handles a step, the session SHALL be paused, so its history is the history as of that step.

#### Scenario: A step comes before the next model call
- **WHEN** the model's first reply calls a tool and its second answers, and the consumer asks for one step at a time
- **THEN**:
  - the first step is `calls`;
  - when it arrives, only one request has been sent, and the history ends with the call's output;
  - the second step is `final`, and the history then ends with the answer's `message` item;
  - then the session ends.

#### Scenario: Calls carry their outcomes
- **WHEN** a reply holds a call that succeeds and one whose arguments fail validation
- **THEN** its `calls` step lists both calls in order: the first with its output, the second with the validation error

## REMOVED Requirements

### Requirement: Create a session from the configuration
**Reason**: Replaced by "Create a session from the configuration and a step limit". The caller must now set the limit, `maxSteps`, and the session no longer defaults to 8.
**Migration**: Pass `maxSteps` to `createSession`; the server passes `MAX_STEPS`.

### Requirement: Alternate model turns and tool calls until the model answers
**Reason**: Replaced by "Alternate model calls and tool calls until the model answers", which calls the model through `callModel`.
**Migration**: None; the session sends the same requests.

### Requirement: Run every call in order and answer each exactly once
**Reason**: Replaced by "Run every tool call in order and answer each exactly once", whose scenarios speak of replies rather than turns.
**Migration**: None.

### Requirement: Stop at the turn limit
**Reason**: Replaced by "Stop at the step limit": the `turn_limit` step is now `step_limit`.
**Migration**: Match `step_limit` where `turn_limit` was matched.

### Requirement: End with a step, not a throw
**Reason**: Replaced by "End every session with a step, not a throw": the `turn_failed` step is now `model_call_failed`, carrying a `ModelCallError`.
**Migration**: Match `model_call_failed` where `turn_failed` was matched.

### Requirement: Yield the result of each turn as it completes
**Reason**: Replaced by "Yield each step as it completes": a step's stats are `StepStats`, carried as `stats` rather than `turn`.
**Migration**: Read `step.stats` where `step.turn` was read.
