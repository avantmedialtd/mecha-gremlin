## RENAMED Requirements

- FROM: `### Requirement: Read a UTF-8 text file under a root directory`
- TO: `### Requirement: Read a UTF-8 text file`

## MODIFIED Requirements

### Requirement: Read a UTF-8 text file
The agent SHALL provide a `read` tool, created for a root directory, the working directory. Its arguments SHALL be a string `path`, and `offset` and `limit`, each a whole number of at least 1 or null; no other property SHALL be allowed. The JSON Schema the model sees SHALL require all three, as strict mode needs. A call that leaves out `offset` or `limit` SHALL be read as if it were null, because models that ignore strict mode leave them out.

A relative path SHALL resolve against the root, and an absolute path SHALL be used as it is. `read` SHALL refuse no path for where it is: outside the root, through a symbolic link, inside a skill's directory or the data folder, or named like an `.env` file. On success its output SHALL be the requested lines of the file decoded as UTF-8, with invalid sequences replaced by U+FFFD, and with no line numbers added. With `offset` and `limit` null, the requested lines are the whole file.

#### Scenario: Reads a file
- **WHEN** the root holds `notes.txt` containing "hello", and `read` is called with `{"path":"notes.txt"}`
- **THEN** it succeeds with the output "hello"

#### Scenario: Reads a nested file
- **WHEN** the root holds `docs/guide.md`, and `read` is called with `{"path":"docs/guide.md"}`
- **THEN** it succeeds with that file's contents

#### Scenario: Reads a skill's file
- **WHEN** a skill directory holds `references/forms.md`, and `read` is called with that file's absolute path
- **THEN** it succeeds with that file's contents

#### Scenario: The model sees a closed schema
- **WHEN** `read` is converted with `toFunctionTool`
- **THEN** its parameters require a string `path`, and `offset` and `limit`, each an integer of at least 1 or null, and set `additionalProperties` to false

#### Scenario: Extra arguments are rejected
- **WHEN** `read` is called with `{"path":"notes.txt","offset":null,"limit":null,"encoding":"utf8"}`
- **THEN** the arguments fail validation, and no file is read

#### Scenario: Null paging arguments
- **WHEN** `read` is called with `{"path":"notes.txt","offset":null,"limit":null}`
- **THEN** it succeeds with the whole of `notes.txt`, as when they are left out

#### Scenario: Invalid paging arguments
- **WHEN** `read` is called with an `offset` or a `limit` of 0, -1 or 1.5, or the string "5"
- **THEN** the arguments fail validation, and no file is read

#### Scenario: Outside the root
- **WHEN** `read` is called for `../outside/notes.txt`, and for the absolute path of a text file in a directory outside the root
- **THEN** each call succeeds with that file's contents

#### Scenario: Through a symbolic link
- **WHEN** the root holds `link.txt`, a symbolic link to a text file outside the root
- **THEN** reading `link.txt` succeeds with the target's contents

#### Scenario: Environment files and the data folder
- **WHEN** `DATA_DIR` is the root's `data` folder, and `read` is called for `.env`, for `.env.local` and for `data/notes.txt`, a text file there
- **THEN** each call succeeds with the file's contents

#### Scenario: A relative path resolves against the root
- **WHEN** `read` is called with `{"path":"references/forms.md"}`, a file that exists only in a skill directory
- **THEN** it fails with an error saying there is no such file

## REMOVED Requirements

### Requirement: Never read outside the root and the skill directories
**Reason**: The shell, which every run has, reads anything the user can, so the fence bounded `read` alone (Brief R20, C20, D41). Sandboxing is a container's job.
**Migration**: None: a path that was refused is now read, and the skill directories need no allowance. To bound what the agent can reach, run it in a container.

### Requirement: Refuse secrets, directories and binary files
**Reason**: Replaced by "Refuse directories and binary files", without the refusals of `.env` files and the data folder (Brief D41). The database's files are binary, which `read` still refuses (Brief R20.4).
**Migration**: None needed.

## ADDED Requirements

### Requirement: Refuse directories and binary files
`read` SHALL fail with an error naming the path and the reason when:
- the path is a directory;
- the file holds a NUL byte in its first 8 KiB, whatever `offset` asks for;
- the file doesn't exist.

It SHALL report every failure, unexpected I/O errors included, as a failed outcome, and SHALL NOT throw.

#### Scenario: Directory
- **WHEN** `read` is called for `docs`, a directory
- **THEN** it fails with an error saying `docs` is a directory

#### Scenario: Binary file
- **WHEN** the file `logo.png` holds a NUL byte within its first 8 KiB
- **THEN** it fails with an error saying it is a binary file

#### Scenario: Missing file
- **WHEN** `read` is called for `missing.txt`, which doesn't exist
- **THEN** it fails with an error saying there is no such file

#### Scenario: The database
- **WHEN** `read` is called for `db.sqlite` in the data folder, after the store opened it
- **THEN** it fails with an error saying it is a binary file, and the file's contents appear nowhere in the outcome
