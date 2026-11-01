// The login's OAuthClientProvider, over a server's credential rows. The SDK's auth() reads the
// discovery state through it, registers a client through it and builds the authorization URL; the
// login then exchanges the code and saves the tokens through it. Until then everything stays in
// memory: a code verifier and a state are for one login, and a client registered without tokens
// is of no use to a later one.
import { randomBytes } from 'node:crypto';
import { saveCredential } from '@mecha-gremlin/store/credential';
import type { Store } from '@mecha-gremlin/store/store';
import type {
    OAuthClientProvider,
    OAuthDiscoveryState,
    StoredOAuthClientInformation,
    StoredOAuthTokens,
} from '@modelcontextprotocol/client';

/** A client given or saved, stamped with its issuer, kept whole to round-trip the stamp. */
export type LoginClient = {
    readonly client_id: string;
    readonly client_secret?: string | undefined;
    /** The redirect URIs it registered, or for a client given with --client-id, the one used. */
    readonly redirect_uris?: readonly string[];
    readonly issuer?: string;
};

export type LoginProviderOptions = {
    readonly store: Store;
    /** The server's name and its URL as its entry writes it, which key the row with the issuer. */
    readonly server: string;
    readonly url: string;
    readonly issuer: string;
    readonly redirectUrl: string;
    /** What the login discovered, which auth() reads rather than discovering again. */
    readonly discovery: OAuthDiscoveryState;
    /** Without one, auth() registers one. */
    readonly client: LoginClient | undefined;
    /** Shows the authorization URL to whoever is logging in. */
    readonly redirect: (url: URL) => void;
};

export type LoginProvider = OAuthClientProvider & {
    /** The state the authorization URL carries, which the redirect must bring back. */
    readonly sentState: string;
    /** The resource indicator auth() sent, which the code exchange sends again. */
    readonly resource: () => string | undefined;
    /** The values gathered so far that no output may show. */
    readonly secrets: () => string[];
};

/** When tokens that last `expires_in` seconds from `now` expire, in epoch milliseconds. */
export const expiresAtOf = (
    tokens: { readonly expires_in?: number },
    now: number,
): number | null => {
    return tokens.expires_in === undefined ? null : now + tokens.expires_in * 1000;
};

export const createLoginProvider = ({
    store,
    server,
    url,
    issuer,
    redirectUrl,
    discovery,
    client,
    redirect,
}: LoginProviderOptions): LoginProvider => {
    const state = randomBytes(32).toString('base64url');
    let registered: StoredOAuthClientInformation | undefined = client;
    let tokens: StoredOAuthTokens | undefined;
    let verifier: string | undefined;
    let resource: string | undefined;

    return {
        redirectUrl,
        // The registration the design asks for (D31): a native app, a public client, and the
        // grant types that let the authorization server issue a refresh token.
        clientMetadata: {
            client_name: 'mecha-gremlin',
            application_type: 'native',
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code', 'refresh_token'],
            redirect_uris: [redirectUrl],
        },
        state: () => state,
        sentState: state,
        clientInformation: () => registered,
        saveClientInformation: (information) => {
            registered = information;
        },
        // None: given saved ones, auth() would refresh them instead of asking the user, even
        // while they're valid (Brief R17.3).
        tokens: () => undefined,
        saveTokens: async (stamped) => {
            tokens = stamped;
            const written = await saveCredential(store, {
                server,
                url,
                issuer,
                client: registered ?? {},
                tokens: stamped,
                discovery,
                expiresAt: expiresAtOf(stamped, Date.now()),
            });

            // The SDK learns of a failure only from a throw.
            if (!written.ok) {
                throw new Error(written.error);
            }
        },
        redirectToAuthorization: (authorizationUrl) => {
            redirect(authorizationUrl);
        },
        saveCodeVerifier: (codeVerifier) => {
            verifier = codeVerifier;
        },
        // Read only after auth() has saved one.
        codeVerifier: () => String(verifier),
        discoveryState: () => discovery,
        saveResourceUrl: (resourceUrl) => {
            resource = resourceUrl;
        },
        resource: () => resource,
        secrets: () => {
            return [
                registered?.client_secret,
                verifier,
                tokens?.access_token,
                tokens?.refresh_token,
                tokens?.id_token,
            ].filter((secret) => secret !== undefined);
        },
    };
};
