// A fake MCP server over stdio for the client's tests, run with process.execPath, so on Node or
// Bun. It speaks JSON-RPC by hand, so that it can send what a real server's SDK never would. Its
// behaviour comes from its mode and its environment:
// - FAKE_PAGES: the pages of tools/list, as JSON, each `{ tools, nextCursor }`; a cursor is the
//   index of the page it asks for;
// - FAKE_CAPABILITIES: what initialize announces, as JSON;
// - FAKE_RESULTS: a result, or `{ "error": … }`, for each tool by name, as JSON;
// - FAKE_STDERR: written to stderr at the start, each \n in it as a line feed, since an entry's
//   values can't hold one;
// - FAKE_EXIT: the exit code of the `exit` mode;
// - FAKE_LIST_DELAY: how long, in milliseconds, each page of tools/list takes.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Message = {
    readonly id?: number | string;
    readonly method?: string;
    readonly params?: {
        readonly name?: string;
        readonly cursor?: string;
        readonly arguments?: unknown;
    };
};

const SELF = fileURLToPath(import.meta.url);
const LIFETIME_MS = 30_000;
const [mode = 'serve'] = process.argv.slice(2);
const json = (name: string, fallback: unknown): unknown =>
    JSON.parse(process.env[name] ?? JSON.stringify(fallback));
const pages = json('FAKE_PAGES', [{ tools: [] }]) as readonly {
    readonly tools: unknown[];
    readonly nextCursor?: string;
}[];
const results = json('FAKE_RESULTS', {}) as Readonly<Record<string, unknown>>;
let child: number | undefined;

const send = (message: unknown): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
};

// Like `sleep 30`: it ends on its own if no test stops it.
const stay = (): void => {
    setTimeout(() => {
        process.exit(0);
    }, LIFETIME_MS);
};

const call = (name: string, args: unknown): unknown => {
    switch (name) {
        case 'env':
            return {
                content: [{ type: 'text', text: Object.keys(process.env).toSorted().join('\n') }],
            };
        case 'cwd':
            return { content: [{ type: 'text', text: process.cwd() }] };
        case 'registry':
            return {
                content: [
                    {
                        type: 'text',
                        text: execFileSync('npm', ['config', 'get', 'registry'], {
                            encoding: 'utf8',
                        }).trim(),
                    },
                ],
            };
        case 'argv':
            return { content: [{ type: 'text', text: JSON.stringify(process.argv.slice(3)) }] };
        case 'echo':
            return { content: [{ type: 'text', text: JSON.stringify(args) }] };
        case 'pids':
            return {
                content: [{ type: 'text', text: JSON.stringify({ server: process.pid, child }) }],
            };
        case 'die':
            setTimeout(() => process.exit(0), 10);

            return { content: [{ type: 'text', text: 'dying' }] };
        // Gone before it answers, so the call is pending when the connection closes.
        case 'crash':
            return process.exit(3);
        case 'complain':
            process.stderr.write('later\n');

            return { content: [{ type: 'text', text: 'complained' }] };
        case 'changed':
            setTimeout(
                () => send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }),
                10,
            );

            return { content: [{ type: 'text', text: 'changed' }] };
        default:
            return results[name];
    }
};

const answer = (message: Message): void => {
    const { id, method, params } = message;

    if (id === undefined || mode === 'silent' || mode === 'mute') {
        return;
    }

    if (method === 'initialize') {
        if (mode === 'refusing') {
            send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'no handshake today' } });

            return;
        }

        send({
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: '2025-11-25',
                capabilities: json('FAKE_CAPABILITIES', { tools: {} }),
                serverInfo: { name: 'fake', version: '1.0.0' },
            },
        });
    } else if (method === 'tools/list') {
        // Gone without an answer, once the handshake is done.
        if (mode === 'vanishing') {
            process.exit(4);
        }

        setTimeout(
            () => {
                // It stops reading before it answers, and leaves soon after: the request that the
                // answer brings finds its stdin closed. Destroying the stream leaves the fd open.
                if (mode === 'deserting') {
                    process.stdin.destroy();
                    closeSync(0);
                    setTimeout(() => process.exit(3), 100);
                }

                send({
                    jsonrpc: '2.0',
                    id,
                    result: pages[Number(params?.cursor ?? 0)] ?? { tools: [] },
                });
            },
            Number(process.env.FAKE_LIST_DELAY ?? 0),
        );
    } else if (method === 'tools/call') {
        const result = call(params?.name ?? '', params?.arguments);
        const failure = typeof result === 'object' && result !== null && 'error' in result;

        if (result !== 'never') {
            send(failure ? { jsonrpc: '2.0', id, ...result } : { jsonrpc: '2.0', id, result });
        }
    } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }
};

const serve = (): void => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
        buffer += chunk;

        for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            answer(JSON.parse(line) as Message);
        }
    });

    // A server leaves when its stdin ends, unless it ignores that.
    process.stdin.on('end', () => {
        if (!['stubborn', 'graceful', 'clinging', 'mute'].includes(mode)) {
            process.exit(0);
        }
    });
};

process.stderr.write((process.env.FAKE_STDERR ?? '').replaceAll('\\n', '\n'));

switch (mode) {
    case 'exit':
        process.exitCode = Number(process.env.FAKE_EXIT ?? 1);
        break;
    case 'stubborn':
        process.on('SIGTERM', () => {});
        serve();
        stay();
        break;
    // It closes its stdout at once, answers nothing, and ignores end-of-file and SIGTERM.
    case 'mute':
        process.on('SIGTERM', () => {});
        closeSync(1);
        serve();
        stay();
        break;
    // It ignores end-of-file, and takes a moment to leave on SIGTERM.
    case 'graceful':
        process.on('SIGTERM', () => {
            setTimeout(() => process.exit(0), 200);
        });
        serve();
        stay();
        break;
    // A process outside the server's descendants holds its stdout, as a daemon that forks twice
    // does: the middle one starts it, in a session of its own, and leaves at once.
    case 'orphan':
        execFileSync(process.execPath, [SELF, 'middle'], {
            stdio: ['ignore', 'inherit', 'ignore'],
        });
        serve();
        stay();
        break;
    case 'middle':
        spawn(process.execPath, [SELF, 'idle'], {
            detached: true,
            stdio: ['ignore', 'inherit', 'ignore'],
        }).unref();
        break;
    case 'flood':
        process.stderr.write(`${'x'.repeat(1024 * 1024 - 20)}\nthe last line\n`, () => {
            serve();
        });
        stay();
        break;
    // Like `child`, but the server itself ignores end-of-file and SIGTERM.
    case 'clinging': {
        process.on('SIGTERM', () => {});
        const started = spawn(process.execPath, [SELF, 'idle'], {
            detached: true,
            stdio: 'ignore',
        });
        child = started.pid;
        started.unref();
        serve();
        stay();
        break;
    }
    // A child of its own process group, which outlives this process unless it is stopped.
    case 'child': {
        const started = spawn(process.execPath, [SELF, 'idle'], {
            detached: true,
            stdio: 'ignore',
        });
        child = started.pid;
        started.unref();
        serve();
        stay();
        break;
    }
    // Lines that aren't JSON-RPC before it answers, as some servers print.
    case 'noise':
        process.stdout.write('not json\n{"hello":1}\n');
        serve();
        stay();
        break;
    // A line longer than the client's read buffer takes.
    case 'huge':
        process.stdout.write(`${'h'.repeat(11 * 1024 * 1024)}\n`);
        serve();
        stay();
        break;
    case 'idle':
        setTimeout(() => process.exit(0), LIFETIME_MS);
        break;
    default:
        serve();
        stay();
}
