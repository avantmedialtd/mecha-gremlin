import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import { runProcesses, vouchForRun } from '../../../../test/signal-guard.ts';

export const HELPER = fileURLToPath(new URL('helper.ts', import.meta.url));

// The helper as a shell command would start it.
export const helperCommand = (...args: readonly string[]): string => {
    return [process.execPath, HELPER, ...args].map((arg) => `'${arg}'`).join(' ');
};

// A test that leaves a process carrying its run ID, or calls dispose(), takes a fresh one, which
// the signal guard vouches for.
export const freshRunId = (): string => {
    const runId = randomUUID().slice(0, 8);
    vouchForRun(runId);

    return runId;
};

export type Ended = {
    readonly code: number | null;
    readonly signal: string | null;
};

export type Helper = {
    readonly child: ChildProcess;
    readonly ready: string;
    readonly ended: Promise<Ended>;
};

const tracked = new Set<number>();

// Starts the helper with the given environment, and waits until it's ready.
export const startHelper = async (
    env: Readonly<Record<string, string>>,
    ...args: readonly string[]
): Promise<Helper> => {
    const child = spawn(process.execPath, [HELPER, ...args], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    const ended = new Promise<Ended>((resolve) => {
        child.once('exit', (code, signal) => {
            resolve({ code, signal });
        });
    });

    tracked.add(Number(child.pid));

    const ready = await new Promise<string>((resolve, reject) => {
        let text = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            text += chunk;

            if (text.includes('\n')) {
                resolve(text.slice(0, text.indexOf('\n')));
            }
        });
        child.stdout.once('end', () => {
            reject(new Error(`The helper ended before printing a line: ${JSON.stringify(text)}`));
        });
    });

    return { child, ready, ended };
};

// A process the test didn't start itself, to stop after the test if it's still running.
export const track = (pid: number): number => {
    tracked.add(pid);

    return pid;
};

// A process that has exited stays a zombie until its parent reaps it, and ps prints nothing for
// one that ended after the signal 0.
export const isGone = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
    } catch (error) {
        return Object(error).code === 'ESRCH';
    }

    const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    const state = stat.stdout.trim();

    return state === '' || state.startsWith('Z');
};

export const waitUntilGone = async (pid: number): Promise<void> => {
    await vi.waitFor(
        () => {
            expect(isGone(pid), `process ${pid} has ended`).toBe(true);
        },
        { timeout: 4000, interval: 20 },
    );
};

// For afterEach: stops whatever a test left, even when the code under test failed to.
export const stopLeftovers = (): void => {
    for (const pid of new Set([...runProcesses(), ...tracked])) {
        if (isGone(pid)) {
            continue;
        }

        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // It ended in the meantime. A signal the guard refused still fails the test.
        }
    }

    tracked.clear();
};
