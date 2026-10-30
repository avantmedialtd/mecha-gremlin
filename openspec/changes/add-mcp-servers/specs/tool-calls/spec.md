## MODIFIED Requirements

### Requirement: Convert a tool to a Responses function tool
The shared tool definition SHALL provide its input JSON Schema requested with target `draft-07`, without the top-level `$schema` key. A tool MAY say it isn't strict, with `strict: false`. The Responses adapter SHALL convert a tool to a function tool with `type` `function`, the tool's name and description, `strict: true`, or `strict: false` for a tool that says it isn't strict, and that schema as `parameters`. The Anthropic adapter SHALL use the same schema as its client tool's `input_schema` without requesting Anthropic strict mode. Wire-format conversion SHALL not require an SDK type in `core`.

#### Scenario: Function tool from a schema
- **WHEN** a tool named `read`, described as "Read a file", has a draft-07 input schema containing a `$schema` key, an object property `path`, a required `path` and `additionalProperties: false`
- **THEN** its Responses function tool has `type` `function`, the same name and description, `strict: true`, and that schema without `$schema` as `parameters`

#### Scenario: The JSON Schema is requested as draft-07
- **WHEN** either adapter converts a tool
- **THEN** its schema's `~standard.jsonSchema.input` is called with target `draft-07`

#### Scenario: Anthropic keeps non-strict constraints
- **WHEN** the input JSON Schema contains a numeric minimum
- **THEN** the Anthropic tool retains it in `input_schema` and does not enable strict tool use

#### Scenario: A tool that isn't strict
- **WHEN** a tool is defined with `strict: false`
- **THEN** its Responses function tool has `strict: false`, and a tool defined without `strict` has `strict: true`
