# read-file-tool Specification

## Purpose

The server's `read_file` tool: what it may read, its limits, and how it reports what it can't do.

## Requirements

### Requirement: Read a UTF-8 text file under a root directory
The server SHALL provide a `read_file` tool, created for a root directory. Its arguments SHALL be exactly one required string, `path`, relative to the root, and no other property SHALL be allowed. On success its output SHALL be the file's contents decoded as UTF-8, with invalid sequences replaced by U+FFFD.

#### Scenario: Reads a file
- **WHEN** the root holds `notes.txt` containing "hello", and `read_file` is called with `{"path":"notes.txt"}`
- **THEN** it succeeds with the output "hello"

#### Scenario: Reads a nested file
- **WHEN** the root holds `docs/guide.md`, and `read_file` is called with `{"path":"docs/guide.md"}`
- **THEN** it succeeds with that file's contents

#### Scenario: The model sees a closed schema
- **WHEN** `read_file` is converted with `toFunctionTool`
- **THEN** its parameters require a string `path` and set `additionalProperties` to false

#### Scenario: Extra arguments are rejected
- **WHEN** `read_file` is called with `{"path":"notes.txt","limit":5}`
- **THEN** the arguments fail validation, and no file is read

### Requirement: Never read outside the root
`read_file` SHALL refuse, before reading anything, any path that resolves outside the root. That is:
- a path that leaves the root lexically, through `..` or as an absolute path;
- a path whose real path, after following symbolic links, is outside the root's real path.

#### Scenario: Parent directory
- **WHEN** `read_file` is called with `{"path":"../secret.txt"}`
- **THEN** it fails with an error saying the path is outside the directory it may read

#### Scenario: Absolute path outside the root
- **WHEN** `read_file` is called with `{"path":"/etc/hosts"}`
- **THEN** it fails with an error saying the path is outside the directory it may read

#### Scenario: Symbolic link pointing outside
- **WHEN** the root holds `link.txt`, a symbolic link to a file outside the root
- **THEN** reading `link.txt` fails with an error saying the path is outside the directory it may read, and the target's contents appear nowhere in the outcome

#### Scenario: Symbolic link pointing inside
- **WHEN** the root holds `alias.txt`, a symbolic link to `notes.txt` in the root
- **THEN** reading `alias.txt` succeeds with the contents of `notes.txt`

### Requirement: Refuse secrets, directories and binary files
`read_file` SHALL fail with an error naming the path and the reason when:
- the requested file name, or the real file name, begins with `.env`;
- the path is a directory;
- the file holds a NUL byte in its first 8 KiB;
- the file doesn't exist.

It SHALL report every failure, unexpected I/O errors included, as a failed outcome, and SHALL NOT throw.

#### Scenario: Environment files
- **WHEN** `read_file` is called for `.env` or for `.env.local`
- **THEN** it fails with an error saying environment files can't be read, and the file's contents appear nowhere in the outcome

#### Scenario: A link to an environment file
- **WHEN** the root holds `innocent.txt`, a symbolic link to `.env`
- **THEN** reading `innocent.txt` fails as reading `.env` does

#### Scenario: Directory
- **WHEN** `read_file` is called for `docs`, a directory
- **THEN** it fails with an error saying `docs` is a directory

#### Scenario: Binary file
- **WHEN** the file `logo.png` holds a NUL byte within its first 8 KiB
- **THEN** it fails with an error saying it is a binary file

#### Scenario: Missing file
- **WHEN** `read_file` is called for `missing.txt`, which doesn't exist
- **THEN** it fails with an error saying there is no such file

### Requirement: Cap what it returns
`read_file` SHALL return at most the first 32 KiB (32,768 bytes) of a file, cut back to the nearest UTF-8 character boundary. When it cuts, a note SHALL follow, giving the number of bytes shown and the file's size in bytes.

#### Scenario: Small file
- **WHEN** the file is 1,000 bytes
- **THEN** the output is the whole file, with no note

#### Scenario: Large file
- **WHEN** the file is 40,000 bytes of ASCII text
- **THEN** the output is its first 32,768 bytes, followed by a note saying 32768 of 40000 bytes are shown

#### Scenario: Cut on a character boundary
- **WHEN** the file is 20,000 copies of "€", 3 bytes each and 60,000 bytes in all
- **THEN** the output is 10,922 copies of "€" (32,766 bytes) with no replacement character, followed by a note saying 32766 of 60000 bytes are shown
