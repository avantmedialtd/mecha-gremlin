import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { spawnProcess } from '@mecha-gremlin/process/spawn';
import type { Env } from '../config/config.ts';
import { copyVariables } from './env.ts';

export type ProcessEntry = {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
};

export type SweepOptions = {
    readonly graceMs: number;
    // Where to find ps.
    readonly parentEnv: Env;
    readonly listTimeoutMs?: number;
};

// A run starts a handful of processes. More matches than this means the match itself is wrong.
export const MAX_MATCHES = 32;

// Signals are ignored while the session's processes are stopped, so a ps that hangs mustn't hold
// the server for long. Reading every process's environment takes far less, even on a busy machine.
const LIST_TIMEOUT_MS = 10_000;

const POLL_MS = 50;

type Line = ProcessEntry & {
    readonly text: string;
};

const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s/;

const parseLines = (output: string): Line[] => {
    return output.split('\n').flatMap((text) => {
        const match = LINE.exec(text);

        return match === null
            ? []
            : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), text }];
    });
};

const entryOf = ({ pid, ppid, pgid }: ProcessEntry): ProcessEntry => {
    return { pid, ppid, pgid };
};

export const parseListing = (output: string): ProcessEntry[] => {
    return parseLines(output).map(entryOf);
};

// macOS hides some processes' environments, and a ps elsewhere may show none. Without this
// process's own, the run's processes couldn't be found either, and the sweep would quietly stop
// nothing.
export const checkListing = (output: string, ownPid: number): Result<void, string> => {
    const own = parseLines(output).find((line) => line.pid === ownPid);

    return own !== undefined && own.text.includes(' PATH=')
        ? ok(undefined)
        : err(
              `ps didn't show this process's environment (pid ${ownPid}), so the run's processes can't be found by their ID.`,
          );
};

// The line holds the command line and then the environment, as ps prints them: a process whose
// arguments name the run's ID matches too.
export const findRunProcesses = (output: string, runId: string): ProcessEntry[] => {
    const word = ` GREMLIN_RUN_ID=${runId}`;

    return parseLines(output)
        .filter(({ text }) => text.includes(`${word} `) || text.endsWith(word))
        .map(entryOf);
};

// Stryker activates one mutant at a time, so a mutant that widens the match can't also remove
// this guard, which has tests of its own.
export const checkMatches = (
    matches: readonly ProcessEntry[],
    ownPid: number,
    parentPid: number,
): Result<void, string> => {
    if (matches.length > MAX_MATCHES) {
        return err(
            `${matches.length} processes carry the run's ID, more than the ${MAX_MATCHES} a run is trusted to start: the match is too wide, so nothing was signalled.`,
        );
    }

    for (const { pid } of matches) {
        if (pid <= 1 || pid === ownPid || pid === parentPid) {
            return err(
                `Process ${pid} carries the run's ID, but it is process 1 or below, this process or its parent, so nothing was signalled.`,
            );
        }
    }

    return ok(undefined);
};

// Each process has one parent, so only a loop back to the starting pids could make the walk
// endless, and those are never descendants.
export const descendants = (
    listing: readonly ProcessEntry[],
    pids: readonly number[],
): ProcessEntry[] => {
    const found: ProcessEntry[] = [];
    const parents = [...pids];

    for (const parent of parents) {
        for (const entry of listing) {
            if (entry.ppid === parent && !pids.includes(entry.pid)) {
                found.push(entry);
                parents.push(entry.pid);
            }
        }
    }

    return found;
};

// The descendants whose groups go with a match killed at the end of the grace: a daemon killed
// that way would otherwise leave Chrome, which leads a group of its own and hides its environment,
// beyond any sweep. Never a group of 1 or below, nor this process's own, whatever the listing says.
export const escalation = (
    listing: readonly ProcessEntry[],
    pid: number,
    ownPid: number,
): ProcessEntry[] => {
    const ownGroup = listing.find((entry) => entry.pid === ownPid)?.pgid;

    // Without this process's own group, no group can be told apart from it.
    if (ownGroup === undefined) {
        return [];
    }

    return descendants(listing, [pid]).filter((entry) => entry.pgid > 1 && entry.pgid !== ownGroup);
};

const errorCode = (thrown: unknown): unknown => {
    return Object(thrown).code;
};

// A process that has already exited (ESRCH) or belongs to another user (EPERM) can't be part of
// the run.
const SKIPPED = new Set<unknown>(['ESRCH', 'EPERM']);

// A negative pid signals a process group.
export const signalProcess = (pid: number, signal: NodeJS.Signals): boolean => {
    try {
        process.kill(pid, signal);
    } catch (thrown) {
        if (SKIPPED.has(errorCode(thrown))) {
            return false;
        }

        throw thrown;
    }

    return true;
};

// Signal 0 delivers nothing: it fails with ESRCH once the process has ended, and with EPERM while
// another user's process runs.
export const isRunning = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
    } catch (thrown) {
        return errorCode(thrown) !== 'ESRCH';
    }

    return true;
};

const listProcesses = async (
    parentEnv: Env,
    timeoutMs: number,
): Promise<Result<string, string>> => {
    // With no locale variable passed, ps prints in the C locale.
    const spawned = await spawnProcess(['ps', 'axeww', '-o', 'pid=,ppid=,pgid=,command='], {
        // The root always exists, while a stale TMPDIR would fail the spawn with a message that
        // blames ps. '' means the current directory, which works the same while it exists.
        // Stryker disable next-line StringLiteral
        cwd: '/',
        env: copyVariables(parentEnv, ['PATH']),
        // ps lists the same processes from any group, so this can't be told apart from `true`.
        // Stryker disable next-line BooleanLiteral
        detached: false,
    });

    if (!spawned.ok) {
        return err(`ps couldn't be started: ${spawned.error}`);
    }

    const ps = spawned.value;
    const deadline = AbortSignal.timeout(timeoutMs);
    const listed = await Promise.race([
        Promise.all([new Response(ps.stdout).text(), new Response(ps.stderr).text(), ps.exited]),
        new Promise<undefined>((resolve) => {
            deadline.addEventListener('abort', () => {
                resolve(undefined);
            });
        }),
    ]);

    // This process's own child, not detached, so its pid is above 1 and no one else's.
    if (listed === undefined) {
        signalProcess(ps.pid, 'SIGKILL');

        return err(`ps didn't list the processes within ${timeoutMs / 1000} s.`);
    }

    const [stdout, stderr, exit] = listed;

    if (exit.exitCode !== 0) {
        return err(`ps failed with exit code ${exit.exitCode}: ${stderr.trim()}`);
    }

    return ok(stdout);
};

// The deadline's timer doesn't keep the server running once the processes have ended.
const waitForExit = async (pids: readonly number[], graceMs: number): Promise<void> => {
    const deadline = AbortSignal.timeout(graceMs);

    while (!deadline.aborted && pids.some((pid) => isRunning(pid))) {
        await new Promise((resolve) => {
            setTimeout(resolve, POLL_MS);
        });
    }
};

const stopRun = async (
    runId: string,
    { graceMs, parentEnv, listTimeoutMs = LIST_TIMEOUT_MS }: SweepOptions,
): Promise<Result<number, string>> => {
    const listed = await listProcesses(parentEnv, listTimeoutMs);

    if (!listed.ok) {
        return listed;
    }

    const shown = checkListing(listed.value, process.pid);

    if (!shown.ok) {
        return shown;
    }

    // One listing, taken before any signal: the descendants come from it too.
    const listing = parseListing(listed.value);
    const matches = findRunProcesses(listed.value, runId);
    const checked = checkMatches(matches, process.pid, process.ppid);

    if (!checked.ok) {
        return checked;
    }

    const stopped = matches.filter((match) => signalProcess(match.pid, 'SIGTERM'));

    await waitForExit(
        stopped.map((match) => match.pid),
        graceMs,
    );

    for (const match of stopped.filter((entry) => isRunning(entry.pid))) {
        signalProcess(match.pid, 'SIGKILL');

        const groups = escalation(listing, match.pid, process.pid)
            .filter((entry) => isRunning(entry.pid))
            .map((entry) => entry.pgid);

        for (const group of new Set(groups)) {
            signalProcess(-group, 'SIGKILL');
        }
    }

    return ok(stopped.length);
};

export const sweep = async (
    runId: string,
    options: SweepOptions,
): Promise<Result<number, string>> => {
    try {
        return await stopRun(runId, options);
    } catch (thrown) {
        return err(
            `The sweep failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        );
    }
};
