# read-tool Specification

## Purpose

The agent's `read` tool, `read_file` until `file-write-tools`: what it may read, how it pages through a file by line, its limits, and how it reports what it can't do.
## Requirements
### Requirement: Read a UTF-8 text file under a root directory
The agent SHALL provide a `read` tool, created for a root directory and a list of skill directories, which may be empty. Its arguments SHALL be a string `path`, and `offset` and `limit`, each a whole number of at least 1 or null; no other property SHALL be allowed. The JSON Schema the model sees SHALL require all three, as strict mode needs. A call that leaves out `offset` or `limit` SHALL be read as if it were null, because models that ignore strict mode leave them out.

A relative path SHALL resolve against the root, and an absolute path SHALL be used as it is. On success its output SHALL be the requested lines of the file decoded as UTF-8, with invalid sequences replaced by U+FFFD, and with no line numbers added. With `offset` and `limit` null, the requested lines are the whole file.

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

### Requirement: Never read outside the root and the skill directories
`read` SHALL refuse, before reading anything, any path that resolves outside every directory it may read: the root and each skill directory. That is:
- a path that, resolved against the root, is inside neither the root nor a skill directory, which covers `..` and absolute paths;
- a path whose real path, after following symbolic links, is inside neither the root's real path nor a skill directory's real path.

The refusal SHALL say the path is outside the directories the `read` tool may read.

#### Scenario: Parent directory
- **WHEN** `read` is called with `{"path":"../secret.txt"}`, which resolves outside the root and every skill directory
- **THEN** it fails with an error saying the path is outside the directories it may read

#### Scenario: Absolute path outside the root
- **WHEN** `read` is called with `{"path":"/etc/hosts"}`
- **THEN** it fails with an error saying the path is outside the directories it may read

#### Scenario: Symbolic link pointing outside
- **WHEN** the root holds `link.txt`, a symbolic link to a file outside the root and every skill directory
- **THEN** reading `link.txt` fails with an error saying the path is outside the directories it may read, and the target's contents appear nowhere in the outcome

#### Scenario: Symbolic link pointing inside
- **WHEN** the root holds `alias.txt`, a symbolic link to `notes.txt` in the root
- **THEN** reading `alias.txt` succeeds with the contents of `notes.txt`

#### Scenario: A link out of a skill directory
- **WHEN** a skill directory holds `leak.md`, a symbolic link to a file outside the root and every skill directory, and `read` is called with its absolute path
- **THEN** it fails with an error saying the path is outside the directories it may read, and the target's contents appear nowhere in the outcome

#### Scenario: A relative path stays in the root
- **WHEN** `read` is called with `{"path":"references/forms.md"}`, a file that exists only in a skill directory
- **THEN** it fails with an error saying there is no such file

### Requirement: Refuse secrets, directories and binary files
`read` SHALL fail with an error naming the path and the reason when:
- the requested file name, or the real file name, begins with `.env`;
- the path is a directory;
- the file holds a NUL byte in its first 8 KiB, whatever `offset` asks for;
- the file doesn't exist.

It SHALL report every failure, unexpected I/O errors included, as a failed outcome, and SHALL NOT throw.

#### Scenario: Environment files
- **WHEN** `read` is called for `.env` or for `.env.local`
- **THEN** it fails with an error saying environment files can't be read, and the file's contents appear nowhere in the outcome

#### Scenario: A link to an environment file
- **WHEN** the root holds `innocent.txt`, a symbolic link to `.env`
- **THEN** reading `innocent.txt` fails as reading `.env` does

#### Scenario: Directory
- **WHEN** `read` is called for `docs`, a directory
- **THEN** it fails with an error saying `docs` is a directory

#### Scenario: Binary file
- **WHEN** the file `logo.png` holds a NUL byte within its first 8 KiB
- **THEN** it fails with an error saying it is a binary file

#### Scenario: Missing file
- **WHEN** `read` is called for `missing.txt`, which doesn't exist
- **THEN** it fails with an error saying there is no such file

### Requirement: Cap what it returns
`read` SHALL return at most 32 KiB (32,768 bytes) of text per call, in whole lines: each requested line is included, with its line ending, while the output still fits. When the first requested line alone is longer than 32 KiB, `read` SHALL return the start of that line, cut back to the nearest UTF-8 character boundary. No character is longer than 4 bytes, so the cut SHALL move back at most 3 bytes. In invalid UTF-8 it stops there, and each broken byte reads as U+FFFD.

When the output leaves out requested text, a note SHALL follow it, after a blank line:
- when it stopped at a line end, the note SHALL give the lines shown and say to read with `offset` set to the next line to continue;
- when it cut a line, the note SHALL give the line's number and the bytes of it shown. It SHALL say the rest of that line can be seen only through the shell. When lines follow it, the note SHALL also give the `offset` of the next line.

#### Scenario: Small file
- **WHEN** the file is 1,000 bytes
- **THEN** the output is the whole file, with no note

#### Scenario: Large file
- **WHEN** the file is 40,000 bytes of ASCII text on one line
- **THEN** the output is its first 32,768 bytes, followed by a note saying 32768 bytes of line 1 are shown and the rest only through the shell

#### Scenario: Cut on a character boundary
- **WHEN** the file is 20,000 copies of "€", 3 bytes each and 60,000 bytes in all
- **THEN** the output is 10,922 copies of "€" (32,766 bytes) with no replacement character, followed by a note saying 32766 bytes of line 1 are shown

#### Scenario: A four-byte character at the cut
- **WHEN** the file is "a" and then 10,000 copies of "😀", 4 bytes each and 40,001 bytes in all
- **THEN** the output is "a" and 8,191 copies of "😀" (32,765 bytes) with no replacement character, followed by a note saying 32765 bytes of line 1 are shown

#### Scenario: Invalid UTF-8 at the cut
- **WHEN** the file is 32,760 bytes of ASCII text, then 20 bytes of 0x80, then 1,000 more bytes of ASCII text, all on one line
- **THEN** the output is the 32,760 ASCII bytes and five U+FFFD characters, followed by a note saying 32765 bytes of line 1 are shown

#### Scenario: Cut at a line end
- **WHEN** the file is 1,000 lines of 99 ASCII characters and a `\n`, 100,000 bytes in all
- **THEN** the output is lines 1 to 327 (32,700 bytes), followed by a note saying lines 1–327 are shown and to read with offset 328 to continue

#### Scenario: Continue from the note
- **WHEN** the same file is read with `offset` 328 and `limit` null
- **THEN** the output is lines 328 to 654, followed by a note giving offset 655

#### Scenario: A long line followed by others
- **WHEN** the file's line 1 is 40,000 bytes and lines 2 and 3 are short
- **THEN** the output is the first 32,768 bytes of line 1, followed by a note saying the rest of line 1 is reachable only through the shell, and that offset 2 continues after it

### Requirement: Read part of a file by lines
A line SHALL end with `\n`; a final run of text without one SHALL count as a line too. A `\r` before the `\n` SHALL stay part of the line's ending. `offset` SHALL be the number of the first line to return, counting from 1, and null SHALL mean 1. `limit` SHALL be the most lines to return, and null SHALL mean no limit apart from the 32 KiB cap.

- When `limit` stops the output before the file's end, the note SHALL give the lines shown and the `offset` to continue from, as when the cap stops it.
- When the requested lines reach the end of the file, no note SHALL follow.
- An `offset` greater than the number of lines SHALL fail with an error giving the file's number of lines. The exception is an `offset` of 1, which returns an empty file's empty contents.

#### Scenario: A window of lines
- **WHEN** the file holds the lines "1" to "10", each ending in `\n`, and `read` is called with `offset` 3 and `limit` 2
- **THEN** the output is "3\n4\n", followed by a note saying lines 3–4 are shown and to read with offset 5 to continue

#### Scenario: A window reaching the end
- **WHEN** the same file is read with `offset` 9 and `limit` 5
- **THEN** the output is "9\n10\n", with no note

#### Scenario: An offset alone
- **WHEN** the same file is read with `offset` 8 and `limit` null
- **THEN** the output is "8\n9\n10\n", with no note

#### Scenario: A limit alone
- **WHEN** the same file is read with `offset` null and `limit` 2
- **THEN** the output is "1\n2\n", followed by a note giving offset 3

#### Scenario: Past the end
- **WHEN** the same file is read with `offset` 11
- **THEN** it fails with an error saying the file has 10 lines

#### Scenario: A last line without a newline
- **WHEN** the file is "a\nb", and `read` is called with `offset` 2
- **THEN** the output is "b"

#### Scenario: CRLF lines
- **WHEN** the file is "a\r\nb\r\nc\r\n", and `read` is called with `offset` 2 and `limit` 1
- **THEN** the output is "b\r\n", followed by a note giving offset 3

#### Scenario: An empty file
- **WHEN** the file is empty, and `read` is called with `offset` null or 1
- **THEN** the output is empty, with no note

