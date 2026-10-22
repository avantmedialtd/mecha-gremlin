# write-tool Specification

## Purpose

The agent's `write` tool: creating or replacing a whole text file under the working directory, what it refuses, and what it returns.
## Requirements
### Requirement: Write a UTF-8 text file under the working directory
The agent SHALL provide a `write` tool, created for a root directory. Its arguments SHALL be exactly two required strings, `path` and `content`, and no other property SHALL be allowed. A relative path SHALL resolve against the root, and an absolute path SHALL be used as it is. It SHALL write `content` to the file exactly as given, encoded as UTF-8, creating the file when it doesn't exist and replacing its contents when it does. It SHALL create missing parent directories. A replaced file SHALL keep its permissions.

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

### Requirement: Never write outside the working directory
`write` SHALL refuse, before writing or creating anything, any path whose target isn't inside the root. That is:
- a path that, resolved against the root, isn't inside the root. That covers `..`, absolute paths elsewhere, and paths inside a skill directory, which stay read-only;
- a path whose nearest existing ancestor directory, after following symbolic links, isn't inside the root's real path;
- an existing target that is a symbolic link whose real path isn't inside the root's real path;
- a target that is a broken symbolic link.

The refusal SHALL say the path is outside the working directory, the only place the `write` tool may write.

#### Scenario: Parent directory
- **WHEN** `write` is called with `{"path":"../escape.txt","content":"x"}`
- **THEN** it fails with an error saying the path is outside the working directory, and no file is created outside the root

#### Scenario: Absolute path outside the root
- **WHEN** `write` is called for `/tmp/elsewhere.txt`, outside the root
- **THEN** it fails with an error saying the path is outside the working directory

#### Scenario: Absolute path inside the root
- **WHEN** `write` is called with the absolute path of `notes.txt` in the root
- **THEN** it writes `notes.txt`

#### Scenario: A skill's file
- **WHEN** `write` is called with the absolute path of a file inside a loaded skill's directory, outside the root
- **THEN** it fails with an error saying the path is outside the working directory, and the skill's file is unchanged

#### Scenario: A linked directory pointing outside
- **WHEN** the root holds `out`, a symbolic link to a directory outside the root, and `write` is called for `out/new/file.txt`
- **THEN** it fails with an error saying the path is outside the working directory, and nothing is created outside the root

#### Scenario: A link to a file outside
- **WHEN** the root holds `link.txt`, a symbolic link to a file outside the root
- **THEN** writing `link.txt` fails with an error saying the path is outside the working directory, and the outside file is unchanged

#### Scenario: A broken link
- **WHEN** the root holds `dangling.txt`, a symbolic link to a path that doesn't exist
- **THEN** writing `dangling.txt` fails with an error saying the path is outside the working directory, and the link's target isn't created

#### Scenario: A link inside the root
- **WHEN** the root holds `alias.txt`, a symbolic link to `notes.txt` in the root
- **THEN** writing `alias.txt` replaces the contents of `notes.txt`, and `alias.txt` is still a link

### Requirement: Refuse secrets, directories and large files
`write` SHALL fail with an error naming the path and the reason, writing nothing, when:
- the requested file name, or the real file name, begins with `.env`;
- the path is an existing directory;
- the path is an existing file larger than 32 KiB (32,768 bytes), the most one call of the `read` tool returns. The error SHALL say that the file is larger than one read returns, so replacing it whole could drop what the model hasn't read, and that the `edit` tool changes part of a file.

It SHALL report every failure, unexpected I/O errors included, as a failed outcome, and SHALL NOT throw.

#### Scenario: Environment files
- **WHEN** `write` is called for `.env` or for `config/.env.local`
- **THEN** it fails with an error saying environment files can't be written, and no such file is created or changed

#### Scenario: A link to an environment file
- **WHEN** the root holds `innocent.txt`, a symbolic link to `.env`
- **THEN** writing `innocent.txt` fails as writing `.env` does, and `.env` is unchanged

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

