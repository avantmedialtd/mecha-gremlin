import { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Mock, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { commandEnv } from '../../src/exec/env.ts';
import { type RunOptions, runCommand, signalGroup } from '../../src/exec/run.ts';
import { freshRunId, helperCommand, stopLeftovers } from './processes.ts';

let dir: string;

beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'run-')));
});

afterEach(async () => {
    stopLeftovers();
    await rm(dir, { recursive: true, force: true });
});

const options = (overrides: Partial<RunOptions> = {}): RunOptions => {
    return {
        cwd: dir,
        env: commandEnv(process.env, freshRunId()),
        timeoutMs: 10_000,
        graceMs: 300,
        pipeWaitMs: 200,
        captureBytes: 1024,
        signal: new AbortController().signal,
        ...overrides,
    };
};

const failure = (code: string): Error => {
    return Object.assign(new Error(`kill ${code}`), { code });
};

describe('signalGroup', () => {
    test.each([0, 1, -5, 2.5, Number.NaN])('never signals %s', (pgid) => {
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

        signalGroup(pgid, 'SIGKILL');

        expect(kill).not.toHaveBeenCalled();
    });

    test('a group above 1', () => {
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

        signalGroup(2, 'SIGTERM');

        expect(kill).toHaveBeenCalledExactlyOnceWith(-2, 'SIGTERM');
    });

    test.each(['ESRCH', 'EPERM'])('a group it gets %s for', (code) => {
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw failure(code);
        });

        expect(() => {
            signalGroup(4321, 'SIGKILL');
        }).not.toThrow();
    });
});

// Calls `then` as soon as bash has been started, before the runner gets its subprocess.
const whenSpawned = (then: () => void): void => {
    if (typeof Bun === 'undefined') {
        const prototype = ChildProcess.prototype as unknown as {
            spawn: (...args: readonly unknown[]) => unknown;
        };
        const spawn = prototype.spawn;
        vi.spyOn(prototype, 'spawn').mockImplementation(function (
            this: unknown,
            ...args: readonly unknown[]
        ) {
            const result: unknown = Reflect.apply(spawn, this, args);
            then();

            return result;
        });
    } else {
        const spawn = Bun.spawn;
        vi.spyOn(Bun, 'spawn').mockImplementation((...args) => {
            const proc = spawn(...args);
            then();

            return proc;
        });
    }
};

describe('Stopping a command when the session stops', { timeout: 15_000 }, () => {
    test('once aborted, no command starts', async () => {
        const stopping = new AbortController();
        stopping.abort();

        const result = await runCommand('touch started', options({ signal: stopping.signal }));

        expect(result).toEqual({
            ok: false,
            error: 'the session is stopping; the command was not run',
        });
        await expect(stat(join(dir, 'started'))).rejects.toThrow('ENOENT');
    });

    test('aborting kills the running command', async () => {
        const stopping = new AbortController();
        const pending = runCommand('touch started; sleep 30', options({ signal: stopping.signal }));
        await vi.waitFor(() => stat(join(dir, 'started')), { timeout: 4000, interval: 20 });

        stopping.abort();

        expect(await pending).toMatchObject({
            ok: true,
            value: { exitCode: null, signal: 'SIGKILL', timedOut: false },
        });
    });

    test('aborted while bash is being started', async () => {
        const stopping = new AbortController();
        whenSpawned(() => {
            stopping.abort();
        });

        const result = await runCommand(
            'sleep 30',
            options({ signal: stopping.signal, timeoutMs: 1000 }),
        );

        expect(result).toMatchObject({ ok: true, value: { signal: 'SIGKILL', timedOut: false } });
    });

    test("a finished command's group isn't signalled again", async () => {
        const stopping = new AbortController();
        await runCommand('true', options({ signal: stopping.signal }));
        const kill = vi.spyOn(process, 'kill');

        stopping.abort();

        expect(kill).not.toHaveBeenCalled();
    });
});

// The subprocess's own unref(), whichever runtime started it.
const spyOnUnref = (): Mock => {
    if (typeof Bun === 'undefined') {
        return vi.spyOn(ChildProcess.prototype, 'unref');
    }

    const unref = vi.fn<() => void>();
    const spawn = Bun.spawn;
    vi.spyOn(Bun, 'spawn').mockImplementation((...args) => {
        const proc = spawn(...args);
        const own = proc.unref.bind(proc);
        vi.spyOn(proc, 'unref').mockImplementation(() => {
            unref();
            own();
        });

        return proc;
    });

    return unref;
};

describe('Handles', { timeout: 15_000 }, () => {
    test('a process outside the group holding both pipes: both are cancelled, every timer is cleared, then unref()', async () => {
        const report = join(dir, 'report');
        const setTimer = vi.spyOn(globalThis, 'setTimeout');
        const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
        const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
        const unref = spyOnUnref();

        const result = await runCommand(
            `echo started; ${helperCommand('leave', 'hold', report)}`,
            options(),
        );
        const timers = setTimer.mock.results.map((set) => set.value);
        const cleared = clearTimer.mock.calls.map(([timer]) => timer);
        const lastCleared = Math.max(...clearTimer.mock.invocationCallOrder);

        expect(result).toMatchObject({
            ok: true,
            value: { exitCode: 0, timedOut: false, stdout: expect.stringMatching(/^started\n/) },
        });
        expect(timers.length).toBeGreaterThan(0);
        expect(timers.filter((timer) => !cleared.includes(timer))).toEqual([]);
        expect(cancel).toHaveBeenCalledTimes(2);
        expect(Math.max(...cancel.mock.invocationCallOrder)).toBeLessThan(lastCleared);
        expect(unref).toHaveBeenCalledOnce();
        expect(unref.mock.invocationCallOrder[0]).toBeGreaterThan(lastCleared);
        // Both pipes are closed: the process's next writes fail.
        for (const stream of ['stdout', 'stderr']) {
            const written = await vi.waitFor(() => readFile(`${report}-${stream}`, 'utf8'), {
                timeout: 4000,
                interval: 20,
            });

            expect(written).toBe('EPIPE');
        }
    });
});
