import { describe, expect, test, vi } from 'vitest';
import {
    type Credential,
    type NewCredential,
    type Server,
    credentialSchema,
    deleteCredentials,
    findCredentials,
    markNeedsLogin,
    releaseRefreshLease,
    saveCredential,
    saveRefreshedTokens,
    takeRefreshLease,
} from '../src/credential.ts';
import type { Store } from '../src/store.ts';
import { open } from './stores.ts';

const LINEAR: Server = { server: 'linear', url: 'https://mcp.linear.app/mcp' };
const ISSUER = 'https://linear.app';

// Shaped as the MCP SDK saves them, the client information with its issuer stamp.
const CLIENT = {
    client_id: 'client-1',
    redirect_uris: ['http://127.0.0.1:33418/callback'],
    token_endpoint_auth_method: 'none',
    issuer: ISSUER,
};
const TOKENS = {
    access_token: 'at-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'rt-1',
    scope: 'read write',
};
const DISCOVERY = {
    authorizationServerUrl: ISSUER,
    resourceMetadata: { resource: LINEAR.url, scopes_supported: ['read', 'write'] },
    authorizationServerMetadata: { issuer: ISSUER, code_challenge_methods_supported: ['S256'] },
};

const credential = (changes: Partial<NewCredential> = {}): NewCredential => {
    return {
        ...LINEAR,
        issuer: ISSUER,
        client: CLIENT,
        tokens: TOKENS,
        discovery: DISCOVERY,
        expiresAt: 4_600_000,
        ...changes,
    };
};

const at = (time: number): void => {
    vi.spyOn(Date, 'now').mockReturnValue(time);
};

const rowsOf = async (store: Store, server: Server = LINEAR): Promise<Credential[]> => {
    const found = await findCredentials(store, server);

    if (!found.ok) {
        throw new Error(found.error);
    }

    return found.value;
};

// A store holding the one credential, saved at time 1000, and the row's id.
const saved = async (changes: Partial<NewCredential> = {}) => {
    const { store } = await open();
    at(1000);
    await saveCredential(store, credential(changes));
    const [row] = await rowsOf(store);

    if (row === undefined) {
        throw new Error('the credential was not saved');
    }

    return { store, id: row.id };
};

// Two credentials, both leased by one owner, as a run refreshing more than one server would hold
// them.
const twoLeased = async () => {
    const { store, id } = await saved();
    await saveCredential(store, credential({ server: 'notion' }));
    const [notion] = await rowsOf(store, { server: 'notion', url: LINEAR.url });

    if (notion === undefined) {
        throw new Error('the second credential was not saved');
    }

    await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 30_000 });
    await takeRefreshLease(store, { id: notion.id, seen: 'rt-1', owner: 'run-1', leaseMs: 30_000 });

    return { store, id, other: { server: 'notion', url: LINEAR.url } };
};

// The store's tests compare the entity with the database, but TypeORM would give the id, generated
// by increment, the type integer by itself, so only this shows a type left out.
test('every column of the entity has an explicit type', () => {
    const columns = Object.entries(credentialSchema.options.columns);

    expect(columns.filter(([, column]) => !column?.type).map(([name]) => name)).toEqual([]);
    expect(columns).toHaveLength(13);
});

describe('Keep OAuth credentials', () => {
    test('a round trip keeps the SDK values exactly, and says when', async () => {
        const { store } = await open();
        at(1000);

        expect(await saveCredential(store, credential())).toEqual({ ok: true, value: undefined });
        expect(await rowsOf(store)).toEqual([
            {
                id: 1,
                server: 'linear',
                url: 'https://mcp.linear.app/mcp',
                issuer: ISSUER,
                client: CLIENT,
                tokens: TOKENS,
                discovery: DISCOVERY,
                expiresAt: 4_600_000,
                needsLogin: false,
                leaseOwner: null,
                leaseUntil: null,
                createdAt: 1000,
                updatedAt: 1000,
            },
        ]);
    });

    test('no discovery state and no expiry', async () => {
        const { store } = await saved({ discovery: null, expiresAt: null });

        expect(await rowsOf(store)).toMatchObject([{ discovery: null, expiresAt: null }]);
    });

    test('saving again for the same server and issuer replaces the row, clearing its state', async () => {
        const { store, id } = await saved();
        at(2000);
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 30_000 });
        await markNeedsLogin(store, { id, owner: 'run-1' });
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-2', leaseMs: 30_000 });
        at(3000);
        const tokens = { access_token: 'at-2', token_type: 'Bearer', refresh_token: 'rt-2' };

        await saveCredential(
            store,
            credential({
                client: { client_id: 'client-2' },
                tokens,
                discovery: null,
                expiresAt: 7,
            }),
        );

        expect(await rowsOf(store)).toEqual([
            {
                id,
                ...LINEAR,
                issuer: ISSUER,
                client: { client_id: 'client-2' },
                tokens,
                discovery: null,
                expiresAt: 7,
                needsLogin: false,
                leaseOwner: null,
                leaseUntil: null,
                createdAt: 1000,
                updatedAt: 3000,
            },
        ]);
    });

    test('one server under two issuers: both, the most recently updated first', async () => {
        const { store, id } = await saved();
        at(2000);
        await saveCredential(store, credential({ issuer: 'https://auth.linear.app' }));

        const newest = await rowsOf(store);
        at(3000);
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 1 });
        const touched = await rowsOf(store);

        expect(newest.map((row) => row.issuer)).toEqual(['https://auth.linear.app', ISSUER]);
        expect(touched.map((row) => row.issuer)).toEqual([ISSUER, 'https://auth.linear.app']);
    });

    test('rows updated at the same time come newest first', async () => {
        const { store } = await saved();
        await saveCredential(store, credential({ issuer: 'https://auth.linear.app' }));

        expect((await rowsOf(store)).map((row) => row.issuer)).toEqual([
            'https://auth.linear.app',
            ISSUER,
        ]);
    });

    test('one URL under two names: each name gives only its own row', async () => {
        const { store } = await saved();
        await saveCredential(store, credential({ server: 'linear-work' }));

        expect((await rowsOf(store)).map((row) => row.server)).toEqual(['linear']);
        expect(
            (await rowsOf(store, { server: 'linear-work', url: LINEAR.url })).map(
                (row) => row.server,
            ),
        ).toEqual(['linear-work']);
        expect(await rowsOf(store, { server: 'linear', url: 'https://other.example/mcp' })).toEqual(
            [],
        );
    });

    test("deleting a server's credentials says how many, and leaves the others", async () => {
        const { store } = await saved();
        await saveCredential(store, credential({ issuer: 'https://auth.linear.app' }));
        await saveCredential(store, credential({ server: 'notion' }));

        const deleted = await deleteCredentials(store, LINEAR);

        expect(deleted).toEqual({ ok: true, value: 2 });
        expect(await rowsOf(store)).toEqual([]);
        expect(await rowsOf(store, { server: 'notion', url: LINEAR.url })).toHaveLength(1);
        expect(await deleteCredentials(store, LINEAR)).toEqual({ ok: true, value: 0 });
    });
});

describe("Lease a credential's refresh", () => {
    test('one holder at a time, whose lease is recorded', async () => {
        const { store, id } = await saved();
        at(2000);

        const taken = await Promise.all([
            takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 30_000 }),
            takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-2', leaseMs: 30_000 }),
        ]);

        expect(taken).toEqual([
            { ok: true, value: true },
            { ok: true, value: false },
        ]);
        expect(await rowsOf(store)).toMatchObject([
            { leaseOwner: 'run-1', leaseUntil: 32_000, updatedAt: 2000 },
        ]);
    });

    test('an expired lease: held until its end, then given to another caller', async () => {
        const { store, id } = await saved();
        at(2000);
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 1000 });
        at(3000);
        const atTheEnd = await takeRefreshLease(store, {
            id,
            seen: 'rt-1',
            owner: 'run-2',
            leaseMs: 1000,
        });
        at(3001);

        const afterIt = await takeRefreshLease(store, {
            id,
            seen: 'rt-1',
            owner: 'run-2',
            leaseMs: 1000,
        });

        expect(atTheEnd).toEqual({ ok: true, value: false });
        expect(afterIt).toEqual({ ok: true, value: true });
        expect(await rowsOf(store)).toMatchObject([{ leaseOwner: 'run-2', leaseUntil: 4001 }]);
    });

    test('a rotated refresh token: the caller naming the old one is refused', async () => {
        const { store, id } = await saved();

        expect(
            await takeRefreshLease(store, { id, seen: 'rt-0', owner: 'run-1', leaseMs: 1000 }),
        ).toEqual({ ok: true, value: false });
        expect(
            await takeRefreshLease(store, { id, seen: null, owner: 'run-1', leaseMs: 1000 }),
        ).toEqual({ ok: true, value: false });
        expect(await rowsOf(store)).toMatchObject([{ leaseOwner: null }]);
    });

    test('no refresh token: a caller naming none is given the lease', async () => {
        const { store, id } = await saved({ tokens: { access_token: 'at-1' } });

        expect(
            await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 1000 }),
        ).toEqual({ ok: true, value: false });
        expect(
            await takeRefreshLease(store, { id, seen: null, owner: 'run-1', leaseMs: 1000 }),
        ).toEqual({ ok: true, value: true });
    });

    test('another credential: the lease is taken by its id', async () => {
        const { store, id } = await saved();

        expect(
            await takeRefreshLease(store, {
                id: id + 1,
                seen: 'rt-1',
                owner: 'run-1',
                leaseMs: 1000,
            }),
        ).toEqual({ ok: true, value: false });
    });

    test("the holder's refreshed tokens are stored, and its lease released", async () => {
        const { store, id } = await saved();
        at(2000);
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 30_000 });
        at(3000);
        const tokens = { access_token: 'at-2', token_type: 'Bearer', refresh_token: 'rt-2' };

        const stored = await saveRefreshedTokens(store, {
            id,
            seen: 'rt-1',
            owner: 'run-1',
            tokens,
            expiresAt: 3_603_000,
        });

        expect(stored).toEqual({ ok: true, value: true });
        expect(await rowsOf(store)).toMatchObject([
            {
                tokens,
                expiresAt: 3_603_000,
                leaseOwner: null,
                leaseUntil: null,
                createdAt: 1000,
                updatedAt: 3000,
            },
        ]);
        expect(
            await takeRefreshLease(store, { id, seen: 'rt-2', owner: 'run-2', leaseMs: 1000 }),
        ).toEqual({ ok: true, value: true });
    });

    test('refreshed tokens for a refresh token other than the stored one are not stored', async () => {
        const { store, id } = await saved();
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 30_000 });

        const stored = await saveRefreshedTokens(store, {
            id,
            seen: 'rt-0',
            owner: 'run-1',
            tokens: { access_token: 'at-2' },
            expiresAt: null,
        });

        expect(stored).toEqual({ ok: true, value: false });
        expect(await rowsOf(store)).toMatchObject([{ tokens: TOKENS, leaseOwner: 'run-1' }]);
    });

    test('saving after the lease was lost stores nothing, and the new holder saves', async () => {
        const { store, id } = await saved();
        at(2000);
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 1000 });
        at(5000);
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-2', leaseMs: 30_000 });

        const late = await saveRefreshedTokens(store, {
            id,
            seen: 'rt-1',
            owner: 'run-1',
            tokens: { access_token: 'at-late', refresh_token: 'rt-late' },
            expiresAt: 1,
        });
        const current = await saveRefreshedTokens(store, {
            id,
            seen: 'rt-1',
            owner: 'run-2',
            tokens: { access_token: 'at-2', refresh_token: 'rt-2' },
            expiresAt: 2,
        });

        expect(late).toEqual({ ok: true, value: false });
        expect(current).toEqual({ ok: true, value: true });
        expect(await rowsOf(store)).toMatchObject([
            { tokens: { access_token: 'at-2', refresh_token: 'rt-2' }, expiresAt: 2 },
        ]);
    });

    test('a login during a refresh: the refreshed tokens are not stored over it', async () => {
        const { store, id } = await saved();
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 30_000 });
        const login = { access_token: 'at-login', refresh_token: 'rt-1' };
        await saveCredential(store, credential({ tokens: login }));

        const stored = await saveRefreshedTokens(store, {
            id,
            seen: 'rt-1',
            owner: 'run-1',
            tokens: { access_token: 'at-2', refresh_token: 'rt-2' },
            expiresAt: null,
        });

        expect(stored).toEqual({ ok: true, value: false });
        expect(await rowsOf(store)).toMatchObject([{ tokens: login, leaseOwner: null }]);
    });

    test('releasing: by the holder at once, by anyone else not at all', async () => {
        const { store, id } = await saved();
        at(2000);
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 30_000 });
        at(3000);

        const byOther = await releaseRefreshLease(store, { id, owner: 'run-2' });
        const held = await rowsOf(store);
        const byHolder = await releaseRefreshLease(store, { id, owner: 'run-1' });

        expect(byOther).toEqual({ ok: true, value: false });
        expect(held).toMatchObject([{ leaseOwner: 'run-1', leaseUntil: 32_000, updatedAt: 2000 }]);
        expect(byHolder).toEqual({ ok: true, value: true });
        expect(await rowsOf(store)).toMatchObject([
            { leaseOwner: null, leaseUntil: null, updatedAt: 3000 },
        ]);
        expect(
            await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-2', leaseMs: 1000 }),
        ).toEqual({ ok: true, value: true });
    });

    test('a credential that needs a new login, until the login saves it again', async () => {
        const { store, id } = await saved();
        at(2000);
        await takeRefreshLease(store, { id, seen: 'rt-1', owner: 'run-1', leaseMs: 30_000 });
        at(3000);

        const byOther = await markNeedsLogin(store, { id, owner: 'run-2' });
        const unmarked = await rowsOf(store);
        const byHolder = await markNeedsLogin(store, { id, owner: 'run-1' });
        const marked = await rowsOf(store);
        const retaken = await takeRefreshLease(store, {
            id,
            seen: 'rt-1',
            owner: 'run-2',
            leaseMs: 1000,
        });
        await saveCredential(store, credential());

        expect(byOther).toEqual({ ok: true, value: false });
        expect(unmarked).toMatchObject([{ needsLogin: false, leaseOwner: 'run-1' }]);
        expect(byHolder).toEqual({ ok: true, value: true });
        expect(marked).toMatchObject([
            { needsLogin: true, leaseOwner: null, leaseUntil: null, updatedAt: 3000 },
        ]);
        expect(retaken).toEqual({ ok: true, value: true });
        expect(await rowsOf(store)).toMatchObject([{ needsLogin: false, leaseOwner: null }]);
    });

    test('an owner holding two leases stores refreshed tokens for the one it names', async () => {
        const { store, id, other } = await twoLeased();
        const tokens = { access_token: 'at-2', refresh_token: 'rt-2' };

        const stored = await saveRefreshedTokens(store, {
            id,
            seen: 'rt-1',
            owner: 'run-1',
            tokens,
            expiresAt: 2,
        });

        expect(stored).toEqual({ ok: true, value: true });
        expect(await rowsOf(store)).toMatchObject([{ tokens, leaseOwner: null }]);
        expect(await rowsOf(store, other)).toMatchObject([{ tokens: TOKENS, leaseOwner: 'run-1' }]);
    });

    test('an owner holding two leases releases the one it names', async () => {
        const { store, id, other } = await twoLeased();

        const released = await releaseRefreshLease(store, { id, owner: 'run-1' });

        expect(released).toEqual({ ok: true, value: true });
        expect(await rowsOf(store)).toMatchObject([{ leaseOwner: null }]);
        expect(await rowsOf(store, other)).toMatchObject([{ leaseOwner: 'run-1' }]);
    });

    test('an owner holding two leases marks the one it names as needing a login', async () => {
        const { store, id, other } = await twoLeased();

        const marked = await markNeedsLogin(store, { id, owner: 'run-1' });

        expect(marked).toEqual({ ok: true, value: true });
        expect(await rowsOf(store)).toMatchObject([{ needsLogin: true, leaseOwner: null }]);
        expect(await rowsOf(store, other)).toMatchObject([
            { needsLogin: false, leaseOwner: 'run-1' },
        ]);
    });
});
