## MODIFIED Requirements

### Requirement: Refuse secrets, directories and large files
`write` SHALL fail with an error naming the path and the reason, writing nothing, when:
- the requested file name, or the real file name, begins with `.env`;
- the path, as written or with links resolved, is inside the data folder, `DATA_DIR`, which holds the agent's database;
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

#### Scenario: The data folder
- **WHEN** `DATA_DIR` is the working directory's `data` folder, and `write` is called for `data/db.sqlite` or for `data/new.txt`
- **THEN** it fails with an error saying the path is inside the data folder, and no file there is created or changed

#### Scenario: A link into the data folder
- **WHEN** the root holds `out`, a symbolic link to the data folder, and `write` is called for `out/x.txt`
- **THEN** it fails as writing inside the data folder does, and nothing is created there
