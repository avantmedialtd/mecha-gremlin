import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDataSource } from '@mecha-gremlin/store/connection';
import {
    type Credential,
    type NewCredential,
    findCredentials,
    saveCredential,
    takeRefreshLease,
} from '@mecha-gremlin/store/credential';
import { type Store, closeStore, openStore } from '@mecha-gremlin/store/store';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Fields, Json, Logger } from '../../src/log/log.ts';
import { type McpServers, createMcpServers } from '../../src/mcp/servers.ts';
import type { ToolHandler } from '../../src/tools/tool-handler.ts';
import { type AuthOptions, type FakeAuth, startAuthServer } from './auth-server.ts';
import { type FakeHttp, type FakeTool, startHttpServer } from './http-server.ts';

// Captured before any test stubs it: the SDK's transport looks fetch up at request time.
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

const TIMEOUTS = { startupTimeoutMs: 10_000, toolTimeoutMs: 10_000 };

const MINUTE = 60_000;

const search: FakeTool = {
    name: 'search',
    call: () => ({ content: [{ type: 'text', text: 'found' }] }),
};

type LogRecord = {
    readonly level: string;
    readonly message: string;
    readonly [field: string]: Json | undefined;
};

let folder: string;
let store: Store;
let records: LogRecord[];
const stores: Store[] = [];
const started: McpServers[] = [];
const cleanups: (() => Promise<void>)[] = [];

const recorder =
    (level: string) =>
    (message: string, fields: Fields = {}) => {
        records.push({ level, message, ...fields });
    };

const LOG: Logger = { info: recorder('info'), warn: recorder('warn'), error: recorder('error') };

const openOne = async (): Promise<Store> => {
    const opened = await openStore(folder);

    if (!opened.ok) {
        throw new Error(opened.error);
    }

    stores.push(opened.value.store);

    return opened.value.store;
};

beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'mcp-bearer-'));
    store = await openOne();
    records = [];

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
    await Promise.all(started.splice(0).map((mcp) => mcp.close()));
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));

    for (const each of stores.splice(0)) {
        await closeStore(each);
    }

    await rm(folder, { recursive: true, force: true });

    if (written.length > 0) {
        throw new Error(`The console was written to: ${JSON.stringify(written)}`);
    }
}, 20_000);

type Guarded = {
    readonly auth: FakeAuth;
    readonly server: FakeHttp;
};

const guarded = async (
    options: AuthOptions = {},
    answer?: (request: Parameters<FakeAuth['guard']>[0]) => Response | undefined,
): Promise<Guarded> => {
    const auth = await startAuthServer(options);
    let url = '';
    const server = await startHttpServer({
        tools: [search],
        answer: (request) => answer?.(request) ?? auth.guard(request, url),
    });
    url = server.url;
    cleanups.push(server.close, auth.close);

    return { auth, server };
};

const runOf = (
    runId: string,
    on: Store = store,
    parentEnv: Readonly<Record<string, string>> = {},
): McpServers => {
    const mcp = createMcpServers({
        parentEnv,
        runId,
        workDir: folder,
        dataDir: folder,
        store: on,
        log: LOG,
    });
    started.push(mcp);

    return mcp;
};

const rowOf = (url: string, entry: Readonly<Record<string, unknown>> = {}) => {
    return { name: 'docs', prefix: 'docs', disabled: false, entry: { url, ...TIMEOUTS, ...entry } };
};

const without = (name: string): string => {
    return `To run without it: bun run mcp disable ${name}, for every run, or an mcp list in the task's frontmatter that leaves it out, for one task.`;
};

type Saved = {
    /** Where the saved metadata says the token endpoint is. */
    readonly tokenPath?: string;
    readonly accessToken?: string;
    /** Null for none. */
    readonly refreshToken?: string | null;
    readonly expiresAt?: number | null;
    readonly url?: string;
    readonly changes?: Partial<NewCredential>;
};

/** A login, as `bun run mcp login` leaves one, which the fake honours. */
const saveLogin = async (
    { auth, server }: Guarded,
    {
        tokenPath = '/token',
        accessToken = 'at1',
        refreshToken = 'rt1',
        expiresAt = null,
        url = server.url,
        changes = {},
    }: Saved = {},
): Promise<void> => {
    auth.grant({ clientId: 'client-1', accessToken, refreshToken: refreshToken ?? undefined });
    const saved = await saveCredential(store, {
        server: 'docs',
        url,
        issuer: auth.issuer,
        client: { client_id: 'client-1', token_endpoint_auth_method: 'none', issuer: auth.issuer },
        tokens: {
            access_token: accessToken,
            token_type: 'Bearer',
            ...(refreshToken === null ? {} : { refresh_token: refreshToken }),
            issuer: auth.issuer,
        },
        discovery: {
            authorizationServerUrl: auth.issuer,
            authorizationServerMetadata: {
                issuer: auth.issuer,
                authorization_endpoint: `${auth.issuer}/authorize`,
                token_endpoint: `${auth.issuer}${tokenPath}`,
                response_types_supported: ['code'],
                token_endpoint_auth_methods_supported: ['none'],
            },
            resourceMetadata: { resource: server.url },
        },
        expiresAt,
        ...changes,
    });

    if (!saved.ok) {
        throw new Error(saved.error);
    }
};

const rowsOf = async (url: string, on: Store = store): Promise<Credential[]> => {
    const found = await findCredentials(on, { server: 'docs', url });

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

const handlersOf = async (mcp: McpServers, url: string): Promise<readonly ToolHandler[]> => {
    const connected = await mcp.connect([rowOf(url)]);

    if (!connected.ok) {
        throw new Error(connected.error.join('\n'));
    }

    return connected.value.tools;
};

const problemsOf = async (mcp: McpServers, url: string): Promise<string[]> => {
    const connected = await mcp.connect([rowOf(url)]);

    expect(connected.ok).toBe(false);

    return connected.ok ? [] : connected.error;
};

const bearers = (server: FakeHttp): string[] => {
    return server.requests.map((request) => String(request.headers.authorization));
};

const refreshes = (auth: FakeAuth) => {
    return auth.tokenRequests.filter((request) => request.grant_type === 'refresh_token');
};

// Real I/O goes on under fake timers; this waits for it without a timer.
const until = async (done: () => boolean): Promise<void> => {
    while (!done()) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
};

describe("Use a server's login in a run", { timeout: 20_000 }, () => {
    test("the token sent, on every request, in place of the entry's Authorization header", async () => {
        const guard = await guarded();
        await saveLogin(guard, { url: 'https://docs.example.test/mcp' });
        const base = guard.server.url.replace('/mcp', '');
        vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : String(input);

            return realFetch(url.replace('https://docs.example.test', base), init);
        });
        const mcp = runOf('run-a', store, { DOCS_TOKEN: 'old' });

        const connected = await mcp.connect([
            {
                name: 'docs',
                prefix: 'docs',
                disabled: false,
                entry: {
                    url: 'https://docs.example.test/mcp',
                    headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Team': 'docs' },
                    ...TIMEOUTS,
                },
            },
        ]);

        expect(connected.ok).toBe(true);
        expect(guard.server.requests.length).toBeGreaterThan(1);
        expect(bearers(guard.server)).toEqual(guard.server.requests.map(() => 'Bearer at1'));
        expect(guard.server.requests.map((request) => request.headers['x-team'])).toEqual(
            guard.server.requests.map(() => 'docs'),
        );
        expect(guard.auth.tokenRequests).toEqual([]);
    });

    test('a token about to expire: refreshed before the first request, and the new one sent', async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        const before = Date.now();

        const handlers = await handlersOf(runOf('run-a'), guard.server.url);
        const [row] = await rowsOf(guard.server.url);
        const tokens = Object(row?.tokens);

        expect(handlers).toHaveLength(1);
        expect(refreshes(guard.auth)).toEqual([
            {
                grant_type: 'refresh_token',
                refresh_token: 'rt1',
                client_id: 'client-1',
                resource: guard.server.url,
            },
        ]);
        expect(tokens.access_token).not.toBe('at1');
        expect(tokens.issuer).toBe(guard.auth.issuer);
        expect(row?.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
        expect(row).toMatchObject({ leaseOwner: null, leaseUntil: null, needsLogin: false });
        expect(bearers(guard.server)).toEqual(
            guard.server.requests.map(() => `Bearer ${tokens.access_token}`),
        );
    });

    test('the token endpoint the saved metadata names', async () => {
        const guard = await guarded({ tokenPath: '/oauth/token' });
        await saveLogin(guard, { tokenPath: '/oauth/token', expiresAt: Date.now() + MINUTE });

        const handlers = await handlersOf(runOf('run-a'), guard.server.url);

        expect(handlers).toHaveLength(1);
        expect(refreshes(guard.auth)).toHaveLength(1);
        expect(guard.auth.requests.map((request) => request.url)).toEqual(['/oauth/token']);
    });

    test.each([
        ['5 minutes', 5 * MINUTE, 1],
        ['just over 5 minutes', 5 * MINUTE + 1, 0],
    ])('a token that expires in %s', async (_name, ahead, expected) => {
        const guard = await guarded();
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        await saveLogin(guard, { expiresAt: now + ahead });

        await handlersOf(runOf('run-a'), guard.server.url);

        expect(refreshes(guard.auth)).toHaveLength(expected);
    });

    test('a token without an expiry, and one about to expire without a refresh token', async () => {
        const lasting = await guarded();
        await saveLogin(lasting, { expiresAt: null });
        const expiring = await guarded();
        await saveLogin(expiring, {
            refreshToken: null,
            expiresAt: Date.now() + MINUTE,
            url: expiring.server.url,
        });

        await handlersOf(runOf('run-a'), lasting.server.url);
        await handlersOf(runOf('run-b'), expiring.server.url);

        expect(lasting.auth.tokenRequests).toEqual([]);
        expect(expiring.auth.tokenRequests).toEqual([]);
        expect(bearers(expiring.server)).toContain('Bearer at1');
    });

    test('a 401 during the session: refreshed, and the call sent again with the new token', async () => {
        const guard = await guarded();
        await saveLogin(guard);
        const handlers = await handlersOf(runOf('run-a'), guard.server.url);
        guard.auth.expire('at1');

        const outcome = await handlers[0]?.invoke('{}');
        const [row] = await rowsOf(guard.server.url);

        expect(outcome).toEqual({ ok: true, value: 'found' });
        expect(refreshes(guard.auth)).toHaveLength(1);
        expect(bearers(guard.server).at(-1)).toBe(`Bearer ${Object(row?.tokens).access_token}`);
    });

    test('calls that meet a 401 together share one refresh, and a later 401 has its own', async () => {
        const guard = await guarded();
        await saveLogin(guard);
        const handlers = await handlersOf(runOf('run-a'), guard.server.url);
        guard.auth.expire('at1');
        // Slow enough that both calls meet their 401 while the refresh goes on.
        guard.auth.answerTokens('issue', 300);
        const [handler] = handlers;

        const together = await Promise.all([handler?.invoke('{}'), handler?.invoke('{}')]);
        guard.auth.answerTokens('issue');
        const [row] = await rowsOf(guard.server.url);
        guard.auth.expire(String(Object(row?.tokens).access_token));
        const later = await handler?.invoke('{}');

        expect(together).toEqual([
            { ok: true, value: 'found' },
            { ok: true, value: 'found' },
        ]);
        expect(later).toEqual({ ok: true, value: 'found' });
        expect(refreshes(guard.auth)).toHaveLength(2);
    });

    test('two runs at once: one refresh request, both with the new token, and the grant kept', async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        guard.auth.answerTokens('issue', 400);
        const other = await openOne();

        const [first, second] = await Promise.all([
            runOf('run-a').connect([rowOf(guard.server.url)]),
            runOf('run-b', other).connect([rowOf(guard.server.url)]),
        ]);
        const [row] = await rowsOf(guard.server.url);
        const token = String(Object(row?.tokens).access_token);

        expect(first.ok && second.ok).toBe(true);
        expect(refreshes(guard.auth)).toHaveLength(1);
        expect(guard.auth.revoked('rt1')).toBe(false);
        expect(guard.auth.honours(token)).toBe(true);
        expect(new Set(bearers(guard.server))).toEqual(new Set([`Bearer ${token}`]));
    });

    test("while waiting, the server's own row, though another issuer's is newer", async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        const [saved] = await rowsOf(guard.server.url);
        await takeRefreshLease(store, {
            id: Number(saved?.id),
            seen: 'rt1',
            owner: 'other',
            leaseMs: 10 * MINUTE,
        });
        guard.auth.grant({ clientId: 'client-1', accessToken: 'at2', refreshToken: 'rt2' });
        guard.auth.grant({ clientId: 'client-1', accessToken: 'at-b', refreshToken: 'rt-b' });
        const connecting = runOf('run-a').connect([rowOf(guard.server.url)]);
        await new Promise((resolve) => {
            setTimeout(resolve, 300);
        });

        // Another issuer's login, newer, then the other run's refresh, which leaves the row's
        // time as it was.
        await saveCredential(store, {
            server: 'docs',
            url: guard.server.url,
            issuer: 'https://other.example',
            client: { client_id: 'client-1' },
            tokens: { access_token: 'at-b', refresh_token: 'rt-b' },
            discovery: { authorizationServerUrl: guard.auth.issuer },
            expiresAt: null,
        });
        await sql(
            `UPDATE credential SET tokens = json_set(tokens, '$.access_token', 'at2', '$.refresh_token', 'rt2'), lease_owner = NULL, lease_until = NULL WHERE id = ${Number(saved?.id)}`,
        );
        const connected = await connecting;

        expect(connected.ok).toBe(true);
        expect(bearers(guard.server).at(-1)).toBe('Bearer at2');
    });

    test('a lease given up without new tokens: this run takes it and refreshes', async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        const [saved] = await rowsOf(guard.server.url);
        await takeRefreshLease(store, {
            id: Number(saved?.id),
            seen: 'rt1',
            owner: 'crashed',
            leaseMs: 600,
        });

        const handlers = await handlersOf(runOf('run-a'), guard.server.url);
        const [row] = await rowsOf(guard.server.url);

        expect(handlers).toHaveLength(1);
        expect(refreshes(guard.auth)).toHaveLength(1);
        expect(row?.leaseOwner).toBeNull();
    });

    test('a lease held for over 35 seconds: the run gives up', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        const [saved] = await rowsOf(guard.server.url);
        await takeRefreshLease(store, {
            id: Number(saved?.id),
            seen: 'rt1',
            owner: 'stuck',
            leaseMs: 10 * MINUTE,
        });
        const timers = vi.getTimerCount();
        const connecting = runOf('run-a').connect([rowOf(guard.server.url)]);
        await until(() => vi.getTimerCount() > timers);

        await vi.advanceTimersByTimeAsync(35_000 - 250);
        const early = await Promise.race([connecting, Promise.resolve('waiting')]);
        await vi.advanceTimersByTimeAsync(250);
        const connected = await connecting;

        expect(early).toBe('waiting');
        expect(connected).toEqual({
            ok: false,
            error: [
                `The MCP server docs couldn't start: its login couldn't be refreshed: another run held its refresh for over 35 seconds.\n${without('docs')}`,
            ],
        });
        expect(guard.auth.tokenRequests).toEqual([]);
    });

    test('a login that another run finds refused, or that is logged out, while this one waits', async () => {
        const refused = await guarded();
        await saveLogin(refused, { expiresAt: Date.now() + 2 * MINUTE });
        const [saved] = await rowsOf(refused.server.url);
        await takeRefreshLease(store, {
            id: Number(saved?.id),
            seen: 'rt1',
            owner: 'other',
            leaseMs: 10 * MINUTE,
        });

        const connecting = runOf('run-a').connect([rowOf(refused.server.url)]);
        // The run waits on the lease meanwhile, reading the row every 250 ms.
        await new Promise((resolve) => {
            setTimeout(resolve, 300);
        });
        await sql('UPDATE credential SET needs_login = 1');
        const whileRefused = await connecting;
        await sql('DELETE FROM credential');
        await saveLogin(refused, { expiresAt: Date.now() + 2 * MINUTE });
        const [again] = await rowsOf(refused.server.url);
        await takeRefreshLease(store, {
            id: Number(again?.id),
            seen: 'rt1',
            owner: 'other',
            leaseMs: 10 * MINUTE,
        });
        const loggingOut = runOf('run-b').connect([rowOf(refused.server.url)]);
        await new Promise((resolve) => {
            setTimeout(resolve, 300);
        });
        await sql('DELETE FROM credential');
        const whileGone = await loggingOut;

        const needs = `The MCP server docs couldn't start: it needs a new login: bun run mcp login docs.\n${without('docs')}`;
        expect(whileRefused).toEqual({ ok: false, error: [needs] });
        expect(whileGone).toEqual({ ok: false, error: [needs] });
    });

    test("tokens that can't be read while another run holds the lease", async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        const [saved] = await rowsOf(guard.server.url);
        await takeRefreshLease(store, {
            id: Number(saved?.id),
            seen: 'rt1',
            owner: 'other',
            leaseMs: 10 * MINUTE,
        });
        const connecting = runOf('run-a').connect([rowOf(guard.server.url)]);
        await new Promise((resolve) => {
            setTimeout(resolve, 300);
        });

        await sql(`UPDATE credential SET tokens = '{"token_type":"Bearer"}'`);
        const connected = await connecting;

        expect(connected).toEqual({
            ok: false,
            error: [
                `The MCP server docs couldn't start: it needs a new login: bun run mcp login docs.\n${without('docs')}`,
            ],
        });
    });

    test('a revoked grant: marked, the run fails naming the login, and a later run fails before any request', async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        guard.auth.answerTokens('refuse');

        const first = await problemsOf(runOf('run-a'), guard.server.url);
        const [row] = await rowsOf(guard.server.url);
        const requests = [guard.auth.requests.length, guard.server.requests.length];
        const later = await problemsOf(runOf('run-b'), guard.server.url);

        expect(first).toEqual([
            `The MCP server docs couldn't start: its login was refused when refreshed, so it needs a new login: bun run mcp login docs.\n${without('docs')}`,
        ]);
        expect(row).toMatchObject({ needsLogin: true, leaseOwner: null });
        expect(later).toEqual([
            `The MCP server docs can't start. Its login was refused when refreshed, so it needs a new login: bun run mcp login docs. ${without('docs')}`,
        ]);
        expect([guard.auth.requests.length, guard.server.requests.length]).toEqual(requests);
    });

    test('a revoked grant during the session: the call fails, naming the login', async () => {
        const guard = await guarded();
        await saveLogin(guard);
        const handlers = await handlersOf(runOf('run-a'), guard.server.url);
        guard.auth.expire('at1');
        guard.auth.answerTokens('refuse');

        const outcome = await handlers[0]?.invoke('{}');

        expect(outcome).toEqual({
            ok: false,
            error: 'The call to search on the MCP server docs failed: its login was refused when refreshed, so it needs a new login: bun run mcp login docs',
        });
    });

    test("an authorization server that doesn't answer: the tokens stay, unmarked", async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        guard.auth.answerTokens('hang');
        const connecting = runOf('run-a').connect([rowOf(guard.server.url)]);
        await until(() => guard.auth.tokenRequests.length > 0);

        await vi.advanceTimersByTimeAsync(25_000);
        const connected = await connecting;
        const [row] = await rowsOf(guard.server.url);

        expect(connected).toEqual({
            ok: false,
            error: [
                `The MCP server docs couldn't start: its login couldn't be refreshed: the authorization server didn't answer within 25 seconds.\n${without('docs')}`,
            ],
        });
        expect(row).toMatchObject({ needsLogin: false, leaseOwner: null });
        expect(Object(row?.tokens).access_token).toBe('at1');
    });

    test('a server error from the authorization server: the tokens stay, unmarked', async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        guard.auth.answerTokens('fail');

        const problems = await problemsOf(runOf('run-a'), guard.server.url);
        const [row] = await rowsOf(guard.server.url);

        expect(problems).toEqual([
            expect.stringMatching(
                /^The MCP server docs couldn't start: its login couldn't be refreshed: HTTP 500: .*given \[redacted\]\./,
            ),
        ]);
        expect(problems.join()).not.toContain('rt1');
        expect(row).toMatchObject({ needsLogin: false, leaseOwner: null });
        expect(Object(row?.tokens).access_token).toBe('at1');
    });

    test('a refresh that ends leaves no timer behind', async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        const setTimer = vi.spyOn(globalThis, 'setTimeout');
        const clearTimer = vi.spyOn(globalThis, 'clearTimeout');

        await handlersOf(runOf('run-a'), guard.server.url);
        const refreshing = setTimer.mock.calls.findIndex(([, ms]) => ms === 25_000);

        expect(refreshing).not.toBe(-1);
        // By identity: on Bun, timers have no fields, so any two are deeply equal.
        expect(clearTimer.mock.calls.map(([handle]) => handle)).toContain(
            setTimer.mock.results[refreshing]?.value,
        );
    });

    test('a 401 with no refresh token', async () => {
        const guard = await guarded();
        await saveLogin(guard, { refreshToken: null });
        guard.auth.expire('at1');

        const problems = await problemsOf(runOf('run-a'), guard.server.url);

        expect(problems).toEqual([
            `The MCP server docs couldn't start: its login has no refresh token, so it can't be refreshed: log in again with bun run mcp login docs.\n${without('docs')}`,
        ]);
    });

    test('a token refused even after a refresh', async () => {
        const guard = await guarded({}, (request) => {
            return request.url.startsWith('/.well-known')
                ? undefined
                : new Response('No.', { status: 401 });
        });
        await saveLogin(guard);

        const problems = await problemsOf(runOf('run-a'), guard.server.url);

        expect(problems).toEqual([
            `The MCP server docs couldn't start: it refused its login's token even after a refresh: log in again with bun run mcp login docs.\n${without('docs')}`,
        ]);
        expect(refreshes(guard.auth)).toHaveLength(1);
    });

    test('a token in an error, the refreshed one too, appears in no record', async () => {
        let failing = false;
        const guard = await guarded({}, (request) => {
            return failing && request.method === 'POST'
                ? new Response(`Broken for ${request.headers.authorization}`, { status: 500 })
                : undefined;
        });
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        const handlers = await handlersOf(runOf('run-a'), guard.server.url);
        failing = true;

        const outcome = await handlers[0]?.invoke('{}');
        const [row] = await rowsOf(guard.server.url);
        const text = JSON.stringify([outcome, records]);

        expect(text).toContain('Broken for Bearer [redacted]');
        expect(text).not.toContain(String(Object(row?.tokens).access_token));
        expect(text).not.toContain('at1');
    });

    test('the word undefined in a result, from a login without a client secret, stays', async () => {
        const auth = await startAuthServer();
        let url = '';
        const server = await startHttpServer({
            tools: [
                {
                    name: 'search',
                    call: () => ({
                        content: [{ type: 'text', text: 'undefined is not a function' }],
                    }),
                },
            ],
            answer: (request) => auth.guard(request, url),
        });
        url = server.url;
        cleanups.push(server.close, auth.close);
        await saveLogin({ auth, server });
        const handlers = await handlersOf(runOf('run-a'), server.url);

        const outcome = await handlers[0]?.invoke('{}');

        expect(outcome).toEqual({ ok: true, value: 'undefined is not a function' });
    });

    test('a token, a refresh token and a client secret in a failure to start', async () => {
        const guard = await guarded({}, (request) => {
            return request.method === 'POST'
                ? new Response('Leaked at1, rt1 and sesame.', { status: 500 })
                : undefined;
        });
        await saveLogin(guard, {
            changes: {
                client: { client_id: 'client-1', client_secret: 'sesame', issuer: 'x' },
            },
        });

        const problems = await problemsOf(runOf('run-a'), guard.server.url);

        expect(problems).toEqual([
            expect.stringContaining('Leaked [redacted], [redacted] and [redacted].'),
        ]);
    });
});

describe('Pick and read the saved login', { timeout: 20_000 }, () => {
    test('the most recently saved row of the server, by its URL as written', async () => {
        const guard = await guarded();
        await saveLogin(guard, { accessToken: 'at-old', refreshToken: 'rt-old' });
        await sql(`UPDATE credential SET issuer = 'https://old.example', updated_at = 1`);
        await saveLogin(guard, { accessToken: 'at-new', refreshToken: 'rt-new' });

        await handlersOf(runOf('run-a'), guard.server.url);

        expect(new Set(bearers(guard.server))).toEqual(new Set(['Bearer at-new']));
    });

    test("a login saved under another URL is not this server's", async () => {
        const guard = await guarded();
        await saveLogin(guard, { url: `${guard.server.url}?v=2` });

        const problems = await problemsOf(runOf('run-a'), guard.server.url);

        expect(problems).toEqual([
            `The MCP server docs couldn't start: it needs a login: bun run mcp login docs.\n${without('docs')}`,
        ]);
    });

    test.each([
        ['tokens', `json_remove(tokens, '$.access_token')`, 'tokens'],
        ['client', `json_remove(client, '$.client_id')`, 'client'],
        ['discovery', `json_remove(discovery, '$.authorizationServerUrl')`, 'discovery'],
    ])("a row whose %s can't be read fails before any request", async (_name, value, column) => {
        const guard = await guarded();
        await saveLogin(guard);
        await sql(`UPDATE credential SET ${column} = ${value}`);

        const problems = await problemsOf(runOf('run-a'), guard.server.url);

        expect(problems).toEqual([
            `The MCP server docs can't start. Its saved login can't be read, so it needs a new login: bun run mcp login docs. ${without('docs')}`,
        ]);
        expect(guard.server.requests).toEqual([]);
    });

    test("credentials that can't be listed fail the run", async () => {
        const guard = await guarded();
        await sql('DROP TABLE credential');

        const problems = await problemsOf(runOf('run-a'), guard.server.url);

        expect(problems).toEqual([
            expect.stringMatching(/^Can't find the credentials in the database at /),
        ]);
        expect(guard.server.requests).toEqual([]);
    });
});

const refuseUpdates = (when: string): Promise<unknown> => {
    return sql(
        `CREATE TRIGGER refuse BEFORE UPDATE ON credential WHEN ${when} BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );
};

describe("The store's failures during a refresh", { timeout: 20_000 }, () => {
    test("a lease that can't be taken", async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        await refuseUpdates('NEW.lease_owner IS NOT NULL');

        const problems = await problemsOf(runOf('run-a'), guard.server.url);

        expect(problems).toEqual([
            expect.stringMatching(
                /^The MCP server docs couldn't start: Can't take the refresh lease in the database at .*: SqliteError: refused\./,
            ),
        ]);
    });

    test("refreshed tokens that can't be saved", async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        await refuseUpdates('NEW.tokens != OLD.tokens');

        const problems = await problemsOf(runOf('run-a'), guard.server.url);

        expect(problems).toEqual([
            expect.stringMatching(
                /^The MCP server docs couldn't start: Can't save the refreshed tokens in the database at .*: SqliteError: refused\./,
            ),
        ]);
    });

    test("a refused login that can't be marked", async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        guard.auth.answerTokens('refuse');
        await refuseUpdates('NEW.needs_login = 1');

        const problems = await problemsOf(runOf('run-a'), guard.server.url);

        expect(problems).toEqual([
            expect.stringMatching(
                /^The MCP server docs couldn't start: Can't mark the credential as needing a login in the database at .*: SqliteError: refused\./,
            ),
        ]);
    });

    test("a row that can't be read while another run holds the lease", async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        const [saved] = await rowsOf(guard.server.url);
        await takeRefreshLease(store, {
            id: Number(saved?.id),
            seen: 'rt1',
            owner: 'other',
            leaseMs: 10 * MINUTE,
        });
        // Taking the lease reads no column but tokens, and listing reads them all.
        const listed = runOf('run-a').connect([rowOf(guard.server.url)]);
        await new Promise((resolve) => {
            setTimeout(resolve, 100);
        });
        await sql(`UPDATE credential SET client = 'not json'`);

        const connected = await listed;

        expect(connected).toEqual({
            ok: false,
            error: [
                expect.stringMatching(
                    /^The MCP server docs couldn't start: Can't find the credentials in the database at /,
                ),
            ],
        });
    });

    test('a login that replaced the row during the refresh: not saved over, and this run goes on', async () => {
        const guard = await guarded();
        await saveLogin(guard, { expiresAt: Date.now() + 2 * MINUTE });
        guard.auth.answerTokens('issue', 300);
        const connecting = runOf('run-a').connect([rowOf(guard.server.url)]);
        await vi.waitFor(() => {
            expect(guard.auth.tokenRequests).toHaveLength(1);
        });

        await saveLogin(guard, { accessToken: 'at-login', refreshToken: 'rt-login' });
        const connected = await connecting;
        const [row] = await rowsOf(guard.server.url);

        expect(connected.ok).toBe(true);
        expect(Object(row?.tokens).access_token).toBe('at-login');
        expect(bearers(guard.server).at(-1)).not.toBe('Bearer at-login');
        expect(bearers(guard.server).at(-1)).not.toBe('Bearer at1');
    });
});
