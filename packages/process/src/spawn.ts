import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { Readable, type Writable } from 'node:stream';
import { type Result, err, ok } from '@mecha-gremlin/core/result';

export type Argv = readonly [program: string, ...args: string[]];

export type Stdin = 'ignore' | 'pipe';

// What the caller gets for each mode: nothing to write to, or a stream of bytes.
type Streams = {
    readonly ignore: undefined;
    readonly pipe: WritableStream<Uint8Array>;
};

export type SpawnOptions<S extends Stdin = Stdin> = {
    readonly cwd: string;
    // The whole environment: none of the caller's is added.
    readonly env: Readonly<Record<string, string>>;
    readonly detached: boolean;
    // 'ignore' gives the process an empty stdin, and 'pipe' one the caller writes.
    readonly stdin: S;
};

export type Exit = {
    readonly exitCode: number | null;
    // The name of the signal that ended the process, or its number when it has none.
    readonly signal: string | null;
};

// There's no kill(): process.kill(pid) and, for a group, process.kill(-pid) work the same with
// either implementation.
export type Subprocess<S extends Stdin = Stdin> = {
    readonly pid: number;
    // A write resolves once the pipe has taken the bytes. Once the process has exited or closed
    // its stdin, every write fails with an error whose code is EPIPE.
    readonly stdin: Streams[S];
    // Cancelling a stream closes its pipe, so the process's next write to it fails with EPIPE.
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly exited: Promise<Exit>;
    // Frees the caller only once both streams have been cancelled: unread pipes keep either
    // runtime running, unref() or not.
    readonly unref: () => void;
};

export type Spawner = <S extends Stdin>(
    argv: Argv,
    options: SpawnOptions<S>,
) => Promise<Result<Subprocess<S>, string>>;

type Globals = {
    readonly Bun?: unknown;
};

type Child = ChildProcessByStdio<Writable | null, Readable, Readable>;

type Started<S extends Stdin> = {
    readonly child: Child;
    readonly stdin: Streams[S];
};

const messageOf = (thrown: unknown): string => {
    return thrown instanceof Error ? thrown.message : String(thrown);
};

// The runtimes report a broken pipe in different ways, and some not at all: only the code is
// common.
const brokenPipe = (): Error => {
    return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
};

// Bun's FileSink takes writes after the process has exited, and drops them without an error.
const bunWriter = (sink: Bun.FileSink, exited: () => boolean): WritableStream<Uint8Array> => {
    return new WritableStream({
        write: async (chunk) => {
            if (exited()) {
                throw brokenPipe();
            }

            await sink.write(chunk);
            await sink.flush();
        },
        close: async () => {
            await sink.end();
        },
        abort: async () => {
            await sink.end();
        },
    });
};

const BUN_STDIN: {
    readonly [S in Stdin]: (
        sink: Bun.SpawnOptions.WritableToIO<S>,
        exited: () => boolean,
    ) => Streams[S];
} = {
    ignore: () => undefined,
    pipe: bunWriter,
};

export const spawnWithBun = async <S extends Stdin>(
    argv: Argv,
    { cwd, env, detached, stdin }: SpawnOptions<S>,
): Promise<Result<Subprocess<S>, string>> => {
    try {
        const proc = Bun.spawn([...argv], {
            cwd,
            env,
            detached,
            stdin,
            stdout: 'pipe',
            stderr: 'pipe',
        });

        return ok({
            pid: proc.pid,
            stdin: BUN_STDIN[stdin](
                proc.stdin,
                () => proc.exitCode !== null || proc.signalCode !== null,
            ),
            stdout: proc.stdout,
            stderr: proc.stderr,
            exited: proc.exited.then(() => ({
                exitCode: proc.exitCode,
                signal: proc.signalCode === null ? null : String(proc.signalCode),
            })),
            unref: () => {
                proc.unref();
            },
        });
    } catch (thrown) {
        return err(messageOf(thrown));
    }
};

// Node destroys the stream when the process exits, and a write then fails with
// ERR_STREAM_DESTROYED; a write after the process closed its stdin fails with EPIPE. The writer
// writes to the stream and destroys it, so it can't take the stream as readonly.
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
const nodeWriter = (stdin: Writable): WritableStream<Uint8Array> => {
    // The listener stays for the stream's whole life: an `error` event without one would be
    // thrown, and crash the caller.
    stdin.on('error', () => undefined);

    return new WritableStream({
        write: (chunk) => {
            return new Promise((resolve, reject) => {
                stdin.write(chunk, (error) => {
                    if (error) {
                        reject(brokenPipe());
                    } else {
                        resolve();
                    }
                });
            });
        },
        // end() never calls back on a destroyed stream.
        close: () => {
            return new Promise((resolve) => {
                if (stdin.destroyed) {
                    resolve();

                    return;
                }

                stdin.end(resolve);
            });
        },
        abort: () => {
            stdin.destroy();
        },
    });
};

type NodeOptions = Omit<SpawnOptions, 'stdin'>;

// spawn throws for some failures, such as a working directory that is a file, and reports the
// others through an `error` event.
const NODE_SPAWN: {
    readonly [S in Stdin]: (argv: Argv, options: NodeOptions) => Started<S>;
} = {
    ignore: ([program, ...args], { cwd, env, detached }) => {
        return {
            child: spawn(program, args, { cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'] }),
            stdin: undefined,
        };
    },
    // Without `stdio`, Node gives the process three pipes.
    pipe: ([program, ...args], { cwd, env, detached }) => {
        const child = spawn(program, args, { cwd, env, detached });

        return { child, stdin: nodeWriter(child.stdin) };
    },
};

const startChild = <S extends Stdin>(
    argv: Argv,
    options: SpawnOptions<S>,
): Result<Started<S>, string> => {
    try {
        return ok(NODE_SPAWN[options.stdin](argv, options));
    } catch (thrown) {
        return err(messageOf(thrown));
    }
};

export const spawnWithNode = async <S extends Stdin>(
    argv: Argv,
    options: SpawnOptions<S>,
): Promise<Result<Subprocess<S>, string>> => {
    const started = startChild(argv, options);

    if (!started.ok) {
        return started;
    }

    const { child, stdin } = started.value;
    // Like Bun's `exited`, `exit` comes when the process exits, before its pipes close.
    const exited = new Promise<Exit>((resolve) => {
        child.once('exit', (exitCode, signal) => {
            resolve({ exitCode, signal });
        });
    });

    return new Promise((resolve) => {
        // The listener stays for the child's whole life: an `error` event without one would be
        // thrown, and crash the caller.
        child.on('error', (error) => {
            resolve(err(messageOf(error)));
        });
        child.once('spawn', () => {
            resolve(
                ok({
                    // Set once `spawn` has fired.
                    pid: Number(child.pid),
                    stdin,
                    stdout: Readable.toWeb(child.stdout),
                    stderr: Readable.toWeb(child.stderr),
                    exited,
                    unref: () => {
                        child.unref();
                    },
                }),
            );
        });
    });
};

// A function of the global object rather than a `typeof Bun` check: tests can't hide Bun's own
// global, so they reach both branches by passing objects of their own.
export const chooseSpawner = (globals: Globals): Spawner => {
    return globals.Bun === undefined ? spawnWithNode : spawnWithBun;
};

export const spawnProcess: Spawner = chooseSpawner(globalThis);
