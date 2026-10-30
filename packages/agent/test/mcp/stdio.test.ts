import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { type CloseLimits, createStdioTransport } from '../../src/mcp/stdio.ts';
import { listProcesses } from '../../../../test/signal-guard.ts';
import { freshRunId, isGone, stopLeftovers, track, waitUntilGone } from '../exec/processes.ts';

const FAKE = fileURLToPath(new URL('stdio-server.ts', import.meta.url));

// Short, so that a close that has to signal ends soon; the listing keeps the sweep's.
const LIMITS: CloseLimits = {
    listTimeoutMs: 10_000,
    exitWaitMs: 300,
    termWaitMs: 300,
    killWaitMs: 300,
};

const PAGES = JSON.stringify([
    { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] },
]);

let runId: string;
let cwd: string;
const closes: (() => Promise<void>)[] = [];

const CONSOLE = ['debug', 'info', 'warn', 'error', 'log'] as const;

beforeEach(async () => {
    runId = freshRunId();
    cwd = await mkdtemp(join(tmpdir(), 'mcp-stdio-'));

    for (const method of CONSOLE) {
        vi.spyOn(console, method);
    }
});

afterEach(async () => {
    await Promise.all(closes.splice(0).map((close) => close()));
    stopLeftovers();
    await rm(cwd, { recursive: true, force: true });

    // The SDK and the transport write nothing themselves.
    const written = CONSOLE.flatMap((method) => vi.mocked(console[method]).mock.calls);

    if (written.length > 0) {
        throw new Error(`The console was written to: ${JSON.stringify(written)}`);
    }
}, 20_000);

const transportFor = (
    args: readonly string[],
    env: Readonly<Record<string, string>> = {},
    limits: CloseLimits = LIMITS,
) => {
    const transport = createStdioTransport({
        program: process.execPath,
        args,
        cwd,
        env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            GREMLIN_RUN_ID: runId,
            FAKE_PAGES: PAGES,
            ...env,
        },
        parentEnv: process.env,
        limits,
    });
    closes.push(() => transport.close());

    return transport;
};

const connected = async (
    args: readonly string[],
    env: Readonly<Record<string, string>> = {},
    limits: CloseLimits = LIMITS,
) => {
    const transport = transportFor(args, env, limits);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(transport, { timeout: 10_000 });

    return { transport, client };
};

// The signals the close sent, other than signal 0, which only asks.
const signalsOf = (kill: {
    readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}) => {
    return kill.mock.calls.filter(([, signal]) => signal !== 0);
};

const pids = async (client: Client): Promise<{ server: number; child?: number }> => {
    const result = await client.callTool({ name: 'pids', arguments: {} });
    const [block] = result.content as { text: string }[];

    return JSON.parse(block?.text ?? '{}');
};

describe('The stdio transport', { timeout: 15_000 }, () => {
    test('messages each way, framed by lines', async () => {
        const { client } = await connected([FAKE]);

        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo']);
        expect(await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).toMatchObject({
            content: [{ type: 'text', text: '{"text":"hi"}' }],
        });
    });

    test("a program that cannot start fails the start, with the runtime's message", async () => {
        const transport = createStdioTransport({
            program: join(cwd, 'missing'),
            args: [],
            cwd,
            env: { PATH: '/usr/bin:/bin' },
            parentEnv: process.env,
            limits: LIMITS,
        });

        await expect(transport.start()).rejects.toThrow(/missing|ENOENT/);
        await transport.close();
        expect(transport.exit()).toBeUndefined();
    });

    test('end-of-file is enough: no signal', async () => {
        const kill = vi.spyOn(process, 'kill');
        const { transport, client } = await connected([FAKE]);
        const { server } = await pids(client);

        await transport.close();

        expect(signalsOf(kill)).toEqual([]);
        expect(transport.exit()).toEqual({ exitCode: 0, signal: null });
        expect(isGone(server)).toBe(true);
    });

    test('a server that ignores end-of-file and SIGTERM gets SIGTERM, then SIGKILL', async () => {
        const kill = vi.spyOn(process, 'kill');
        const { transport, client } = await connected([FAKE, 'stubborn']);
        const { server } = await pids(client);
        track(server);

        await transport.close();

        expect(signalsOf(kill)).toEqual([
            [-server, 'SIGTERM'],
            [-server, 'SIGKILL'],
        ]);
        expect(transport.exit()).toEqual({ exitCode: null, signal: 'SIGKILL' });
        expect(isGone(server)).toBe(true);
    });

    test('a wrapper, whose server starts a child of its own group: none is left', async () => {
        const wrapper = `'${process.execPath}' '${FAKE}' child; true`;
        const transport = createStdioTransport({
            program: '/bin/sh',
            args: ['-c', wrapper],
            cwd,
            env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                GREMLIN_RUN_ID: runId,
                FAKE_PAGES: PAGES,
            },
            parentEnv: process.env,
            limits: LIMITS,
        });
        closes.push(() => transport.close());
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(transport, { timeout: 10_000 });
        const { server, child = 0 } = await pids(client);
        track(server);
        track(child);

        await transport.close();

        expect([isGone(server), isGone(child)]).toEqual([true, true]);
    });

    test('a server that leaves soon after SIGTERM gets no SIGKILL', async () => {
        const kill = vi.spyOn(process, 'kill');
        // Far longer than the test may take: the close stops waiting once the group is empty.
        const { transport, client } = await connected(
            [FAKE, 'graceful'],
            {},
            {
                ...LIMITS,
                termWaitMs: 60_000,
            },
        );
        const { server } = await pids(client);
        track(server);

        await transport.close();

        expect(signalsOf(kill)).toEqual([[-server, 'SIGTERM']]);
        expect(transport.exit()).toEqual({ exitCode: 0, signal: null });
        expect(isGone(server)).toBe(true);
    });

    test('after SIGKILL, the close waits until every group is empty', async () => {
        const { transport, client } = await connected(
            [FAKE, 'clinging'],
            {},
            {
                ...LIMITS,
                killWaitMs: 60_000,
            },
        );
        const { server, child = 0 } = await pids(client);
        track(server);
        track(child);
        const passOn = process.kill.bind(process);
        const answers: string[] = [];
        let killed = false;
        // The child's group seems alive for three more checks after its SIGKILL.
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            killed ||= pid === -child && signal === 'SIGKILL';

            if (pid !== -child || signal !== 0 || !killed) {
                return passOn(pid, signal);
            }

            if (answers.length < 3) {
                answers.push('alive');

                return true;
            }

            try {
                passOn(pid, signal);
                answers.push('alive');
            } catch (error) {
                answers.push('empty');
                throw error;
            }

            return true;
        });

        await transport.close();

        expect(answers.slice(0, 3)).toEqual(['alive', 'alive', 'alive']);
        expect(answers.at(-1)).toBe('empty');
        expect(isGone(child)).toBe(true);
    });

    test('a server that outlives SIGKILL: the close still ends, within its limits', async () => {
        const { transport, client } = await connected([FAKE, 'stubborn']);
        const { server } = await pids(client);
        track(server);
        const passOn = process.kill.bind(process);
        let killed = false;
        let checks = 0;
        // SIGKILL never arrives, and the group then seems empty, while the server lives on.
        const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (pid === -server && signal === 'SIGKILL') {
                killed = true;

                return true;
            }

            if (pid === -server && signal === 0 && killed) {
                checks += 1;

                throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
            }

            return passOn(pid, signal);
        });

        await transport.close();

        expect(transport.exit()).toBeUndefined();
        expect(isGone(server)).toBe(false);
        // It went on checking, for the server's exit, until killWaitMs ran out.
        expect(checks).toBeGreaterThan(1);

        kill.mockRestore();
        process.kill(server, 'SIGKILL');
        await waitUntilGone(server);
    });

    test('a member of the group that outlives the server is stopped', async () => {
        const fake = `'${process.execPath}' '${FAKE}'`;
        const transport = createStdioTransport({
            program: '/bin/sh',
            args: ['-c', `${fake} idle & exec ${fake}`],
            cwd,
            env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                GREMLIN_RUN_ID: runId,
                FAKE_PAGES: PAGES,
            },
            parentEnv: process.env,
            limits: LIMITS,
        });
        closes.push(() => transport.close());
        const client = new Client({ name: 'test', version: '1.0.0' });
        await client.connect(transport, { timeout: 10_000 });
        const [member = 0] = listProcesses()
            .filter(({ text }) => text.includes(`${FAKE} idle`) && text.includes(runId))
            .map(({ pid }) => track(pid));

        await transport.close();

        expect(member).toBeGreaterThan(1);
        expect(isGone(member)).toBe(true);
    });

    test("a process outside the server's groups that holds its stdout doesn't hold the close", async () => {
        const { transport, client } = await connected([FAKE, 'orphan']);
        const { server } = await pids(client);

        await transport.close();

        expect(transport.exit()).toEqual({ exitCode: 0, signal: null });
        expect(isGone(server)).toBe(true);
    });

    test('a close before any start fires onclose once', async () => {
        const transport = transportFor([FAKE]);
        const onclose = vi.fn<() => void>();
        Object.assign(transport, { onclose });

        await transport.close();

        expect(onclose).toHaveBeenCalledOnce();
        expect(transport.exit()).toBeUndefined();
    });

    test('the close is one, shared by every caller, and fires onclose once', async () => {
        const { transport } = await connected([FAKE]);
        const onclose = vi.fn<() => void>();
        // The SDK's callbacks are properties, not events.
        Object.assign(transport, { onclose });

        const first = transport.close();
        const second = transport.close();

        expect(second).toBe(first);
        await first;
        await transport.close();
        expect(onclose).toHaveBeenCalledOnce();
    });

    test('a close while the server starts waits for it, and stops it', async () => {
        const transport = transportFor([FAKE]);

        const starting = transport.start();
        await transport.close();
        await starting;

        expect(transport.exit()).toEqual({ exitCode: 0, signal: null });
    });

    test('a server that exits on its own closes the transport', async () => {
        const { transport, client } = await connected([FAKE]);
        const onclose = new Promise<void>((resolve) => {
            const previous = transport.onclose;
            Object.assign(transport, {
                onclose: () => {
                    previous?.();
                    resolve();
                },
            });
        });

        await client.callTool({ name: 'die', arguments: {} });
        await onclose;

        await expect(client.callTool({ name: 'echo', arguments: {} })).rejects.toThrow(
            /Not connected|Connection closed/,
        );
    });

    test('a line that is JSON but not JSON-RPC is an error, and a line that is not JSON is skipped', async () => {
        const transport = transportFor([FAKE, 'noise']);
        const client = new Client({ name: 'test', version: '1.0.0' });
        const errors: Readonly<Error>[] = [];
        Object.assign(client, {
            onerror: (error: Readonly<Error>) => {
                errors.push(error);
            },
        });

        await client.connect(transport, { timeout: 10_000 });

        expect(errors.map((error) => error.message)).toEqual([
            'A line on stdout is JSON, but not a JSON-RPC message.',
        ]);
        expect((await client.listTools()).tools).toHaveLength(1);
    });

    test('a line longer than the read buffer ends the transport', async () => {
        const transport = transportFor([FAKE, 'huge']);
        const errors: Readonly<Error>[] = [];
        const closed = new Promise<void>((resolve) => {
            Object.assign(transport, {
                onclose: resolve,
                onerror: (error: Readonly<Error>) => {
                    errors.push(error);
                },
            });
        });

        await transport.start();
        await closed;

        expect(errors.map((error) => error.message)).toEqual([
            "The server's stdout can't be read any more.",
        ]);
    });
});

describe('A transport without handlers', { timeout: 15_000 }, () => {
    test('a message that no onmessage takes is dropped', async () => {
        const transport = transportFor([FAKE]);
        const errors: Readonly<Error>[] = [];
        const closed = new Promise<void>((resolve) => {
            Object.assign(transport, {
                onclose: resolve,
                onerror: (error: Readonly<Error>) => {
                    errors.push(error);
                },
            });
        });

        await transport.start();
        await transport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'die', arguments: {} },
        });
        await closed;

        expect(errors).toEqual([]);
    });

    test('a line that is JSON but not JSON-RPC, with no onerror, is skipped', async () => {
        const transport = transportFor([FAKE, 'noise']);
        const messages: unknown[] = [];
        const answered = new Promise<void>((resolve) => {
            Object.assign(transport, {
                onclose: resolve,
                onmessage: (message: unknown) => {
                    messages.push(message);
                    resolve();
                },
            });
        });

        await transport.start();
        await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
        await answered;

        expect(messages).toEqual([
            { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
        ]);
    });

    test('a line longer than the read buffer, with no onerror, still ends the transport', async () => {
        const transport = transportFor([FAKE, 'huge']);
        const closed = new Promise<string>((resolve) => {
            Object.assign(transport, { onclose: () => resolve('closed') });
        });

        await transport.start();

        expect(await closed).toBe('closed');
    });

    test('a message sent before the start goes nowhere', async () => {
        const transport = transportFor([FAKE]);

        await expect(
            transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        ).resolves.toBeUndefined();
    });
});

describe("The server's stderr", { timeout: 15_000 }, () => {
    test('a flood: it connects, and once closed, the last line is in the kept tail', async () => {
        const { transport, client } = await connected([FAKE, 'flood']);

        expect((await client.listTools()).tools).toHaveLength(1);

        await transport.close();
        const tail = transport.stderrTail();

        expect(tail.endsWith('the last line\n')).toBe(true);
        expect(new TextEncoder().encode(tail).byteLength).toBeLessThanOrEqual(8 * 1024);
        // The tail began inside the long line, so all of that line is gone.
        expect(tail).toBe('the last line\n');
    });

    test('a tail that begins at the start of a line keeps it', async () => {
        const line = `${'y'.repeat(127)}\n`;
        const transport = transportFor([FAKE, 'exit'], {
            FAKE_STDERR: `${'x'.repeat(1023)}\n${line.repeat(64)}`,
        });

        await transport.start();
        await transport.close();

        // The cut falls right after the line of x: the tail is the 64 lines of y, whole.
        expect(transport.stderrTail()).toBe(line.repeat(64));
    });

    test('a line too long for the tail leaves nothing of it', async () => {
        const transport = transportFor([FAKE, 'exit'], { FAKE_STDERR: 'z'.repeat(10_000) });

        await transport.start();
        await transport.close();

        expect(transport.stderrTail()).toBe('');
    });

    test('stderr that comes in two parts is kept whole', async () => {
        const { transport, client } = await connected([FAKE], { FAKE_STDERR: 'first\n' });
        // The first part has been read before the second is written.
        await vi.waitFor(() => {
            expect(transport.stderrTail()).toBe('first\n');
        });

        await client.callTool({ name: 'complain', arguments: {} });
        await transport.close();

        expect(transport.stderrTail()).toBe('first\nlater\n');
    });

    test('a stderr of exactly 8 KiB is kept whole', async () => {
        const text = `${'a'.repeat(8 * 1024 - 1)}\n`;
        const transport = transportFor([FAKE, 'exit'], { FAKE_STDERR: text });

        await transport.start();
        await transport.close();

        expect(transport.stderrTail()).toBe(text);
    });

    test('a short stderr, kept whole', async () => {
        const transport = transportFor([FAKE, 'exit'], { FAKE_STDERR: 'bad config\n' });

        await transport.start();
        await transport.close();

        expect(transport.stderrTail()).toBe('bad config\n');
        expect(transport.exit()).toEqual({ exitCode: 1, signal: null });
    });
});
