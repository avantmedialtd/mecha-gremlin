import { stat } from 'node:fs/promises';
import {
    type Capture,
    appendCapture,
    renderCapture,
    startCapture,
    wasCut,
} from '@mecha-gremlin/core/output';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { spawnProcess } from '@mecha-gremlin/process/spawn';

export type RunOptions = {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly graceMs: number;
    readonly pipeWaitMs: number;
    readonly captureBytes: number;
    // Aborting it kills the running command's group, and once it's aborted no command starts.
    readonly signal: AbortSignal;
};

export type RunResult = {
    readonly exitCode: number | null;
    // The name of the signal that ended bash, or null when bash exited.
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly cut: boolean;
    readonly stdout: string;
    readonly stderr: string;
};

const NOT_RUN = 'the session is stopping; the command was not run';

// Only a group above 1: a group of 0 would be the caller's own, and -1 every process the user may
// signal.
export const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
    if (!Number.isInteger(pgid) || pgid <= 1) {
        return;
    }

    try {
        process.kill(-pgid, signal);
    } catch {
        // ESRCH when the group has ended. EPERM, when all that's left is a process this user can't
        // signal, such as a setuid program, can't be helped here, and a throw from a timer would
        // end the agent's process.
    }
};

type Reading = {
    readonly done: Promise<void>;
    readonly cancel: () => Promise<void>;
    readonly capture: () => Capture;
};

const startReading = (stream: ReadableStream<Uint8Array>, limit: number): Reading => {
    const reader = stream.getReader();
    let capture = startCapture(limit);
    const read = async (): Promise<void> => {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            capture = appendCapture(capture, chunk.value);
        }
    };
    // A stream that fails ends there, and what was read before still counts.
    const done = read().catch(() => undefined);

    return {
        done,
        // Cancelling ends a pending read at once, and closes the pipe: a process still holding it
        // gets EPIPE on its next write.
        cancel: async () => {
            await reader.cancel().catch(() => undefined);
            await done;
        },
        capture: () => capture,
    };
};

export const runCommand = async (
    command: string,
    options: RunOptions,
): Promise<Result<RunResult, string>> => {
    const { cwd, env, timeoutMs, graceMs, pipeWaitMs, captureBytes, signal } = options;

    // Otherwise the spawn would fail with a message that blames bash, on either runtime.
    try {
        await stat(cwd);
    } catch {
        return err(`The working directory ${cwd} doesn't exist.`);
    }

    // After every await, right before the spawn: a call that began before the session started
    // stopping can't start a command after it.
    if (signal.aborted) {
        return err(NOT_RUN);
    }

    // A process group of its own: one signal reaches everything the command started that stayed
    // in it. Neither runtime's own timeout or maxBuffer is used: a timeout kills only bash, and
    // maxBuffer kills the command rather than cutting its output (Brief R8).
    const spawned = await spawnProcess(['bash', '-c', command], { cwd, env, detached: true });

    if (!spawned.ok) {
        return err(`bash couldn't be started: ${spawned.error}`);
    }

    const proc = spawned.value;
    const stdout = startReading(proc.stdout, captureBytes);
    const stderr = startReading(proc.stderr, captureBytes);
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const after = (ms: number, then: () => void): ReturnType<typeof setTimeout> => {
        const timer = setTimeout(then, ms);
        timers.add(timer);

        return timer;
    };
    const kill = (): void => {
        signalGroup(proc.pid, 'SIGKILL');
    };
    const grace = Promise.withResolvers<void>();
    let timedOut = false;

    signal.addEventListener('abort', kill);

    // Aborted while bash was starting.
    if (signal.aborted) {
        kill();
    }

    const timeout = after(timeoutMs, () => {
        timedOut = true;
        signalGroup(proc.pid, 'SIGTERM');
        after(graceMs, () => {
            kill();
            grace.resolve();
        });
    });

    const exit = await proc.exited;

    clearTimeout(timeout);

    // Once the timeout has fired, a child shutting down cleanly gets the whole grace, even after
    // bash has exited (Brief C3).
    if (timedOut) {
        await grace.promise;
    }

    // `exited` resolves even while a background child holds a pipe, so the readers get at most
    // the pipe wait (Brief R10).
    await Promise.race([
        Promise.all([stdout.done, stderr.done]),
        new Promise<void>((resolve) => {
            after(pipeWaitMs, resolve);
        }),
    ]);

    // Background jobs don't outlive the command.
    kill();

    // In this order: unref() frees the agent's process only once both streams are cancelled, and
    // a process that left the group may still hold a pipe.
    await Promise.all([stdout.cancel(), stderr.cancel()]);

    for (const timer of timers) {
        clearTimeout(timer);
    }

    // Once the group is empty its ID can be reused, so closing the shell later mustn't signal it.
    signal.removeEventListener('abort', kill);
    proc.unref();

    const out = stdout.capture();
    const errors = stderr.capture();

    return ok({
        exitCode: exit.exitCode,
        signal: exit.signal,
        timedOut,
        cut: wasCut(out) || wasCut(errors),
        stdout: renderCapture(out),
        stderr: renderCapture(errors),
    });
};
