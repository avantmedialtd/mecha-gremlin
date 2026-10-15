## MODIFIED Requirements

### Requirement: Tools are defined by a name, a description and a Standard Schema
The `core` package SHALL provide a `Tool<Args>` type made of a `name`, a `description` and a `schema`. The schema SHALL be any object implementing both the Standard Schema v1 interface (`~standard.validate`) and the Standard JSON Schema interface (`~standard.jsonSchema`). `core` SHALL declare these interfaces itself, as types, and SHALL NOT depend on a schema library.

#### Scenario: No schema library in core
- **WHEN** `packages/core/package.json` is read
- **THEN** its `dependencies` and `peerDependencies` name no package other than `yaml`, which parses skills' frontmatter and isn't a schema library, and `openai`
