// `bun run mcp login <name>`: OAuth's authorization code flow with PKCE, against a Streamable HTTP
// server's authorization server (C17). An initialize without a token comes first: a 401's
// WWW-Authenticate names where the server's protected-resource metadata is, which the well-known
// URLs aren't on many servers (Brief R17.4). The SDK's auth() takes the client, registers one if
// it must, and builds the authorization URL. The login takes the redirect, checks its state, which
// the SDK doesn't, and has the SDK exchange the code, which checks iss (Brief R17.3). It exchanges
// it through fetchToken() rather than auth(), which would warn on the console and send the code
// again when the authorization server refuses it. No code, token, code verifier or client secret
// reaches its output.
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { findCredentials } from '@mecha-gremlin/store/credential';
import type { Store } from '@mecha-gremlin/store/store';
import {
    LATEST_PROTOCOL_VERSION,
    type OAuthServerInfo,
    type OAuthTokens,
    type ServerCapabilities,
    StreamableHTTPClientTransport,
    auth,
    discoverOAuthServerInfo,
    extractWWWAuthenticateParams,
    fetchToken,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createLoginProvider } from './oauth-provider.ts';
import { type Redact, redactor } from './redact.ts';
import { type Redirect, listenForRedirect } from './redirect.ts';
import type { HttpConnection, ServerConfig } from './resolve.ts';
import { CLIENT, createClient } from './servers.ts';
import { listTools } from './tools.ts';

export type LoginRequest = {
    readonly store: Store;
    /** The server, its references resolved as a run resolves them. */
    readonly server: ServerConfig;
    /** Its connection, a Streamable HTTP one. */
    readonly connection: HttpConnection;
    readonly clientId: string | undefined;
    /** `--client-secret`'s value, its reference resolved. */
    readonly clientSecret: string | undefined;
    readonly redirectUri: URL | undefined;
    readonly scope: string | undefined;
    /** Where a pasted address comes from: stdin. */
    readonly input: Readonly<NodeJS.ReadableStream>;
    /** Shows the authorization URL, with what to do with it. */
    readonly show: (url: string) => void;
    /** Shows a warning, such as one about a line that was pasted. */
    readonly warn: (text: string) => void;
};

// A client an earlier login saved, as the SDK gave it: every field is kept, so that its issuer
// stamp round-trips (Brief R17.3).
const SavedClient = z
    .looseObject({
        client_id: z.string(),
        client_secret: z.string().optional(),
        client_id_issued_at: z.number().optional(),
        client_secret_expires_at: z.number().optional(),
        redirect_uris: z.array(z.string()).readonly().optional(),
        issuer: z.string().optional(),
    })
    .readonly();

/** What a 401 to the first request said: where the metadata is, and the scope to ask for. */
type Challenge = ReturnType<typeof extractWWWAuthenticateParams>;

type Flow = LoginRequest & {
    readonly info: OAuthServerInfo;
    /** The challenge's resource_metadata, as text. */
    readonly resourceMetadataUrl: string | undefined;
    /** The challenge's scope. */
    readonly challengeScope: string | undefined;
    readonly issuer: string;
    readonly saved: z.infer<typeof SavedClient> | undefined;
    /** Whether the authorization server can register a client. */
    readonly registers: boolean;
    readonly redirect: Redirect;
};

// RFC 6749's characters for an error code, and for an error description, neither of which may be
// empty, so that the terminal shows no control sequence.
const ERROR_CODE = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/;

const reasonOf = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

const refusal = (error: string, description: string): string => {
    const code = ERROR_CODE.test(error)
        ? error
        : 'an error code in characters that OAuth allows in none';

    return ERROR_CODE.test(description) ? `${code} (${description})` : code;
};

// The initialize a run sends first, with the entry's headers and no token, to the server's own URL
// alone: a redirect isn't followed, so the headers reach no other. Only the answer's status and
// headers count, and its body, which may be a stream that never ends, is let go.
const probe = async ({ server, connection }: LoginRequest): Promise<Result<Challenge, string>> => {
    let response: Response;

    try {
        response = await fetch(connection.url, {
            method: 'POST',
            headers: {
                ...connection.headers,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
                method: 'initialize',
                params: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: {},
                    clientInfo: CLIENT,
                },
                jsonrpc: '2.0',
                id: 0,
            }),
            redirect: 'manual',
            signal: AbortSignal.timeout(server.startupTimeoutMs),
        });
        await response.body?.cancel();
    } catch (error) {
        return err(reasonOf(error));
    }

    if (response.status === 401) {
        return ok(extractWWWAuthenticateParams(response));
    }

    return response.ok
        ? ok({})
        : err(`its answer to an initialize without a token is HTTP ${response.status}`);
};

// The tools a later run offers, through a connection of its own with the new token.
const countTools = async (
    { server, connection }: Flow,
    tokens: Readonly<OAuthTokens>,
    redact: Redact,
): Promise<Result<number, string>> => {
    const deadline = Date.now() + server.startupTimeoutMs;
    const remaining = (): number => deadline - Date.now();
    const client = createClient();
    const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
        requestInit: { headers: { ...connection.headers } },
        authProvider: { token: async () => tokens.access_token },
    });

    try {
        await client.connect(transport, { timeout: remaining() });
        const capabilities: ServerCapabilities = client.getServerCapabilities() ?? {};

        // tools/list goes only to a server that announces tools.
        if (capabilities.tools === undefined) {
            return ok(0);
        }

        const listing = await listTools(client, {
            includeTools: server.includeTools,
            excludeTools: server.excludeTools,
            remaining,
            signal: new AbortController().signal,
            redact,
        });

        return listing.ok ? ok(listing.value.tools.length) : err(redact(listing.error));
    } catch (error) {
        return err(redact(reasonOf(error)));
    } finally {
        await client.close().catch(() => undefined);
    }
};

const authorize = async (flow: Flow): Promise<Result<number, string>> => {
    const { store, server, connection, clientId, clientSecret, scope, show } = flow;
    const { info, resourceMetadataUrl, challengeScope, issuer, saved, registers, redirect } = flow;
    const { name, secrets } = server;
    const metadata = info.authorizationServerMetadata;
    // A saved client lists the redirect URIs it registered, through the login or ahead of time,
    // and is of no use with another. One given with --client-id that was saved before such
    // clients kept theirs lists none.
    const reusable =
        saved?.redirect_uris === undefined || saved.redirect_uris.includes(redirect.uri)
            ? saved
            : undefined;
    // The SDK holds redirect URIs only for a client it registers, so this one is given the one
    // it's used with, for a later login to listen on its port.
    const client =
        clientId === undefined
            ? reusable
            : {
                  client_id: clientId,
                  client_secret: clientSecret,
                  issuer,
                  redirect_uris: [redirect.uri],
              };

    if (client === undefined && !registers) {
        return err(
            `The authorization server of ${name}, ${issuer}, can't register a client. Register one with it whose redirect URI is http://127.0.0.1:<port>/callback, on a free port of your choosing, and log in with it: bun run mcp login ${name} --client-id <id> --redirect-uri http://127.0.0.1:<port>/callback, adding --client-secret '\${NAME}' if it has a secret.`,
        );
    }

    const provider = createLoginProvider({
        store,
        server: name,
        url: connection.writtenUrl,
        issuer,
        redirectUrl: redirect.uri,
        discovery: { ...info, resourceMetadataUrl },
        client,
        redirect: (url) => {
            show(url.href);
        },
    });
    const failed = (error: unknown, redact: Redact): Result<never, string> => {
        return err(`Can't log in to ${name}: ${redact(reasonOf(error))}`);
    };

    try {
        // The challenge's scope, unless one is given, as the specification has clients do.
        await auth(provider, { serverUrl: connection.url, scope: scope ?? challengeScope });
    } catch (error) {
        return failed(error, (text) => redactor([...secrets, ...provider.secrets()])(text));
    }

    const answered = await redirect.wait();

    if (!answered.ok) {
        return answered;
    }

    const parameters = answered.value;
    const code = parameters.get('code');
    const error = parameters.get('error');
    const redact: Redact = (text) => {
        return redactor([...secrets, ...provider.secrets(), ...parameters.getAll('code')])(text);
    };

    // Fail closed: a redirect that isn't this login's may carry someone else's code.
    if (parameters.get('state') !== provider.sentState) {
        return err(
            "The redirect's state doesn't match the one the login sent, so it may not be this login's: the login stopped.",
        );
    }

    if (error !== null) {
        const reason = refusal(error, parameters.get('error_description') ?? '');

        return err(`The authorization server refused the login to ${name}: ${reason}.`);
    }

    if (code === null) {
        return err('The redirect holds no code, so the login has nothing to exchange.');
    }

    let tokens: OAuthTokens;

    try {
        tokens = await fetchToken(provider, info.authorizationServerUrl, {
            metadata,
            resource: provider.resource(),
            authorizationCode: code,
            iss: parameters.get('iss') ?? undefined,
        });
        await provider.saveTokens({ ...tokens, issuer });
    } catch (thrown) {
        return failed(thrown, redact);
    }

    const counted = await countTools(flow, tokens, redact);

    return counted.ok
        ? counted
        : err(`The login to ${name} is saved, but connecting with it failed: ${counted.error}.`);
};

/**
 * Logs in to the server, saves the login in its credential row, and lists the server's tools
 * with the new token: their number, or every problem, as a whole message.
 */
export const logIn = async (request: LoginRequest): Promise<Result<number, string>> => {
    const { store, server, connection, clientId, redirectUri, input, warn } = request;
    const { name, secrets } = server;
    const undiscovered = (reason: string): Result<never, string> => {
        return err(`Can't find out how to log in to ${name}: ${redactor(secrets)(reason)}`);
    };
    const probed = await probe(request);

    if (!probed.ok) {
        return undiscovered(probed.error);
    }

    const challenge = probed.value;
    let info: OAuthServerInfo;

    try {
        info = await discoverOAuthServerInfo(connection.url, {
            resourceMetadataUrl: challenge.resourceMetadataUrl,
        });
    } catch (error) {
        return undiscovered(reasonOf(error));
    }

    if (info.resourceMetadata === undefined && info.authorizationServerMetadata === undefined) {
        return err(`The MCP server ${name} offers no OAuth login: it publishes no OAuth metadata.`);
    }

    const metadata = info.authorizationServerMetadata;
    const issuer = metadata?.issuer ?? info.authorizationServerUrl;
    // Without metadata, the SDK registers a client at /register.
    const registers = metadata === undefined || metadata.registration_endpoint !== undefined;
    const found = await findCredentials(store, { server: name, url: connection.writtenUrl });

    if (!found.ok) {
        return found;
    }

    const parsed = SavedClient.safeParse(found.value.find((row) => row.issuer === issuer)?.client);
    const saved = parsed.success ? parsed.data : undefined;
    const listened = await listenForRedirect({
        given: redirectUri,
        // A client given with --client-id comes with the redirect URI it registered, if any,
        // unless it's the saved one.
        registered:
            clientId === undefined || clientId === saved?.client_id
                ? saved?.redirect_uris?.[0]
                : undefined,
        // No client could be registered for another port.
        keepRegistered: !registers,
        input,
        warn,
    });

    if (!listened.ok) {
        return listened;
    }

    try {
        return await authorize({
            ...request,
            info,
            resourceMetadataUrl: challenge.resourceMetadataUrl?.href,
            challengeScope: challenge.scope,
            issuer,
            saved,
            registers,
            redirect: listened.value,
        });
    } finally {
        await listened.value.close();
    }
};
