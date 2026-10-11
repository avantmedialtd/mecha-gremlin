## ADDED Requirements

### Requirement: Alternate model turns and tool calls until the model answers
The server SHALL provide an agent loop. It takes an `openai` client, a model name, optional reasoning settings, a list of tools each paired with a handler, and a starting history. On each turn it SHALL:
1. send a request through `core`'s `runTurn` with:
   - the model;
   - the reasoning settings, when given;
   - `input` from `toInput(history)`;
   - `tools` from `toFunctionTool` of every tool, identical on every turn;
2. append every output item of the completed turn to the history, in order;
3. classify the output with `classify`. When it is `final`, the loop SHALL return `ok: true` with the answer's text and the history.

#### Scenario: Answer without tools
- **WHEN** the first turn answers "42"
- **THEN** the loop returns `ok: true` with the text "42", one request was sent, and the history ends with that turn's `message` item

#### Scenario: One tool round trip
- **WHEN** the first turn returns a `read_file` call, `call_1`, and the second turn answers
- **THEN** two requests were sent. The second request's `input` is:
  1. the first request's `input`;
  2. then the first turn's output items;
  3. then a `function_call_output` for `call_1` holding the handler's output.

#### Scenario: Tools are frozen for the run
- **WHEN** the loop sends more than one request
- **THEN** every request carries the same `tools`

### Requirement: Run every call in order and answer each exactly once
When a turn's output is `calls`, the loop SHALL handle the calls one at a time, in output order. Before it sends the next turn, it SHALL append exactly one `function_call_output` per call, carrying the call's `call_id`, built with `toOutputItem` from the call's outcome. The outcome SHALL be:
- **known tool, valid arguments** (they pass `validateArgs`): the handler's outcome;
- **invalid arguments:** a failure with the `validateArgs` error. The handler is not run;
- **unknown tool** (no tool has the call's name): a failure saying so and listing the available tool names;
- **the handler throws or rejects:** a failure containing the error's message. The loop SHALL continue.

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
The loop SHALL send at most 8 turns unless the caller sets another limit. When the last allowed turn still returns calls, the loop SHALL NOT run them. It SHALL append for each one a failed output saying it wasn't run because the turn limit was reached, and SHALL return a `turn_limit` failure.

#### Scenario: The model never stops calling tools
- **WHEN** every turn returns a call
- **THEN**:
  - exactly 8 requests are sent;
  - the handler runs 7 times;
  - the 8th turn's call gets an output saying it wasn't run;
  - the loop returns a `turn_limit` failure with that history.

### Requirement: Return failures as values, with the history so far
The loop SHALL NOT throw for model or tool failures. It SHALL stop and return `ok: false` with a reason and the history up to that point when:
- a turn fails (`turn_failed`), carrying the turn's error kind, detail and HTTP status;
- a turn's output is `empty` (`empty`);
- the history can't be turned into input (`history`).

#### Scenario: A later turn fails
- **WHEN** the first turn returns a call and the second turn fails with HTTP 500
- **THEN** the loop returns `turn_failed` with the error kind `server_error` and status 500, and its history holds the first turn's items and the call's output

#### Scenario: No answer
- **WHEN** a turn's output holds only a `reasoning` item
- **THEN** the loop returns an `empty` failure, and no further turn is sent

### Requirement: Report progress as it happens
The loop SHALL accept an optional progress callback and SHALL call it:
- after each completed turn, with the turn number, the turn's usage and its elapsed time;
- before running each call, with the tool's name and the raw arguments;
- after each call, with whether it succeeded, and either the output's length in bytes or the error.

#### Scenario: Progress for a tool round trip
- **WHEN** the first turn returns a `read_file` call and the second turn answers
- **THEN** the callback receives, in order: turn 1 completed, the call starting, the call's result, and turn 2 completed
