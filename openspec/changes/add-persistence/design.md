## Context

The agent reads its settings from the environment, validates them with Zod before any network request, runs one task and keeps everything in memory. Runtime-specific code lives in small packages, `yaml` and `process`, which report only through their results. It runs on Bun 1.4.4 and Node 26, where Node strips types itself and runs no transform (D19). Tests run on both runtimes, and Stryker fails below a 100% mutation score.

On 2026-10-29 D25 made SQLite, in a data folder on a local file system, the database for good, and D26 made better-sqlite3 13 its driver under TypeORM 1.1.2. D27 put persistence in a package of its own, and D28 made `DATA_DIR` required. The research behind them is R17.1, R17.2 and R17.6 in the Brief. C15 lists the conventions TypeORM needs on SQLite and Node, and C17 the shape of a credential row. Several of those findings constrain this design:
- Node 26 can't parse decorators, so entities are `EntitySchema` definitions.
- TypeORM gives each DataSource one connection and one query runner on SQLite, so overlapping transactions corrupt each other.
- The drivers are synchronous, so waiting for a lock freezes the event loop.
- A failed migration leaves foreign keys off.
- better-sqlite3 13 is outside TypeORM's declared `^12` peer range, though Bun links it.

The OAuth login command and the MCP client come in later changes (C16, D35). This change gives them a store and a table to write to.

## Goals / Non-Goals

**Goals:**
- One call that gives a ready database in the data folder, or an error that says what's wrong.
- Files that are private from the start, and pragmas that don't depend on the build or the runtime.
- The `credential` table, and the functions the OAuth login will need, the refresh lease included, tested without OAuth.
- The same behaviour on Bun and Node and on macOS and Linux, with the tests and Stryker at 100% on the new code.

**Non-Goals:**
- An OAuth flow, an MCP client, or anything that calls the credential functions.
- Encrypting columns: D32 is open, and its recommendation is the file's mode and the fence first.
- Backups, Docker, a daemon lock, or tables for runs, history, events and tasks (4.4).
- A repository layer, dependency injection, or a database other than SQLite.

## Decisions

### 1. A package of its own, with a small functional API

```
packages/store/
├── package.json        @mecha-gremlin/store: "exports": { "./*": "./src/*.ts" }
├── tsconfig.json       "extends": "../../tsconfig.json"
├── src/
│   ├── store.ts        openStore and closeStore, and the mutex every query goes through
│   ├── credential.ts   the credential EntitySchema and its functions
│   └── migrations/
│       └── 1793232000000-create-credential.ts
└── test/               mirrors src
```

```ts
// @mecha-gremlin/store/store
export type Store = { readonly path: string };   // the DataSource and the mutex stay inside
export type Opened = { readonly store: Store; readonly migrated: readonly string[] };
export const openStore: (dataDir: string) => Promise<Result<Opened, string>>;
export const closeStore: (store: Store) => Promise<void>;

// @mecha-gremlin/store/credential
export const findCredentials, saveCredential, deleteCredentials,
    takeRefreshLease, saveRefreshedTokens, releaseRefreshLease, markNeedsLogin;
```

Every function gives a `Result`, as the rest of the code does (`result`), and none throws. The package reads no environment and logs nothing: it is given the folder, and the agent reports what happened. It joins `yaml` and `process` under the lint override that forbids `process` and `console` in their sources.

**Alternatives:** a `store` folder in `agent`, which is simpler today but would move into M1's app, where 4.2 puts entities and migrations; or M1's app package, started now. The app runs agents, so the agent couldn't import it, and credentials would have to be handed to it.

### 2. Opening: the file, then TypeORM, then the migrations, then `synchronous`

1. **The file.** `db.sqlite` is created with `open(path, 'wx', 0o600)` when it's missing. SQLite then gives the `-wal` and `-shm` files the same mode, where a umask of 022 would have left all three readable by anyone (R17.2). An existing file keeps its mode.
2. **The DataSource.** `type: 'better-sqlite3'`, the file's path, the entity and migration classes, `synchronize: false`, `enableWAL: true`, `timeout: 2000` and `logging: false`. `prepareDatabase` sets `recursive_triggers = ON`, so a later append-only trigger can't be bypassed with `INSERT OR REPLACE` (R17.2). TypeORM turns foreign keys on itself.
   - `timeout` is SQLite's busy timeout, and so the longest a waiting call may freeze the event loop (R17.2). Two seconds is plenty for this app's writes, which take milliseconds.
3. **The migrations.** `runMigrations({ transaction: 'all' })` runs every pending migration in one transaction, and its names are what `openStore` gives as `migrated`. On a failure, `openStore` destroys the DataSource and gives an error. TypeORM leaves foreign keys off after a failed migration, on the connection it shares, so nothing may keep using it (R17.1).
4. **`synchronous = FULL`**, then read back. better-sqlite3's SQLite applies its WAL default, NORMAL, when it first reads the file, so a value set before that read doesn't stick (R17.6); by now the migrations have read it. FULL makes each commit survive a power loss, which matters for a rotated refresh token (R17.2), and the app writes too rarely for the extra fsync to matter.

**Alternatives:** `synchronize: true`, which changes the schema with no reviewable record; and `migrationsRun: true`, which runs the same migrations inside `initialize()` but doesn't give their names.

### 3. One mutex for all the work on a store

The store chains every query on one promise, and `closeStore` waits for the chain before destroying the DataSource. TypeORM's SQLite drivers share one connection and query runner per DataSource. A second `transaction()` becomes a savepoint inside the first, and a `query()` from another task joins whichever transaction is open (R17.2). Without the mutex, a find during a save returned null, and closing overtook a save (R17.6).

Inside the mutex, a write transaction starts with a write, so SQLite's busy handler waits for the lock instead of failing a deferred read-then-write at once (C15, R17.2). The credential functions are single statements, which need no transaction at all.

**Alternative:** a worker thread holding the connection, so lock waits wouldn't freeze the event loop. Not now: the writes are rare and short.

### 4. EntitySchema, and migrations written by hand

- **Entities** are `EntitySchema` definitions with an explicit type on every column (C7, C15). TypeORM's types are imported with `import type`.
- **Migrations** are classes imported by name, never found by a glob. Each:
  - is named with the 13-digit timestamp TypeORM requires;
  - runs one SQL statement per `query()`, since `node:sqlite` and `bun:sqlite` drop a second one silently and better-sqlite3 throws (R17.1);
  - has an exact `down`.

  The CLI's `migration:generate` may write a first draft, which then needs `import type` and single statements (R17.1).
- **A test compares the entity with the database:** after migrating, `createSchemaBuilder().log()` has no up queries. It keeps the two in step, and it kills the static mutants in the schema literal, which Stryker under load can otherwise count as timeouts (R17.6).

### 5. The `credential` table

| Column | Type | Holds |
|---|---|---|
| `id` | integer, primary key | generated |
| `server` | text | the configured server's name |
| `url` | text | the server's URL, as configured |
| `issuer` | text | the authorization server's issuer, which keys the registration (R17.4) |
| `client` | text: JSON | the client information as the MCP SDK saves it, issuer stamp included |
| `tokens` | text: JSON | the token set as the SDK saves it |
| `discovery` | text: JSON, nullable | the discovery state the SDK saves |
| `expires_at` | integer, nullable | when the access token expires, in epoch milliseconds |
| `needs_login` | integer: boolean | set when a refresh is refused |
| `lease_owner` | text, nullable | who holds the refresh lease |
| `lease_until` | integer, nullable | when the lease ends, in epoch milliseconds |
| `created_at`, `updated_at` | integer | epoch milliseconds |

- **Unique on `server`, `url` and `issuer`.** One URL configured under two names holds two sign-ins, and a server whose authorization server changes keeps one row per issuer, as the specification requires (R17.4). Q22 can be answered either way without changing the table.
- **The SDK's values are kept verbatim,** because its issuer stamps must round-trip (R17.3). The JSON columns are TypeORM's `simple-json`, plain text; `json` declares NUMERIC affinity, which stores a top-level number as an integer (R17.2).
- **Times are integers,** since SQLite has no date type and text in mixed formats compares wrongly (R17.2). The functions read the clock themselves, as the rest of the app does, and tests fake it.
- **Tokens are stored as they come.** The file's mode and the fence protect them (D32).

The functions each run one statement, inside the mutex:
- `findCredentials(store, { server, url })` gives a server's rows, the most recently updated first.
- `saveCredential(store, credential)` inserts the row, or replaces the one with the same `server`, `url` and `issuer`, clearing `needs_login` and the lease. It is an `INSERT … ON CONFLICT … DO UPDATE` through TypeORM's `orUpdate`: the unique key isn't partial, so TypeORM's SQLite limits don't apply.
- `deleteCredentials(store, { server, url })`.
- `takeRefreshLease(store, { id, seen, owner, leaseMs })`:
  ```sql
  UPDATE credential SET lease_owner = :owner, lease_until = :now + :leaseMs, updated_at = :now
   WHERE id = :id AND json_extract(tokens, '$.refresh_token') IS :seen
     AND (lease_until IS NULL OR lease_until < :now)
  ```
- `saveRefreshedTokens(store, { id, seen, owner, tokens, expiresAt })`:
  ```sql
  UPDATE credential SET tokens = :tokens, expires_at = :expiresAt, lease_owner = NULL,
                        lease_until = NULL, updated_at = :now
   WHERE id = :id AND lease_owner = :owner AND json_extract(tokens, '$.refresh_token') IS :seen
  ```
- `releaseRefreshLease(store, { id, owner })`, and `markNeedsLogin(store, { id, owner })`, which also releases the lease. Both act only for the lease's holder.

Each update says whether it changed the row, from TypeORM's `UpdateResult.affected`, which better-sqlite3 reports correctly. Raw `dataSource.query()` would give the last insert rowid for a write, not a count (R17.1). `IS` compares a missing refresh token as NULL, where `=` would never match.

The caller makes the HTTP refresh between taking the lease and saving, outside any transaction, and aborts it before the lease runs out. Against a mock server that rotates refresh tokens and revokes the grant on reuse, this protocol gave exactly one rotation, and other writers never waited more than a few milliseconds (R17.2). Holding `BEGIN IMMEDIATE` across the call stalled every writer in every process, and compare-and-swap alone let the grant be revoked.

### 6. The agent opens the store before any network request, and closes it last

- **Configuration.** `DATA_DIR` is required, and resolved and checked as `WORK_DIR` is: it must be an existing directory, and its native real path is used. It must not be `WORK_DIR` or contain it, since every file the tools work on would then sit inside the folder they refuse. The error joins the other configuration errors, all reported before any network request.
- **Start.** After the configuration and the skills, and before the run ID, the shell and the session, the agent calls `openStore(config.dataDir)`. On an error it logs it and exits with 1, having made no network request. Opening first also keeps better-sqlite3's first open on Linux clear of open sockets: its #1527 reports a stall of seconds there (R17.6).
- **Logs.** An `info` record `migrated`, with `names`, when any migration ran. The `asking` record gains `dataDir`.
- **Finish.** `finish()` closes the store once the session's processes are stopped, on every path, signals included. A clean close checkpoints the WAL and removes `-wal` and `-shm`.

### 7. The file tools refuse the data folder

`fenceRead` and `fenceWrite` are given the data folder's real path, and refuse a target inside it, as written and with links resolved. The message names the path, and says that the folder holds the agent's database. The check matters when the folder sits inside the working directory or a skill directory; elsewhere the existing checks already refuse it. The shell isn't fenced, as it isn't for `.env` (README), and under C3 the workspace container won't mount the folder at all.

### 8. Dependencies, install and lint

- **`packages/store`** depends on `typeorm` `^1.1.2`, `better-sqlite3` `^13.0.3` and `@mecha-gremlin/core`. TypeORM loads better-sqlite3 itself. Bun's isolated install links version 13 as TypeORM's optional peer despite the `^12` range, and its hoisting fallback finds it too (R17.6). Nothing imports better-sqlite3 directly, so `@types/better-sqlite3` isn't needed.
- **The root `overrides`** gain `"better-sqlite3": "^13.0.3"`, beside `qs`. In an npm workspace, npm would otherwise put 12.x at the root for TypeORM's peer, which Bun can't load (R17.6). This repository can't be installed with npm today, so the entry is insurance.
- **`packages/agent`'s `engines.bun`** becomes `>=1.4.4`. Bun 1.4.3 runs a node-gyp build for better-sqlite3 13, which fails without Python. Bun ignores `engines`, so the entry documents the floor, and CI pins 1.4.4.
- **`.oxlintrc.json`:** the readonly-parameter rule's `allow` list gains the TypeORM types the code passes around, such as `DataSource`, `EntityManager` and `QueryRunner`. `packages/store/src/**` joins the `yaml` and `process` override.
- **`.gitignore`:** `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm` and `*.sqlite-journal`. The database holds tokens, and a data folder may sit inside a checkout.
- **The README:**
  - Prerequisites, now Bun 1.4.4 or later.
  - The package in Layout, and `DATA_DIR` in Configuration.
  - A section on the data folder:
    - its files;
    - keeping it on a local file system: in Docker, a named volume, never a bind mount on Docker Desktop for macOS;
    - copying it with `VACUUM INTO`, never `db.sqlite` alone;
    - and that the shell can read it.
- **CI's Node start-up check** supplies `DATA_DIR: ${{ runner.temp }}`, so Node opens the store and runs the migrations before it fails on LM Studio.

### 9. Tests

- **Real SQLite** in temporary directories, on both runtimes, never a mock. Each test opens its own store and closes it.
- **The store:**
  - the file's mode, and each pragma;
  - migrations applied once and then never again, the schema comparison, and a failed migration;
  - the mutex: overlapping calls, and a close while work runs;
  - every credential function, including two callers taking one lease, an expired lease, a rotated refresh token, and a fenced save after the lease was lost.
- **The agent:**
  - `DATA_DIR` unset, naming a file, given relatively, given through a link, and containing `WORK_DIR`;
  - the store opening before any network request, and `migrated` on the first run only;
  - an unusable data folder, the close on every path, and each tool's refusal.
- **Stryker** keeps its 100% threshold, with `store` included.

## Risks / Trade-offs

- [better-sqlite3 13 is outside TypeORM's declared peer range] → Bun links it today, and CI's frozen install notices if that changes. The `node:sqlite` stand-in is the fallback (D26).
- [Bun's #36712 would swap better-sqlite3 for a `bun:sqlite` shim] → It is a stale bot PR. If it moves, pass the module by its absolute path as `driver` (R17.6).
- [Waiting for a lock freezes the event loop] → A 2-second busy timeout, and writes of one statement each.
- [The prebuilds need glibc 2.34 or musl, on x64 or arm64] → The README says so. Docker's Debian 13 and Alpine images meet it (R17.6).
- [Tokens are stored in plain text] → Mode 0600, the fence, and `.gitignore`. D32 decides about encryption.
- [A failed migration leaves foreign keys off] → The open fails, and the agent exits.
- [`synchronous` falls back to NORMAL without a word] → It is set after the first read, read back, and tested.
- [Under load, Stryker can count a static mutant that no test kills as a timeout] → The schema comparison test, and a look at the report's timeouts.

## Migration Plan

Every `.env` adds `DATA_DIR`, naming an existing directory outside the checkout or in an ignored path. The first run creates `db.sqlite` and applies the first migration. To roll back, revert the change and delete the data folder, which holds nothing else yet.

## Open Questions

- D32: should the token columns be encrypted, with a key kept outside the data folder?
- Q22: is a server identified by its name, or by its name and URL? The unique key covers both.
- Should the busy timeout and the lease's length be settings? They are constants for now.
