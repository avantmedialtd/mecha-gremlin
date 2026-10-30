import type { Result } from '@mecha-gremlin/core/result';
import { EntitySchema } from 'typeorm';
import { type Store, withDataSource } from './connection.ts';

export type Credential = {
    readonly id: number;
    readonly server: string;
    readonly url: string;
    readonly issuer: string;
    readonly client: object;
    readonly tokens: object;
    readonly discovery: object | null;
    readonly expiresAt: number | null;
    readonly needsLogin: boolean;
    readonly leaseOwner: string | null;
    readonly leaseUntil: number | null;
    readonly createdAt: number;
    readonly updatedAt: number;
};

// The SDK's values are kept verbatim, since its issuer stamps must round-trip (Brief R17.3):
// `simple-json` is plain text, where TypeORM's `json` declares NUMERIC affinity. Times are epoch
// milliseconds, since SQLite has no date type and text in mixed formats compares wrongly (R17.2).
export const credentialSchema = new EntitySchema<Credential>({
    name: 'credential',
    columns: {
        id: { type: 'integer', primary: true, generated: 'increment' },
        server: { type: 'text' },
        url: { type: 'text' },
        issuer: { type: 'text' },
        client: { type: 'simple-json' },
        tokens: { type: 'simple-json' },
        discovery: { type: 'simple-json', nullable: true },
        expiresAt: { name: 'expires_at', type: 'integer', nullable: true },
        needsLogin: { name: 'needs_login', type: 'boolean' },
        leaseOwner: { name: 'lease_owner', type: 'text', nullable: true },
        leaseUntil: { name: 'lease_until', type: 'integer', nullable: true },
        createdAt: { name: 'created_at', type: 'integer' },
        updatedAt: { name: 'updated_at', type: 'integer' },
    },
    uniques: [{ columns: ['server', 'url', 'issuer'] }],
});

/** A configured server's name and URL: one row for each issuer it has signed in with. */
export type Server = Pick<Credential, 'server' | 'url'>;

/** What a login saves. The client information, tokens and discovery state are the SDK's own. */
export type NewCredential = Pick<
    Credential,
    'server' | 'url' | 'issuer' | 'client' | 'tokens' | 'discovery' | 'expiresAt'
>;

/** `seen` is the refresh token the caller read in the row, or null when it held none. */
export type LeaseRequest = {
    readonly id: number;
    readonly seen: string | null;
    readonly owner: string;
    readonly leaseMs: number;
};

export type RefreshedTokens = {
    readonly id: number;
    readonly seen: string | null;
    readonly owner: string;
    readonly tokens: object;
    readonly expiresAt: number | null;
};

export type LeaseHolder = { readonly id: number; readonly owner: string };

// `IS` compares a missing refresh token as NULL, where `=` would never match.
const SEEN = "json_extract(tokens, '$.refresh_token') IS :seen";

const HELD = 'lease_owner = :owner';

export const findCredentials = (
    store: Store,
    { server, url }: Server,
): Promise<Result<Credential[], string>> => {
    return withDataSource(store, 'find the credentials', (dataSource) => {
        return dataSource.getRepository(credentialSchema).find({
            where: { server, url },
            order: { updatedAt: 'DESC', id: 'DESC' },
        });
    });
};

// A login replaces the row it signed in again for, and a refresh in progress then can't save
// over it: the replacement clears the lease.
export const saveCredential = (
    store: Store,
    credential: NewCredential,
): Promise<Result<undefined, string>> => {
    return withDataSource(store, 'save the credential', async (dataSource) => {
        const now = Date.now();

        await dataSource
            .createQueryBuilder()
            .insert()
            .into(credentialSchema)
            .values({
                server: credential.server,
                url: credential.url,
                issuer: credential.issuer,
                client: credential.client,
                tokens: credential.tokens,
                discovery: credential.discovery,
                expiresAt: credential.expiresAt,
                needsLogin: false,
                leaseOwner: null,
                leaseUntil: null,
                createdAt: now,
                updatedAt: now,
            })
            .orUpdate(
                [
                    'client',
                    'tokens',
                    'discovery',
                    'expires_at',
                    'needs_login',
                    'lease_owner',
                    'lease_until',
                    'updated_at',
                ],
                ['server', 'url', 'issuer'],
            )
            .execute();

        return undefined;
    });
};

export const deleteCredentials = (
    store: Store,
    { server, url }: Server,
): Promise<Result<number, string>> => {
    return withDataSource(store, 'delete the credentials', async (dataSource) => {
        const deleted = await dataSource
            .createQueryBuilder()
            .delete()
            .from(credentialSchema)
            .where('server = :server AND url = :url', { server, url })
            .execute();

        return deleted.affected ?? 0;
    });
};

// The lease lets one caller refresh at a time: the refresh happens over HTTP between taking and
// saving, outside any transaction, so that no writer waits on it (Brief R17.2). Each update says
// whether it changed the row from UpdateResult.affected, which better-sqlite3 reports correctly;
// a raw query would give the last insert rowid instead (Brief R17.1).
export const takeRefreshLease = (
    store: Store,
    { id, seen, owner, leaseMs }: LeaseRequest,
): Promise<Result<boolean, string>> => {
    return withDataSource(store, 'take the refresh lease', async (dataSource) => {
        const now = Date.now();
        const updated = await dataSource
            .createQueryBuilder()
            .update(credentialSchema)
            .set({ leaseOwner: owner, leaseUntil: now + leaseMs, updatedAt: now })
            .where('id = :id', { id })
            .andWhere(SEEN, { seen })
            .andWhere('(lease_until IS NULL OR lease_until < :now)', { now })
            .execute();

        return updated.affected === 1;
    });
};

export const saveRefreshedTokens = (
    store: Store,
    { id, seen, owner, tokens, expiresAt }: RefreshedTokens,
): Promise<Result<boolean, string>> => {
    return withDataSource(store, 'save the refreshed tokens', async (dataSource) => {
        const updated = await dataSource
            .createQueryBuilder()
            .update(credentialSchema)
            .set({ tokens, expiresAt, leaseOwner: null, leaseUntil: null, updatedAt: Date.now() })
            .where('id = :id', { id })
            .andWhere(HELD, { owner })
            .andWhere(SEEN, { seen })
            .execute();

        return updated.affected === 1;
    });
};

export const releaseRefreshLease = (
    store: Store,
    { id, owner }: LeaseHolder,
): Promise<Result<boolean, string>> => {
    return withDataSource(store, 'release the refresh lease', async (dataSource) => {
        const updated = await dataSource
            .createQueryBuilder()
            .update(credentialSchema)
            .set({ leaseOwner: null, leaseUntil: null, updatedAt: Date.now() })
            .where('id = :id', { id })
            .andWhere(HELD, { owner })
            .execute();

        return updated.affected === 1;
    });
};

export const markNeedsLogin = (
    store: Store,
    { id, owner }: LeaseHolder,
): Promise<Result<boolean, string>> => {
    return withDataSource(store, 'mark the credential as needing a login', async (dataSource) => {
        const updated = await dataSource
            .createQueryBuilder()
            .update(credentialSchema)
            .set({ needsLogin: true, leaseOwner: null, leaseUntil: null, updatedAt: Date.now() })
            .where('id = :id', { id })
            .andWhere(HELD, { owner })
            .execute();

        return updated.affected === 1;
    });
};
