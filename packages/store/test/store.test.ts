import { existsSync } from 'node:fs';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { describe, expect, test, vi } from 'vitest';
import { withDataSource } from '../src/connection.ts';
import { findCredentials, saveCredential } from '../src/credential.ts';
import { type Store, closeStore, openStore } from '../src/store.ts';
import { dataFolder, open } from './stores.ts';

const CREDENTIAL = {
    server: 'linear',
    url: 'https://mcp.linear.app/mcp',
    issuer: 'https://linear.app',
    client: { client_id: 'client-1' },
    tokens: { access_token: 'at-1', refresh_token: 'rt-1' },
    discovery: null,
    expiresAt: null,
};

const modeOf = async (path: string): Promise<number> => {
    return (await stat(path)).mode & 0o777;
};

// Pragmas belong to a connection, so they're read through the store's own.
const pragma = (store: Store, name: string) => {
    return withDataSource(store, `read ${name}`, (dataSource) => {
        return dataSource.query(`PRAGMA ${name}`);
    });
};

// A connection of its own, outside the store, opened and closed around the statements.
const outside = async (path: string, ...statements: readonly string[]): Promise<unknown[]> => {
    const dataSource = new DataSource({ type: 'better-sqlite3', database: path });
    const results: unknown[] = [];
    await dataSource.initialize();

    try {
        for (const statement of statements) {
            results.push(await dataSource.query(statement));
        }
    } finally {
        await dataSource.destroy();
    }

    return results;
};

// A clean close of the last connection checkpoints the WAL and removes these.
const leftovers = (path: string): string[] => {
    return [`${path}-wal`, `${path}-shm`].filter((file) => existsSync(file));
};

describe('Open the database in a data folder', () => {
    // Under the usual umask, 022, SQLite alone would create all three readable by anyone. Tests
    // can't set it: Stryker runs them in worker threads, which may not.
    test('a new database is private, and so are the files SQLite creates beside it', async () => {
        const folder = await dataFolder();

        await open(folder);

        expect(await modeOf(join(folder, 'db.sqlite'))).toBe(0o600);
        expect(await modeOf(join(folder, 'db.sqlite-wal'))).toBe(0o600);
        expect(await modeOf(join(folder, 'db.sqlite-shm'))).toBe(0o600);
    });

    test('an existing database keeps its mode', async () => {
        const folder = await dataFolder();
        await writeFile(join(folder, 'db.sqlite'), '');
        await chmod(join(folder, 'db.sqlite'), 0o640);

        const { migrated } = await open(folder);

        expect(migrated).toEqual(['CreateCredential1793232000000']);
        expect(await modeOf(join(folder, 'db.sqlite'))).toBe(0o640);
    });

    test('a db.sqlite that is a directory', async () => {
        const folder = await dataFolder();
        await mkdir(join(folder, 'db.sqlite'));

        expect(await openStore(folder)).toEqual({
            ok: false,
            error: `Can't open the database at ${join(folder, 'db.sqlite')}: unable to open database file`,
        });
    });

    test.skipIf(process.getuid?.() === 0)("a folder it can't write to", async () => {
        const folder = await dataFolder();
        await chmod(folder, 0o555);

        try {
            expect(await openStore(folder)).toEqual({
                ok: false,
                error: expect.stringContaining(
                    `Can't create the database at ${join(folder, 'db.sqlite')}: EACCES`,
                ),
            });
            expect(existsSync(join(folder, 'db.sqlite'))).toBe(false);
        } finally {
            await chmod(folder, 0o755);
        }
    });

    // TypeORM's own loggers print a failed migration even with logging off.
    test('it writes nothing to stdout or stderr, even when a migration fails', async () => {
        const calls = [
            vi.spyOn(console, 'log'),
            vi.spyOn(console, 'info'),
            vi.spyOn(console, 'warn'),
            vi.spyOn(console, 'error'),
            vi.spyOn(console, 'debug'),
            vi.spyOn(process, 'emitWarning'),
            vi.spyOn(process.stdout, 'write'),
            vi.spyOn(process.stderr, 'write'),
        ];
        const folder = await dataFolder();
        const taken = await dataFolder();
        await outside(join(taken, 'db.sqlite'), 'CREATE TABLE credential (note text)');

        const { store } = await open(folder);
        await saveCredential(store, CREDENTIAL);
        await findCredentials(store, CREDENTIAL);
        await closeStore(store);
        const failures = [await openStore(join(folder, 'missing')), await openStore(taken)];

        expect(failures).toMatchObject([{ ok: false }, { ok: false }]);
        expect(calls.flatMap((spy) => spy.mock.calls)).toEqual([]);
    });
});

describe('Set every pragma itself', () => {
    test('the pragmas, once a query has read the database', async () => {
        const { store } = await open();
        await findCredentials(store, CREDENTIAL);

        expect(await pragma(store, 'journal_mode')).toEqual({
            ok: true,
            value: [{ journal_mode: 'wal' }],
        });
        expect(await pragma(store, 'foreign_keys')).toEqual({
            ok: true,
            value: [{ foreign_keys: 1 }],
        });
        expect(await pragma(store, 'busy_timeout')).toEqual({
            ok: true,
            value: [{ timeout: 2000 }],
        });
        expect(await pragma(store, 'synchronous')).toEqual({
            ok: true,
            value: [{ synchronous: 2 }],
        });
        expect(await pragma(store, 'recursive_triggers')).toEqual({
            ok: true,
            value: [{ recursive_triggers: 1 }],
        });
    });

    test('an existing database gets them too', async () => {
        const folder = await dataFolder();
        await closeStore((await open(folder)).store);
        const { store } = await open(folder);
        await findCredentials(store, CREDENTIAL);

        expect(await pragma(store, 'synchronous')).toEqual({
            ok: true,
            value: [{ synchronous: 2 }],
        });
        expect(await pragma(store, 'recursive_triggers')).toEqual({
            ok: true,
            value: [{ recursive_triggers: 1 }],
        });
    });

    // A build or driver whose synchronous falls back to its WAL default without a word.
    test.each([
        ['reads back as NORMAL', [{ synchronous: 1 }]],
        ['reads back as nothing', []],
    ])('synchronous that %s fails the open, and closes the connection', async (_how, rows) => {
        // The original, which the spy calls for every other query.
        const query = Reflect.get(DataSource.prototype, 'query');
        vi.spyOn(DataSource.prototype, 'query').mockImplementation(function (
            this: DataSource,
            ...args
        ) {
            return args[0] === 'PRAGMA synchronous'
                ? Promise.resolve(rows)
                : Reflect.apply(query, this, args);
        });
        const folder = await dataFolder();
        const path = join(folder, 'db.sqlite');

        const opened = await openStore(folder);

        expect(opened).toEqual({
            ok: false,
            error: `Can't open the database at ${path}: synchronous doesn't stay FULL, which a commit needs to survive a power loss.`,
        });
        expect(leftovers(path)).toEqual([]);
    });
});

describe('Migrate when it opens', () => {
    test('the first open creates the credential table', async () => {
        const { store, migrated } = await open();

        expect(migrated).toEqual(['CreateCredential1793232000000']);
        expect(
            await withDataSource(store, 'list the tables', (dataSource) => {
                return dataSource.query(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'",
                );
            }),
        ).toEqual({ ok: true, value: [{ name: 'credential' }] });
    });

    // One migration of one statement can't show the difference, so the option is pinned.
    test('pending migrations run in one transaction', async () => {
        const run = vi.spyOn(DataSource.prototype, 'runMigrations');

        await open();

        expect(run).toHaveBeenCalledExactlyOnceWith({ transaction: 'all' });
    });

    test('a later open runs none, and what was saved is still there', async () => {
        const folder = await dataFolder();
        const first = await open(folder);
        await saveCredential(first.store, CREDENTIAL);
        await closeStore(first.store);

        const { store, migrated } = await open(folder);

        expect(migrated).toEqual([]);
        expect(await findCredentials(store, CREDENTIAL)).toMatchObject({
            ok: true,
            value: [{ issuer: 'https://linear.app' }],
        });
    });

    test('the schema matches the entity definitions', async () => {
        const { store } = await open();

        expect(
            await withDataSource(store, 'compare the schema', (dataSource) => {
                return dataSource.driver.createSchemaBuilder().log();
            }),
        ).toEqual({ ok: true, value: { upQueries: [], downQueries: [] } });
    });

    test('a credential table that no migration created fails the open, unchanged', async () => {
        const folder = await dataFolder();
        const path = join(folder, 'db.sqlite');
        await outside(
            path,
            'CREATE TABLE credential (note text)',
            "INSERT INTO credential VALUES ('kept')",
        );

        const opened = await openStore(folder);

        expect(opened).toEqual({
            ok: false,
            error: `Can't migrate the database at ${path}: SqliteError: table "credential" already exists`,
        });
        // TypeORM leaves foreign keys off after a failed migration, so the connection is closed.
        expect(leftovers(path)).toEqual([]);
        expect(
            await outside(
                path,
                'SELECT note FROM credential',
                "SELECT sql FROM sqlite_master WHERE name = 'credential'",
                'SELECT name FROM migrations',
            ),
        ).toEqual([[{ note: 'kept' }], [{ sql: 'CREATE TABLE credential (note text)' }], []]);
    });
});

describe('Close the store', () => {
    test('closing checkpoints the database and removes its -wal and -shm files', async () => {
        const folder = await dataFolder();
        const { store } = await open(folder);
        await saveCredential(store, CREDENTIAL);

        await closeStore(store);

        expect(leftovers(join(folder, 'db.sqlite'))).toEqual([]);
        expect(await outside(join(folder, 'db.sqlite'), 'SELECT server FROM credential')).toEqual([
            [{ server: 'linear' }],
        ]);
    });

    test('closing a closed store does nothing', async () => {
        const { store } = await open();
        await closeStore(store);

        await expect(closeStore(store)).resolves.toBeUndefined();
    });
});
