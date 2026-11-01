import { mkdtemp, rm } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { withDataSource } from '@mecha-gremlin/store/connection';
import { findCredentials } from '@mecha-gremlin/store/credential';
import { type Store, closeStore, openStore } from '@mecha-gremlin/store/store';
import { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Logger } from '../../src/log/log.ts';
import { type LoginRequest, logIn } from '../../src/mcp/login.ts';
import type { HttpConnection, ServerConfig } from '../../src/mcp/resolve.ts';
import { createMcpServers } from '../../src/mcp/servers.ts';
import { type AuthOptions, type FakeAuth, startAuthServer } from './auth-server.ts';
import { type FakeHttp, type FakeTool, startHttpServer } from './http-server.ts';

// Captured before any test stubs it.
const realFetch = globalThis.fetch;

const PROXIES = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
];

const CONSOLE = ['debug', 'info', 'warn', 'error', 'log'] as const;

const LOG: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const tool = (name: string): FakeTool => {
    return { name, call: () => ({ content: [{ type: 'text', text: `${name} done` }] }) };
};

const TOOLS = [tool('search'), tool('fetch')];

const TIMEOUTS = { startupTimeoutMs: 10_000, toolTimeoutMs: 10_000 };

let folder: string;
let store: Store;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'mcp-login-'));
    const opened = await openStore(folder);

    if (!opened.ok) {
        throw new Error(opened.error);
    }

    store = opened.value.store;

    // A request to 127.0.0.1 mustn't go through the developer's proxy (Brief R18.1).
    for (const name of PROXIES) {
        vi.stubEnv(name, undefined);
    }

    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost');

    for (const method of CONSOLE) {
        vi.spyOn(console, method);
    }
});

afterEach(async () => {
    vi.useRealTimers();
    const written = CONSOLE.flatMap((method) => vi.mocked(console[method]).mock.calls);
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await closeStore(store);
    await rm(folder, { recursive: true, force: true });

    if (written.length > 0) {
        throw new Error(`The console was written to: ${JSON.stringify(written)}`);
    }
}, 20_000);

type Guarded = {
    readonly auth: FakeAuth;
    readonly server: FakeHttp;
};

/** An MCP server that the fake authorization server guards. */
const guarded = async (
    options: AuthOptions = {},
    tools: readonly FakeTool[] = TOOLS,
): Promise<Guarded> => {
    const auth = await startAuthServer(options);
    let url = '';
    const server = await startHttpServer({ tools, answer: (request) => auth.guard(request, url) });
    url = server.url;
    cleanups.push(server.close, auth.close);

    return { auth, server };
};

const configOf = (url: string, changes: Partial<ServerConfig> = {}): ServerConfig => {
    return {
        name: 'docs',
        prefix: 'docs',
        includeTools: undefined,
        excludeTools: [],
        startupTimeoutMs: 10_000,
        toolTimeoutMs: 10_000,
        connection: { transport: 'http', url, writtenUrl: url, headers: {} },
        secrets: [],
        ...changes,
    };
};

type Started = {
    readonly done: Promise<Awaited<ReturnType<typeof logIn>>>;
    readonly input: PassThrough;
    readonly shown: readonly string[];
    readonly warnings: readonly string[];
    /** The authorization URL, once the login has shown it. */
    readonly url: () => Promise<URL>;
};

const startLogin = (
    url: string,
    changes: Partial<LoginRequest> = {},
    config: Partial<ServerConfig> = {},
): Started => {
    const input = new PassThrough();
    const shown: string[] = [];
    const warnings: string[] = [];
    const server = configOf(url, config);
    const connection = server.connection as HttpConnection;
    const done = logIn({
        store,
        server,
        connection,
        clientId: undefined,
        clientSecret: undefined,
        redirectUri: undefined,
        scope: undefined,
        input,
        show: (address) => {
            shown.push(address);
        },
        warn: (text) => {
            warnings.push(text);
        },
        ...changes,
    });

    return {
        done,
        input,
        shown,
        warnings,
        url: async () => {
            await vi.waitFor(
                () => {
                    expect(shown).toHaveLength(1);
                },
                { timeout: 10_000, interval: 10 },
            );

            return new URL(String(shown[0]));
        },
    };
};

/** A whole login: the browser follows the URL and reaches the listener. */
const logInThroughBrowser = async (
    { auth, server }: Guarded,
    changes: Partial<LoginRequest> = {},
) => {
    const login = startLogin(server.url, changes);
    const url = await login.url();
    const redirect = await auth.authorize(url.href);
    const page = await realFetch(redirect);
    const result = await login.done;

    return { login, url, redirect, page, result };
};

const rowsOf = async (url: string) => {
    const found = await findCredentials(store, { server: 'docs', url });

    if (!found.ok) {
        throw new Error(found.error);
    }

    return found.value;
};

const sql = (statement: string): Promise<unknown> => {
    return withDataSource(store, 'change the database', (dataSource) => {
        return dataSource.query(statement);
    });
};

// Real I/O goes on under fake timers; this waits for it without a timer.
const until = async (done: () => boolean): Promise<void> => {
    while (!done()) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
};

// Ends a login that is waiting for its redirect, with one whose state is wrong. Writing to its
// stdin changes the stream, so the login can't be taken as readonly.
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
const abandon = async (login: Started): Promise<void> => {
    login.input.write('http://127.0.0.1/callback?code=x&state=abandoned\n');
    await login.done;
};

// A port that something else is listening on.
const occupy = async (port = 0): Promise<number> => {
    const server: Server = createServer((_request, response) => {
        response.end();
    });
    await new Promise<void>((resolve) => {
        server.listen(port, '127.0.0.1', resolve);
    });
    cleanups.push(
        () =>
            new Promise((resolve) => {
                server.close(() => {
                    resolve();
                });
            }),
    );

    return (server.address() as AddressInfo).port;
};

// A port that nothing listens on.
const freePort = async (): Promise<number> => {
    const server = createServer();
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => {
        server.close(resolve);
    });

    return port;
};

const portOf = (redirectUri: string | null): number => {
    return Number(new URL(String(redirectUri)).port);
};

const refused = async (port: number): Promise<boolean> => {
    return realFetch(`http://127.0.0.1:${port}/callback`).then(
        () => false,
        () => true,
    );
};

/**
 * A server whose authorization server knows the client `abc`, registered ahead of time with one
 * redirect URI, on a free port, which it matches exactly.
 */
const exacting = async (options: AuthOptions = {}) => {
    const port = await freePort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const guard = await guarded({
        clients: { abc: 'sesame' },
        redirectUris: { abc: [redirectUri] },
        ...options,
    });

    return { guard, port, redirectUri };
};

/** A login with `abc`, given with its secret and its redirect URI. */
const withAbc = (redirectUri: string): Partial<LoginRequest> => {
    return { clientId: 'abc', clientSecret: 'sesame', redirectUri: new URL(redirectUri) };
};

describe('Log in to a Streamable HTTP server with OAuth', { timeout: 20_000 }, () => {
    test('a login through the browser, and a later run with the saved token', async () => {
        const guard = await guarded();

        const { url, page, result } = await logInThroughBrowser(guard);
        const [row] = await rowsOf(guard.server.url);
        const mcp = createMcpServers({
            parentEnv: {},
            runId: 'later',
            workDir: folder,
            dataDir: folder,
            store,
            log: LOG,
        });
        cleanups.push(mcp.close);
        const connected = await mcp.connect([
            { name: 'docs', prefix: 'docs', entry: { url: guard.server.url, ...TIMEOUTS } },
        ]);
        const sent = guard.server.requests.at(-1)?.headers.authorization;

        expect(result).toEqual({ ok: true, value: 2 });
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(await page.text()).toContain('You can close this tab.');
        // auth() reads what the login discovered, rather than discovering again.
        expect(
            guard.auth.requests.filter((request) => request.url.startsWith('/.well-known')),
        ).toHaveLength(1);
        expect(guard.auth.tokenRequests[0]?.resource).toBe(guard.server.url);
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
            response_type: 'code',
            client_id: expect.stringMatching(/^client-/),
            code_challenge: expect.any(String),
            code_challenge_method: 'S256',
            redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
            state: expect.any(String),
            resource: guard.server.url,
        });
        expect(connected.ok).toBe(true);
        expect(sent).toBe(`Bearer ${String(Object(row?.tokens).access_token)}`);
    });

    test('a server that offers no OAuth', async () => {
        const server = await startHttpServer({ tools: TOOLS });
        cleanups.push(server.close);

        const result = await startLogin(server.url).done;

        expect(result).toEqual({
            ok: false,
            error: 'The MCP server docs offers no OAuth login: it publishes no OAuth metadata.',
        });
        expect(await rowsOf(server.url)).toEqual([]);
    });

    test("a server that can't be reached", async () => {
        const port = await freePort();

        const result = await startLogin(`http://127.0.0.1:${port}/mcp`).done;

        expect(result.ok ? '' : result.error).toMatch(/^Can't find out how to log in to docs: /);
    });

    test('an authorization server whose metadata fails, without a secret in the error', async () => {
        let origin = '';
        const server = await startHttpServer({
            tools: TOOLS,
            answer: (request) => {
                if (request.url.startsWith('/.well-known/oauth-protected-resource')) {
                    return Response.json({
                        resource: `${origin}/mcp`,
                        authorization_servers: [`${origin}/tenants/k3y`],
                    });
                }

                return request.url.startsWith('/.well-known/oauth-authorization-server')
                    ? new Response('Down.', { status: 500 })
                    : undefined;
            },
        });
        origin = new URL(server.url).origin;
        cleanups.push(server.close);

        const result = await startLogin(server.url, {}, { secrets: ['k3y'] }).done;

        expect(result.ok ? '' : result.error).toMatch(
            /^Can't find out how to log in to docs: HTTP 500 .*\/tenants\/\[redacted\]$/,
        );
    });

    test('the scope given replaces the one the SDK would ask for', async () => {
        const { server } = await guarded({ scopes: ['read', 'admin'] });

        const login = startLogin(server.url, { scope: 'read write' });
        const scope = (await login.url()).searchParams.get('scope');
        await abandon(login);
        const usual = startLogin(server.url);
        const scopeOtherwise = (await usual.url()).searchParams.get('scope');
        await abandon(usual);

        expect(scope).toBe('read write');
        expect(scopeOtherwise).toBe('read admin');
    });

    test('an authorization server without metadata: its default paths', async () => {
        const guard = await guarded({ metadata: false });

        const { url, result } = await logInThroughBrowser(guard);
        const [row] = await rowsOf(guard.server.url);

        expect(result).toEqual({ ok: true, value: 2 });
        expect(url.origin).toBe(guard.auth.issuer);
        expect(url.pathname).toBe('/authorize');
        expect(guard.auth.registrations).toHaveLength(1);
        expect(row?.issuer).toBe(guard.auth.issuer);
    });

    test("the entry's headers, and its tool filters, in the connection that proves the login", async () => {
        const guard = await guarded();
        const login = startLogin(
            guard.server.url,
            {},
            {
                includeTools: ['search'],
                connection: {
                    transport: 'http',
                    url: guard.server.url,
                    writtenUrl: guard.server.url,
                    headers: { 'X-Team': 'docs', Authorization: 'Bearer stale' },
                },
            },
        );
        const redirect = await guard.auth.authorize((await login.url()).href);
        await realFetch(redirect);

        const result = await login.done;
        const last = guard.server.requests.at(-1);

        expect(result).toEqual({ ok: true, value: 1 });
        expect(last?.headers['x-team']).toBe('docs');
        expect(guard.auth.honours(String(last?.headers.authorization).slice(7))).toBe(true);
    });

    test('a server without protected-resource metadata, which is its own authorization server', async () => {
        const auth = await startAuthServer();
        let origin = '';
        const server = await startHttpServer({
            tools: TOOLS,
            answer: (request) => {
                if (request.url.startsWith('/.well-known/oauth-protected-resource')) {
                    return new Response('Not found.', { status: 404 });
                }

                return request.url === '/.well-known/oauth-authorization-server'
                    ? Response.json({
                          issuer: origin,
                          authorization_endpoint: `${auth.issuer}/authorize`,
                          token_endpoint: `${auth.issuer}/token`,
                          registration_endpoint: `${auth.issuer}/register`,
                          response_types_supported: ['code'],
                      })
                    : auth.guard(request, `${origin}/mcp`);
            },
        });
        origin = new URL(server.url).origin;
        cleanups.push(server.close, auth.close);
        const login = startLogin(server.url);
        await realFetch(await auth.authorize((await login.url()).href));

        const result = await login.done;
        const [row] = await rowsOf(server.url);

        expect(result).toEqual({ ok: true, value: 2 });
        expect(row?.issuer).toBe(origin);
    });

    test("the issuer from the authorization server's metadata, though the server names it otherwise", async () => {
        const guard = await guarded({ trailingSlash: true });

        const { result } = await logInThroughBrowser(guard);
        const [row] = await rowsOf(guard.server.url);

        expect(result.ok).toBe(true);
        expect(row?.issuer).toBe(guard.auth.issuer);
    });

    test('the client it connected with, closed', async () => {
        const guard = await guarded();
        const close = vi.spyOn(Client.prototype, 'close');

        const { result } = await logInThroughBrowser(guard);

        expect(result.ok).toBe(true);
        expect(close).toHaveBeenCalledOnce();
    });

    test('a connection that takes longer than the startup timeout', async () => {
        const auth = await startAuthServer();
        let url = '';
        // Answered only when the test ends: the SDK's own limit, 60 seconds, would outlast it.
        const held = Promise.withResolvers<void>();
        const server = await startHttpServer({
            tools: TOOLS,
            answer: async (request) => {
                const guard = auth.guard(request, url);

                if (guard === undefined && request.body.includes('"initialize"')) {
                    await held.promise;
                }

                return guard;
            },
        });
        url = server.url;
        cleanups.push(
            async () => {
                held.resolve();
            },
            server.close,
            auth.close,
        );
        const login = startLogin(server.url, {}, { startupTimeoutMs: 1000 });

        await realFetch(await auth.authorize((await login.url()).href));
        const result = await login.done;

        expect(result.ok ? '' : result.error).toMatch(
            /^The login to docs is saved, but connecting with it failed: .*timed out/i,
        );
    });

    test('a failure to list that names a secret', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url, {}, { includeTools: ['k3y'], secrets: ['k3y'] });

        await realFetch(await guard.auth.authorize((await login.url()).href));
        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: "The login to docs is saved, but connecting with it failed: it doesn't list [redacted], which its includeTools names.",
        });
    });

    test('a server without tools', async () => {
        const guard = await guarded({}, []);

        const { result } = await logInThroughBrowser(guard);

        expect(result).toEqual({ ok: true, value: 0 });
    });

    test('a connection that fails with the new token: the login is saved all the same', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url, {}, { includeTools: ['nope'], secrets: [] });
        const redirect = await guard.auth.authorize((await login.url()).href);
        await realFetch(redirect);

        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: "The login to docs is saved, but connecting with it failed: it doesn't list nope, which its includeTools names.",
        });
        expect(await rowsOf(guard.server.url)).toHaveLength(1);
    });

    test('a connection that the server refuses, without the token in the error', async () => {
        const auth = await startAuthServer();
        let url = '';
        let token = '';
        const server = await startHttpServer({
            tools: TOOLS,
            answer: (request) => {
                const guard = auth.guard(request, url);

                if (guard !== undefined || request.method !== 'POST') {
                    return guard;
                }

                token = String(request.headers.authorization).slice(7);

                return new Response(`Broken for ${token}, undefined`, { status: 500 });
            },
        });
        url = server.url;
        cleanups.push(server.close, auth.close);
        const login = startLogin(server.url);
        const redirect = await auth.authorize((await login.url()).href);
        await realFetch(redirect);

        const result = await login.done;

        expect(result.ok ? '' : result.error).toMatch(
            /^The login to docs is saved, but connecting with it failed: .*Broken for \[redacted\], undefined/,
        );
        expect(token).not.toBe('');
    });
});

describe('Register a client for the login', { timeout: 20_000 }, () => {
    test('dynamic registration: one, with the fields the design names, saved', async () => {
        const guard = await guarded();

        const { url, result } = await logInThroughBrowser(guard);
        const [row] = await rowsOf(guard.server.url);

        expect(result.ok).toBe(true);
        expect(guard.auth.registrations).toEqual([
            {
                client_name: 'mecha-gremlin',
                application_type: 'native',
                token_endpoint_auth_method: 'none',
                grant_types: ['authorization_code', 'refresh_token'],
                redirect_uris: [url.searchParams.get('redirect_uri')],
            },
        ]);
        expect(row?.client).toMatchObject({
            client_id: url.searchParams.get('client_id'),
            client_name: 'mecha-gremlin',
            issuer: guard.auth.issuer,
        });
    });

    test('a saved client, used again', async () => {
        const guard = await guarded();
        const first = await logInThroughBrowser(guard);

        const second = await logInThroughBrowser(guard);

        expect(second.result.ok).toBe(true);
        expect(guard.auth.registrations).toHaveLength(1);
        expect(second.url.searchParams.get('client_id')).toBe(
            first.url.searchParams.get('client_id'),
        );
    });

    test('a saved client that was registered for another issuer is no use', async () => {
        const guard = await guarded();
        await logInThroughBrowser(guard);
        await sql(`UPDATE credential SET issuer = 'https://elsewhere.example'`);

        const again = await logInThroughBrowser(guard);

        expect(again.result.ok).toBe(true);
        expect(guard.auth.registrations).toHaveLength(2);
        expect(await rowsOf(guard.server.url)).toHaveLength(2);
    });

    test("a saved client that can't be read is registered again", async () => {
        const guard = await guarded();
        await logInThroughBrowser(guard);
        await sql(`UPDATE credential SET client = '{"name":"no id"}'`);

        const again = await logInThroughBrowser(guard);

        expect(again.result.ok).toBe(true);
        expect(guard.auth.registrations).toHaveLength(2);
    });

    test('a configured client, which authenticates with its secret, with no registration offered', async () => {
        const guard = await guarded({ clients: { abc: 'sesame' }, registration: false });

        const { url, result } = await logInThroughBrowser(guard, {
            clientId: 'abc',
            clientSecret: 'sesame',
        });
        const exchange = guard.auth.tokenRequests[0];
        const [row] = await rowsOf(guard.server.url);

        expect(result.ok).toBe(true);
        expect(guard.auth.registrations).toEqual([]);
        expect(url.searchParams.get('client_id')).toBe('abc');
        expect(exchange?.authorization).toBe(
            `Basic ${Buffer.from('abc:sesame').toString('base64')}`,
        );
        expect(row?.client).toEqual({
            client_id: 'abc',
            client_secret: 'sesame',
            issuer: guard.auth.issuer,
            redirect_uris: [url.searchParams.get('redirect_uri')],
        });
    });

    test('a configured client saved, and used again without --client-id', async () => {
        const guard = await guarded({ clients: { abc: 'sesame' } });
        await logInThroughBrowser(guard, { clientId: 'abc', clientSecret: 'sesame' });

        const again = await logInThroughBrowser(guard);

        expect(again.result.ok).toBe(true);
        expect(again.url.searchParams.get('client_id')).toBe('abc');
        expect(guard.auth.registrations).toEqual([]);
    });

    test('a configured client saved without a redirect URI, as before: used again, on any port', async () => {
        const guard = await guarded({ clients: { abc: 'sesame' }, registration: false });
        await logInThroughBrowser(guard, { clientId: 'abc', clientSecret: 'sesame' });
        await sql(`UPDATE credential SET client = json_remove(client, '$.redirect_uris')`);

        const again = await logInThroughBrowser(guard);

        expect(again.result.ok).toBe(true);
        expect(again.url.searchParams.get('client_id')).toBe('abc');
    });

    test("a configured client in place of a saved one, which doesn't take its port", async () => {
        const guard = await guarded({ clients: { abc: 'sesame' } });
        const saved = await logInThroughBrowser(guard);

        const configured = await logInThroughBrowser(guard, {
            clientId: 'abc',
            clientSecret: 'sesame',
        });

        expect(configured.result.ok).toBe(true);
        expect(configured.url.searchParams.get('client_id')).toBe('abc');
        expect(guard.auth.registrations).toHaveLength(1);
        expect(portOf(configured.url.searchParams.get('redirect_uri'))).not.toBe(
            portOf(saved.url.searchParams.get('redirect_uri')),
        );
    });

    test('no dynamic registration, and no client given or saved: where to register one, and how to log in with it', async () => {
        const { auth, server } = await guarded({ registration: false });

        const result = await startLogin(server.url).done;

        expect(result).toEqual({
            ok: false,
            error: `The authorization server of docs, ${auth.issuer}, can't register a client. Register one with it whose redirect URI is http://127.0.0.1:<port>/callback, on a free port of your choosing, and log in with it: bun run mcp login docs --client-id <id> --redirect-uri http://127.0.0.1:<port>/callback, adding --client-secret '\${NAME}' if it has a secret.`,
        });
        expect(auth.requests.map((request) => request.url)).not.toContain('/register');
    });

    test('a protected resource that names another server: the SDK refuses it', async () => {
        const auth = await startAuthServer();
        let url = '';
        const server = await startHttpServer({
            tools: TOOLS,
            answer: (request) => {
                const guard = auth.guard(request, url);

                return request.url.startsWith('/.well-known/oauth-protected-resource')
                    ? Response.json({
                          resource: 'https://other.example/mcp',
                          authorization_servers: [auth.issuer],
                      })
                    : guard;
            },
        });
        url = server.url;
        cleanups.push(server.close, auth.close);

        const result = await startLogin(`${server.url}?key=k3y`, {}, { secrets: ['k3y'] }).done;

        expect(result.ok ? '' : result.error).toMatch(
            /^Can't log in to docs: Protected resource https:\/\/other\.example\/mcp does not match expected http:\/\/127\.0\.0\.1:\d+\/mcp\?key=\[redacted\]/,
        );
    });
});

describe('Take the redirect at a loopback listener or pasted', { timeout: 20_000 }, () => {
    test('the listener, on 127.0.0.1 only, at /callback', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirectUri = (await login.url()).searchParams.get('redirect_uri');
        const port = portOf(redirectUri);

        const elsewhere = await realFetch(`http://127.0.0.1:${port}/other`);
        const onIpv6 = await realFetch(`http://[::1]:${port}/callback`).then(
            () => 'answered',
            () => 'refused',
        );
        login.input.write('\n');
        const redirect = await guard.auth.authorize(String(login.shown[0]));
        const page = await realFetch(redirect);
        const result = await login.done;

        expect(redirectUri).toBe(`http://127.0.0.1:${port}/callback`);
        expect(elsewhere.status).toBe(404);
        // Neither keeps a connection that would hold the listener open.
        expect(elsewhere.headers.get('connection')).toBe('close');
        expect(page.headers.get('connection')).toBe('close');
        expect(onIpv6).toBe('refused');
        expect(result.ok).toBe(true);
        expect(await refused(port)).toBe(true);
    });

    test('a connection that never finishes its request holds nothing open', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const port = portOf((await login.url()).searchParams.get('redirect_uri'));
        const socket = connect(port, '127.0.0.1');
        await new Promise((resolve) => {
            socket.once('connect', resolve);
        });
        socket.write('GET /callback HTTP/1.1\r\nHost: 127.0.0.1\r\n');
        cleanups.push(async () => {
            socket.destroy();
        });

        login.input.write(`${await guard.auth.authorize(String(login.shown[0]))}\n`);
        const result = await login.done;

        expect(result.ok).toBe(true);
        // The listener ended it, though it never finished its request.
        await vi.waitFor(() => {
            expect(socket.closed).toBe(true);
        });
    });

    test('stdin is no longer read once the login has ended', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        login.input.write(`${await guard.auth.authorize((await login.url()).href)}\n`);
        await login.done;

        login.input.write('not an address\n');
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });

        expect(login.warnings).toEqual([]);
    });

    test('a login that ends leaves no timer behind', async () => {
        const guard = await guarded();
        const setTimer = vi.spyOn(globalThis, 'setTimeout');
        const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
        const login = startLogin(guard.server.url);

        login.input.write(`${await guard.auth.authorize((await login.url()).href)}\n`);
        const result = await login.done;
        const waiting = setTimer.mock.calls.findIndex(([, ms]) => ms === 5 * 60_000);

        expect(result.ok).toBe(true);
        expect(waiting).not.toBe(-1);
        // By identity: on Bun, timers have no fields, so any two are deeply equal.
        expect(clearTimer.mock.calls.map(([handle]) => handle)).toContain(
            setTimer.mock.results[waiting]?.value,
        );
    });

    test('a pasted redirect, as if the browser had come back', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = await guard.auth.authorize((await login.url()).href);

        login.input.write(`  ${redirect}  \n`);
        const result = await login.done;

        expect(result).toEqual({ ok: true, value: 2 });
        expect(login.warnings).toEqual([]);
    });

    test("a pasted line that isn't the redirect", async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const url = await login.url();

        login.input.write(
            `${url.href}\nnot an address\nhttp://127.0.0.1/callback?state=x\n\n   \n`,
        );
        await vi.waitFor(() => {
            expect(login.warnings).toHaveLength(3);
        });
        login.input.write(`${await guard.auth.authorize(url.href)}\n`);
        const result = await login.done;

        expect(login.warnings).toEqual(
            Array.from({ length: 3 }, () => {
                return "That line isn't the address the browser ended on: paste all of it, which holds code= or error=.";
            }),
        );
        expect(result.ok).toBe(true);
    });

    test('stdin ending says nothing, and the browser still comes back', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const url = await login.url();

        login.input.end();
        await realFetch(await guard.auth.authorize(url.href));
        const result = await login.done;

        expect(result.ok).toBe(true);
    });

    test('a wrong state: no code is exchanged', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = new URL(await guard.auth.authorize((await login.url()).href));
        redirect.searchParams.set('state', 'forged');

        login.input.write(`${redirect.href}\n`);
        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: "The redirect's state doesn't match the one the login sent, so it may not be this login's: the login stopped.",
        });
        expect(guard.auth.tokenRequests).toEqual([]);
        expect(await rowsOf(guard.server.url)).toEqual([]);
    });

    test('no state at all', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = new URL(await guard.auth.authorize((await login.url()).href));
        redirect.searchParams.delete('state');

        await realFetch(redirect);
        const result = await login.done;

        expect(result.ok ? '' : result.error).toMatch(/^The redirect's state doesn't match/);
    });

    test('a refusal, named, pasted', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = await guard.auth.authorize((await login.url()).href, { deny: true });

        login.input.write(`${redirect}\n`);
        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: 'The authorization server refused the login to docs: access_denied.',
        });
    });

    test('a refusal with a description, in parentheses after the code', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = new URL(
            await guard.auth.authorize((await login.url()).href, { deny: true }),
        );
        redirect.searchParams.set(
            'error_description',
            'The user has not been granted access to the requested resource',
        );

        login.input.write(`${redirect.href}\n`);
        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: 'The authorization server refused the login to docs: access_denied (The user has not been granted access to the requested resource).',
        });
    });

    test('a description in other characters: no part of it is named', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = new URL(
            await guard.auth.authorize((await login.url()).href, { deny: true }),
        );
        redirect.searchParams.set('error_description', 'Denied\u001b[31m in red');

        login.input.write(`${redirect.href}\n`);
        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: 'The authorization server refused the login to docs: access_denied.',
        });
    });

    test('an empty description is left out', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = new URL(
            await guard.auth.authorize((await login.url()).href, { deny: true }),
        );
        redirect.searchParams.set('error_description', '');

        login.input.write(`${redirect.href}\n`);
        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: 'The authorization server refused the login to docs: access_denied.',
        });
    });

    test('a refusal whose code holds what OAuth allows in none', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = new URL(await guard.auth.authorize((await login.url()).href));
        redirect.searchParams.set('error', 'denied\u001b[31m');

        login.input.write(`${redirect.href}\n`);
        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: 'The authorization server refused the login to docs: an error code in characters that OAuth allows in none.',
        });
    });

    test.each([
        ['a quote', 'access"denied'],
        ['a backslash', 'access\\denied'],
        ['nothing', ''],
    ])('a refusal whose code holds %s', async (_name, code) => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = new URL(await guard.auth.authorize((await login.url()).href));
        redirect.searchParams.set('error', code);

        await realFetch(redirect);
        const result = await login.done;

        expect(result.ok ? '' : result.error).toBe(
            'The authorization server refused the login to docs: an error code in characters that OAuth allows in none.',
        );
    });

    test('a refusal in every character OAuth allows', async () => {
        const allowed = Array.from({ length: 0x7f - 0x20 }, (_, index) => {
            return String.fromCodePoint(0x20 + index);
        })
            .filter((character) => character !== '"' && character !== '\\')
            .join('');
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = new URL(await guard.auth.authorize((await login.url()).href));
        redirect.searchParams.set('error', allowed);

        await realFetch(redirect);
        const result = await login.done;

        expect(result.ok ? '' : result.error).toBe(
            `The authorization server refused the login to docs: ${allowed}.`,
        );
    });

    test('a redirect without a code', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = new URL(await guard.auth.authorize((await login.url()).href));
        redirect.searchParams.delete('code');

        await realFetch(redirect);
        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: 'The redirect holds no code, so the login has nothing to exchange.',
        });
    });

    test('iss goes to the SDK, which checks it', async () => {
        const guard = await guarded({ issParameter: true });
        const login = startLogin(guard.server.url);
        const redirect = new URL(await guard.auth.authorize((await login.url()).href));
        redirect.searchParams.set('iss', 'https://evil.example');

        login.input.write(`${redirect.href}\n`);
        const result = await login.done;

        expect(result.ok ? '' : result.error).toMatch(/^Can't log in to docs: .*evil\.example/);
        expect(guard.auth.tokenRequests).toEqual([]);
    });

    test('iss, when it is right', async () => {
        const guard = await guarded({ issParameter: true });

        const { redirect, result } = await logInThroughBrowser(guard);

        expect(new URL(redirect).searchParams.get('iss')).toBe(guard.auth.issuer);
        expect(result.ok).toBe(true);
    });

    test('a code the authorization server refuses, without the code in the error', async () => {
        const guard = await guarded();
        const login = startLogin(guard.server.url);
        const redirect = await guard.auth.authorize((await login.url()).href);
        guard.auth.answerTokens('refuse');

        await realFetch(redirect);
        const result = await login.done;
        const code = String(new URL(redirect).searchParams.get('code'));

        expect(result.ok ? '' : result.error).toMatch(
            /^Can't log in to docs: The fake refused \[redacted\], \[redacted\]\.$/,
        );
        expect(result.ok ? '' : result.error).not.toContain(code);
        expect(guard.auth.tokenRequests).toMatchObject([{ code }]);
    });

    test('too long: 5 minutes, then the listener is closed', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const guard = await guarded();
        const timers = vi.getTimerCount();
        const login = startLogin(guard.server.url);
        await until(() => login.shown.length > 0);
        // The wait begins once auth() has returned.
        await until(() => vi.getTimerCount() > timers);
        const port = portOf(new URL(String(login.shown[0])).searchParams.get('redirect_uri'));

        await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
        const early = await Promise.race([login.done, Promise.resolve('waiting')]);
        await vi.advanceTimersByTimeAsync(1);
        const result = await login.done;

        expect(early).toBe('waiting');
        expect(result).toEqual({
            ok: false,
            error: 'The login waited 5 minutes for the redirect, which never came.',
        });
        expect(await refused(port)).toBe(true);
    });

    test('the registered port: used again while free, given up when taken', async () => {
        const guard = await guarded();
        const first = await logInThroughBrowser(guard);
        const port = portOf(first.url.searchParams.get('redirect_uri'));

        const second = await logInThroughBrowser(guard);
        await occupy(port);
        const third = await logInThroughBrowser(guard);

        expect(portOf(second.url.searchParams.get('redirect_uri'))).toBe(port);
        expect(portOf(third.url.searchParams.get('redirect_uri'))).not.toBe(port);
        expect(guard.auth.registrations).toHaveLength(2);
        expect(third.result.ok).toBe(true);
    });

    test('--redirect-uri: its port and path, and the client registered for it', async () => {
        const guard = await guarded();
        const port = await freePort();
        const given = new URL(`http://localhost:${port}/oauth/back`);
        const login = startLogin(guard.server.url, { redirectUri: given });
        const url = await login.url();
        const redirect = await guard.auth.authorize(url.href);

        // A browser may try ::1 for localhost first, and the listener is on 127.0.0.1 alone.
        const page = await realFetch(redirect.replace('//localhost:', '//127.0.0.1:'));
        const result = await login.done;
        const [row] = await rowsOf(guard.server.url);

        expect(url.searchParams.get('redirect_uri')).toBe(given.href);
        expect(page.status).toBe(200);
        expect(result.ok).toBe(true);
        expect(row?.client).toMatchObject({ redirect_uris: [given.href] });
    });

    test('--redirect-uri unlike the one the saved client registered: registered again', async () => {
        const guard = await guarded();
        await logInThroughBrowser(guard);
        const port = await freePort();

        const again = await logInThroughBrowser(guard, {
            redirectUri: new URL(`http://127.0.0.1:${port}/callback`),
        });

        expect(again.result.ok).toBe(true);
        expect(guard.auth.registrations).toHaveLength(2);
    });

    test('--redirect-uri on a port that is taken', async () => {
        const guard = await guarded();
        const port = await occupy();

        const result = await startLogin(guard.server.url, {
            redirectUri: new URL(`http://127.0.0.1:${port}/callback`),
        }).done;

        expect(result.ok ? '' : result.error).toMatch(
            new RegExp(`^Can't listen for the redirect on 127\\.0\\.0\\.1:${port}: `),
        );
        expect(guard.auth.registrations).toEqual([]);
    });

    test('a registered redirect URI that no listener here can take', async () => {
        const guard = await guarded();
        await logInThroughBrowser(guard);
        await sql(
            `UPDATE credential SET client = json_set(client, '$.redirect_uris', json_array('https://app.example/cb'))`,
        );

        const again = await logInThroughBrowser(guard);

        expect(again.result.ok).toBe(true);
        expect(guard.auth.registrations).toHaveLength(2);
    });

    test('a configured client logged in again with no options: its redirect URI, on its port', async () => {
        const { guard, redirectUri } = await exacting({ registration: false });
        await logInThroughBrowser(guard, withAbc(redirectUri));

        const again = await logInThroughBrowser(guard);

        expect(again.result).toEqual({ ok: true, value: 2 });
        expect(again.url.searchParams.get('client_id')).toBe('abc');
        expect(again.url.searchParams.get('redirect_uri')).toBe(redirectUri);
        expect(again.page.status).toBe(200);
    });

    test('the same client given again with --client-id: its saved redirect URI, on its port', async () => {
        const { guard, redirectUri } = await exacting({ registration: false });
        await logInThroughBrowser(guard, withAbc(redirectUri));

        const again = await logInThroughBrowser(guard, { clientId: 'abc', clientSecret: 'sesame' });

        expect(again.result).toEqual({ ok: true, value: 2 });
        expect(again.url.searchParams.get('redirect_uri')).toBe(redirectUri);
        expect(again.page.status).toBe(200);
    });

    test("a configured client's port taken, with no registration offered: the login fails, naming it, before any URL", async () => {
        const { guard, port, redirectUri } = await exacting({ registration: false });
        await logInThroughBrowser(guard, withAbc(redirectUri));
        await occupy(port);
        const login = startLogin(guard.server.url);
        // A login that gave way to another port would end on this, rather than wait 5 minutes.
        login.input.write('http://127.0.0.1/callback?code=x&state=abandoned\n');

        const result = await login.done;

        expect(result.ok ? '' : result.error).toMatch(
            new RegExp(`^Can't listen for the redirect on 127\\.0\\.0\\.1:${port}: `),
        );
        expect(login.shown).toEqual([]);
    });

    test("a configured client's port taken, with registration offered: another port, and a client registered for it", async () => {
        const { guard, port, redirectUri } = await exacting();
        await logInThroughBrowser(guard, withAbc(redirectUri));
        await occupy(port);

        const again = await logInThroughBrowser(guard);
        const [row] = await rowsOf(guard.server.url);

        expect(again.result.ok).toBe(true);
        expect(portOf(again.url.searchParams.get('redirect_uri'))).not.toBe(port);
        expect(guard.auth.registrations).toHaveLength(1);
        expect(row?.client).toMatchObject({
            client_id: again.url.searchParams.get('client_id'),
            client_name: 'mecha-gremlin',
        });
    });
});

describe('Save what later runs need', { timeout: 20_000 }, () => {
    test('the row: the URL as written, the issuer, stamped values, and when it expires', async () => {
        const guard = await guarded();
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        const written = `${guard.server.url}?team=\${TEAM}`;
        const login = startLogin(
            guard.server.url,
            {},
            {
                connection: {
                    transport: 'http',
                    url: guard.server.url,
                    writtenUrl: written,
                    headers: {},
                },
            },
        );
        await realFetch(await guard.auth.authorize((await login.url()).href));

        const result = await login.done;
        const rows = await rowsOf(written);

        expect(result.ok).toBe(true);
        expect(rows).toMatchObject([
            {
                server: 'docs',
                url: written,
                issuer: guard.auth.issuer,
                tokens: {
                    access_token: expect.stringMatching(/^at-/),
                    refresh_token: expect.stringMatching(/^rt-/),
                    token_type: 'Bearer',
                    expires_in: 3600,
                    issuer: guard.auth.issuer,
                },
                client: { issuer: guard.auth.issuer },
                discovery: {
                    authorizationServerUrl: guard.auth.issuer,
                    authorizationServerMetadata: { issuer: guard.auth.issuer },
                    resourceMetadata: { resource: guard.server.url },
                },
                expiresAt: 1_800_003_600_000,
                needsLogin: false,
            },
        ]);
        expect(await rowsOf(guard.server.url)).toEqual([]);
    });

    test("a configured client's redirect URI: the one it was used with, as its only one", async () => {
        const { guard, redirectUri } = await exacting({ registration: false });

        const { result } = await logInThroughBrowser(guard, withAbc(redirectUri));
        const [row] = await rowsOf(guard.server.url);

        expect(result.ok).toBe(true);
        expect(row?.client).toEqual({
            client_id: 'abc',
            client_secret: 'sesame',
            issuer: guard.auth.issuer,
            redirect_uris: [redirectUri],
        });
    });

    test('tokens without expires_in: no expiry', async () => {
        const guard = await guarded({ expiresIn: null });

        await logInThroughBrowser(guard);

        expect(await rowsOf(guard.server.url)).toMatchObject([{ expiresAt: null }]);
    });

    test('a second login: one row, with its tokens, and needs_login cleared', async () => {
        const guard = await guarded();
        await logInThroughBrowser(guard);
        const [first] = await rowsOf(guard.server.url);
        await sql('UPDATE credential SET needs_login = 1');

        await logInThroughBrowser(guard);
        const rows = await rowsOf(guard.server.url);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.needsLogin).toBe(false);
        expect(rows[0]?.tokens).not.toEqual(first?.tokens);
    });

    test("a row that can't be saved", async () => {
        const guard = await guarded();
        await sql(
            "CREATE TRIGGER refuse BEFORE INSERT ON credential BEGIN SELECT RAISE(ABORT, 'refused'); END",
        );

        const { result } = await logInThroughBrowser(guard);

        expect(result.ok ? '' : result.error).toMatch(
            /^Can't log in to docs: Can't save the credential in the database at .*: SqliteError: refused$/,
        );
    });

    test("saved rows that can't be read", async () => {
        const guard = await guarded();
        await sql('DROP TABLE credential');

        const result = await startLogin(guard.server.url).done;

        expect(result.ok ? '' : result.error).toMatch(
            /^Can't find the credentials in the database at /,
        );
    });
});

// A server of the test's own: its first answer is a stream that never ends, and it says when the
// login has let that stream go.
const streaming = async () => {
    let closed = false;
    const server: Server = createServer((request, response) => {
        if (request.method !== 'POST') {
            response.writeHead(404).end();

            return;
        }

        response.on('close', () => {
            closed = true;
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': still here\n\n');
    });
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    cleanups.push(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => {
            server.close(resolve);
        });
    });

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
        closed: () => closed,
    };
};

describe('Find the metadata where the first request is told', { timeout: 20_000 }, () => {
    test('metadata only at the URL a 401 names, the well-known ones answering 404', async () => {
        const guard = await guarded({ metadataAt: 'challenge' });

        const { result } = await logInThroughBrowser(guard);
        const [row] = await rowsOf(guard.server.url);
        const asked = guard.server.requests.map((request) => request.url);

        expect(result).toEqual({ ok: true, value: 2 });
        expect(row?.discovery).toMatchObject({
            resourceMetadataUrl: new URL('/oauth/resource', guard.server.url).href,
            resourceMetadata: { resource: guard.server.url },
        });
        expect(asked).toContain('/oauth/resource');
        expect(asked.filter((url) => url.startsWith('/.well-known'))).toEqual([]);
    });

    test('a server that answers an initialize without a token, and publishes well-known metadata', async () => {
        const guard = await guarded({ anonymous: true });

        const { result } = await logInThroughBrowser(guard);
        const [probed] = guard.server.requests;

        expect(result).toEqual({ ok: true, value: 2 });
        expect(probed?.headers.authorization).toBeUndefined();
        expect(guard.server.requests.map((request) => request.url)).toContain(
            '/.well-known/oauth-protected-resource/mcp',
        );
    });

    test('a 401 that names no metadata: the well-known URLs', async () => {
        const guard = await guarded({ metadataAt: 'unnamed' });

        const { result } = await logInThroughBrowser(guard);
        const [row] = await rowsOf(guard.server.url);

        expect(result).toEqual({ ok: true, value: 2 });
        expect(row?.discovery).not.toHaveProperty('resourceMetadataUrl');
    });

    test("the challenge's scope, unless --scope gives one", async () => {
        const guard = await guarded({ challengeScope: 'files:read', scopes: ['everything'] });

        const login = startLogin(guard.server.url);
        const scope = (await login.url()).searchParams.get('scope');
        await abandon(login);
        const given = startLogin(guard.server.url, { scope: 'read write' });
        const scopeGiven = (await given.url()).searchParams.get('scope');
        await abandon(given);

        expect(scope).toBe('files:read');
        expect(scopeGiven).toBe('read write');
    });

    test("the entry's headers reach the server's first request, and no metadata or token endpoint", async () => {
        const guard = await guarded({ metadataAt: 'challenge' });
        const login = startLogin(
            guard.server.url,
            {},
            {
                connection: {
                    transport: 'http',
                    url: guard.server.url,
                    writtenUrl: guard.server.url,
                    headers: { 'X-Team': 'docs' },
                },
            },
        );
        await realFetch(await guard.auth.authorize((await login.url()).href));

        const result = await login.done;
        const [probed] = guard.server.requests;
        const metadata = guard.server.requests.filter((request) => request.url !== '/mcp');

        expect(result.ok).toBe(true);
        expect(probed).toMatchObject({
            method: 'POST',
            url: '/mcp',
            headers: {
                'x-team': 'docs',
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
        });
        expect(probed?.headers.authorization).toBeUndefined();
        expect(JSON.parse(String(probed?.body))).toEqual({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'mecha-gremlin', version: '0.0.0' },
            },
        });
        expect(metadata.length).toBeGreaterThan(0);
        expect(metadata.map((request) => request.headers['x-team'])).toEqual(
            metadata.map(() => undefined),
        );
        expect(guard.auth.requests.length).toBeGreaterThan(2);
        expect(guard.auth.requests.map((request) => request.headers['x-team'])).toEqual(
            guard.auth.requests.map(() => undefined),
        );
    });

    test('a first request answered with 500: an error naming the server, and no browser', async () => {
        const auth = await startAuthServer();
        const server = await startHttpServer({
            tools: TOOLS,
            answer: () => new Response('Broken.', { status: 500 }),
        });
        cleanups.push(server.close, auth.close);
        const login = startLogin(server.url);

        const result = await login.done;

        expect(result).toEqual({
            ok: false,
            error: "Can't find out how to log in to docs: its answer to an initialize without a token is HTTP 500",
        });
        expect(login.shown).toEqual([]);
        expect(server.requests).toHaveLength(1);
    });

    test('a first request redirected elsewhere: not followed, so the headers stay home', async () => {
        const elsewhere = await startHttpServer({ tools: TOOLS });
        const server = await startHttpServer({
            tools: TOOLS,
            answer: () => new Response(null, { status: 307, headers: { location: elsewhere.url } }),
        });
        cleanups.push(server.close, elsewhere.close);

        const result = await startLogin(
            server.url,
            {},
            {
                connection: {
                    transport: 'http',
                    url: server.url,
                    writtenUrl: server.url,
                    headers: { 'X-Api-Key': 'k3y' },
                },
            },
        ).done;

        expect(result).toEqual({
            ok: false,
            error: "Can't find out how to log in to docs: its answer to an initialize without a token is HTTP 307",
        });
        expect(elsewhere.requests).toEqual([]);
    });

    test('a first request answered with no body at all', async () => {
        const guard = await guarded({ anonymous: true });
        let probed = false;
        const server = await startHttpServer({
            tools: TOOLS,
            answer: (request) => {
                const first = !probed && request.method === 'POST';
                probed ||= first;

                return first
                    ? new Response(null, { status: 204 })
                    : guard.auth.guard(request, server.url);
            },
        });
        cleanups.push(server.close);
        const login = startLogin(server.url);

        await realFetch(await guard.auth.authorize((await login.url()).href));
        const result = await login.done;

        expect(result).toEqual({ ok: true, value: 2 });
    });

    test('a first answer that streams on: let go, not waited for', async () => {
        const server = await streaming();

        const result = await startLogin(server.url).done;

        expect(result).toEqual({
            ok: false,
            error: 'The MCP server docs offers no OAuth login: it publishes no OAuth metadata.',
        });
        await vi.waitFor(() => {
            expect(server.closed()).toBe(true);
        });
    });

    test('a first request that gets no answer within the startup timeout', async () => {
        const held = Promise.withResolvers<void>();
        const server = await startHttpServer({
            tools: TOOLS,
            answer: async () => {
                await held.promise;

                return new Response('Too late.', { status: 500 });
            },
        });
        cleanups.push(async () => {
            held.resolve();
        }, server.close);

        const result = await startLogin(server.url, {}, { startupTimeoutMs: 1000 }).done;

        expect(result.ok ? '' : result.error).toMatch(
            /^Can't find out how to log in to docs: The operation (timed out\.|was aborted due to timeout)$/,
        );
    });
});
