## ADDED Requirements

### Requirement: Replace exact text in a file
The agent SHALL provide an `edit` tool, created for a root directory. Its arguments SHALL be exactly the required strings `path`, `old_string` and `new_string` and the required boolean `replace_all`, and no other property SHALL be allowed. Paths SHALL resolve as `write`'s do.

It SHALL find `old_string` in the file's contents as exact text, counting non-overlapping occurrences:
- with exactly one occurrence, it SHALL replace that occurrence with `new_string`;
- with more than one and `replace_all` true, it SHALL replace every occurrence;
- `new_string` SHALL be inserted literally, with no pattern such as `$&` or `$1` interpreted.

The rest of the file SHALL be unchanged, byte for byte, and the file SHALL keep its permissions. On success its output SHALL be `Replaced 1 occurrence in <path>.` or `Replaced <n> occurrences in <path>.`, where `<path>` is the argument as given.

#### Scenario: Replaces a unique snippet
- **WHEN** `app.ts` holds "const a = 1;\nconst b = 2;\n", and `edit` is called with `old_string` "const b = 2;", `new_string` "const b = 3;" and `replace_all` false
- **THEN** `app.ts` holds "const a = 1;\nconst b = 3;\n", and the output is `Replaced 1 occurrence in app.ts.`

#### Scenario: Replaces every occurrence
- **WHEN** `names.txt` holds "foo bar foo baz foo", and `edit` replaces "foo" with "qux" with `replace_all` true
- **THEN** `names.txt` holds "qux bar qux baz qux", and the output is `Replaced 3 occurrences in names.txt.`

#### Scenario: replace_all with a single occurrence
- **WHEN** the file holds "foo" once, and `edit` replaces it with `replace_all` true
- **THEN** it replaces that occurrence, and the output is `Replaced 1 occurrence in <path>.`

#### Scenario: Deletes text
- **WHEN** `edit` is called with a unique `old_string` and an empty `new_string`
- **THEN** that text is removed and nothing else changes

#### Scenario: Replacement patterns are literal
- **WHEN** `edit` replaces "price" with "$& and $1"
- **THEN** the file holds "$& and $1" where "price" was

#### Scenario: Non-overlapping count
- **WHEN** the file holds "aaa", and `edit` replaces "aa" with "b" with `replace_all` true
- **THEN** the file holds "ba", and the output reports 1 occurrence

#### Scenario: The model sees a closed schema
- **WHEN** `edit` is converted with `toFunctionTool`
- **THEN** its parameters require `path`, `old_string`, `new_string` and the boolean `replace_all`, and set `additionalProperties` to false

#### Scenario: Missing replace_all is rejected
- **WHEN** `edit` is called without `replace_all`
- **THEN** the arguments fail validation, and the file is unchanged

### Requirement: Explain a failed match
`edit` SHALL fail without changing the file when:
- `old_string` doesn't occur. The error SHALL say it wasn't found in the path, that it must match the file exactly, including whitespace and indentation, and that the model should read the file again and copy the text. When the file holds `\r\n` and `old_string` holds a `\n` not preceded by `\r`, the error SHALL also say that the file uses CRLF line endings;
- `old_string` occurs more than once and `replace_all` is false. The error SHALL give the number of occurrences, and say to include more of the surrounding text to make it unique, or to set `replace_all` to true;
- `old_string` is empty. The error SHALL say to use `write` to create or replace a whole file;
- `old_string` equals `new_string`. The error SHALL say there is nothing to change.

#### Scenario: Not found
- **WHEN** `edit` is called with an `old_string` the file doesn't contain
- **THEN** it fails with an error saying the text wasn't found and must match exactly, and the file is unchanged

#### Scenario: Not found in a CRLF file
- **WHEN** the file holds "one\r\ntwo\r\n", and `old_string` is "one\ntwo"
- **THEN** it fails with an error that also says the file uses CRLF line endings

#### Scenario: Ambiguous
- **WHEN** the file holds "x = 1" three times, and `edit` replaces "x = 1" with `replace_all` false
- **THEN** it fails with an error saying it occurs 3 times and naming `replace_all`, and the file is unchanged

#### Scenario: Empty old_string
- **WHEN** `edit` is called with an empty `old_string`
- **THEN** it fails with an error naming the `write` tool

#### Scenario: Nothing to change
- **WHEN** `old_string` and `new_string` are equal
- **THEN** it fails with an error saying there is nothing to change, and the file is unchanged

### Requirement: Edit only text files under the working directory
`edit` SHALL apply `write`'s fence: the same refusals of paths outside the working directory, of skill directories, of links leading outside, of broken links, and of `.env` files, with the same messages naming the `edit` tool. It SHALL also fail with an error naming the path and the reason, changing nothing, when:
- the file doesn't exist;
- the path is a directory;
- the file is larger than 10 MiB (10,485,760 bytes);
- the file holds a NUL byte;
- the file isn't valid UTF-8.

It SHALL report every failure, unexpected I/O errors included, as a failed outcome, and SHALL NOT throw.

#### Scenario: Missing file
- **WHEN** `edit` is called for `missing.txt`, which doesn't exist
- **THEN** it fails with an error saying there is no such file, and no file is created

#### Scenario: Outside the working directory
- **WHEN** `edit` is called for `../other/app.ts`
- **THEN** it fails with an error saying the path is outside the working directory

#### Scenario: Environment file
- **WHEN** `edit` is called for `.env`
- **THEN** it fails with an error saying environment files can't be written, and `.env` is unchanged

#### Scenario: Directory
- **WHEN** `edit` is called for `docs`, a directory
- **THEN** it fails with an error saying `docs` is a directory

#### Scenario: Too large
- **WHEN** the file is larger than 10 MiB
- **THEN** it fails with an error saying the file is too large to edit

#### Scenario: Binary file
- **WHEN** the file holds a NUL byte
- **THEN** it fails with an error saying it is a binary file

#### Scenario: Invalid UTF-8
- **WHEN** the file holds the byte 0xFF and no NUL
- **THEN** it fails with an error saying the file isn't valid UTF-8, and the file is unchanged
