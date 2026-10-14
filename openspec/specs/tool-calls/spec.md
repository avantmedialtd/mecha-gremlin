# tool-calls Specification

## Purpose

The core library's pure contract for tool calling over the Responses API: tool definitions and their `FunctionTool` form, classifying a turn's output, validating call arguments, building call outputs, and turning chat history into request input.

## Requirements

### Requirement: Tools are defined by a name, a description and a Standard Schema
The `core` package SHALL provide a `Tool<Args>` type made of a `name`, a `description` and a `schema`. The schema SHALL be any object implementing both the Standard Schema v1 interface (`~standard.validate`) and the Standard JSON Schema interface (`~standard.jsonSchema`). `core` SHALL declare these interfaces itself, as types, and SHALL NOT depend on a schema library.

#### Scenario: No schema library in core
- **WHEN** `packages/core/package.json` is read
- **THEN** its `dependencies` and `peerDependencies` name no package other than `openai`

### Requirement: Convert a tool to a Responses function tool
`toFunctionTool(tool)` SHALL return a Responses API function tool with:
- `type` `"function"`;
- the tool's `name` and `description`;
- `strict: true`;
- as `parameters`, the schema's input JSON Schema, requested with target `draft-07`, without its top-level `$schema` key.

#### Scenario: Function tool from a schema
- **WHEN** a tool named `read_file`, described as "Read a file", has a schema whose `draft-07` input JSON Schema is `{ "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false }`
- **THEN** `toFunctionTool` returns `type` `"function"`, `name` `read_file`, `description` "Read a file", `strict: true`, and `parameters` equal to that JSON Schema without the `$schema` key

#### Scenario: The JSON Schema is requested as draft-07
- **WHEN** `toFunctionTool` converts a tool
- **THEN** it calls the schema's `~standard.jsonSchema.input` with `target` `draft-07`

### Requirement: Classify a completed turn's output
`classify(output)` SHALL classify the output items of a completed turn as exactly one of:
- `calls`, when there is at least one `function_call` item: every `function_call` item, in output order, whatever text the output also holds;
- otherwise, `final`, when the text is non-empty after trimming whitespace. The text is the concatenation, in order, of every `message` item's `output_text` and `refusal` parts. The result carries the trimmed text;
- otherwise, `empty`.

#### Scenario: Calls win over text
- **WHEN** the output holds a `reasoning` item, a `message` item whose text is "\n\n", and a `function_call` item for `read_file`
- **THEN** the result is `calls` with that one call

#### Scenario: Several calls keep their order
- **WHEN** the output holds two `function_call` items, `call_a` then `call_b`
- **THEN** the result is `calls` with `call_a` then `call_b`

#### Scenario: The answer is trimmed
- **WHEN** the output holds one `message` item with the text "\n\nThe check script runs the linter."
- **THEN** the result is `final` with the text "The check script runs the linter."

#### Scenario: Text from several messages is joined
- **WHEN** the output holds two `message` items with the texts "Hello, " and "world"
- **THEN** the result is `final` with the text "Hello, world"

#### Scenario: A refusal is the answer
- **WHEN** the output holds a `message` item whose only part is a `refusal`, "I can't help with that."
- **THEN** the result is `final` with the text "I can't help with that."

#### Scenario: Nothing to act on
- **WHEN** the output holds only a `reasoning` item and a `message` item whose text is whitespace
- **THEN** the result is `empty`

### Requirement: Validate a call's arguments
`validateArgs(tool, raw)` SHALL resolve, without throwing or rejecting, to a `Result`: `ok(args)`, holding the schema's validated output, or `err(error)`, holding a message written for the model. It SHALL:
1. treat empty or whitespace-only `raw` as `{}`;
2. parse `raw` as JSON;
3. require the parsed value to be a JSON object, not an array, `null`, string, number or boolean;
4. validate it with the schema's `~standard.validate`, awaiting the result when it is a promise. When the validator throws or rejects, the `error` SHALL say that validating the arguments failed, with the thrown error's message.

Every `error` SHALL name the tool, say what was wrong, and end with the tool's expected JSON Schema: the same `parameters` that `toFunctionTool` produces. When that JSON Schema can't be produced, because the schema's `~standard.jsonSchema.input` throws, the `error` SHALL end without it. For a schema failure, it SHALL list each issue with its path and the validator's message. Paths are dot-separated, and the root is shown as `(root)`.

#### Scenario: Valid arguments
- **WHEN** `raw` is `{"path":"package.json"}` and the schema accepts it
- **THEN** the result is `ok: true` with `value` equal to `{ path: "package.json" }`

#### Scenario: Empty arguments mean an empty object
- **WHEN** `raw` is "" or "  "
- **THEN** the schema is asked to validate `{}`

#### Scenario: Invalid JSON
- **WHEN** `raw` is `{"path":`
- **THEN** the result is `ok: false`, and `error` names the tool, says the arguments are not valid JSON, and includes the expected JSON Schema

#### Scenario: Not an object
- **WHEN** `raw` is `"package.json"`, `[]` or `null`
- **THEN** the result is `ok: false`, `error` says the arguments must be a JSON object, and the schema is not asked to validate

#### Scenario: Schema mismatch
- **WHEN** `raw` is `{"file":"x"}` and the schema reports an issue at path `path` with the message "Required"
- **THEN** the result is `ok: false`, and `error` contains "path: Required" and the expected JSON Schema

#### Scenario: Issue at the root
- **WHEN** the schema reports an issue with no path and the message "Unrecognized key: limit"
- **THEN** `error` contains "(root): Unrecognized key: limit"

#### Scenario: Asynchronous validator
- **WHEN** the schema's `~standard.validate` returns a promise
- **THEN** `validateArgs` resolves with that promise's outcome

#### Scenario: A validator that throws
- **WHEN** the schema's `~standard.validate` throws an error with the message "boom", or returns a promise that rejects with it
- **THEN** the result is `ok: false`, and `error` names the tool, says validating its arguments failed, contains "boom", and includes the expected JSON Schema

#### Scenario: A JSON Schema that can't be produced
- **WHEN** `raw` is `[]` and the schema's `~standard.jsonSchema.input` throws
- **THEN** the result is `ok: false`, and `error` says the arguments must be a JSON object and ends there, without a JSON Schema

### Requirement: Build call outputs and the next request's input from the history
A tool call's outcome SHALL be a `Result` holding text either way: a success, `ok(output)`, or a failure, `err(error)`. `toOutputItem(callId, outcome)` SHALL return a `function_call_output` item with that `call_id`. Its `output` SHALL be the success's value, or `Error: ` followed by the failure's error.

`toInput(history)` SHALL turn a history of Responses items, kept as received, into the input for the next request. That is every replayable item, in order, with SDK-only fields removed, as the `openai` SDK's `toResponseInputItems` does. It SHALL return `ok(input)`. When the history holds an item the SDK can't replay, it SHALL return `err(message)` naming the item's type, and SHALL NOT throw.

#### Scenario: Successful call
- **WHEN** `toOutputItem("call_1", ok("file contents"))` is called
- **THEN** it returns `{ type: "function_call_output", call_id: "call_1", output: "file contents" }`

#### Scenario: Failed call
- **WHEN** `toOutputItem("call_1", err("no such file: x.txt"))` is called
- **THEN** the item's `output` is "Error: no such file: x.txt"

#### Scenario: History round trip
- **WHEN** the history holds a developer message, a user message, a `reasoning` item, a `message` item, a `function_call` item carrying `parsed_arguments`, and a `function_call_output` item
- **THEN** `toInput` returns all six items in the same order, and the `function_call` item no longer has `parsed_arguments`

#### Scenario: Unknown item type
- **WHEN** the history holds an item of type `made_up`
- **THEN** `toInput` returns `ok: false` with an error naming `made_up`, and doesn't throw
