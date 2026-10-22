# apply-patch-tool Specification

## Purpose

The agent's `apply_patch` tool, offered instead of `write` and `edit` when `FILE_TOOLS` is `apply-patch`: the V4A patch format it accepts, how it finds each chunk as Codex does, and how it applies a patch whole or not at all.
## Requirements
### Requirement: Accept a patch in Codex's V4A format
The agent SHALL provide an `apply_patch` tool, created for a root directory. Its arguments SHALL be exactly one required string, `patch`, and no other property SHALL be allowed. Its description SHALL explain the format, with an example.

A patch SHALL be `*** Begin Patch`, then one or more hunks, then `*** End Patch`. Each hunk SHALL be one of:
- `*** Add File: <path>`, followed by one or more lines that each begin with `+`;
- `*** Delete File: <path>`;
- `*** Update File: <path>`, optionally followed by `*** Move to: <path>`, then one or more chunks.

A chunk SHALL open with a line that is `@@` or `@@ <context line>`, except that the first chunk of a hunk MAY omit it. Its lines SHALL each begin with ` ` (context), `-` (removed) or `+` (added), and it MAY end with `*** End of File`. An empty line inside a chunk SHALL count as an empty context line.

Like Codex's parser, it SHALL:
- ignore whitespace around markers;
- accept a patch wrapped in a heredoc, whose first line is `<<EOF`, `<<'EOF'` or `<<"EOF"` and whose last line ends with `EOF`, and strip the wrapper;
- fail with an error that begins `invalid patch:` when the markers are missing or the patch has no hunk;
- fail with an error that begins `invalid hunk at line <n>,`, giving the patch's line number, for a malformed hunk.

A path SHALL be relative to the root, or absolute.

#### Scenario: Parses every kind of hunk
- **WHEN** a patch adds `new.txt`, deletes `old.txt`, and updates `app.ts` with two chunks
- **THEN** it is parsed into those three hunks, in order

#### Scenario: A heredoc wrapper
- **WHEN** the patch's first line is `<<'EOF'` and its last line is `EOF`
- **THEN** it is parsed as the patch between them

#### Scenario: No hunks
- **WHEN** the patch is `*** Begin Patch` followed by `*** End Patch`
- **THEN** it fails with an error beginning `invalid patch:`, and no file changes

#### Scenario: Missing markers
- **WHEN** the patch doesn't begin with `*** Begin Patch`
- **THEN** it fails with an error beginning `invalid patch:`

#### Scenario: A malformed hunk
- **WHEN** an update chunk holds a line beginning with neither ` `, `-`, `+`, `@@` nor a marker
- **THEN** it fails with an error beginning `invalid hunk at line` and giving that line's number

#### Scenario: The model sees a closed schema
- **WHEN** `apply_patch` is converted with `toFunctionTool`
- **THEN** its parameters require the string `patch` and set `additionalProperties` to false

### Requirement: Find each chunk as Codex does
For each Update hunk, `apply_patch` SHALL apply its chunks in order, each searching forward from where the previous one ended:
1. When the chunk has an `@@ <context line>` header, that line SHALL be found first, as a single line, and the search SHALL continue after it. If it isn't found, the patch SHALL fail with `Failed to find context '<line>' in <path>`.
2. The chunk's old lines, its context and removed lines in order, SHALL then be found as a run of consecutive lines, trying four passes in turn and taking the first match of the first pass that finds one:
   - exact;
   - ignoring trailing whitespace;
   - ignoring leading and trailing whitespace;
   - ignoring leading and trailing whitespace, with Unicode dashes and minus signs read as `-`, curly and low single quotes as `'`, curly and low double quotes as `"`, and non-breaking and other Unicode spaces as a space.
3. If they aren't found and the old lines end with an empty line, the search SHALL be retried without it, and without a trailing empty new line.
4. With `*** End of File`, the search SHALL start no earlier than where the old lines would end the file.
5. A chunk with no old lines SHALL append its added lines at the end of the file.

If the old lines aren't found, the patch SHALL fail with `Failed to find expected lines in <path>:` followed by those lines.

When a chunk is applied, its removed lines SHALL be replaced by its added lines. Its context lines SHALL keep the file's own text, even when they matched only leniently. Every line SHALL keep its own line ending, and an inserted line SHALL take the file's first line ending, or `\n` when the file has none.

#### Scenario: An exact update
- **WHEN** `app.ts` holds "a\nb\nc\n", and a chunk has the context line "a", removes "b" and adds "B"
- **THEN** `app.ts` holds "a\nB\nc\n"

#### Scenario: A context header picks the place
- **WHEN** `app.ts` holds two functions that both contain the line "return 0;", and a chunk's header is `@@ function second() {` and it removes "return 0;"
- **THEN** only the line in `second` changes

#### Scenario: Trailing whitespace is tolerated
- **WHEN** the file's line is "foo   " and the chunk's context line is "foo"
- **THEN** the chunk applies, and the file's line is still "foo   "

#### Scenario: Typographic punctuation is tolerated
- **WHEN** the file's line holds "it’s – done" and the chunk removes "it's - done"
- **THEN** the chunk applies

#### Scenario: Context not found
- **WHEN** a chunk's header names a line the file doesn't hold
- **THEN** it fails with `Failed to find context '<line>' in <path>`, and no file changes

#### Scenario: Lines not found
- **WHEN** a chunk removes a line the file doesn't hold
- **THEN** it fails with an error beginning `Failed to find expected lines in`, listing the old lines, and no file changes

#### Scenario: Appending at the end
- **WHEN** a chunk has only added lines
- **THEN** they are appended at the end of the file

#### Scenario: CRLF is kept
- **WHEN** the file holds "a\r\nb\r\n", and a chunk replaces "b" with "B" and adds "C"
- **THEN** the file holds "a\r\nB\r\nC\r\n"

#### Scenario: The first match is used
- **WHEN** the old lines occur twice after the previous chunk, and there is no header
- **THEN** the first occurrence changes

### Requirement: Add, delete, update and move files under the working directory
`apply_patch` SHALL apply `write`'s fence to every path the patch names, `Move to` destinations included, with the same messages naming `apply_patch`, and the same refusal of `.env` files.

- **Add File** SHALL write the `+` lines, joined with `\n` and ending with `\n`, creating parent directories. An existing file SHALL be replaced, unless it is a directory or larger than 32 KiB, which `write` refuses for the same reasons.
- **Delete File** SHALL remove the file. It SHALL fail when the file doesn't exist or is a directory.
- **Update File** SHALL fail when the file doesn't exist or is a directory, or when `edit` would refuse it: larger than 10 MiB, holding a NUL byte, or not valid UTF-8.
- **Move to** SHALL write the updated contents to the destination, creating its parent directories, and then remove the source.
- **A path named in more than one hunk,** as a source or a destination, SHALL fail the patch.

#### Scenario: Adds a file in a new directory
- **WHEN** a patch adds `docs/new.md` with the lines "+# Title" and "+text"
- **THEN** `docs/new.md` holds "# Title\ntext\n"

#### Scenario: Deletes a file
- **WHEN** a patch deletes `old.txt`, which exists
- **THEN** `old.txt` no longer exists

#### Scenario: Deleting a missing file
- **WHEN** a patch deletes `gone.txt`, which doesn't exist
- **THEN** it fails with an error naming `gone.txt`, and no file changes

#### Scenario: Moves and updates a file
- **WHEN** a patch updates `src/a.ts` with `*** Move to: lib/b.ts` and one chunk
- **THEN** `lib/b.ts` holds the updated contents, and `src/a.ts` no longer exists

#### Scenario: Outside the working directory
- **WHEN** a patch adds `../escape.txt`
- **THEN** it fails with an error saying the path is outside the working directory, and no file changes

#### Scenario: An environment file
- **WHEN** a patch updates `.env`
- **THEN** it fails with an error saying environment files can't be written, and no file changes

#### Scenario: Replacing a large file
- **WHEN** a patch adds `big.log`, an existing file of 40,000 bytes
- **THEN** it fails with an error saying the file is larger than one read returns, and no file changes

#### Scenario: A path named twice
- **WHEN** a patch updates `app.ts` in two separate hunks
- **THEN** it fails with an error naming `app.ts`, and no file changes

### Requirement: Change nothing unless the whole patch applies, and report each file
`apply_patch` SHALL parse the whole patch, check every path, read every file it updates or deletes, and work out every new content before it writes, removes or creates anything. If any of those steps fails, no file SHALL change. It SHALL then make the changes in the patch's order. If an I/O error stops it partway, the error SHALL list the files already changed.

On success its output SHALL be `Success. Updated the following files:`, followed by one line per hunk, in the patch's order: `A <path>` for an added file, `M <path>` for an updated one, and `D <path>` for a deleted one. A moved file SHALL be listed as `M` with its destination. Paths SHALL be as the patch gives them.

It SHALL report every failure as a failed outcome, and SHALL NOT throw.

#### Scenario: A later hunk fails
- **WHEN** a patch adds `new.txt`, then updates `app.ts` with a chunk that doesn't match
- **THEN** it fails, `new.txt` isn't created, and `app.ts` is unchanged

#### Scenario: The success report
- **WHEN** a patch adds `a.txt`, updates `b.txt` and deletes `c.txt`
- **THEN** the output is "Success. Updated the following files:\nA a.txt\nM b.txt\nD c.txt"

#### Scenario: A move in the report
- **WHEN** a patch updates `src/a.ts` with `*** Move to: lib/b.ts`
- **THEN** the report lists `M lib/b.ts`

