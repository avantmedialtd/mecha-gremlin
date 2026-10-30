import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ToolOutcome, toolJsonSchema } from '@mecha-gremlin/core/tools';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { Fields, Json, Logger } from '../../src/log/log.ts';
import { prefixOf } from '../../src/mcp/entry.ts';
import { type McpServers, createClient, createMcpServers } from '../../src/mcp/servers.ts';
import type { CloseLimits } from '../../src/mcp/stdio.ts';
import type { ToolHandler } from '../../src/tools/tool-handler.ts';
import { freshRunId, stopLeftovers } from '../exec/processes.ts';
import { runProcesses } from '../../../../test/signal-guard.ts';
import { type FakeTool, startHttpServer } from './http-server.ts';

const FAKE = fileURLToPath(new URL('stdio-server.ts', import.meta.url));

// Captured before any test stubs it: the SDK's HTTP transport looks fetch up at request time.
const realFetch = globalThis.fetch;

const LIMITS: CloseLimits = {
    listTimeoutMs: 10_000,
    exitWaitMs: 500,
    termWaitMs: 500,
    killWaitMs: 500,
};

const TIMEOUTS = { startupTimeoutMs: 10_000, toolTimeoutMs: 10_000 };

const PROXIES = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
];

type LogRecord = {
    readonly level: string;
    readonly message: string;
    readonly [field: string]: Json | undefined;
};

let runId: string;
let workDir: string;
let dataDir: string;
let records: LogRecord[];
const started: McpServers[] = [];
const cleanups: (() => Promise<void>)[] = [];

const recorder =
    (level: string) =>
    (message: string, fields: Fields = {}) => {
        records.push({ level, message, ...fields });
    };

const LOG: Logger = { info: recorder('info'), warn: recorder('warn'), error: recorder('error') };

beforeEach(async () => {
    runId = freshRunId();
    workDir = await realpath(await mkdtemp(join(tmpdir(), 'mcp-work-')));
    dataDir = await realpath(await mkdtemp(join(tmpdir(), 'mcp-data-')));
    records = [];

    // Nothing but the agent's logger may write; this one records instead.
    for (const method of ['debug', 'info', 'warn', 'error', 'log'] as const) {
        vi.spyOn(console, method);
    }

    // A request to 127.0.0.1 mustn't go through the developer's proxy (Brief R18.1).
    for (const name of PROXIES) {
        vi.stubEnv(name, undefined);
    }

    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost');
});

afterEach(async () => {
    await Promise.all(
        started.splice(0).map(async (mcp) => {
            await mcp.close();
            await mcp.removeDirectory();
        }),
    );
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    stopLeftovers();
    await rm(workDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
}, 20_000);

const consoleCalls = (): unknown[] => {
    return (['debug', 'info', 'warn', 'error', 'log'] as const).flatMap(
        (method) => vi.mocked(console[method]).mock.calls,
    );
};

const servers = (env: Readonly<Record<string, string>> = {}): McpServers => {
    const mcp = createMcpServers({
        parentEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
        runId,
        workDir,
        dataDir,
        log: LOG,
        limits: LIMITS,
    });
    started.push(mcp);

    return mcp;
};

type Stdio = {
    readonly mode?: string;
    readonly tools?: readonly unknown[];
    readonly pages?: readonly unknown[];
    readonly results?: Readonly<Record<string, unknown>>;
    readonly env?: Readonly<Record<string, string>>;
    readonly entry?: Readonly<Record<string, unknown>>;
};

const stdio = (
    name: string,
    { mode = 'serve', tools = [], pages, results = {}, env = {}, entry = {} }: Stdio = {},
) => {
    return {
        name,
        prefix: prefixOf(name),
        entry: {
            command: process.execPath,
            args: [FAKE, mode],
            // A $ in an entry's value is written $$.
            env: {
                FAKE_PAGES: JSON.stringify(pages ?? [{ tools }]).replaceAll('$', '$$$$'),
                FAKE_RESULTS: JSON.stringify(results).replaceAll('$', '$$$$'),
                ...env,
            },
            ...TIMEOUTS,
            ...entry,
        },
    };
};

const tool = (
    name: string,
    inputSchema: Readonly<Record<string, unknown>> = { type: 'object' },
) => {
    return { name, description: `The ${name} tool.`, inputSchema };
};

const handlersOf = async (
    mcp: McpServers,
    rows: Parameters<McpServers['connect']>[0],
): Promise<ToolHandler[]> => {
    const connected = await mcp.connect(rows);

    if (!connected.ok) {
        throw new Error(connected.error.join('\n'));
    }

    return connected.value;
};

const problemsOf = async (
    mcp: McpServers,
    rows: Parameters<McpServers['connect']>[0],
): Promise<string[]> => {
    const connected = await mcp.connect(rows);

    expect(connected.ok).toBe(false);

    return connected.ok ? [] : connected.error;
};

const names = (handlers: readonly ToolHandler[]): string[] => {
    return handlers.map((handler) => handler.tool.name);
};

const invoke = (
    handlers: readonly ToolHandler[],
    name: string,
    args: unknown = {},
): Promise<ToolOutcome> => {
    const handler = handlers.find((each) => each.tool.name === name);

    if (handler === undefined) {
        throw new Error(`no tool ${name}`);
    }

    return handler.invoke(JSON.stringify(args));
};

const text = (value: string) => ({ content: [{ type: 'text', text: value }] });

const hashed = (raw: string): string => {
    const hash = createHash('sha256').update(`docs\0${raw}`).digest('hex').slice(0, 8);

    return `mcp__docs__get_user_${hash}`;
};

describe('Connect every enabled server before the session', { timeout: 20_000 }, () => {
    test("two servers' tools, sorted by name, and their records in name order", async () => {
        const handlers = await handlersOf(servers(), [
            stdio('b', { tools: [tool('zeta')] }),
            stdio('a', { tools: [tool('alpha')] }),
        ]);

        expect(names(handlers)).toEqual(['mcp__a__alpha', 'mcp__b__zeta']);
        expect(handlers.map((handler) => handler.tool.strict)).toEqual([false, false]);
        expect(records.map((record) => [record.message, record.name])).toEqual([
            ['mcp server', 'a'],
            ['mcp server', 'b'],
        ]);
        expect(consoleCalls()).toEqual([]);
    });

    test('no servers: no tools, and no record', async () => {
        expect(await servers().connect([])).toEqual({ ok: true, value: [] });
        expect(records).toEqual([]);
    });

    test('an unset reference fails before any server starts', async () => {
        const mcp = servers({ OTHER: 'set' });

        const problems = await problemsOf(mcp, [
            stdio('docs', { env: { DOCS_TOKEN: '${DOCS_TOKEN}', OTHER: '${OTHER}' } }),
            stdio('other'),
        ]);

        expect(problems).toEqual([
            "The MCP server docs can't start. It refers to DOCS_TOKEN, which is unset or blank: set it in .env. To run without it: bun run mcp disable docs.",
        ]);
        expect(runProcesses()).toEqual([]);
    });

    test('every problem of every server, before any starts', async () => {
        const problems = await problemsOf(servers(), [
            stdio('a', { entry: { colour: 'blue' } }),
            stdio('b', { entry: { cwd: '/${CWD}' } }),
            stdio('c', { entry: { cwd: join(workDir, 'missing') } }),
        ]);

        expect(problems).toEqual([
            "The MCP server a can't start. The field colour isn't known. To run without it: bun run mcp disable a.",
            "The MCP server b can't start. It refers to CWD, which is unset or blank: set it in .env. To run without it: bun run mcp disable b.",
            "The MCP server c can't start. Its cwd, with its references resolved, must be an absolute path to a directory that exists. To run without it: bun run mcp disable c.",
        ]);
        expect(runProcesses()).toEqual([]);
    });

    test('a server that exits at start', async () => {
        const problems = await problemsOf(servers(), [
            stdio('docs', {
                mode: 'exit',
                env: { FAKE_STDERR: 'loading\\nbad config\\n', FAKE_EXIT: '3' },
            }),
        ]);

        expect(problems).toEqual([
            "The MCP server docs couldn't start: it exited with code 3 before it was ready.\nIts stderr ended with:\nloading\nbad config\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test('a handshake the server refuses: its error, not the exit that the close caused', async () => {
        expect(await problemsOf(servers(), [stdio('docs', { mode: 'refusing' })])).toEqual([
            "The MCP server docs couldn't start: no handshake today.\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test('a server that leaves while it lists its tools: its exit', async () => {
        expect(await problemsOf(servers(), [stdio('docs', { mode: 'vanishing' })])).toEqual([
            "The MCP server docs couldn't start: it exited with code 4 before it was ready.\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test('a server that stops reading, and then leaves: its exit', async () => {
        const pages = [{ tools: [], nextCursor: '1' }, { tools: [] }];

        expect(await problemsOf(servers(), [stdio('docs', { mode: 'deserting', pages })])).toEqual([
            "The MCP server docs couldn't start: it exited with code 3 before it was ready.\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test('a line on stdout too long to read', async () => {
        expect(await problemsOf(servers(), [stdio('docs', { mode: 'huge' })])).toEqual([
            "The MCP server docs couldn't start: Connection closed.\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test("a server that has gone, but whose exit the close doesn't see: its error", async () => {
        const passOn = process.kill.bind(process);
        const swallowed = new Set<number>();
        // SIGKILL never arrives, and its group then seems empty, while the server lives on.
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (pid < 0 && signal === 'SIGKILL') {
                swallowed.add(pid);

                return true;
            }

            if (signal === 0 && swallowed.has(pid)) {
                throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
            }

            return passOn(pid, signal);
        });

        expect(await problemsOf(servers(), [stdio('docs', { mode: 'mute' })])).toEqual([
            "The MCP server docs couldn't start: Connection closed.\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test('a server ended by a signal before it was ready', async () => {
        const killed = {
            name: 'docs',
            prefix: 'docs',
            // A $ in an entry's value is written $$: the shell gets $$, its own pid.
            entry: { command: '/bin/sh', args: ['-c', 'kill -TERM $$$$'], ...TIMEOUTS },
        };

        expect(await problemsOf(servers(), [killed])).toEqual([
            "The MCP server docs couldn't start: it was ended by SIGTERM before it was ready.\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test('a server that never answers fails at its startupTimeoutMs, and every server is closed', async () => {
        const mcp = servers();
        const connecting = mcp.connect([
            stdio('silent', { mode: 'silent', entry: { startupTimeoutMs: 1000 } }),
            stdio('fine', { tools: [tool('pids')] }),
        ]);

        const connected = await connecting;

        expect(connected).toEqual({
            ok: false,
            error: [
                "The MCP server silent couldn't start: it didn't finish starting within its startupTimeoutMs of 1000 ms.\nTo run without it: bun run mcp disable silent.",
            ],
        });
        expect(runProcesses()).toEqual([]);
    });

    test('a required tool that is missing', async () => {
        const problems = await problemsOf(servers(), [
            stdio('docs', {
                tools: [tool('fetch')],
                entry: { includeTools: ['search', 'fetch', 'read'] },
            }),
        ]);

        expect(problems).toEqual([
            "The MCP server docs couldn't start: it doesn't list search, read, which its includeTools names.\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test('a secret in stderr is redacted, longest value first', async () => {
        const problems = await problemsOf(servers({ DOCS_TOKEN: 't0k', LONGER: 't0k-and-more' }), [
            stdio('docs', {
                mode: 'exit',
                env: {
                    DOCS_TOKEN: '${DOCS_TOKEN}',
                    OTHER: '${LONGER}',
                    FAKE_STDERR: 'token t0k, and t0k-and-more\\n',
                },
            }),
        ]);

        expect(problems.join()).not.toContain('t0k');
        expect(problems.join()).toContain('token [redacted], and [redacted]');
    });

    test('a tail that begins inside a line', async () => {
        const problems = await problemsOf(servers(), [
            stdio('docs', {
                mode: 'exit',
                env: { FAKE_STDERR: `${'x'.repeat(10 * 1024)}\\nbad config\\n` },
            }),
        ]);

        expect(problems).toEqual([
            "The MCP server docs couldn't start: it exited with code 1 before it was ready.\nIts stderr ended with:\nbad config\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test('only the last ten lines of stderr', async () => {
        const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
        const problems = await problemsOf(servers(), [
            stdio('docs', {
                mode: 'exit',
                env: { FAKE_STDERR: `${lines.join('\\n')}\\n\\n  \\n` },
            }),
        ]);

        expect(problems.join().split('\n').slice(2, -1)).toEqual(lines.slice(2));
    });
});

describe('Run stdio servers in a group of their own', { timeout: 20_000 }, () => {
    test("the environment: the shell's variables, the entry's and the run's ID", async () => {
        const handlers = await handlersOf(
            servers({ HOME: '/home/x', LANG: 'C', SECRET: 'kept out', MODEL_API_KEY: 'sk-x' }),
            [stdio('docs', { tools: [tool('env')], env: { DOCS_VALUE: '1' } })],
        );

        const outcome = await invoke(handlers, 'mcp__docs__env');
        const listed = (outcome.ok ? outcome.value : '')
            .split('\n')
            .filter((name) => !['PWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING'].includes(name));

        expect(listed).toEqual([
            'CI',
            'DEBIAN_FRONTEND',
            'DOCS_VALUE',
            'FAKE_PAGES',
            'FAKE_RESULTS',
            'GIT_PAGER',
            'GIT_TERMINAL_PROMPT',
            'GREMLIN_RUN_ID',
            'HOME',
            'LANG',
            'NO_COLOR',
            'PAGER',
            'PATH',
            'TERM',
        ]);
    });

    test("the run's directory, holding only an empty node_modules, and a cwd of its own", async () => {
        const named = join(workDir, 'site');
        await mkdir(named);
        const mcp = servers();
        const handlers = await handlersOf(mcp, [
            stdio('a', { tools: [tool('cwd')] }),
            stdio('b', { tools: [tool('cwd')], entry: { cwd: named } }),
        ]);

        const [own, given] = [
            await invoke(handlers, 'mcp__a__cwd'),
            await invoke(handlers, 'mcp__b__cwd'),
        ].map((outcome) => (outcome.ok ? outcome.value : ''));
        const directory = own ?? '';

        expect(await realpath(directory)).toBe(directory);
        expect(directory.startsWith(await realpath(tmpdir()))).toBe(true);
        expect(await readdir(directory)).toEqual(['node_modules']);
        expect(await readdir(join(directory, 'node_modules'))).toEqual([]);
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        expect(given).toBe(named);

        await mcp.close();
        await mcp.removeDirectory();

        expect(existsSync(directory)).toBe(false);
    });

    test("an npm configuration above the run's directory is not read", async () => {
        const above = await mkdtemp(join(tmpdir(), 'mcp-npmrc-'));
        cleanups.push(() => rm(above, { recursive: true, force: true }));
        await writeFile(join(above, 'package.json'), '{}');
        await writeFile(join(above, '.npmrc'), 'registry=http://127.0.0.1:9/planted/\n');
        await mkdir(join(above, 'tmp'));
        vi.stubEnv('TMPDIR', join(above, 'tmp'));

        const handlers = await handlersOf(servers(), [
            stdio('docs', { tools: [tool('registry')] }),
        ]);

        expect(await invoke(handlers, 'mcp__docs__registry')).toEqual({
            ok: true,
            value: 'https://registry.npmjs.org/',
        });
    });

    test.each(['work', 'data'])('a temporary directory inside the %s folder', async (folder) => {
        const inside = join(folder === 'work' ? workDir : dataDir, 'tmp');
        await mkdir(inside);
        vi.stubEnv('TMPDIR', inside);

        const problems = await problemsOf(servers(), [stdio('docs')]);

        expect(problems).toEqual([
            `The temporary directory, ${inside}, is inside WORK_DIR or DATA_DIR, where the agent's tools could change what a stdio MCP server reads: set TMPDIR to a directory outside both.`,
        ]);
        expect(runProcesses()).toEqual([]);
    });

    test("a close while the run's directory is made starts no server", async () => {
        const mcp = servers();

        const connecting = mcp.connect([stdio('docs', { tools: [tool('x')] })]);
        await mcp.close();

        expect(await connecting).toEqual({ ok: false, error: [] });
        expect(runProcesses()).toEqual([]);
    });

    test('a temporary directory that is missing', async () => {
        vi.stubEnv('TMPDIR', join(workDir, 'missing'));

        expect(await problemsOf(servers(), [stdio('docs')])).toEqual([
            `The temporary directory, ${join(workDir, 'missing')}, doesn't exist, so stdio MCP servers can't get a directory of their own: set TMPDIR to one that does.`,
        ]);
    });

    test('relative entries in PATH are skipped', async () => {
        // A name of its own, since one decoy goes in the agent's current directory, the repository.
        const name = `fake-mcp-${randomUUID().slice(0, 8)}`;
        const bin = join(workDir, 'bin');
        const decoy = join(workDir, 'decoy');
        const here = join(process.cwd(), name);
        const launcher = `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`;
        await mkdir(bin);
        await mkdir(decoy);
        await writeFile(join(bin, name), launcher, { mode: 0o755 });

        for (const path of [join(decoy, name), here]) {
            await writeFile(path, '#!/bin/sh\necho decoy >&2\nexit 9\n', { mode: 0o755 });
            await chmod(path, 0o755);
        }

        try {
            const handlers = await handlersOf(servers(), [
                stdio('docs', {
                    tools: [tool('argv')],
                    entry: { command: name, args: ['serve', '$$5'], cwd: decoy },
                    env: { PATH: `.::${bin}:/usr/bin:/bin` },
                }),
            ]);

            // The argument as stored is $$5; the server gets $5.
            expect(await invoke(handlers, 'mcp__docs__argv')).toEqual({
                ok: true,
                value: '["$5"]',
            });
        } finally {
            await rm(here, { force: true });
        }
    });

    test('a command found in none of the absolute directories of PATH', async () => {
        expect(
            await problemsOf(servers(), [
                stdio('docs', { entry: { command: 'fake-mcp-${X}' }, env: { PATH: '.:bin' } }),
            ]),
        ).toEqual([
            "The MCP server docs can't start. It refers to X, which is unset or blank: set it in .env. To run without it: bun run mcp disable docs.",
        ]);
        expect(
            await problemsOf(servers({ X: '1' }), [
                stdio('docs', { entry: { command: 'fake-mcp-${X}' }, env: { PATH: '.:bin' } }),
            ]),
        ).toEqual([
            "The MCP server docs can't start. Its command, fake-mcp-${X}, is in none of the absolute directories of its PATH: give the command's absolute path, or set PATH in its env. To run without it: bun run mcp disable docs.",
        ]);
    });

    test('a command that resolves to a relative path', async () => {
        expect(
            await problemsOf(servers({ DIR: 'bin' }), [
                stdio('docs', { entry: { command: '${DIR}/server' } }),
            ]),
        ).toEqual([
            "The MCP server docs can't start. Its command, with its references resolved, must be an absolute path, or a name without a slash. To run without it: bun run mcp disable docs.",
        ]);
    });

    test('a cwd that resolves to a file', async () => {
        const file = join(workDir, 'file.txt');
        await writeFile(file, 'x');

        expect(
            await problemsOf(servers({ FILE: file }), [
                stdio('docs', { entry: { cwd: '${FILE}' } }),
            ]),
        ).toEqual([
            "The MCP server docs can't start. Its cwd, with its references resolved, must be an absolute path to a directory that exists. To run without it: bun run mcp disable docs.",
        ]);
    });
});

// Requests to the https origin go to the in-process server on 127.0.0.1: an entry whose header
// holds a reference may not use plain http.
const routeTo = (origin: string, target: string): void => {
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);

        return realFetch(
            url.startsWith(origin) ? `${target}${url.slice(origin.length)}` : url,
            init,
        );
    });
};

const httpServer = async (options: Parameters<typeof startHttpServer>[0] = {}) => {
    const server = await startHttpServer(options);
    cleanups.push(server.close);

    return server;
};

const ORIGIN = 'https://docs.example.test';

const httpRow = (name: string, url: string, entry: Readonly<Record<string, unknown>> = {}) => {
    return { name, prefix: prefixOf(name), entry: { url, ...TIMEOUTS, ...entry } };
};

const search: FakeTool = {
    name: 'search',
    description: 'Search the docs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    call: () => ({ content: [{ type: 'text', text: 'found' }] }),
};

describe('Reach Streamable HTTP servers with their headers', { timeout: 20_000 }, () => {
    test('a server without references, on plain http', async () => {
        const server = await httpServer({ tools: [search] });

        const handlers = await handlersOf(servers(), [httpRow('docs', server.url)]);

        expect(names(handlers)).toEqual(['mcp__docs__search']);
        expect(await invoke(handlers, 'mcp__docs__search', { query: 'x' })).toEqual({
            ok: true,
            value: 'found',
        });
        expect(records).toMatchObject([{ message: 'mcp server', name: 'docs', transport: 'http' }]);
        expect(consoleCalls()).toEqual([]);
    });

    test("servers that don't need the run's directory make none", async () => {
        const inside = join(workDir, 'tmp');
        await mkdir(inside);
        vi.stubEnv('TMPDIR', inside);
        const server = await httpServer({ tools: [search] });

        const handlers = await handlersOf(servers(), [
            stdio('own', { tools: [tool('cwd')], entry: { cwd: workDir } }),
            httpRow('docs', server.url),
        ]);

        expect(names(handlers)).toEqual(['mcp__docs__search', 'mcp__own__cwd']);
        expect(await readdir(inside)).toEqual([]);
    });

    test('a header from the environment, on every request', async () => {
        const server = await httpServer({ tools: [search] });
        routeTo(ORIGIN, server.url.replace('/mcp', ''));

        const handlers = await handlersOf(servers({ DOCS_TOKEN: ' t0k ' }), [
            httpRow('docs', `${ORIGIN}/mcp`, {
                headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
            }),
        ]);
        await invoke(handlers, 'mcp__docs__search', { query: 'x' });

        expect(server.requests.length).toBeGreaterThan(2);
        expect(server.requests.map((request) => request.headers.authorization)).toEqual(
            server.requests.map(() => 'Bearer t0k'),
        );
    });

    test('the handshake: protocol version 2025-11-25, and no capabilities', async () => {
        const server = await httpServer();

        await handlersOf(servers(), [httpRow('docs', server.url)]);

        expect(JSON.parse(server.requests[0]?.body ?? '{}')).toMatchObject({
            method: 'initialize',
            params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: { name: 'mecha-gremlin', version: '0.0.0' },
            },
        });
    });

    test('a resolved URL that breaks a rule fails before any request', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        vi.stubGlobal('fetch', fetch);

        const problems = await problemsOf(servers({ DOCS_KEY: 'a#b' }), [
            httpRow('docs', 'https://docs.example.com/mcp?key=${DOCS_KEY}'),
        ]);

        expect(problems).toEqual([
            "The MCP server docs can't start. The url, with its references resolved, has a fragment. To run without it: bun run mcp disable docs.",
        ]);
        expect(problems.join()).not.toContain('a#b');
        expect(fetch).not.toHaveBeenCalled();
    });

    test("a resolved header value that can't be sent", async () => {
        const problems = await problemsOf(servers({ DOCS_TOKEN: 'a\u0001b€' }), [
            httpRow('docs', 'https://docs.example.com/mcp', {
                headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
            }),
        ]);

        expect(problems).toEqual([
            "The MCP server docs can't start. The header Authorization, with its references resolved, holds a control character, or a character beyond U+00FF. To run without it: bun run mcp disable docs.",
        ]);
    });

    test('a server that wants a login', async () => {
        const server = await httpServer({
            answer: () => new Response('who are you?', { status: 401 }),
        });

        expect(await problemsOf(servers(), [httpRow('docs', server.url)])).toEqual([
            "The MCP server docs couldn't start: it needs a login, which isn't supported yet.\nTo run without it: bun run mcp disable docs.",
        ]);
    });

    test("a secret in an error's body, and in a tool's error", async () => {
        const failing = await httpServer({
            answer: () => new Response('broken by t0k', { status: 500 }),
        });
        routeTo(ORIGIN, failing.url.replace('/mcp', ''));
        const headers = { Authorization: 'Bearer ${DOCS_TOKEN}' };

        const problems = await problemsOf(servers({ DOCS_TOKEN: 't0k' }), [
            httpRow('docs', `${ORIGIN}/mcp`, { headers }),
        ]);
        const erring = await httpServer({
            tools: [
                {
                    ...search,
                    call: () => ({
                        isError: true,
                        content: [{ type: 'text', text: 'no t0k here' }],
                    }),
                },
            ],
        });
        routeTo(ORIGIN, erring.url.replace('/mcp', ''));
        const handlers = await handlersOf(servers({ DOCS_TOKEN: 't0k' }), [
            httpRow('docs', `${ORIGIN}/mcp`, { headers }),
        ]);
        const outcome = await invoke(handlers, 'mcp__docs__search', { query: 'x' });

        expect(problems.join()).not.toContain('t0k');
        expect(problems.join()).toContain('[redacted]');
        expect(outcome).toEqual({ ok: false, error: 'no [redacted] here' });
    });

    test('arguments its schema refuses never reach the server', async () => {
        const call = vi.fn<FakeTool['call']>(() => ({
            content: [{ type: 'text', text: 'found' }],
        }));
        const server = await httpServer({ tools: [{ ...search, call }] });
        const handlers = await handlersOf(servers(), [httpRow('docs', server.url)]);

        const outcome = await invoke(handlers, 'mcp__docs__search', { query: 1 });

        expect(outcome).toEqual({
            ok: false,
            error: expect.stringMatching(
                /^The arguments for mcp__docs__search don't match its schema:/,
            ),
        });
        expect(call).not.toHaveBeenCalled();
    });
});

describe(
    "Offer each server's tools under names every provider accepts",
    { timeout: 20_000 },
    () => {
        test('a hyphenated name, and a call that reaches the tool by its own name', async () => {
            const handlers = await handlersOf(servers(), [
                stdio('context7', {
                    tools: [tool('resolve-library-id')],
                    results: { 'resolve-library-id': text('/upstash/context7') },
                }),
            ]);

            expect(names(handlers)).toEqual(['mcp__context7__resolve_library_id']);
            expect(await invoke(handlers, 'mcp__context7__resolve_library_id')).toEqual({
                ok: true,
                value: '/upstash/context7',
            });
        });

        test('a camelCase name, and a long one, the same in every run', async () => {
            const long = `fetch_${'x'.repeat(60)}`;
            const rows = [stdio('docs', { tools: [tool('getUser'), tool(long)] })];
            const hash = createHash('sha256').update(`docs\0${long}`).digest('hex').slice(0, 8);
            const expected = `${`mcp__docs__${long}`.slice(0, 55)}_${hash}`;

            const first = names(await handlersOf(servers(), rows));
            const second = names(await handlersOf(servers(), rows));

            expect(first).toEqual([expected, 'mcp__docs__get_user']);
            expect(second).toEqual(first);
            expect(expected).toHaveLength(64);
        });

        test('two tools that would share a name both take the hashed form, and each call reaches its own', async () => {
            const handlers = await handlersOf(servers(), [
                stdio('docs', {
                    tools: [tool('get_user'), tool('getUser')],
                    results: { get_user: text('snake'), getUser: text('camel') },
                }),
            ]);
            expect(names(handlers).toSorted()).toEqual(
                [hashed('getUser'), hashed('get_user')].toSorted(),
            );
            expect(await invoke(handlers, hashed('get_user'))).toEqual({
                ok: true,
                value: 'snake',
            });
            expect(await invoke(handlers, hashed('getUser'))).toEqual({ ok: true, value: 'camel' });
        });

        test('malformed tools, and one listed twice, are dropped with warnings; the rest are offered', async () => {
            const handlers = await handlersOf(servers({ SECRET: 'kept' }), [
                stdio('docs', {
                    tools: [
                        { name: 'no-schema' },
                        { inputSchema: { type: 'object' } },
                        { name: '', inputSchema: { type: 'object' } },
                        tool('valid'),
                        { ...tool('valid'), description: 'again' },
                    ],
                }),
            ]);

            expect(names(handlers)).toEqual(['mcp__docs__valid']);
            expect(handlers[0]?.tool.description).toBe('The valid tool.');
            expect(records).toEqual([
                {
                    level: 'warn',
                    message: 'mcp tool dropped',
                    server: 'docs',
                    tool: 'no-schema',
                    reason: "it isn't a valid MCP tool, or its name is empty",
                },
                {
                    level: 'warn',
                    message: 'mcp tool dropped',
                    server: 'docs',
                    tool: undefined,
                    reason: "it isn't a valid MCP tool, or its name is empty",
                },
                {
                    level: 'warn',
                    message: 'mcp tool dropped',
                    server: 'docs',
                    tool: '',
                    reason: "it isn't a valid MCP tool, or its name is empty",
                },
                {
                    level: 'warn',
                    message: 'mcp tool dropped',
                    server: 'docs',
                    tool: 'valid',
                    reason: 'the server lists it twice, and only the first is offered',
                },
                expect.objectContaining({
                    level: 'info',
                    message: 'mcp server',
                    tools: ['mcp__docs__valid'],
                }),
            ]);
        });

        test("a dropped tool's name is redacted", async () => {
            await handlersOf(servers({ DOCS_TOKEN: 't0k' }), [
                stdio('docs', {
                    tools: [{ name: 'about-t0k' }],
                    env: { DOCS_TOKEN: '${DOCS_TOKEN}' },
                }),
            ]);

            expect(records[0]).toMatchObject({
                message: 'mcp tool dropped',
                tool: 'about-[redacted]',
            });
        });

        test('filters: exclusions, one unmatched, and then inclusions', async () => {
            const tools = [tool('a'), tool('b'), tool('c')];

            const excluded = await handlersOf(servers(), [
                stdio('docs', { tools, entry: { excludeTools: ['b', 'z'] } }),
            ]);
            const warnings = records.filter((record) => record.level === 'warn');
            const included = await handlersOf(servers(), [
                stdio('docs', { tools, entry: { includeTools: ['a', 'b'] } }),
            ]);

            expect(names(excluded)).toEqual(['mcp__docs__a', 'mcp__docs__c']);
            expect(warnings).toEqual([
                {
                    level: 'warn',
                    message: 'mcp exclusion unmatched',
                    server: 'docs',
                    tool: 'z',
                    reason: "excludeTools names it, but the server doesn't list it",
                },
            ]);
            expect(names(included)).toEqual(['mcp__docs__a', 'mcp__docs__b']);
        });

        test('a schema with a union at its root: dropped, and then required', async () => {
            const union = tool('either', {
                type: 'object',
                anyOf: [{ required: ['a'] }, { required: ['b'] }],
            });

            const handlers = await handlersOf(servers(), [
                stdio('docs', { tools: [union, tool('plain')] }),
            ]);
            const dropped = records[0];
            const problems = await problemsOf(servers(), [
                stdio('docs', { tools: [union], entry: { includeTools: ['either'] } }),
            ]);

            expect(names(handlers)).toEqual(['mcp__docs__plain']);
            expect(dropped).toEqual({
                level: 'warn',
                message: 'mcp tool dropped',
                server: 'docs',
                tool: 'either',
                reason: 'its input schema has anyOf at its root, which providers refuse',
            });
            expect(problems).toEqual([
                "The MCP server docs couldn't start: it can't offer either, which its includeTools names: its input schema has anyOf at its root, which providers refuse.\nTo run without it: bun run mcp disable docs.",
            ]);
        });

        test.each(['oneOf', 'allOf'])('%s at the root', async (keyword) => {
            await handlersOf(servers(), [
                stdio('docs', { tools: [tool('x', { type: 'object', [keyword]: [{}] })] }),
            ]);

            expect(records[0]).toMatchObject({
                reason: `its input schema has ${keyword} at its root, which providers refuse`,
            });
        });

        test("schemas the validator can't take, and nothing but records written", async () => {
            const handlers = await handlersOf(servers(), [
                stdio('docs', {
                    tools: [
                        tool('valid', { type: 'object', properties: { a: { type: 'string' } } }),
                        tool('old', {
                            $schema: 'http://json-schema.org/draft-04/schema#',
                            type: 'object',
                        }),
                        tool('formats', {
                            type: 'object',
                            properties: { a: { type: 'string', format: 'made-up' } },
                        }),
                        tool('broken', {
                            type: 'object',
                            properties: { a: { type: 'string', pattern: '(' } },
                        }),
                    ],
                }),
            ]);
            const broken = records[0];

            expect(names(handlers)).toEqual([
                'mcp__docs__formats',
                'mcp__docs__old',
                'mcp__docs__valid',
            ]);
            expect(broken).toMatchObject({
                level: 'warn',
                message: 'mcp tool dropped',
                server: 'docs',
                tool: 'broken',
                reason: expect.any(String),
            });
            expect(await invoke(handlers, 'mcp__docs__formats', { a: 'anything' })).toMatchObject({
                ok: false,
            });
            expect(consoleCalls()).toEqual([]);
        });

        test("a schema that a required tool has, which can't compile", async () => {
            const problems = await problemsOf(servers(), [
                stdio('docs', {
                    tools: [
                        tool('broken', {
                            type: 'object',
                            properties: { a: { type: 'string', pattern: '(' } },
                        }),
                    ],
                    entry: { includeTools: ['broken'] },
                }),
            ]);

            expect(problems[0]).toMatch(
                /^The MCP server docs couldn't start: it can't offer broken, which its includeTools names: /,
            );
        });

        test("a required tool's error is redacted with the rest of the failure", async () => {
            const problems = await problemsOf(servers({ DOCS_TOKEN: 't0k' }), [
                stdio('docs', {
                    tools: [
                        tool('broken', {
                            type: 'object',
                            properties: { a: { $ref: '#/definitions/t0k' } },
                        }),
                    ],
                    env: { DOCS_TOKEN: '${DOCS_TOKEN}' },
                    entry: { includeTools: ['broken'] },
                }),
            ]);

            // Ajv's own message quotes the reference, on both runtimes.
            expect(problems[0]).toContain('#/definitions/[redacted]');
            expect(problems[0]).not.toContain('t0k');
        });

        test('a patched schema is what the model is sent', async () => {
            const handlers = await handlersOf(servers(), [
                stdio('docs', {
                    tools: [
                        tool('bare', {
                            $schema: 'https://json-schema.org/draft/2020-12/schema',
                            type: 'object',
                            properties: { list: { type: 'array' }, nested: { type: 'object' } },
                        }),
                    ],
                }),
            ]);

            expect(toolJsonSchema((handlers[0] as ToolHandler).tool)).toEqual({
                type: 'object',
                properties: {
                    list: { type: 'array', items: {} },
                    nested: { type: 'object', properties: {} },
                },
            });
        });

        test('pages: every page, and a repeated cursor that stops the listing', async () => {
            const handlers = await handlersOf(servers(), [
                stdio('paged', {
                    pages: [
                        { tools: [tool('one')], nextCursor: '1' },
                        { tools: [tool('two')], nextCursor: '2' },
                        { tools: [tool('three')] },
                    ],
                }),
                stdio('looping', {
                    pages: [
                        { tools: [tool('first')], nextCursor: '1' },
                        { tools: [tool('second')], nextCursor: '1' },
                    ],
                }),
            ]);

            expect(names(handlers)).toEqual([
                'mcp__looping__first',
                'mcp__looping__second',
                'mcp__paged__one',
                'mcp__paged__three',
                'mcp__paged__two',
            ]);
        });

        test('a page whose tools are not a list fails the server', async () => {
            const problems = await problemsOf(servers(), [
                stdio('docs', { pages: [{ tools: 'none' }] }),
            ]);

            expect(problems).toEqual([
                expect.stringMatching(
                    /^The MCP server docs couldn't start: Invalid result for tools\/list: /,
                ),
            ]);
        });

        test('at most 64 pages', async () => {
            const pages = Array.from({ length: 70 }, (_, page) => ({
                tools: [tool(`t${page}`)],
                nextCursor: String(page + 1),
            }));

            const handlers = await handlersOf(servers(), [stdio('many', { pages })]);

            expect(handlers).toHaveLength(64);
        });

        test('a changed list is logged, and the tools stay as they are', async () => {
            const handlers = await handlersOf(servers(), [
                stdio('docs', { tools: [tool('changed')] }),
            ]);

            await invoke(handlers, 'mcp__docs__changed');
            await vi.waitFor(
                () => {
                    expect(records.map((record) => record.message)).toContain('mcp tools changed');
                },
                { timeout: 4000, interval: 20 },
            );

            expect(records.at(-1)).toEqual({
                level: 'info',
                message: 'mcp tools changed',
                name: 'docs',
            });
            expect(names(handlers)).toEqual(['mcp__docs__changed']);
        });

        test('a server that announces no tools is asked for none', async () => {
            const handlers = await handlersOf(servers(), [
                stdio('quiet', { tools: [tool('hidden')], env: { FAKE_CAPABILITIES: '{}' } }),
            ]);

            expect(handlers).toEqual([]);
            expect(records).toEqual([
                {
                    level: 'info',
                    message: 'mcp server',
                    name: 'quiet',
                    transport: 'stdio',
                    tools: [],
                    bytes: 2,
                    catalog: createHash('sha256').update('[]').digest('hex'),
                },
            ]);
            expect(consoleCalls()).toEqual([]);
        });
    },
);

const outcomeOf = async (result: unknown, entry: Readonly<Record<string, unknown>> = {}) => {
    const handlers = await handlersOf(servers({ DOCS_TOKEN: 't0k' }), [
        stdio('docs', {
            tools: [tool('x')],
            results: { x: result },
            env: { DOCS_TOKEN: '${DOCS_TOKEN}' },
            entry,
        }),
    ]);

    return invoke(handlers, 'mcp__docs__x');
};

describe("Return a tool's result to the model as capped text", { timeout: 20_000 }, () => {
    test.each([
        [
            'text blocks',
            {
                content: [
                    { type: 'text', text: 'a' },
                    { type: 'text', text: 'b' },
                ],
            },
            'a\nb',
        ],
        [
            'a resource link and an image',
            {
                content: [
                    {
                        type: 'resource_link',
                        name: 'doc',
                        uri: 'file:///doc.md',
                        mimeType: 'text/markdown',
                    },
                    { type: 'image', mimeType: 'image/png', data: 'A'.repeat(1000) },
                ],
            },
            '[resource link: doc file:///doc.md (text/markdown)]\n[image image/png, 1000 base64 characters, not shown]',
        ],
        [
            'a link without a type, audio, and resources',
            {
                content: [
                    { type: 'resource_link', name: 'doc', uri: 'file:///doc' },
                    { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' },
                    { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } },
                    {
                        type: 'resource',
                        resource: {
                            uri: 'file:///a.bin',
                            blob: 'AAAA',
                            mimeType: 'application/pdf',
                        },
                    },
                    { type: 'resource', resource: { uri: 'file:///b.bin', blob: 'AA' } },
                ],
            },
            '[resource link: doc file:///doc]\n[audio audio/wav, 4 base64 characters, not shown]\n[resource file:///a.txt]\nhello\n[resource application/pdf, 4 base64 characters, not shown]\n[resource, 2 base64 characters, not shown]',
        ],
        [
            'structured content beside a text block',
            { content: [{ type: 'text', text: 'the text' }], structuredContent: { a: 1 } },
            'the text',
        ],
        ['structured content alone', { content: [], structuredContent: { a: [1] } }, '{"a":[1]}'],
        [
            'structured content beside an image',
            {
                content: [{ type: 'image', mimeType: 'image/png', data: 'AA' }],
                structuredContent: 7,
            },
            '[image image/png, 2 base64 characters, not shown]\n7',
        ],
        ['nothing', { content: [] }, '(no output)'],
        ['no content at all', {}, '(no output)'],
        [
            'blocks of unknown types, and malformed ones',
            {
                content: [
                    { type: 'text', text: 'kept' },
                    { type: 'video' },
                    { type: 'text' },
                    5,
                    { kind: 'x' },
                ],
            },
            'kept\n[video block, not shown]\n[text block, not shown]\n[unknown block, not shown]\n[unknown block, not shown]',
        ],
        [
            'a secret in the result',
            { content: [{ type: 'text', text: 'got t0k' }] },
            'got [redacted]',
        ],
    ])('%s', async (_what, result, expected) => {
        expect(await outcomeOf(result)).toEqual({ ok: true, value: expected });
    });

    test('a large result, cut on a character boundary, with its full size', async () => {
        const outcome = await outcomeOf({
            content: [{ type: 'text', text: `é${'a'.repeat(102_398)}` }],
        });
        const value = outcome.ok ? outcome.value : '';
        const [shown, note] = value.split('\n');

        expect(new TextEncoder().encode(shown).byteLength).toBeLessThanOrEqual(32 * 1024);
        expect(shown).toBe(`é${'a'.repeat(32 * 1024 - 2)}`);
        expect(note).toBe(
            '[The result is 102400 bytes, so it was cut: these are its first 32768.]',
        );
    });

    test('a tool error', async () => {
        expect(
            await outcomeOf({ isError: true, content: [{ type: 'text', text: 'not found' }] }),
        ).toEqual({
            ok: false,
            error: 'not found',
        });
    });

    test('a JSON-RPC error names the server and the tool, redacted', async () => {
        expect(await outcomeOf({ error: { code: -32602, message: 'no x for t0k' } })).toEqual({
            ok: false,
            error: 'The MCP server docs refused the call to x: no x for [redacted]',
        });
    });

    test('a call that takes too long', async () => {
        expect(await outcomeOf('never', { toolTimeoutMs: 1000 })).toEqual({
            ok: false,
            error: 'The call to x on the MCP server docs took longer than its toolTimeoutMs of 1000 ms, so it was cancelled.',
        });
    });

    test('a server that died', async () => {
        const handlers = await handlersOf(servers(), [
            stdio('docs', { tools: [tool('die'), tool('x')] }),
        ]);

        await invoke(handlers, 'mcp__docs__die');
        await vi.waitFor(
            async () => {
                expect(await invoke(handlers, 'mcp__docs__x')).toEqual({
                    ok: false,
                    error: expect.stringMatching(/^The call to x on the MCP server docs failed: /),
                });
            },
            { timeout: 4000, interval: 50 },
        );
    });

    test('a call the server leaves unanswered when it dies', async () => {
        const handlers = await handlersOf(servers(), [stdio('docs', { tools: [tool('crash')] })]);

        expect(await invoke(handlers, 'mcp__docs__crash')).toEqual({
            ok: false,
            error: 'The call to crash on the MCP server docs failed: Connection closed',
        });
    });

    test('a call when closing has begun', async () => {
        const mcp = servers();
        const handlers = await handlersOf(mcp, [
            stdio('docs', { tools: [tool('x')], results: { x: 'never' } }),
        ]);

        const calling = invoke(handlers, 'mcp__docs__x');
        await mcp.close();

        expect(await calling).toEqual({
            ok: false,
            error: expect.stringMatching(/^The call to x on the MCP server docs failed: /),
        });
    });
});

describe('Log each server, and never its secrets', { timeout: 20_000 }, () => {
    test('the record', async () => {
        await handlersOf(servers(), [stdio('docs', { tools: [tool('a'), tool('b')] })]);

        expect(records).toEqual([
            {
                level: 'info',
                message: 'mcp server',
                name: 'docs',
                transport: 'stdio',
                tools: ['mcp__docs__a', 'mcp__docs__b'],
                bytes: expect.any(Number),
                catalog: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
        ]);
        expect(records[0]?.bytes).toBe(
            new TextEncoder().encode(
                JSON.stringify([
                    {
                        name: 'mcp__docs__a',
                        description: 'The a tool.',
                        parameters: { type: 'object', properties: {} },
                    },
                    {
                        name: 'mcp__docs__b',
                        description: 'The b tool.',
                        parameters: { type: 'object', properties: {} },
                    },
                ]),
            ).byteLength,
        );
    });

    test('name order, though b lists its tools first', async () => {
        await handlersOf(servers(), [
            stdio('b', { tools: [tool('x')] }),
            stdio('a', { tools: [{ name: 'broken' }, tool('x')], env: { FAKE_LIST_DELAY: '300' } }),
        ]);

        expect(records.map((record) => [record.message, record.name ?? record.server])).toEqual([
            ['mcp tool dropped', 'a'],
            ['mcp server', 'a'],
            ['mcp server', 'b'],
        ]);
    });

    test('the same catalog in two runs, and another for another list', async () => {
        await handlersOf(servers(), [stdio('docs', { tools: [tool('a')] })]);
        await handlersOf(servers(), [stdio('docs', { tools: [tool('a')] })]);
        await handlersOf(servers(), [stdio('docs', { tools: [tool('b')] })]);

        const [first, second, third] = records.map((record) => record.catalog);

        expect(second).toBe(first);
        expect(third).not.toBe(first);
        expect(first).toBe(
            createHash('sha256')
                .update(JSON.stringify([tool('a')]))
                .digest('hex'),
        );
    });
});

describe('The client each server gets', () => {
    test('a request that the server announced no capability for is refused before it is sent', async () => {
        const [ours, theirs] = InMemoryTransport.createLinkedPair();
        const server = new McpServer({ name: 'bare', version: '1.0.0' });
        await server.connect(theirs);
        const client = createClient();
        await client.connect(ours);

        await expect(
            client.request({ method: 'tools/list', params: {} }, z.looseObject({})),
        ).rejects.toThrow('Server does not support tools (required for tools/list)');
        await client.close();
        await server.close();
    });
});
