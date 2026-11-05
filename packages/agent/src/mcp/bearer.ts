// A server's saved login in a run (mcp-client): the access token every request carries, refreshed
// before the server's first request when it expires within 5 minutes, and once after a 401. The
// transport gets only the SDK's minimal AuthProvider, so that a run never registers a client,
// starts an authorization or refreshes through the SDK's own flow, which takes a transient refresh
// failure for a reason to authorize again (Brief R17.3) and can't hold the credential's lease,
// without which two runs spend a rotating refresh token twice and lose the grant (R17.2).
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import {
    type Credential,
    findCredentials,
    markNeedsLogin,
    releaseRefreshLease,
    saveRefreshedTokens,
    takeRefreshLease,
} from '@mecha-gremlin/store/credential';
import type { Store } from '@mecha-gremlin/store/store';
import {
    type AuthProvider,
    type OAuthTokens,
    refreshAuthorization,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import { expiresAtOf } from './oauth-provider.ts';

export type Bearer = {
    readonly provider: AuthProvider;
    /** Refreshes the token before the server's first request, when it expires within 5 minutes. */
    readonly prepare: () => Promise<Result<undefined, string>>;
    /** The login's tokens, all it has held, and its client secret: no text may show them. */
    readonly secrets: () => readonly string[];
};

/** Why a saved login can't serve, or how the store failed as it was read. */
export type LoginProblem = {
    readonly reason: string;
    /** The store failed, which no change to the server would mend. */
    readonly fromStore: boolean;
};

export type LoginOptions = {
    readonly store: Store;
    readonly name: string;
    /** The server's URL as its entry writes it. */
    readonly url: string;
    /** Who holds the lease while refreshing: the run. */
    readonly owner: string;
};

// What a run reads in the row the login saved. Every token field is kept, for the next save.
const Tokens = z.looseObject({ access_token: z.string(), refresh_token: z.string().optional() });

const Client = z.object({
    client_id: z.string(),
    client_secret: z.string().optional(),
    token_endpoint_auth_method: z.string().optional(),
});

const Discovery = z.object({
    authorizationServerUrl: z.string(),
    authorizationServerMetadata: z
        .object({
            issuer: z.string(),
            authorization_endpoint: z.string(),
            token_endpoint: z.string(),
            response_types_supported: z.array(z.string()),
            token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
        })
        .optional(),
    resourceMetadata: z.object({ resource: z.string() }).optional(),
});

type Tokens = Readonly<z.infer<typeof Tokens>>;

// The lease outlasts the refresh request, which is cancelled before it ends: a lease shorter than
// the request lets another run send the same refresh token (Brief R17.2).
const LEASE_MS = 30_000;

const REFRESH_TIMEOUT_MS = 25_000;

const POLL_MS = 250;

const WAIT_MS = 35_000;

const AHEAD_MS = 5 * 60_000;

const reasonOf = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

// An OAuthError's, such as invalid_grant.
const codeOf = (error: unknown): unknown => {
    return Object(error).code;
};

const pause = (ms: number): Promise<void> => {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

const newLogin = (name: string): string => {
    return `it needs a new login: bun run mcp login ${name}`;
};

// The bearer of a row that can be read, or undefined.
const bearerOf = (
    { store, name, url, owner }: LoginOptions,
    row: Credential,
): Bearer | undefined => {
    const saved = Tokens.safeParse(row.tokens);
    const read = Client.safeParse(row.client);
    const known = Discovery.safeParse(row.discovery);

    if (!saved.success || !read.success || !known.success) {
        return undefined;
    }

    const { id, issuer } = row;
    const client = read.data;
    const discovery = known.data;
    const held = [saved.data.access_token, saved.data.refresh_token, client.client_secret];
    let tokens: Tokens = saved.data;
    let refreshing: Promise<Result<undefined, string>> | undefined;

    const use = (fresh: Tokens): void => {
        tokens = fresh;
        held.push(fresh.access_token, fresh.refresh_token);
    };

    // Holding the lease, outside any transaction, so that no writer waits on the request.
    const refreshHeld = async (refreshToken: string): Promise<Result<undefined, string>> => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
            controller.abort();
        }, REFRESH_TIMEOUT_MS);
        let fresh: OAuthTokens;

        try {
            fresh = await refreshAuthorization(discovery.authorizationServerUrl, {
                metadata: discovery.authorizationServerMetadata,
                clientInformation: client,
                refreshToken,
                resource: discovery.resourceMetadata?.resource,
                fetchFn: (target, init) => fetch(target, { ...init, signal: controller.signal }),
            });
        } catch (error) {
            if (codeOf(error) === 'invalid_grant') {
                const marked = await markNeedsLogin(store, { id, owner });

                return marked.ok
                    ? err(`its login was refused when refreshed, so ${newLogin(name)}`)
                    : marked;
            }

            // The tokens stay: the failure may pass.
            await releaseRefreshLease(store, { id, owner });

            return err(
                controller.signal.aborted
                    ? `its login couldn't be refreshed: the authorization server didn't answer within ${REFRESH_TIMEOUT_MS / 1000} seconds`
                    : `its login couldn't be refreshed: ${reasonOf(error)}`,
            );
        } finally {
            clearTimeout(timer);
        }

        const stamped = { ...fresh, issuer };
        const until = expiresAtOf(fresh, Date.now());
        // Saving releases the lease. When a login has replaced the row meanwhile, nothing is
        // saved, and the tokens still serve this run.
        const written = await saveRefreshedTokens(store, {
            id,
            seen: refreshToken,
            owner,
            tokens: stamped,
            expiresAt: until,
        });

        if (!written.ok) {
            return written;
        }

        use(stamped);

        return ok(undefined);
    };

    // While another run holds the lease, the row is read until that run has saved its tokens,
    // which this run then uses, or until it gives the lease up or lets it lapse, and this run
    // takes it.
    const refreshUnderLease = async (refreshToken: string): Promise<Result<undefined, string>> => {
        const deadline = Date.now() + WAIT_MS;

        while (Date.now() < deadline) {
            const taken = await takeRefreshLease(store, {
                id,
                seen: refreshToken,
                owner,
                leaseMs: LEASE_MS,
            });

            if (!taken.ok) {
                return taken;
            }

            if (taken.value) {
                return refreshHeld(refreshToken);
            }

            const found = await findCredentials(store, { server: name, url });

            if (!found.ok) {
                return found;
            }

            const current = found.value.find((each) => each.id === id);
            const other = Tokens.safeParse(current?.tokens);

            if (current === undefined || current.needsLogin || !other.success) {
                return err(newLogin(name));
            }

            if (other.data.refresh_token !== refreshToken) {
                use(other.data);

                return ok(undefined);
            }

            await pause(POLL_MS);
        }

        return err(
            `its login couldn't be refreshed: another run held its refresh for over ${WAIT_MS / 1000} seconds`,
        );
    };

    // One refresh at a time in a run: requests that meet a 401 together share it.
    const refresh = (): Promise<Result<undefined, string>> => {
        const refreshToken = tokens.refresh_token;

        if (refreshToken === undefined) {
            return Promise.resolve(
                err(
                    `its login has no refresh token, so it can't be refreshed: log in again with bun run mcp login ${name}`,
                ),
            );
        }

        refreshing ??= refreshUnderLease(refreshToken).finally(() => {
            refreshing = undefined;
        });

        return refreshing;
    };

    return {
        provider: {
            token: async () => tokens.access_token,
            // The transport sends the request once more after this, and fails with what it throws.
            onUnauthorized: async () => {
                const refreshed = await refresh();

                if (!refreshed.ok) {
                    throw new Error(refreshed.error);
                }
            },
        },
        prepare: async () => {
            const { expiresAt } = row;

            return expiresAt === null ||
                expiresAt > Date.now() + AHEAD_MS ||
                tokens.refresh_token === undefined
                ? ok(undefined)
                : refresh();
        },
        secrets: () => held.filter((secret) => secret !== undefined),
    };
};

/**
 * The bearer of the server's most recently saved login for its name and its URL as written, an
 * issuer having a row each, if it has one; or why that login can't serve.
 */
export const findLogin = async (
    options: LoginOptions,
): Promise<Result<Bearer | undefined, LoginProblem>> => {
    const { store, name, url } = options;
    const found = await findCredentials(store, { server: name, url });

    if (!found.ok) {
        return err({ reason: found.error, fromStore: true });
    }

    const [row] = found.value;

    if (row === undefined) {
        return ok(undefined);
    }

    const bearer = row.needsLogin ? undefined : bearerOf(options, row);

    if (bearer === undefined) {
        const why = row.needsLogin
            ? 'Its login was refused when refreshed'
            : "Its saved login can't be read";

        return err({ reason: `${why}, so ${newLogin(name)}.`, fromStore: false });
    }

    return ok(bearer);
};
