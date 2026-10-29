## ADDED Requirements

### Requirement: Open the database in a data folder
`openStore(dataDir)`, exported by `@mecha-gremlin/store/store`, SHALL open `db.sqlite` in the directory it is given, through TypeORM 1.1.2's `better-sqlite3` driver with better-sqlite3 13. It SHALL give the store, with the names of the migrations it applied. When `db.sqlite` doesn't exist, it SHALL create it with mode 0600 before SQLite opens it; an existing file SHALL keep its mode. When the database can't be created or opened, it SHALL give an error naming the database's path and the reason. It SHALL report every failure as a result and SHALL NOT throw. The store SHALL read no environment variable, and SHALL write nothing to stdout or stderr.

#### Scenario: A new database
- **WHEN** `openStore` is given an empty directory
- **THEN** `db.sqlite` exists there with mode 0600, and the `-wal` and `-shm` files SQLite creates beside it have mode 0600 too

#### Scenario: An existing database
- **WHEN** `db.sqlite` already exists with mode 0640
- **THEN** the store opens it, and its mode stays 0640

#### Scenario: A database that can't be opened
- **WHEN** `db.sqlite` in the given directory is itself a directory
- **THEN** `openStore` gives an error naming that path and the reason, and doesn't throw

#### Scenario: A folder it can't write to
- **WHEN** the given directory isn't writable and holds no `db.sqlite`
- **THEN** `openStore` gives an error naming the database's path and the reason

### Requirement: Set every pragma itself
On every open, the store SHALL set `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 2000`, `synchronous = FULL` and `recursive_triggers = ON`, whatever the SQLite build's defaults. `synchronous` SHALL still be FULL after the database's first read.

#### Scenario: The pragmas
- **WHEN** a store has opened, and a query has read the database
- **THEN** `PRAGMA journal_mode` gives `wal`, `foreign_keys` gives 1, `busy_timeout` gives 2000, `synchronous` gives 2 and `recursive_triggers` gives 1

### Requirement: Migrate when it opens
The store SHALL run every pending migration when it opens, in one transaction, with TypeORM's schema synchronisation off. It SHALL give the names of the migrations it applied, in the order they ran. Once they have run, TypeORM SHALL find no difference between the store's entity definitions and the database. A migration that fails SHALL be rolled back, the connection SHALL be closed, and the open SHALL give an error naming the reason; no store SHALL be given.

#### Scenario: The first open
- **WHEN** a store opens in an empty directory
- **THEN** it gives the name of the migration that creates the `credential` table, and the table exists

#### Scenario: A later open
- **WHEN** a store opens again in the same directory
- **THEN** it gives no migration names, and the credentials saved before are still there

#### Scenario: The schema matches the definitions
- **WHEN** a store has opened
- **THEN** TypeORM's schema builder has no queries to run

#### Scenario: A migration that fails
- **WHEN** the database already holds a `credential` table that no migration created
- **THEN** the open gives an error, that table is unchanged, and no store is given

### Requirement: Serialise all work on a store
A store SHALL run its database work one call at a time, in the order the calls were made, even when the callers don't wait for each other. `closeStore` SHALL wait for the work already started before it closes the connection. Work asked of a closed store SHALL give an error saying the store is closed.

#### Scenario: Overlapping calls
- **WHEN** a save and then a find for the same server are started without waiting for each other
- **THEN** the find gives the saved row

#### Scenario: Closing during work
- **WHEN** `closeStore` is called while a save runs
- **THEN** the save completes, and its row is there when a store is opened in the same directory again

#### Scenario: A closed store
- **WHEN** a credential function is called with a closed store
- **THEN** it gives an error saying the store is closed, and doesn't throw

### Requirement: Keep OAuth credentials
The store SHALL keep OAuth credentials in a `credential` table, with one row for each server name, server URL and issuer. A row SHALL hold:
- the client information, the tokens and the discovery state, exactly as they were saved, as JSON;
- when the access token expires, and when the row was created and last updated, in epoch milliseconds;
- whether a new login is needed;
- the refresh lease's holder and its end.

`saveCredential` SHALL insert a row, or replace the one with the same server name, URL and issuer, clearing `needsLogin` and the lease. `findCredentials` SHALL give a server's rows for its name and URL, the most recently updated first. `deleteCredentials` SHALL delete them, and say how many it deleted.

#### Scenario: A round trip
- **WHEN** a credential is saved whose client information and tokens hold nested objects, arrays and an issuer stamp
- **THEN** `findCredentials` gives them back deeply equal to what was saved

#### Scenario: Replacing a row
- **WHEN** a credential is saved twice for one server name, URL and issuer
- **THEN** one row remains, holding the second tokens, with `needsLogin` false and no lease

#### Scenario: One server under two issuers
- **WHEN** credentials are saved for one server's name and URL under two issuers
- **THEN** `findCredentials` gives both, the most recently updated first

#### Scenario: One URL under two names
- **WHEN** credentials are saved for two server names with the same URL
- **THEN** `findCredentials` for each name gives only that name's row

#### Scenario: Deleting
- **WHEN** a server's credentials are deleted
- **THEN** `deleteCredentials` says how many it deleted, `findCredentials` gives none for that server, and other servers' rows remain

### Requirement: Lease a credential's refresh
`takeRefreshLease` SHALL give a lease, for the length the caller asks, only when the row's stored refresh token is the one the caller names, none included, and no unexpired lease is held. `saveRefreshedTokens` SHALL store new tokens and their expiry, and release the lease, only while the caller holds the lease and the stored refresh token is still the one it named. `releaseRefreshLease` SHALL release the lease, and `markNeedsLogin` SHALL set `needsLogin` and release the lease, only for the lease's holder. Each of them SHALL say whether it changed the row.

#### Scenario: One holder at a time
- **WHEN** two callers take the lease for the same refresh token
- **THEN** exactly one of them is given it

#### Scenario: An expired lease
- **WHEN** a lease's end has passed
- **THEN** another caller is given the lease

#### Scenario: A rotated refresh token
- **WHEN** the stored refresh token is no longer the one the caller names
- **THEN** the caller is refused the lease

#### Scenario: No refresh token
- **WHEN** the stored tokens hold no refresh token, and the caller names none
- **THEN** the caller is given the lease

#### Scenario: Saving after the lease was lost
- **WHEN** a caller's lease has expired and another caller has taken it
- **THEN** the first caller's `saveRefreshedTokens` stores nothing and says so, and the second caller's stores its tokens

#### Scenario: A login during a refresh
- **WHEN** `saveCredential` replaces a row while a caller holds its refresh lease
- **THEN** that caller's `saveRefreshedTokens` stores nothing and says so

#### Scenario: Releasing the lease
- **WHEN** the holder releases its lease
- **THEN** another caller can take it at once, while a release by a caller that doesn't hold it changes nothing

#### Scenario: A credential that needs a new login
- **WHEN** the lease's holder marks the credential as needing a login
- **THEN** `needsLogin` is true and the lease is released, and a later `saveCredential` for the same row clears `needsLogin`
