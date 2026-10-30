import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { DataSource, type Logger } from 'typeorm';
import { type Store, connect, reasonOf } from './connection.ts';
import { credentialSchema } from './credential.ts';
import { CreateCredential1793232000000 } from './migrations/1793232000000-create-credential.ts';

export { type Store, closeStore } from './connection.ts';

export type Opened = {
    readonly store: Store;
    /** The migrations the open applied, in the order they ran. */
    readonly migrated: readonly string[];
};

// SQLite's busy timeout, and so the longest a call may freeze the event loop while it waits for
// another connection's lock: the driver is synchronous (Brief R17.2).
const BUSY_TIMEOUT_MS = 2000;

const SYNCHRONOUS_FULL = 2;

// TypeORM's own loggers print a failed migration whatever its `logging` option says, and the
// store reports only through its results.
const SILENT: Logger = {
    logQuery: () => undefined,
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
    log: () => undefined,
};

// SQLite gives the -wal and -shm files the database file's mode, so creating it 0600 keeps all
// three private, where a umask of 022 would leave them readable by anyone (Brief R17.2).
const createFile = async (path: string): Promise<Result<undefined, string>> => {
    try {
        await writeFile(path, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (Object(error).code !== 'EEXIST') {
            return err(`Can't create the database at ${path}: ${reasonOf(error)}`);
        }
    }

    return ok(undefined);
};

const createDataSource = (path: string): DataSource => {
    return new DataSource({
        type: 'better-sqlite3',
        database: path,
        entities: [credentialSchema],
        migrations: [CreateCredential1793232000000],
        synchronize: false,
        // TypeORM sets journal_mode = WAL for this, and foreign_keys = ON whatever the options.
        enableWAL: true,
        timeout: BUSY_TIMEOUT_MS,
        logger: SILENT,
        // So that a later append-only trigger can't be bypassed with INSERT OR REPLACE, whose
        // deletes fire delete triggers only while this is on (Brief R17.2).
        prepareDatabase: (database: { readonly pragma: (source: string) => unknown }) => {
            database.pragma('recursive_triggers = ON');
        },
    });
};

export const openStore = async (dataDir: string): Promise<Result<Opened, string>> => {
    const path = join(dataDir, 'db.sqlite');
    const created = await createFile(path);

    if (!created.ok) {
        return created;
    }

    let dataSource: DataSource;

    try {
        dataSource = createDataSource(path);
        await dataSource.initialize();
    } catch (error) {
        return err(`Can't open the database at ${path}: ${reasonOf(error)}`);
    }

    let migrated: string[];
    let synchronous: readonly { readonly synchronous: unknown }[];

    try {
        const migrations = await dataSource.runMigrations({ transaction: 'all' });
        migrated = migrations.map((migration) => migration.name);
        // FULL makes each commit, such as a rotated refresh token, survive a power loss. Until
        // SQLite first reads the file, synchronous reads back as FULL whatever it will be; then
        // an unset one falls to the WAL default, NORMAL in better-sqlite3's build (Brief R17.2,
        // R17.6). The migrations have read the file, so what reads back now holds.
        await dataSource.query('PRAGMA synchronous = FULL');
        synchronous = await dataSource.query('PRAGMA synchronous');
    } catch (error) {
        // A failed migration leaves foreign keys off on the connection that all work shares, so
        // nothing may use it (Brief R17.1).
        await dataSource.destroy();

        return err(`Can't migrate the database at ${path}: ${reasonOf(error)}`);
    }

    if (synchronous[0]?.synchronous !== SYNCHRONOUS_FULL) {
        await dataSource.destroy();

        return err(
            `Can't open the database at ${path}: synchronous doesn't stay FULL, which a commit needs to survive a power loss.`,
        );
    }

    return ok({ store: connect(path, dataSource), migrated });
};
