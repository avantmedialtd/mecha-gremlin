// The stdio transport, over @mecha-gremlin/process rather than the SDK's own, which signals only
// its direct child: a server behind `sh -c`, and Playwright's Chrome, would outlive its close
// (Brief R17.3, R18.3).
import { type Exit, type Subprocess, spawnProcess } from '@mecha-gremlin/process/spawn';
import {
    type JSONRPCMessage,
    ReadBuffer,
    type Transport,
    serializeMessage,
} from '@modelcontextprotocol/client';
import type { Env } from '../config/config.ts';
import { LIST_TIMEOUT_MS, descendantGroups, signalProcess } from '../exec/sweep.ts';

export type CloseLimits = {
    /** How long the listing of the server's descendants may take. */
    readonly listTimeoutMs: number;
    /** How long the server may take to exit once its stdin has ended. */
    readonly exitWaitMs: number;
    /** How long its group may take to empty after SIGTERM. */
    readonly termWaitMs: number;
    /** How long the groups may take to empty, and the server's exit to be seen, after SIGKILL. */
    readonly killWaitMs: number;
};

// Every wait in a close is bounded, so a close takes at most about 16 seconds: the agent ignores
// signals while it finishes.
export const CLOSE_LIMITS: CloseLimits = {
    listTimeoutMs: LIST_TIMEOUT_MS,
    exitWaitMs: 2000,
    termWaitMs: 2000,
    killWaitMs: 2000,
};

export type StdioOptions = {
    /** The absolute path the command resolved to. */
    readonly program: string;
    readonly args: readonly string[];
    readonly cwd: string;
    /** The server's whole environment. */
    readonly env: Readonly<Record<string, string>>;
    /** Where to find ps, for the listing of the server's descendants. */
    readonly parentEnv: Env;
    readonly limits?: CloseLimits;
};

export type StdioTransport = Transport & {
    /** The last 8 KiB of stderr: complete only once the transport has closed, since it lags. */
    readonly stderrTail: () => string;
    /** How the server exited, once it has: undefined after a close only if it outlived SIGKILL. */
    readonly exit: () => Exit | undefined;
    /** Whether the server's stdout has reached its end, as it does when the server exits. */
    readonly ended: () => boolean;
};

const TAIL_BYTES = 8 * 1024;

const POLL_MS = 50;

const LINE_FEED = 0x0a;

type Running = {
    readonly server: Subprocess<'pipe'>;
    readonly writer: WritableStreamDefaultWriter<Uint8Array>;
    /** Cancel the stdout and stderr readers. */
    readonly cancels: readonly (() => Promise<void>)[];
};

// Signal 0 delivers nothing. On macOS a group whose only member is a zombie answers EPERM, and
// one that has gone ESRCH, so both count as empty (Brief R18.3).
const groupAlive = (group: number): boolean => {
    try {
        process.kill(-group, 0);
    } catch {
        return false;
    }

    return true;
};

const waitUntil = async (done: () => boolean, ms: number): Promise<void> => {
    const deadline = AbortSignal.timeout(ms);

    while (!deadline.aborted && !done()) {
        await new Promise((resolve) => {
            setTimeout(resolve, POLL_MS);
        });
    }
};

const within = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
    const deadline = AbortSignal.timeout(ms);

    return Promise.race([
        promise,
        new Promise<undefined>((resolve) => {
            deadline.addEventListener('abort', () => {
                resolve(undefined);
            });
        }),
    ]);
};

// The messages a read buffer holds now. A line that isn't JSON is skipped, as in the SDK's own
// transport; one that is JSON but not JSON-RPC comes as an error. Reading a message changes the
// SDK's buffer, so it can't be taken as readonly.
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
const drain = (buffer: ReadBuffer): (JSONRPCMessage | Error)[] => {
    const items: (JSONRPCMessage | Error)[] = [];

    for (;;) {
        try {
            const message = buffer.readMessage();

            if (message === null) {
                return items;
            }

            items.push(message);
        } catch {
            items.push(new Error('A line on stdout is JSON, but not a JSON-RPC message.'));
        }
    }
};

export const createStdioTransport = ({
    program,
    args,
    cwd,
    env,
    parentEnv,
    limits = CLOSE_LIMITS,
}: StdioOptions): StdioTransport => {
    let running: Running | undefined;
    let tail = new Uint8Array(0);
    // Whether the kept tail begins where a line does.
    let lineStart = true;
    let exit: Exit | undefined;
    let ended = false;
    let closing: Promise<void> | undefined;
    let closed = false;
    let reading: Promise<unknown> = Promise.resolve();
    let spawning: Promise<unknown> = Promise.resolve();

    const keep = (chunk: Uint8Array): void => {
        const joined = new Uint8Array(tail.length + chunk.length);
        joined.set(tail);
        joined.set(chunk, tail.length);
        const cut = joined.length - TAIL_BYTES;

        if (cut > 0) {
            lineStart = joined[cut - 1] === LINE_FEED;
        }

        tail = joined.slice(Math.max(cut, 0));
    };

    // Once, whichever comes first: the end of stdout, after which the server can't answer, so the
    // requests still pending fail at once, or the end of a close.
    const finish = (target: Readonly<Transport>): void => {
        if (!closed) {
            closed = true;
            target.onclose?.();
        }
    };

    const transport: StdioTransport = {
        start: async () => {
            const spawn = spawnProcess([program, ...args], {
                cwd,
                env,
                // The leader of a group of its own, which a close signals whole.
                detached: true,
                stdin: 'pipe',
            });
            spawning = spawn;
            const spawned = await spawn;

            if (!spawned.ok) {
                throw new Error(spawned.error);
            }

            const started = spawned.value;
            const stdout = started.stdout.getReader();
            const stderr = started.stderr.getReader();
            running = {
                server: started,
                writer: started.stdin.getWriter(),
                cancels: [() => stdout.cancel(), () => stderr.cancel()],
            };

            // A close waits for this only as long as its limits allow: a server can outlive
            // SIGKILL, in uninterruptible sleep.
            void (async () => {
                exit = await started.exited;
            })();

            // Always drained: unread, a synchronous writer blocks on Node, and Bun buffers it
            // without bound (Brief R18.3).
            const draining = (async () => {
                for (let chunk = await stderr.read(); !chunk.done; chunk = await stderr.read()) {
                    keep(chunk.value);
                }
            })().catch(() => undefined);

            const delivering = (async () => {
                const buffer = new ReadBuffer();

                try {
                    for (
                        let chunk = await stdout.read();
                        !chunk.done;
                        chunk = await stdout.read()
                    ) {
                        // Bun's streams and Node's Readable.toWeb give plain Uint8Arrays, in
                        // whose first chunk ReadBuffer finds no line: the handshake would stall
                        // (Brief R18.3).
                        const { buffer: bytes, byteOffset, byteLength } = chunk.value;
                        buffer.append(Buffer.from(bytes, byteOffset, byteLength));

                        for (const item of drain(buffer)) {
                            if (item instanceof Error) {
                                transport.onerror?.(item);
                            } else {
                                transport.onmessage?.(item);
                            }
                        }
                    }

                    ended = true;
                } catch {
                    // A line over the buffer's limit, as in the SDK's own transport, or a stream
                    // that failed: either way the server can't be read any more.
                    transport.onerror?.(new Error("The server's stdout can't be read any more."));
                }

                finish(transport);
            })();

            // Cancelling a reader settles its pending read at once, so both loops have ended
            // before a close's cancels resolve, and an empty list can't be told apart. The close
            // still waits for them, should a runtime settle a cancelled read later.
            // Stryker disable next-line ArrayDeclaration
            reading = Promise.all([draining, delivering]);
        },
        send: async (message) => {
            await running?.writer.write(new TextEncoder().encode(serializeMessage(message)));
        },
        // One close, whoever asks: the client starts one, unawaited, when its handshake fails.
        close: () => {
            closing ??= (async () => {
                // A close that comes while the server starts waits for it, so as to stop it.
                await spawning;

                if (running !== undefined) {
                    const { server, writer, cancels } = running;
                    const group = server.pid;
                    // Before any signal: once the server has gone, its children are reparented.
                    const listed = await descendantGroups(group, parentEnv, limits.listTimeoutMs);

                    // Not awaited: a write held by a full pipe holds the close too.
                    void writer.close().catch(() => undefined);
                    await within(server.exited, limits.exitWaitMs);

                    if (groupAlive(group)) {
                        signalProcess(-group, 'SIGTERM');
                        await waitUntil(() => !groupAlive(group), limits.termWaitMs);
                    }

                    const alive = [...new Set([group, ...listed])].filter(groupAlive);

                    for (const each of alive) {
                        signalProcess(-each, 'SIGKILL');
                    }

                    await waitUntil(
                        () => !alive.some(groupAlive) && exit !== undefined,
                        limits.killWaitMs,
                    );
                    await Promise.all(cancels.map((cancel) => cancel().catch(() => undefined)));
                    await reading;
                }

                finish(transport);
            })();

            return closing;
        },
        stderrTail: () => {
            const text = new TextDecoder().decode(tail);

            // A cut can leave part of a secret that redaction would miss.
            return lineStart ? text : text.slice(text.indexOf('\n') + 1 || text.length);
        },
        exit: () => exit,
        ended: () => ended,
    };

    return transport;
};
