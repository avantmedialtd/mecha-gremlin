## Why

The agent keeps nothing between runs. MCP servers that use OAuth need a client registration and rotating tokens kept from one run to the next, and the Brief's runs, history and tasks will need a database after them (4.4). D25–D28 settle its shape: SQLite in a required data folder, through TypeORM 1.1.2 and better-sqlite3 13, in a package of its own. This change adds that store and its first table, ahead of the OAuth login command that will fill it (C16, D35).

## What Changes

- Add `@mecha-gremlin/store`, in `packages/store`. It opens `db.sqlite` in a given data folder through TypeORM 1.1.2 and better-sqlite3 13:
  - it creates the file with mode 0600 when it's missing;
  - it sets every pragma itself: WAL, foreign keys, a short busy timeout, `synchronous = FULL` and recursive triggers;
  - it runs the pending migrations when it opens, and a migration that fails is an error that ends the open;
  - all database work in a process goes through one mutex, since TypeORM shares one connection per DataSource (C15);
  - entities are EntitySchema definitions: decorators can't run on Node 26.
- Add the first table, `credential`, for rotating OAuth credentials: MCP servers' now and SIWC's later (C17). A row holds the server's name and URL, the issuer, the client registration and the tokens as the MCP SDK saves them, the discovery state, when the access token expires, whether a new login is needed, and a lease for the refresh. Functions find, save and delete credentials, take a refresh lease, store refreshed tokens only while holding it, release it, and mark a credential as needing a login. Nothing calls them yet; the OAuth login change will.
- **BREAKING:** require `DATA_DIR`, an existing directory whose real path is used, and which must not contain `WORK_DIR`. Every run opens the store there before any network request, logs the migrations it applied, and closes the store when it ends. The `asking` record gains `dataDir`.
- `read`, `write`, `edit` and `apply_patch` refuse paths inside the data folder, as they refuse `.env` files. The shell can still reach it, as it can reach `.env`.
- Raise `engines.bun` to `>=1.4.4`, since Bun 1.4.3 runs node-gyp for better-sqlite3 13. Add a root `overrides` entry pinning better-sqlite3 to `^13.0.3`, so that an npm install can't choose 12.x for TypeORM's declared peer range.
- Keep SQLite files out of git, allow the TypeORM types the readonly-parameter rule rejects, keep `store` away from `process` and `console` as `yaml` and `process` are, and update the README and CI.

## Capabilities

### New Capabilities

- `store`: the data folder's database: creating and opening it, its pragmas and migrations, serialised work, and the `credential` table with its refresh lease.

### Modified Capabilities

- `agent`: `DATA_DIR` in the configuration; each run opens the store before any network request and closes it when the session ends; the `asking` record's `dataDir` and a `migrated` record; CI's start-up check supplies `DATA_DIR`.
- `read-tool`: refuses paths inside the data folder.
- `write-tool`: refuses paths inside the data folder.
- `edit-tool`: applies `write`'s refusal of the data folder.
- `apply-patch-tool`: applies `write`'s refusal of the data folder to every path a patch names.

## Impact

- A new package, `packages/store`, depending on `typeorm` `^1.1.2` and `better-sqlite3` `^13.0.3`. better-sqlite3 13 is a Node-API addon with prebuilt binaries for x64 and arm64, on glibc 2.34 or later and on musl; it adds 27.7 MB to `node_modules` (R17.6).
- `packages/agent`: the configuration, the entry point's start and finish, the file tools' fence, and a dependency on the store.
- The repository root: `package.json`'s overrides, `.gitignore`, `.oxlintrc.json`, `cspell.json`, the README and the CI workflow.
- Every `.env` must add `DATA_DIR`.
- Not in scope: the OAuth login command, the MCP client, encrypting the token columns (D32 recommends file permissions and the fence first, and remains open), backups, Docker, and the tables for runs, history, events and tasks.
