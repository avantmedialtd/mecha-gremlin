## RENAMED Requirements

- FROM: `### Requirement: Write a UTF-8 text file under the working directory`
- TO: `### Requirement: Write a UTF-8 text file`

## MODIFIED Requirements

### Requirement: Write a UTF-8 text file
The agent SHALL provide a `write` tool, created for a root directory, the working directory. Its arguments SHALL be exactly two required strings, `path` and `content`, and no other property SHALL be allowed. A relative path SHALL resolve against the root, and an absolute path SHALL be used as it is. `write` SHALL refuse no path for where it is: outside the root, through a symbolic link, inside a skill's directory or the data folder, or named like an `.env` file. It SHALL write `content` to the file exactly as given, encoded as UTF-8, creating the file when it doesn't exist and replacing its contents when it does. It SHALL create missing parent directories. A replaced file SHALL keep its permissions, and writing through a symbolic link SHALL replace its target's contents and leave the link a link.

On success its output SHALL be `Created <path> (<n> lines, <b> bytes).` or `Replaced <path> (<n> lines, <b> bytes).`, where:
- `<path>` is the argument as given;
- `<b>` is the content's size in bytes;
- `<n>` is the number of lines: each `\n` ends one, and non-empty text after the last `\n` counts as one more;
- "lines" and "bytes" are "line" and "byte" when their count is 1.

#### Scenario: Creates a file
- **WHEN** the root holds no `notes.txt`, and `write` is called with `{"path":"notes.txt","content":"one\ntwo\n"}`
- **THEN** `notes.txt` holds "one\ntwo\n", and the output is `Created notes.txt (2 lines, 8 bytes).`

#### Scenario: Creates parent directories
- **WHEN** the root holds no `docs` directory, and `write` is called for `docs/plans/q4.md`
- **THEN** `docs/plans/q4.md` exists with the content, and the output begins `Created docs/plans/q4.md`

#### Scenario: Replaces a file
- **WHEN** the root holds `notes.txt` with mode 0600, and `write` is called for it with the content "new"
- **THEN** `notes.txt` holds exactly "new", its mode is still 0600, and the output is `Replaced notes.txt (1 line, 3 bytes).`

#### Scenario: Empty content
- **WHEN** `write` is called for `empty.txt` with the content ""
- **THEN** `empty.txt` exists and is empty, and the output is `Created empty.txt (0 lines, 0 bytes).`

#### Scenario: Multi-byte characters
- **WHEN** `write` is called with the content "€"
- **THEN** the file holds the 3 bytes of "€" in UTF-8, and the output counts 3 bytes

#### Scenario: The model sees a closed schema
- **WHEN** `write` is converted with `toFunctionTool`
- **THEN** its parameters require the strings `path` and `content` and set `additionalProperties` to false

#### Scenario: Extra arguments are rejected
- **WHEN** `write` is called with `{"path":"notes.txt","content":"x","append":true}`
- **THEN** the arguments fail validation, and no file is written

#### Scenario: Outside the root
- **WHEN** `write` is called for `../outside/notes.txt`, and for the absolute path of a file in a directory outside the root
- **THEN** each file is created there, with the output naming the path as given

#### Scenario: Through a symbolic link
- **WHEN** the root holds `alias.txt`, a symbolic link to a file outside the root, and `write` is called for `alias.txt` with the content "new"
- **THEN** the link's target holds "new", `alias.txt` is still a link, and the output is `Replaced alias.txt (1 line, 3 bytes).`

#### Scenario: Environment files and the data folder
- **WHEN** `DATA_DIR` is the root's `data` folder, and `write` is called for `.env`, for `config/.env.local` and for `data/notes.txt`
- **THEN** each file is written as any other file is

#### Scenario: A skill's file
- **WHEN** `write` is called with the absolute path of a file inside a loaded skill's directory
- **THEN** the file holds the content

## REMOVED Requirements

### Requirement: Never write outside the working directory
**Reason**: The shell, which every run has, writes anywhere the user can, so the fence bounded `write` alone, and a write it refused moved into the shell (Brief R20, C20, D41). Sandboxing is a container's job.
**Migration**: None: a path that was refused is now written. To bound what the agent can reach, run it in a container.

### Requirement: Refuse secrets, directories and large files
**Reason**: Replaced by "Refuse directories and large files", which keeps the refusals that don't depend on where a file is, without those of `.env` files and the data folder (Brief D41).
**Migration**: None needed.

## ADDED Requirements

### Requirement: Refuse directories and large files
`write` SHALL fail with an error naming the path and the reason, writing nothing, when:
- the path is an existing directory;
- the path is an existing file larger than 32 KiB (32,768 bytes), the most one call of the `read` tool returns. The error SHALL say that the file is larger than one read returns, so replacing it whole could drop what the model hasn't read, and that the `edit` tool changes part of a file.

It SHALL report every failure, unexpected I/O errors included, as a failed outcome, and SHALL NOT throw.

#### Scenario: Directory
- **WHEN** `write` is called for `docs`, an existing directory
- **THEN** it fails with an error saying `docs` is a directory

#### Scenario: A file larger than one read returns
- **WHEN** the root holds `big.log`, 40,000 bytes, and `write` is called for it
- **THEN** it fails with an error saying the file is larger than one read returns and naming the `edit` tool, and `big.log` is unchanged

#### Scenario: A file at the limit
- **WHEN** the root holds `exact.txt`, exactly 32,768 bytes, and `write` is called for it
- **THEN** it replaces the file

#### Scenario: An I/O error
- **WHEN** the parent directory isn't writable
- **THEN** it fails with an error saying the file can't be written, giving the reason, and doesn't throw
