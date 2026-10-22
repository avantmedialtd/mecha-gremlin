## MODIFIED Requirements

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
- **WHEN** the model's first reply calls `read`, `call_1`, and its second answers
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
- **WHEN** the model calls `delete` and only `read` exists
- **THEN** the call's output says `delete` is unknown and lists `read`, and the model is called again

#### Scenario: Invalid arguments
- **WHEN** the model calls `read` with arguments that fail validation
- **THEN** the handler doesn't run, and the call's output is the validation error

#### Scenario: Handler throws
- **WHEN** a handler throws an error whose message is "disk on fire"
- **THEN** the call's output contains "disk on fire", and the model is called again
