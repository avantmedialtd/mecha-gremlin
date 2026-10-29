# tool-calls Specification

## Purpose

Tool calling across providers: Gremlin-owned tool definitions and replies, their Responses function-tool form, classifying a completed reply, validating call arguments, and building each provider's next request from the history.
## Requirements
### Requirement: Tools are defined by a name, a description and a Standard Schema
The `core` package SHALL provide a `Tool<Args>` type made of a `name`, a `description` and a `schema`. The schema SHALL be any object implementing both the Standard Schema v1 interface (`~standard.validate`) and the Standard JSON Schema interface (`~standard.jsonSchema`). `core` SHALL declare these interfaces itself, as types, and SHALL NOT depend on a schema library or either provider SDK. Its tool, call, reply and history types SHALL be Gremlin-owned rather than SDK aliases.

#### Scenario: No schema library or provider SDK in core
- **WHEN** `packages/core/package.json` and its public types are read
- **THEN** they contain no dependency or type import for a schema library, `openai` or `@anthropic-ai/sdk`

### Requirement: Convert a tool to a Responses function tool
The shared tool definition SHALL provide its input JSON Schema requested with target `draft-07`, without the top-level `$schema` key. The Responses adapter SHALL convert it to a function tool with `type` `function`, the tool's name and description, `strict: true`, and that schema as `parameters`. The Anthropic adapter SHALL use the same schema as its client tool's `input_schema` without requesting Anthropic strict mode. Wire-format conversion SHALL not require an SDK type in `core`.

#### Scenario: Function tool from a schema
- **WHEN** a tool named `read`, described as "Read a file", has a draft-07 input schema containing a `$schema` key, an object property `path`, a required `path` and `additionalProperties: false`
- **THEN** its Responses function tool has `type` `function`, the same name and description, `strict: true`, and that schema without `$schema` as `parameters`

#### Scenario: The JSON Schema is requested as draft-07
- **WHEN** either adapter converts a tool
- **THEN** its schema's `~standard.jsonSchema.input` is called with target `draft-07`

#### Scenario: Anthropic keeps non-strict constraints
- **WHEN** the input JSON Schema contains a numeric minimum
- **THEN** the Anthropic tool retains it in `input_schema` and does not enable strict tool use

### Requirement: Classify a model call's output
The shared `Reply` type SHALL distinguish `calls`, `final` and `empty` using Gremlin-owned types. The provider adapter SHALL derive the reply from the completed native response without replacing or mutating its replay data. When there is at least one client tool call, the reply SHALL be `calls` containing every call in output order, whatever text the output also holds. Otherwise nonempty trimmed text SHALL be `final`; a textual refusal SHALL count as answer text. Otherwise the reply SHALL be `empty`. A call view SHALL identify the call, tool name and raw JSON arguments for local validation.

#### Scenario: Calls win over text
- **WHEN** a reply holds reasoning or thinking, whitespace text and a client call for `read`
- **THEN** it is `calls` with that call and the native reasoning, text and call data remain in history

#### Scenario: Several calls keep their order
- **WHEN** a completed reply holds client calls A then B
- **THEN** its `calls` view lists A then B

#### Scenario: The answer is trimmed
- **WHEN** the reply's text is "\n\nThe check script runs the linter."
- **THEN** its result is `final` with text "The check script runs the linter."

#### Scenario: Text from several parts is joined
- **WHEN** the reply holds text parts "Hello, " and "world"
- **THEN** the final text is "Hello, world"

#### Scenario: A refusal is the answer
- **WHEN** a completed reply's only answer text is a refusal, "I can't help with that."
- **THEN** the result is `final` with that text

#### Scenario: Nothing to act on
- **WHEN** a reply holds only reasoning or thinking and whitespace text
- **THEN** the result is `empty`

### Requirement: Validate a call's arguments
`validateArgs(tool, raw)` SHALL resolve, without throwing or rejecting, to a `Result`: `ok(args)`, holding the schema's validated output, or `err(error)`, holding a message written for the model. It SHALL:
1. treat empty or whitespace-only `raw` as `{}`;
2. parse `raw` as JSON;
3. require the parsed value to be a JSON object, not an array, `null`, string, number or boolean;
4. validate it with the schema's `~standard.validate`, awaiting the result when it is a promise. When the validator throws or rejects, the `error` SHALL say that validating the arguments failed, with the thrown error's message.

Every `error` SHALL name the tool, say what was wrong, and end with the tool's expected draft-07 input JSON Schema without its top-level `$schema`, the same schema offered to the model. When that JSON Schema can't be produced, because the schema's `~standard.jsonSchema.input` throws, the `error` SHALL end without it. For a schema failure, it SHALL list each issue with its path and the validator's message. Paths are dot-separated, and the root is shown as `(root)`.

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
A tool outcome SHALL be a `Result` holding text either way: `ok(output)` or `err(error)`. The session history SHALL retain Gremlin-authored inputs and outcomes plus opaque provider-tagged native assistant replay data in order. The provider adapter SHALL build valid next-request input without mutating the stored native data. Responses tool outcomes SHALL become `function_call_output` items with the call ID and success text, or `Error: ` followed by the failure text. The Responses adapter SHALL use the SDK's `toResponseInputItems` to replay items, retaining its existing removal of SDK-only fields and omission of known non-replayable items. Anthropic outcomes SHALL become grouped `tool_result` blocks as `anthropic-messages` specifies.

An unsupported native item or a history belonging to another provider SHALL return `err(message)` without throwing; it SHALL NOT be silently converted to a different provider's history. `core` SHALL not call an SDK replay helper.

#### Scenario: Successful Responses call
- **WHEN** call `call_1` succeeds with "file contents"
- **THEN** its Responses input item is `{ type: "function_call_output", call_id: "call_1", output: "file contents" }`

#### Scenario: Failed Responses call
- **WHEN** call `call_1` fails with "no such file: x.txt"
- **THEN** its Responses output is "Error: no such file: x.txt"

#### Scenario: Responses history round trip
- **WHEN** Responses history holds a developer message, a user message, a reasoning item, a message, a function call carrying `parsed_arguments`, and a function-call output
- **THEN** the adapter produces replayable input in the same order, strips the SDK-only `parsed_arguments`, and leaves the stored history unchanged

#### Scenario: Unknown native item type
- **WHEN** the history holds a Responses item of type `made_up`
- **THEN** replay returns `ok: false` with an error naming `made_up` and doesn't throw

#### Scenario: Cross-provider replay is refused
- **WHEN** a session configured for Anthropic is given native Responses history from an OpenAI session
- **THEN** session creation fails with a history/provider error before a model request is sent

