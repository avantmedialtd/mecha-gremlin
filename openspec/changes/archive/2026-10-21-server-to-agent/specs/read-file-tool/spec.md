## MODIFIED Requirements

### Requirement: Read a UTF-8 text file under a root directory
The agent SHALL provide a `read_file` tool, created for a root directory and a list of skill directories, which may be empty. Its arguments SHALL be exactly one required string, `path`, and no other property SHALL be allowed. A relative path SHALL resolve against the root, and an absolute path SHALL be used as it is. On success its output SHALL be the file's contents decoded as UTF-8, with invalid sequences replaced by U+FFFD.

#### Scenario: Reads a file
- **WHEN** the root holds `notes.txt` containing "hello", and `read_file` is called with `{"path":"notes.txt"}`
- **THEN** it succeeds with the output "hello"

#### Scenario: Reads a nested file
- **WHEN** the root holds `docs/guide.md`, and `read_file` is called with `{"path":"docs/guide.md"}`
- **THEN** it succeeds with that file's contents

#### Scenario: Reads a skill's file
- **WHEN** a skill directory holds `references/forms.md`, and `read_file` is called with that file's absolute path
- **THEN** it succeeds with that file's contents

#### Scenario: The model sees a closed schema
- **WHEN** `read_file` is converted with `toFunctionTool`
- **THEN** its parameters require a string `path` and set `additionalProperties` to false

#### Scenario: Extra arguments are rejected
- **WHEN** `read_file` is called with `{"path":"notes.txt","limit":5}`
- **THEN** the arguments fail validation, and no file is read
