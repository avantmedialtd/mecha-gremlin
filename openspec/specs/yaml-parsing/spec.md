# yaml-parsing Specification

## Purpose

`@mecha-gremlin/yaml`: parsing YAML with Bun's built-in parser on Bun and the `yaml` package elsewhere, and where the two agree.
## Requirements
### Requirement: Parse YAML with the runtime's own parser
`@mecha-gremlin/yaml/parse` SHALL provide `parseYaml(text)`. It SHALL return a `Result`: the parsed value, or a failure holding the first line of what the parser threw, without a trailing colon. A thrown `Error` SHALL give its message, and any other value its text. It SHALL use Bun's built-in parser, `Bun.YAML.parse`, on Bun, and the `yaml` package elsewhere. The module SHALL also export:
- both implementations by name, `parseYamlWithBun` and `parseYamlWithPackage`;
- `chooseParser(globals)`, which returns `parseYamlWithBun` when `globals.Bun` is defined, and `parseYamlWithPackage` otherwise.

`parseYaml` SHALL be the implementation that `chooseParser(globalThis)` returns, chosen once, when the module loads. The scenarios of this capability SHALL hold for `parseYamlWithPackage` on Bun and on Node, and for `parseYamlWithBun` on Bun.

#### Scenario: The choice
- **WHEN** `chooseParser` is given `{ Bun: {} }`, and then `{}`
- **THEN** it returns `parseYamlWithBun`, and then `parseYamlWithPackage`

#### Scenario: The choice on each runtime
- **WHEN** the module loads on Bun, and on Node
- **THEN** `parseYaml` is `parseYamlWithBun` on Bun, and `parseYamlWithPackage` on Node

#### Scenario: A mapping
- **WHEN** `parseYaml` is given `name: pdf` and `description: Work with PDFs.`, on two lines
- **THEN** it succeeds with `{ name: 'pdf', description: 'Work with PDFs.' }`

#### Scenario: Invalid YAML
- **WHEN** each implementation is given `name: [pdf`
- **THEN** `parseYamlWithBun` fails with "YAML Parse error: Unexpected token", and `parseYamlWithPackage` with "Flow sequence in block collection must be sufficiently indented and end with a ] at line 1, column 11"

#### Scenario: A parser that throws something other than an error
- **WHEN** Bun's parser throws the string "broken" on Bun
- **THEN** `parseYamlWithBun` fails with "broken"

### Requirement: Both parsers give the same values for frontmatter
`parseYamlWithBun` and `parseYamlWithPackage` SHALL give equal values for:
- an empty text, or a comment alone: `null`;
- mappings, sequences and scalars, in block and flow style, including flow collections with trailing commas;
- a value with a custom tag such as `!thing`: the text after the tag;
- a key given twice in one mapping: the last value;
- a merge key `<<`: the merged mapping;
- `yes`, `on` and a date such as `2024-01-01`: strings, as in YAML 1.2.

Both SHALL fail for text that isn't valid YAML, such as an unclosed flow sequence, a plain value holding `: `, or a tab used as indentation. Three kinds of text give different results, and each implementation's result SHALL be pinned by a test, so that a change in either parser shows up:
- a text holding several documents, which Bun returns as an array and the `yaml` package refuses;
- a collection used as a key, which each turns into a different string;
- a key that overrides a merged one, which gives the same values with the keys in a different order.

#### Scenario: Frontmatter as skills write it
- **WHEN** both are given a mapping with `name`, a quoted `description` holding a colon and backticks, `homepage`, and a `metadata` mapping nested in flow style with trailing commas
- **THEN** both give the same value

#### Scenario: Empty frontmatter
- **WHEN** both are given an empty text, and then a text holding only a comment
- **THEN** both give `null` each time

#### Scenario: A repeated key
- **WHEN** both are given `description: First.` and then `description: Second.`, on two lines
- **THEN** both give the description "Second."

#### Scenario: A merge key
- **WHEN** both are given a mapping `base` anchored as `b` and holding `x: 1`, and a mapping `derived` holding `<<: *b` and `y: 2`
- **THEN** both give `derived` as `{ x: 1, y: 2 }`

#### Scenario: YAML 1.2 scalars
- **WHEN** both are given `a: yes`, `b: on` and `d: 2024-01-01`
- **THEN** both give the strings "yes", "on" and "2024-01-01"

#### Scenario: Invalid YAML fails on both
- **WHEN** both are given `name: [pdf`, then `description: Use it: now`, then a mapping indented with a tab
- **THEN** both fail each time

#### Scenario: Several documents
- **WHEN** both are given `a: 1` and `b: 2`, separated by a `---` line
- **THEN** `parseYamlWithBun` gives `[{ a: 1 }, { b: 2 }]`, and `parseYamlWithPackage` fails

#### Scenario: A collection as a key
- **WHEN** both are given `? [a, b]` and then `: c`, on two lines
- **THEN** `parseYamlWithBun` gives `{ 'a,b': 'c' }`, and `parseYamlWithPackage` gives `{ '[ a, b ]': 'c' }`

#### Scenario: A key that overrides a merged one
- **WHEN** both are given a mapping `base` anchored as `b` and holding `x: 1` and `y: 1`, and a mapping `derived` holding `<<: *b` and `y: 2`
- **THEN** both give `derived` the values `x: 1` and `y: 2`. `parseYamlWithBun` lists its keys as `y`, `x`, and `parseYamlWithPackage` as `x`, `y`

### Requirement: Parse quietly
Neither implementation SHALL write to stdout or stderr, or emit a process warning, whatever the text.

#### Scenario: An unresolved tag
- **WHEN** either implementation is given `description: !thing Work with PDFs.`
- **THEN** it succeeds with the description "Work with PDFs.", `process.emitWarning` isn't called, and nothing is written to stdout or stderr

#### Scenario: Invalid YAML is reported only in the result
- **WHEN** either implementation is given `name: [pdf`
- **THEN** it fails, `process.emitWarning` isn't called, and nothing is written to stdout or stderr

