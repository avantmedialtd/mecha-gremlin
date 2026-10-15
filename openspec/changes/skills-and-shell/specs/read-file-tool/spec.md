## RENAMED Requirements

- FROM: `### Requirement: Never read outside the root`
- TO: `### Requirement: Never read outside the root and the skill directories`

## MODIFIED Requirements

### Requirement: Read a UTF-8 text file under a root directory
The server SHALL provide a `read_file` tool, created for a root directory and a list of skill directories, which may be empty. Its arguments SHALL be exactly one required string, `path`, and no other property SHALL be allowed. A relative path SHALL resolve against the root, and an absolute path SHALL be used as it is. On success its output SHALL be the file's contents decoded as UTF-8, with invalid sequences replaced by U+FFFD.

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

### Requirement: Never read outside the root and the skill directories
`read_file` SHALL refuse, before reading anything, any path that resolves outside every directory it may read: the root and each skill directory. That is:
- a path that, resolved against the root, is inside neither the root nor a skill directory, which covers `..` and absolute paths;
- a path whose real path, after following symbolic links, is inside neither the root's real path nor a skill directory's real path.

The refusal SHALL say the path is outside the directories `read_file` may read.

#### Scenario: Parent directory
- **WHEN** `read_file` is called with `{"path":"../secret.txt"}`, which resolves outside the root and every skill directory
- **THEN** it fails with an error saying the path is outside the directories it may read

#### Scenario: Absolute path outside the root
- **WHEN** `read_file` is called with `{"path":"/etc/hosts"}`
- **THEN** it fails with an error saying the path is outside the directories it may read

#### Scenario: Symbolic link pointing outside
- **WHEN** the root holds `link.txt`, a symbolic link to a file outside the root and every skill directory
- **THEN** reading `link.txt` fails with an error saying the path is outside the directories it may read, and the target's contents appear nowhere in the outcome

#### Scenario: Symbolic link pointing inside
- **WHEN** the root holds `alias.txt`, a symbolic link to `notes.txt` in the root
- **THEN** reading `alias.txt` succeeds with the contents of `notes.txt`

#### Scenario: A link out of a skill directory
- **WHEN** a skill directory holds `leak.md`, a symbolic link to a file outside the root and every skill directory, and `read_file` is called with its absolute path
- **THEN** it fails with an error saying the path is outside the directories it may read, and the target's contents appear nowhere in the outcome

#### Scenario: A relative path stays in the root
- **WHEN** `read_file` is called with `{"path":"references/forms.md"}`, a file that exists only in a skill directory
- **THEN** it fails with an error saying there is no such file
