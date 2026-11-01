// An in-process OAuth authorization server, on 127.0.0.1, for the tests of the login and of runs
// that use one: its metadata, dynamic client registration, an authorization endpoint that a test
// follows as the browser would, and a token endpoint that rotates refresh tokens and revokes the
// grant when a rotated-out one comes back (RFC 9700 §4.14.2). It also guards MCP servers: it
// answers their protected-resource metadata, and 401 to a request without an access token it
// issued and still honours.
import { createHash, randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RecordedHttp } from './http-server.ts';

/** How the token endpoint answers: as it should, with invalid_grant, with a 500, or never. */
export type TokenAnswer = 'issue' | 'refuse' | 'fail' | 'hang';

export type AuthOptions = {
    /** Whether it offers dynamic client registration. */
    readonly registration?: boolean;
    /** Whether it publishes its own metadata; without it, a client uses its default paths. */
    readonly metadata?: boolean;
    /** The tokens' lifetime in seconds, or null for none. */
    readonly expiresIn?: number | null;
    /** The scopes its metadata lists. */
    readonly scopes?: readonly string[];
    /** Whether it says that a redirect carries iss, as RFC 9207 has it. */
    readonly issParameter?: boolean;
    /** Clients registered beforehand, by ID, with their secrets. */
    readonly clients?: Readonly<Record<string, string>>;
    /**
     * The redirect URIs that clients registered beforehand are held to, by ID, matched exactly,
     * port included, as some authorization servers match them.
     */
    readonly redirectUris?: Readonly<Record<string, readonly string[]>>;
    /** Whether a guarded server's metadata names it with a trailing /, which its issuer lacks. */
    readonly trailingSlash?: boolean;
    /** Where its token endpoint is: only its metadata says so when it isn't /token. */
    readonly tokenPath?: string;
    /**
     * Where a guarded server's protected-resource metadata is: at the well-known URLs, which its
     * 401 names; only at a URL its 401 names, the well-known ones answering 404; or at the
     * well-known URLs, its 401 naming none.
     */
    readonly metadataAt?: 'well-known' | 'challenge' | 'unnamed';
    /** The scope a guarded server's 401 asks for. */
    readonly challengeScope?: string;
    /** Whether a guarded server lets in a request that carries no token. */
    readonly anonymous?: boolean;
};

/** What the browser does at the authorization endpoint. */
export type Choice = {
    readonly deny?: boolean;
};

export type Grant = {
    readonly clientId: string;
    readonly accessToken: string;
    readonly refreshToken: string | undefined;
};

export type FakeAuth = {
    /** Its issuer: http://127.0.0.1:<port>. */
    readonly issuer: string;
    readonly requests: readonly RecordedHttp[];
    /** The bodies of the registrations it took. */
    readonly registrations: readonly Readonly<Record<string, unknown>>[];
    /** The token requests' parameters, with the Authorization header as `authorization`. */
    readonly tokenRequests: readonly Readonly<Record<string, string>>[];
    /** Changes how the token endpoint answers, from the next request on. */
    readonly answerTokens: (answer: TokenAnswer, delayMs?: number) => void;
    /** Follows an authorization URL as the browser would, and gives the address it ends on. */
    readonly authorize: (url: string, choice?: Choice) => Promise<string>;
    /** A grant of its own, as if a login had made it, for a row a test writes. */
    readonly grant: (grant: Grant) => void;
    /** Stops honouring an access token, as when it expires. */
    readonly expire: (accessToken: string) => void;
    /** Whether it honours the access token. */
    readonly honours: (accessToken: string) => boolean;
    /** Whether the grant that this refresh token belongs to has been revoked. */
    readonly revoked: (refreshToken: string) => boolean;
    /** Guards the MCP server at `resource`: an answer for the request, or undefined to let it in. */
    readonly guard: (request: RecordedHttp, resource: string) => Response | undefined;
    readonly close: () => Promise<void>;
};

type Client = {
    readonly secret: string | undefined;
    /**
     * Undefined for a client registered beforehand and held to no redirect URIs, which may use any
     * loopback redirect.
     */
    readonly redirectUris: readonly string[] | undefined;
};

type GrantState = {
    readonly clientId: string;
    readonly accessTokens: Set<string>;
    /** Every refresh token the grant has had, the one it honours last. */
    readonly refreshTokens: (string | undefined)[];
    revoked: boolean;
};

type Code = {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly challenge: string;
    used: boolean;
};

const json = (body: unknown, status = 200): Response => {
    return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
};

const oauthError = (error: string, status = 400): Response => {
    return json({ error, error_description: `The fake refused it: ${error}.` }, status);
};

const fresh = (prefix: string): string => {
    return `${prefix}-${randomBytes(9).toString('base64url')}`;
};

// Reading a request consumes it, so it can't be taken as readonly.
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
const recordOf = async (request: IncomingMessage): Promise<RecordedHttp> => {
    let body = '';
    request.setEncoding('utf8');

    for await (const chunk of request) {
        body += String(chunk);
    }

    return {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
        ),
        body,
    };
};

const verifies = (verifier: string, challenge: string): boolean => {
    return createHash('sha256').update(verifier).digest('base64url') === challenge;
};

export const startAuthServer = async ({
    registration = true,
    metadata = true,
    expiresIn = 3600,
    scopes,
    issParameter = false,
    clients: given = {},
    redirectUris = {},
    trailingSlash = false,
    tokenPath = '/token',
    metadataAt = 'well-known',
    challengeScope,
    anonymous = false,
}: AuthOptions = {}): Promise<FakeAuth> => {
    const requests: RecordedHttp[] = [];
    const registrations: Record<string, unknown>[] = [];
    const tokenRequests: Record<string, string>[] = [];
    const clients = new Map<string, Client>(
        Object.entries(given).map(([id, secret]) => [
            id,
            { secret, redirectUris: redirectUris[id] },
        ]),
    );
    const codes = new Map<string, Code>();
    const grants: GrantState[] = [];
    const hanging: (() => void)[] = [];
    let tokenAnswer: TokenAnswer = 'issue';
    let tokenDelayMs = 0;
    let issuer = '';

    // Issuing tokens changes the grant, so it can't be taken as readonly.
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types
    const issue = (grant: GrantState): Response => {
        const accessToken = fresh('at');
        const refreshToken = fresh('rt');
        grant.accessTokens.clear();
        grant.accessTokens.add(accessToken);
        grant.refreshTokens.push(refreshToken);

        return json({
            access_token: accessToken,
            token_type: 'Bearer',
            refresh_token: refreshToken,
            ...(expiresIn === null ? {} : { expires_in: expiresIn }),
        });
    };

    // The client authenticates as its registration says: a secret in Basic or in the body, or
    // none for a public one.
    const authenticated = (form: URLSearchParams, authorization: string | undefined) => {
        const basic = /^Basic (.+)$/.exec(authorization ?? '')?.[1];
        const [id, secret] =
            basic === undefined
                ? [form.get('client_id') ?? '', form.get('client_secret') ?? undefined]
                : Buffer.from(basic, 'base64').toString().split(':');
        const client = clients.get(id);

        return client !== undefined && client.secret === secret ? id : undefined;
    };

    const token = (request: RecordedHttp): Response => {
        const form = new URLSearchParams(request.body);
        const clientId = authenticated(form, request.headers.authorization);

        if (clientId === undefined) {
            return oauthError('invalid_client', 401);
        }

        if (form.get('grant_type') === 'authorization_code') {
            const code = codes.get(form.get('code') ?? '');

            if (
                code === undefined ||
                code.used ||
                code.clientId !== clientId ||
                code.redirectUri !== form.get('redirect_uri') ||
                !verifies(form.get('code_verifier') ?? '', code.challenge)
            ) {
                return oauthError('invalid_grant');
            }

            code.used = true;
            const grant: GrantState = {
                clientId,
                accessTokens: new Set(),
                refreshTokens: [],
                revoked: false,
            };
            grants.push(grant);

            return issue(grant);
        }

        const presented = form.get('refresh_token') ?? '';
        const grant = grants.find((each) => each.refreshTokens.includes(presented));

        if (grant === undefined || grant.revoked || grant.clientId !== clientId) {
            return oauthError('invalid_grant');
        }

        // A rotated-out refresh token came back: whoever holds the grant can't be told apart
        // from a thief, so all of it goes.
        if (grant.refreshTokens.at(-1) !== presented) {
            grant.revoked = true;
            grant.accessTokens.clear();

            return oauthError('invalid_grant');
        }

        return issue(grant);
    };

    const register = (request: RecordedHttp): Response => {
        const body = JSON.parse(request.body) as Record<string, unknown>;
        registrations.push(body);
        const id = fresh('client');
        clients.set(id, {
            secret: undefined,
            redirectUris: (body.redirect_uris as string[] | undefined) ?? [],
        });

        return json({ ...body, client_id: id, client_id_issued_at: 1_793_404_800 }, 201);
    };

    const answer = async (request: RecordedHttp): Promise<Response> => {
        const url = new URL(request.url, issuer);

        if (url.pathname === '/.well-known/oauth-authorization-server' && metadata) {
            return json({
                issuer,
                authorization_endpoint: `${issuer}/authorize`,
                token_endpoint: `${issuer}${tokenPath}`,
                ...(registration ? { registration_endpoint: `${issuer}/register` } : {}),
                response_types_supported: ['code'],
                grant_types_supported: ['authorization_code', 'refresh_token'],
                code_challenge_methods_supported: ['S256'],
                token_endpoint_auth_methods_supported: [
                    'none',
                    'client_secret_basic',
                    'client_secret_post',
                ],
                ...(scopes === undefined ? {} : { scopes_supported: scopes }),
                ...(issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
            });
        }

        if (url.pathname === '/register' && registration && request.method === 'POST') {
            return register(request);
        }

        if (url.pathname === tokenPath && request.method === 'POST') {
            tokenRequests.push({
                ...Object.fromEntries(new URLSearchParams(request.body)),
                ...(request.headers.authorization === undefined
                    ? {}
                    : { authorization: request.headers.authorization }),
            });

            if (tokenDelayMs > 0) {
                await new Promise((resolve) => {
                    setTimeout(resolve, tokenDelayMs);
                });
            }

            if (tokenAnswer === 'hang') {
                await new Promise<void>((resolve) => {
                    hanging.push(resolve);
                });
            }

            // Each answer quotes what it was sent, as a careless server might.
            const sent = ['code', 'code_verifier', 'refresh_token']
                .map((name) => new URLSearchParams(request.body).get(name))
                .filter((value) => value !== null)
                .join(', ');

            if (tokenAnswer === 'fail') {
                return new Response(`The fake failed on purpose, given ${sent}.`, {
                    status: 500,
                });
            }

            if (tokenAnswer === 'refuse') {
                return json(
                    { error: 'invalid_grant', error_description: `The fake refused ${sent}.` },
                    400,
                );
            }

            return token(request);
        }

        return new Response('Not found.', { status: 404 });
    };

    const server: Server = createServer((incoming, outgoing) => {
        void (async () => {
            const recorded = await recordOf(incoming);
            requests.push(recorded);
            const response = await answer(recorded);
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
        })();
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let closing: Promise<void> | undefined;

    const honours = (accessToken: string): boolean => {
        return grants.some((grant) => !grant.revoked && grant.accessTokens.has(accessToken));
    };

    return {
        issuer,
        requests,
        registrations,
        tokenRequests,
        answerTokens: (kind, delayMs = 0) => {
            tokenAnswer = kind;
            tokenDelayMs = delayMs;
        },
        authorize: async (address, { deny = false } = {}) => {
            const url = new URL(address);
            const parameters = url.searchParams;
            const clientId = parameters.get('client_id') ?? '';
            const redirectUri = parameters.get('redirect_uri') ?? '';
            const client = clients.get(clientId);

            if (
                url.origin !== issuer ||
                url.pathname !== '/authorize' ||
                client === undefined ||
                !(client.redirectUris ?? [redirectUri]).includes(redirectUri) ||
                parameters.get('code_challenge_method') !== 'S256'
            ) {
                throw new Error(`The fake refused the authorization request ${address}`);
            }

            const target = new URL(redirectUri);
            const state = parameters.get('state');

            if (deny) {
                target.searchParams.set('error', 'access_denied');
            } else {
                const code = fresh('code');
                codes.set(code, {
                    clientId,
                    redirectUri,
                    challenge: parameters.get('code_challenge') ?? '',
                    used: false,
                });
                target.searchParams.set('code', code);
            }

            if (state !== null) {
                target.searchParams.set('state', state);
            }

            if (issParameter) {
                target.searchParams.set('iss', issuer);
            }

            return target.href;
        },
        grant: ({ clientId, accessToken, refreshToken }) => {
            clients.set(clientId, clients.get(clientId) ?? { secret: undefined, redirectUris: [] });
            grants.push({
                clientId,
                accessTokens: new Set([accessToken]),
                refreshTokens: [refreshToken],
                revoked: false,
            });
        },
        expire: (accessToken) => {
            for (const grant of grants) {
                grant.accessTokens.delete(accessToken);
            }
        },
        honours,
        revoked: (refreshToken) => {
            return grants.some(
                (grant) => grant.revoked && grant.refreshTokens.includes(refreshToken),
            );
        },
        guard: (request, resource) => {
            const url = new URL(request.url, resource);
            const named =
                metadataAt === 'challenge'
                    ? '/oauth/resource'
                    : '/.well-known/oauth-protected-resource/mcp';
            const atWellKnown = url.pathname.startsWith('/.well-known/oauth-protected-resource');

            if (atWellKnown && metadataAt === 'challenge') {
                return new Response('Not found.', { status: 404 });
            }

            if (atWellKnown || url.pathname === named) {
                return json({
                    resource,
                    authorization_servers: [trailingSlash ? `${issuer}/` : issuer],
                    ...(scopes === undefined ? {} : { scopes_supported: scopes }),
                });
            }

            const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
            const challenge = [
                ...(metadataAt === 'unnamed'
                    ? ['realm="mcp"']
                    : [`resource_metadata="${new URL(named, resource).href}"`]),
                ...(challengeScope === undefined ? [] : [`scope="${challengeScope}"`]),
            ];

            if (bearer === undefined && anonymous) {
                return undefined;
            }

            return bearer !== undefined && honours(bearer)
                ? undefined
                : new Response('Who are you?', {
                      status: 401,
                      headers: { 'www-authenticate': `Bearer ${challenge.join(', ')}` },
                  });
        },
        close: () => {
            closing ??= (async () => {
                for (const release of hanging.splice(0)) {
                    release();
                }

                server.closeAllConnections();
                await new Promise((resolve) => {
                    server.close(resolve);
                });
            })();

            return closing;
        },
    };
};
