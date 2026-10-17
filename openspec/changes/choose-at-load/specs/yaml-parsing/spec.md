## MODIFIED Requirements

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
