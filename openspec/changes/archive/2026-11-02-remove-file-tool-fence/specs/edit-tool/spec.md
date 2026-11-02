## REMOVED Requirements

### Requirement: Edit only text files under the working directory
**Reason**: Replaced by "Edit only text files", without `write`'s fence: `edit` refuses no path for where it is (Brief R20, C20, D41).
**Migration**: None: a path that was refused is now edited. To bound what the agent can reach, run it in a container.

## ADDED Requirements

### Requirement: Edit only text files
`edit` SHALL refuse no path for where it is, as `write` refuses none. It SHALL fail with an error naming the path and the reason, changing nothing, when:
- the file doesn't exist;
- the path is a directory;
- the file is larger than 10 MiB (10,485,760 bytes);
- the file holds a NUL byte;
- the file isn't valid UTF-8.

It SHALL report every failure, unexpected I/O errors included, as a failed outcome, and SHALL NOT throw.

#### Scenario: Missing file
- **WHEN** `edit` is called for `missing.txt`, which doesn't exist
- **THEN** it fails with an error saying there is no such file, and no file is created

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

#### Scenario: Wherever the file is
- **WHEN** `DATA_DIR` is the root's `data` folder, and `edit` is called for `../other/app.ts`, for `.env` and for `data/notes.txt`, each a text file holding `old_string` once
- **THEN** each file is changed as any other file is
