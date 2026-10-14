# agent-loop Specification

## Purpose

The server's loop that alternates model turns and tool calls until the model answers, with its turn cap, call ordering and failure handling.

## Requirements

### Requirement: Create a session from the configuration
The server SHALL provide an async `createSession(config, options)`. It takes the server's configuration, plus a list of tools each paired with a handler, and a starting history. It SHALL:
- choose the model as the server's model choice describes: LM Studio's loaded model, or `MODEL` for another provider;
- build its own `openai` client from the configuration's base URL and API key;
- send the configured reasoning effort, when there is one, with every turn.

When the caller sets a turn limit that isn't a positive integer, it SHALL resolve to `err(reason)` naming the limit, before it chooses the model, so no request at all is sent. When no model can be chosen, it SHALL resolve to `err(reason)`, and no turn is sent. Otherwise it SHALL resolve to `ok(session)`, where the session has:
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
- **THEN** `createSession` resolves to `ok: false` with an error that suggests `lms load`, and no turn is sent

#### Scenario: A turn limit that isn't a positive integer
- **WHEN** the caller sets the turn limit to 0, -1, 2.5, `NaN` or `Infinity`
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

### Requirement: Alternate model turns and tool calls until the model answers
On each turn, the session SHALL:
1. send a request through `core`'s `runTurn` with:
   - the model;
   - `input` from `toInput(history)`;
   - `tools` from `toFunctionTool` of every tool, identical on every turn;
2. append every output item of the completed turn to the history, in order;
3. classify the output with `classify`. When it is `final`, the session SHALL yield that result as a step, and end.

#### Scenario: Answer without tools
- **WHEN** the first turn answers "42"
- **THEN** the session yields one `final` step with the text "42" and ends, one request was sent, and its history ends with that turn's `message` item

#### Scenario: One tool round trip
- **WHEN** the first turn returns a `read_file` call, `call_1`, and the second turn answers
- **THEN** two requests were sent. The second request's `input` is:
  1. the first request's `input`;
  2. then the first turn's output items;
  3. then a `function_call_output` for `call_1` holding the handler's output.

#### Scenario: Tools are frozen for the session
- **WHEN** the session sends more than one request
- **THEN** every request carries the same `tools`

### Requirement: Run every call in order and answer each exactly once
When a turn's output is `calls`, the session SHALL handle the calls one at a time, in output order. Before it sends the next turn, it SHALL append exactly one `function_call_output` per call, carrying the call's `call_id`, built with `toOutputItem` from the call's outcome. The outcome SHALL be:
- **known tool, valid arguments** (they pass `validateArgs`): the handler's outcome;
- **invalid arguments:** a failure with the `validateArgs` error. The handler is not run;
- **unknown tool** (no tool has the call's name): a failure saying so and listing the available tool names;
- **the handler throws or rejects:** a failure containing the error's message. The session SHALL continue.

#### Scenario: Two calls in one turn
- **WHEN** a turn returns the calls `call_a` then `call_b`
- **THEN** the handler runs for `call_a` before `call_b`, and their outputs follow the turn's items in the history, in that order

#### Scenario: Unknown tool
- **WHEN** the model calls `write_file` and only `read_file` exists
- **THEN** the call's output says `write_file` is unknown and lists `read_file`, and the next turn is sent

#### Scenario: Invalid arguments
- **WHEN** the model calls `read_file` with arguments that fail validation
- **THEN** the handler doesn't run, and the call's output is the validation error

#### Scenario: Handler throws
- **WHEN** a handler throws an error whose message is "disk on fire"
- **THEN** the call's output contains "disk on fire", and the next turn is sent

### Requirement: Stop at the turn limit
The session SHALL send at most 8 turns unless the caller sets another limit. When the last allowed turn still returns calls, the session SHALL NOT run them. It SHALL append for each one a failed output saying it wasn't run because the turn limit was reached, then yield a `turn_limit` step, and end.

#### Scenario: The model never stops calling tools
- **WHEN** every turn returns a call
- **THEN**:
  - exactly 8 requests are sent;
  - the handler runs 7 times;
  - the session yields 7 `calls` steps and then a `turn_limit` step;
  - in the session's history, the 8th turn's call has an output saying it wasn't run.

### Requirement: End with a step, not a throw
The session SHALL NOT throw for model or tool failures. It SHALL yield a last step, and end, when:
- a turn fails: a `turn_failed` step carrying `runTurn`'s error as it is: its kind, detail and HTTP status;
- a turn's output is `empty`: `classify`'s `empty` result;
- the history can't be turned into input: a `history` step carrying `toInput`'s error.

#### Scenario: A later turn fails
- **WHEN** the first turn returns a call and the second turn fails with HTTP 500
- **THEN** the last step is `turn_failed`, its error has the kind `server_error` and status 500, and the session's history holds the first turn's items and the call's output

#### Scenario: No answer
- **WHEN** a turn's output holds only a `reasoning` item
- **THEN** the session yields an `empty` step, and no further turn is sent

### Requirement: Yield the result of each turn as it completes
The session's `steps` SHALL yield one step per model turn, as the turn completes and before the next turn starts:
- `calls`: the turn's calls, each with its outcome, after they have run;
- `final` or `empty`: `classify`'s result, as it is. It is the last step;
- `turn_limit`, `turn_failed` or `history`: why the session stopped. It is the last step.

A step for a turn the model completed SHALL carry the turn's number, its usage and its elapsed time. While the caller handles a step, the session SHALL be paused, so its history is the history as of that step.

#### Scenario: A step comes before the next turn starts
- **WHEN** the first turn returns a call and the second answers, and the consumer asks for one step at a time
- **THEN**:
  - the first step is `calls`;
  - when it arrives, only one request has been sent, and the history ends with the call's output;
  - the second step is `final`, and the history then ends with the answer's `message` item;
  - then the session ends.

#### Scenario: Calls carry their outcomes
- **WHEN** a turn makes a call that succeeds and one whose arguments fail validation
- **THEN** its `calls` step lists both calls in order: the first with its output, the second with the validation error
