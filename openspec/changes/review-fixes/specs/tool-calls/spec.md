## MODIFIED Requirements

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
