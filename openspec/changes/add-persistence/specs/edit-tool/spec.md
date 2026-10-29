## MODIFIED Requirements

### Requirement: Edit only text files under the working directory
`edit` SHALL apply `write`'s fence: the same refusals of paths outside the working directory, of skill directories, of links leading outside, of broken links, of `.env` files, and of the data folder, with the same messages naming the `edit` tool. It SHALL also fail with an error naming the path and the reason, changing nothing, when:
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

#### Scenario: The data folder
- **WHEN** `DATA_DIR` is the working directory's `data` folder, and `edit` is called for `data/notes.txt`, a text file there
- **THEN** it fails with an error saying the path is inside the data folder, and the file is unchanged
