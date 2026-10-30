import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { reasonOf, withDataSource } from '../src/connection.ts';
import {
    type NewCredential,
    deleteCredentials,
    findCredentials,
    markNeedsLogin,
    releaseRefreshLease,
    saveCredential,
    saveRefreshedTokens,
    takeRefreshLease,
} from '../src/credential.ts';
import { closeStore } from '../src/store.ts';
import { dataFolder, open } from './stores.ts';

const CREDENTIAL: NewCredential = {
    server: 'linear',
    url: 'https://mcp.linear.app/mcp',
    issuer: 'https://linear.app',
    client: { client_id: 'client-1' },
    tokens: { access_token: 'at-1', refresh_token: 'rt-1' },
    discovery: null,
    expiresAt: null,
};

// A timer fires only once every promise callback queued so far has run.
const settled = (): Promise<void> => {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
};

describe('Serialise all work on a store', () => {
    test('work starts once the work asked before it has finished', async () => {
        const { store } = await open();
        const first = Promise.withResolvers<string>();
        const started: string[] = [];

        const one = withDataSource(store, 'do one', () => {
            started.push('one');

            return first.promise;
        });
        const two = withDataSource(store, 'do two', async () => {
            started.push('two');

            return 'two';
        });
        await settled();

        expect(started).toEqual(['one']);

        first.resolve('one');

        expect(await one).toEqual({ ok: true, value: 'one' });
        expect(await two).toEqual({ ok: true, value: 'two' });
        expect(started).toEqual(['one', 'two']);
    });

    test('a failure reaches only its own caller', async () => {
        const { store } = await open();

        const failing = withDataSource(store, 'fail', () => Promise.reject(new Error('broken')));
        const after = withDataSource(store, 'carry on', async () => 'after');

        expect(await failing).toEqual({
            ok: false,
            error: `Can't fail in the database at ${store.path}: broken`,
        });
        expect(await after).toEqual({ ok: true, value: 'after' });
    });

    test('overlapping calls: a save and then a find, started together', async () => {
        const { store } = await open();

        const saving = saveCredential(store, CREDENTIAL);
        const found = findCredentials(store, CREDENTIAL);

        expect(await saving).toEqual({ ok: true, value: undefined });
        expect(await found).toMatchObject({ ok: true, value: [{ issuer: 'https://linear.app' }] });
    });

    test('closing during work: the save completes, and its row is there afterwards', async () => {
        const folder = await dataFolder();
        const { store } = await open(folder);

        const saving = saveCredential(store, CREDENTIAL);
        await closeStore(store);

        expect(await saving).toEqual({ ok: true, value: undefined });
        expect(await findCredentials((await open(folder)).store, CREDENTIAL)).toMatchObject({
            ok: true,
            value: [{ issuer: 'https://linear.app' }],
        });
    });

    test('work asked once the close has begun is refused', async () => {
        const { store } = await open();

        const closing = closeStore(store);
        const found = await findCredentials(store, CREDENTIAL);
        await closing;

        expect(found).toEqual({
            ok: false,
            error: `Can't find the credentials: the store at ${store.path} is closed.`,
        });
    });

    test('a closed store refuses every function, without throwing', async () => {
        const folder = await dataFolder();
        const { store } = await open(folder);
        await closeStore(store);
        const closed = `the store at ${join(folder, 'db.sqlite')} is closed.`;
        const holder = { id: 1, owner: 'run-1' };

        expect(
            await Promise.all([
                findCredentials(store, CREDENTIAL),
                saveCredential(store, CREDENTIAL),
                deleteCredentials(store, CREDENTIAL),
                takeRefreshLease(store, { ...holder, seen: 'rt-1', leaseMs: 1000 }),
                saveRefreshedTokens(store, { ...holder, seen: 'rt-1', tokens: {}, expiresAt: 1 }),
                releaseRefreshLease(store, holder),
                markNeedsLogin(store, holder),
            ]),
        ).toEqual([
            { ok: false, error: `Can't find the credentials: ${closed}` },
            { ok: false, error: `Can't save the credential: ${closed}` },
            { ok: false, error: `Can't delete the credentials: ${closed}` },
            { ok: false, error: `Can't take the refresh lease: ${closed}` },
            { ok: false, error: `Can't save the refreshed tokens: ${closed}` },
            { ok: false, error: `Can't release the refresh lease: ${closed}` },
            { ok: false, error: `Can't mark the credential as needing a login: ${closed}` },
        ]);
    });

    test('a query that fails gives an error naming the database and the reason', async () => {
        const { store } = await open();
        await withDataSource(store, 'drop the table', (dataSource) => {
            return dataSource.query('DROP TABLE credential');
        });

        expect(await findCredentials(store, CREDENTIAL)).toEqual({
            ok: false,
            error: `Can't find the credentials in the database at ${store.path}: SqliteError: no such table: credential`,
        });
    });
});

describe('reasonOf', () => {
    test("an error's message", () => {
        expect(reasonOf(new Error('disk on fire'))).toBe('disk on fire');
    });

    test('anything else thrown, as text', () => {
        expect(reasonOf('disk on fire')).toBe('disk on fire');
    });
});
