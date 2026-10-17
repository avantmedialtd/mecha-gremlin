import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { type Result, err, ok } from '@mecha-gremlin/core/result';

export type Argv = readonly [program: string, ...args: string[]];

export type SpawnOptions = {
    readonly cwd: string;
    // The whole environment: none of the caller's is added.
    readonly env: Readonly<Record<string, string>>;
    readonly detached: boolean;
};

export type Exit = {
    readonly exitCode: number | null;
    // The name of the signal that ended the process, or its number when it has none.
    readonly signal: string | null;
};

// There's no kill(): process.kill(pid) and, for a group, process.kill(-pid) work the same with
// either implementation.
export type Subprocess = {
    readonly pid: number;
    // Cancelling a stream closes its pipe, so the process's next write to it fails with EPIPE.
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    readonly exited: Promise<Exit>;
    // Frees the caller only once both streams have been cancelled: unread pipes keep either
    // runtime running, unref() or not.
    readonly unref: () => void;
};

export type Spawner = (argv: Argv, options: SpawnOptions) => Promise<Result<Subprocess, string>>;

type Globals = {
    readonly Bun?: unknown;
};

type Child = ChildProcessByStdio<null, Readable, Readable>;

const messageOf = (thrown: unknown): string => {
    return thrown instanceof Error ? thrown.message : String(thrown);
};

export const spawnWithBun = async (
    argv: Argv,
    { cwd, env, detached }: SpawnOptions,
): Promise<Result<Subprocess, string>> => {
    try {
        const proc = Bun.spawn([...argv], {
            cwd,
            env,
            detached,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });

        return ok({
            pid: proc.pid,
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

// spawn throws for some failures, such as a working directory that is a file, and reports the
// others through an `error` event.
const startChild = (argv: Argv, { cwd, env, detached }: SpawnOptions): Result<Child, string> => {
    const [program, ...args] = argv;

    try {
        return ok(spawn(program, args, { cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (thrown) {
        return err(messageOf(thrown));
    }
};

export const spawnWithNode = async (
    argv: Argv,
    options: SpawnOptions,
): Promise<Result<Subprocess, string>> => {
    const started = startChild(argv, options);

    if (!started.ok) {
        return started;
    }

    const child = started.value;
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
