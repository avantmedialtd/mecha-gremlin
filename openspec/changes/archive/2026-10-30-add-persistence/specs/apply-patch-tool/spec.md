## MODIFIED Requirements

### Requirement: Add, delete, update and move files under the working directory
`apply_patch` SHALL apply `write`'s fence to every path the patch names, `Move to` destinations included, with the same messages naming `apply_patch`, and the same refusals of `.env` files and of the data folder.

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

#### Scenario: The data folder
- **WHEN** `DATA_DIR` is the working directory's `data` folder, and a patch adds `data/x.txt`, or moves `app.ts` to `data/app.ts`
- **THEN** it fails with an error saying the path is inside the data folder, and no file changes
