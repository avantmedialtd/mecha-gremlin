// Past the SDK's own 60-second limit, under fake timers: each request names its own timeout, so a
// server may take as long as its entry allows.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Logger } from '../../src/log/log.ts';
import { type McpServers, createMcpServers } from '../../src/mcp/servers.ts';
import { type FakeHttp, startHttpServer } from './http-server.ts';

const PROXIES = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
];

const LOG: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let folder: string;
let server: FakeHttp | undefined;
let mcp: McpServers | undefined;

const CONSOLE = ['debug', 'info', 'warn', 'error', 'log'] as const;

beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'mcp-slow-'));

    for (const method of CONSOLE) {
        vi.spyOn(console, method);
    }

    for (const name of PROXIES) {
        vi.stubEnv(name, undefined);
    }

    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost');
});

afterEach(async () => {
    vi.useRealTimers();
    await mcp?.close();
    await server?.close();
    await rm(folder, { recursive: true, force: true });

    const written = CONSOLE.flatMap((method) => vi.mocked(console[method]).mock.calls);

    if (written.length > 0) {
        throw new Error(`The console was written to: ${JSON.stringify(written)}`);
    }
});

// Real I/O goes on under fake timers; this waits for it without a timer.
const until = async (done: () => boolean): Promise<void> => {
    while (!done()) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
};

const later = (ms: number): Promise<void> => {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

const methodOf = (body: string): unknown => {
    return body === '' ? undefined : (JSON.parse(body) as { method?: unknown }).method;
};

const connect = (url: string, entry: Readonly<Record<string, unknown>>) => {
    mcp = createMcpServers({
        parentEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        runId: 'slow0000',
        workDir: folder,
        dataDir: folder,
        log: LOG,
    });

    return mcp.connect([{ name: 'docs', prefix: 'docs', entry: { url, ...entry } }]);
};

test('a slow start: answered after 61 seconds, within a startupTimeoutMs of 90000', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    server = await startHttpServer({
        answer: async ({ body }) => {
            if (methodOf(body) === 'initialize') {
                await later(61_000);
            }

            return undefined;
        },
    });
    const requests = server.requests;

    const connecting = connect(server.url, { startupTimeoutMs: 90_000, toolTimeoutMs: 120_000 });
    await until(() => requests.length > 0);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(await connecting).toEqual({ ok: true, value: [] });
});

test('a slow call: answered after 61 seconds, within a toolTimeoutMs of 90000', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    server = await startHttpServer({
        tools: [
            {
                name: 'slow',
                call: async () => {
                    await later(61_000);

                    return { content: [{ type: 'text', text: 'at last' }] };
                },
            },
        ],
    });
    const requests = server.requests;
    const connected = await connect(server.url, {
        startupTimeoutMs: 30_000,
        toolTimeoutMs: 90_000,
    });
    const [handler] = connected.ok ? connected.value : [];
    const before = requests.length;

    const calling = handler?.invoke('{}');
    await until(() => requests.length > before);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(await calling).toEqual({ ok: true, value: 'at last' });
});
