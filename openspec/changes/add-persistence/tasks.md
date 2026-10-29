## 1. The package and its dependencies

- [ ] 1.1 Create `packages/store` as `@mecha-gremlin/store`: `"type": "module"`, `"exports": { "./*": "./src/*.ts" }`, a `tsconfig.json` extending the root's, and `test/` mirroring `src/`. No index file.
- [ ] 1.2 Add `typeorm` `^1.1.2`, `better-sqlite3` `^13.0.3` and `@mecha-gremlin/core` to it with `bun add`, and check that Bun links better-sqlite3 13 where TypeORM loads it, despite TypeORM's `^12` peer range. Add no `@types/better-sqlite3`, since nothing imports it.
- [ ] 1.3 Add `"better-sqlite3": "^13.0.3"` to the root `overrides`, beside `qs`; add `@mecha-gremlin/store` to `packages/agent`; raise `packages/agent`'s `engines.bun` to `>=1.4.4`.
- [ ] 1.4 Add `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm` and `*.sqlite-journal` to `.gitignore`, with a comment saying the database holds tokens.
- [ ] 1.5 Add `packages/store/src/**` to `.oxlintrc.json`'s override for `yaml` and `process` (no `process`, no `console`), and add the TypeORM types the code passes, such as `DataSource`, `EntityManager` and `QueryRunner`, to the readonly-parameter rule's `allow` list.

## 2. Opening the store

- [ ] 2.1 Write `openStore(dataDir)` in `src/store.ts`: create `db.sqlite` with `open(path, 'wx', 0o600)` when it's missing, leaving an existing file's mode; build the DataSource (`better-sqlite3`, `synchronize: false`, `enableWAL: true`, `timeout: 2000`, `logging: false`, `prepareDatabase` setting `recursive_triggers = ON`); and initialise it.
- [ ] 2.2 Run the migrations with `runMigrations({ transaction: 'all' })`, giving their names. On a failure, destroy the DataSource and give an error naming the reason, so that nothing uses a connection whose foreign keys TypeORM left off.
- [ ] 2.3 After the migrations, set `synchronous = FULL` and read it back, failing the open if it isn't 2, since better-sqlite3's SQLite applies its WAL default at the first read.
- [ ] 2.4 Give every failure as a `Result` with the database's path and the reason, and never throw; check that the package reads no environment and writes nothing to stdout or stderr.
- [ ] 2.5 Add the mutex: every query on a store runs after the previous one has finished, `closeStore` waits for the work already started before destroying the DataSource, and work asked of a closed store gives an error saying so.

## 3. The credential table

- [ ] 3.1 Define the `credential` EntitySchema in `src/credential.ts`, with an explicit type on every column: `id` (generated integer), `server`, `url`, `issuer`, `client`, `tokens` and `discovery` (`simple-json`, `discovery` nullable), `expires_at`, `needs_login`, `lease_owner`, `lease_until`, `created_at` and `updated_at`, unique on `server`, `url` and `issuer`.
- [ ] 3.2 Write the migration `src/migrations/1793232000000-create-credential.ts`, named with its 13-digit timestamp, with `import type` for TypeORM's types, one SQL statement per `query()`, and an exact `down`; import it by name in `openStore`.
- [ ] 3.3 Write `findCredentials`, `saveCredential` (an `INSERT … ON CONFLICT … DO UPDATE` through `orUpdate`, clearing `needs_login` and the lease) and `deleteCredentials` (giving the count), each one statement inside the mutex, with times read from the clock in epoch milliseconds.
- [ ] 3.4 Write `takeRefreshLease`, `saveRefreshedTokens`, `releaseRefreshLease` and `markNeedsLogin` as single conditional `UPDATE`s through the QueryBuilder, comparing the stored refresh token with `json_extract(tokens, '$.refresh_token') IS :seen`, and saying from `UpdateResult.affected` whether they changed the row.

## 4. The agent

- [ ] 4.1 Add `DATA_DIR` to `loadConfig`: required, resolved and checked as `WORK_DIR` is (an existing directory, its native real path), and refused when it is the working directory or contains it; report its errors with the others, before any network request.
- [ ] 4.2 Open the store in `main.ts` after the configuration and the skills, and before the run ID, the shell and the session. Log an error and exit with 1 when it fails, and log `migrated` with `names` when migrations ran.
- [ ] 4.3 Add `dataDir` to the `asking` record, and close the store in `finish()` once the session's processes are stopped, on every path, signals included.
- [ ] 4.4 Give `fenceRead` and `fenceWrite` the data folder's real path, and refuse a target inside it, as written and with links resolved, with a message naming the path and saying the folder holds the agent's database; pass the folder to `read`, `write`, `edit` and `apply_patch` from `main.ts`.

## 5. Tests

- [ ] 5.1 Test `openStore` on both runtimes with real SQLite in temporary directories: a new file's mode and its `-wal` and `-shm` files' modes; an existing file's mode kept; a `db.sqlite` that is a directory; an unwritable folder; each pragma, `synchronous` after a read included.
- [ ] 5.2 Test the migrations: the first open's names, a later open's none, the schema builder finding nothing to change, a pre-existing `credential` table making the open fail with nothing changed, and the migration's `down` undoing its `up`.
- [ ] 5.3 Test the mutex: a save and a find started together, a close while a save runs, and a call on a closed store.
- [ ] 5.4 Test the credential functions: the verbatim round trip, replacing a row, two issuers, two names with one URL, deleting, and every lease scenario in the `store` spec, faking the clock for expiry.
- [ ] 5.5 Test the agent: `DATA_DIR` unset, a file, relative, through a link, and being or containing `WORK_DIR`; the store opening before any network request; `migrated` on the first run only; `dataDir` in `asking`; an unusable data folder; and the store closed after an answer, a failure and SIGINT.
- [ ] 5.6 Test each file tool's refusal of the data folder, directly and through a link, and that it creates or changes nothing there.
- [ ] 5.7 Run `bun run mutation` with `store` included and keep the 100% threshold. Kill the schema literal's static mutants with the schema comparison test, and look at every timeout in the report, since under load Stryker can count a static mutant that no test kills as one.

## 6. Documentation, CI and checks

- [ ] 6.1 Update the README: Bun 1.4.4 or later in Prerequisites, the package in Layout, `DATA_DIR` in Configuration and in the example `.env`s, and a section on the data folder. That section covers its files, a local file system (in Docker a named volume, never a bind mount on Docker Desktop for macOS), copying it with `VACUUM INTO` and never `db.sqlite` alone, the prebuilds' glibc 2.34 or musl on x64 or arm64, and that the shell can read it.
- [ ] 6.2 Give CI's Node start-up check `DATA_DIR: ${{ runner.temp }}`, so that Node opens the store and runs the migrations before failing on LM Studio.
- [ ] 6.3 Update `Brief.md`: 4.2's layout gains `store`, and the header's log notes the change.
- [ ] 6.4 Add new words to `cspell.json`, then run `bun run check` and `openspec validate add-persistence --strict`, and fix what fails.
