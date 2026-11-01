## REMOVED Requirements

### Requirement: Add, delete, update and move files under the working directory
**Reason**: Replaced by "Add, delete, update and move files", without `write`'s fence: `apply_patch` refuses no path for where it is (Brief R20, C20, D41).
**Migration**: None: a patch that names a refused path now applies. To bound what the agent can reach, run it in a container.

## ADDED Requirements

### Requirement: Add, delete, update and move files
`apply_patch` SHALL resolve every path the patch names, `Move to` destinations included, as `write` does, and SHALL refuse none for where it is.

- **Add File** SHALL write the `+` lines, joined with `\n` and ending with `\n`, creating parent directories. An existing file SHALL be replaced, unless it is a directory or larger than 32 KiB, which `write` refuses for the same reasons.
- **Delete File** SHALL remove the path the patch names, so that a symbolic link goes, not what it points to. It SHALL fail when the file doesn't exist or is a directory.
- **Update File** SHALL fail when the file doesn't exist or is a directory, or when `edit` would refuse it: larger than 10 MiB, holding a NUL byte, or not valid UTF-8.
- **Move to** SHALL write the updated contents to the destination, creating its parent directories, and then remove the source as the patch names it.
- **A file named in more than one hunk,** as a source or a destination, SHALL fail the patch. Two paths SHALL name one file when they resolve to the same path, or when both exist and have the same real path, as a symbolic link and its target do.

#### Scenario: Adds a file in a new directory
- **WHEN** a patch adds `docs/new.md` with the lines "+# Title" and "+text"
- **THEN** `docs/new.md` holds "# Title\ntext\n"

#### Scenario: Deletes a file
- **WHEN** a patch deletes `old.txt`, which exists
- **THEN** `old.txt` no longer exists

#### Scenario: Deleting a missing file
- **WHEN** a patch deletes `gone.txt`, which doesn't exist
- **THEN** it fails with an error naming `gone.txt`, and no file changes

#### Scenario: Deleting a link
- **WHEN** the root holds `alias.txt`, a symbolic link to `notes.txt`, and a patch deletes `alias.txt`
- **THEN** `alias.txt` no longer exists, and `notes.txt` is unchanged

#### Scenario: Moves and updates a file
- **WHEN** a patch updates `src/a.ts` with `*** Move to: lib/b.ts` and one chunk
- **THEN** `lib/b.ts` holds the updated contents, and `src/a.ts` no longer exists

#### Scenario: Replacing a large file
- **WHEN** a patch adds `big.log`, an existing file of 40,000 bytes
- **THEN** it fails with an error saying the file is larger than one read returns, and no file changes

#### Scenario: A path named twice
- **WHEN** a patch updates `app.ts` in two separate hunks
- **THEN** it fails with an error naming `app.ts`, and no file changes

#### Scenario: A file named twice through a link
- **WHEN** the root holds `alias.ts`, a symbolic link to `app.ts`, and a patch updates `alias.ts` and then `app.ts`
- **THEN** it fails with an error naming `app.ts`, and no file changes

#### Scenario: Wherever the file is
- **WHEN** `DATA_DIR` is the root's `data` folder, and a patch adds `../outside.txt`, updates `.env`, and moves `app.ts` to `data/app.ts`
- **THEN** the patch applies, and the report lists `A ../outside.txt`, `M .env` and `M data/app.ts`
