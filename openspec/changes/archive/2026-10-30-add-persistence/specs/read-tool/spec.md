## MODIFIED Requirements

### Requirement: Refuse secrets, directories and binary files
`read` SHALL fail with an error naming the path and the reason when:
- the requested file name, or the real file name, begins with `.env`;
- the path, as written or with links resolved, is inside the data folder, `DATA_DIR`, which holds the agent's database;
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

#### Scenario: The data folder
- **WHEN** `DATA_DIR` is the working directory's `data` folder, and `read` is called for `data/db.sqlite`
- **THEN** it fails with an error saying the path is inside the data folder, and the file's contents appear nowhere in the outcome

#### Scenario: A link into the data folder
- **WHEN** the root holds `notes.txt`, a symbolic link to a file inside the data folder
- **THEN** reading `notes.txt` fails as reading inside the data folder does
