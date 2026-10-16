import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Env } from '../../src/config/config.ts';
import {
    type ProcessEntry,
    MAX_MATCHES,
    checkListing,
    checkMatches,
    descendants,
    escalation,
    findRunProcesses,
    isRunning,
    parseListing,
    signalProcess,
    sweep,
} from '../../src/exec/sweep.ts';
import {
    freshRunId,
    isGone,
    startHelper,
    stopLeftovers,
    track,
    waitUntilGone,
} from './processes.ts';

// `ps axeww -o pid=,ppid=,pgid=,command=` as macOS prints it: the environment follows the command
// line, except for Apple's own binaries, such as sleep and Chrome here.
const MACOS = [
    '    1     0     1 /sbin/launchd',
    ' 3484  3482  3481 /opt/homebrew/bin/node -e setTimeout(() => {}, 3000) PATH=/usr/bin:/bin GREMLIN_RUN_ID=deadbeef HOME=/Users/example',
    ' 3485  3482  3481 /bin/sleep 3',
    ' 3490     1  3490 node /opt/homebrew/lib/node_modules/@playwright/cli/lib/daemon.js PLAYWRIGHT_CLI_SESSION=gremlin-deadbeef GREMLIN_RUN_ID=deadbeef',
    ' 3491  3490  3491 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless',
    ' 3500     1  3500 node other.js PATH=/usr/bin GREMLIN_RUN_ID=deadbeef-x',
    ' 3501     1  3501 node old.js OLD_GREMLIN_RUN_ID=deadbeef PATH=/usr/bin',
    ' 3502     1  3502 node last.js PATH=/usr/bin GREMLIN_RUN_ID=deadbeef',
    ' 3503     1  3503 node args.js --tag GREMLIN_RUN_ID=deadbeef',
    '',
].join('\n');

// The same columns as procps prints them on Linux, where sleep shows its environment too.
const PROCPS = [
    '      1       0       1 /sbin/init splash',
    '   4321    4300    4321 node -e setTimeout(() => {}, 3000) GREMLIN_RUN_ID=deadbeef PATH=/usr/local/bin:/usr/bin HOME=/home/runner',
    '   4322    4321    4321 sleep 3 GREMLIN_RUN_ID=deadbeef PATH=/usr/bin',
    '   4400       1    4400 node other.js GREMLIN_RUN_ID=deadbeef0 PATH=/usr/bin',
    '   4401       1    4401 node old.js OLD_GREMLIN_RUN_ID=deadbeef PATH=/usr/bin',
    '',
].join('\n');

const entry = (pid: number, ppid: number, pgid: number): ProcessEntry => {
    return { pid, ppid, pgid };
};

describe('findRunProcesses', () => {
    test("a macOS listing: the run's processes, by their environment or their arguments", () => {
        expect(findRunProcesses(MACOS, 'deadbeef')).toEqual([
            entry(3484, 3482, 3481),
            entry(3490, 1, 3490),
            entry(3502, 1, 3502),
            entry(3503, 1, 3503),
        ]);
    });

    test("a procps listing, with another run's ID that starts with this one", () => {
        expect(findRunProcesses(PROCPS, 'deadbeef')).toEqual([
            entry(4321, 4300, 4321),
            entry(4322, 4321, 4321),
        ]);
    });

    test("lines that don't start with three numbers", () => {
        const listing = [
            '  PID  PPID  PGID COMMAND',
            'ps: a warning 12 34 56 GREMLIN_RUN_ID=deadbeef',
            '12 34 GREMLIN_RUN_ID=deadbeef',
            '  77    1   77 node GREMLIN_RUN_ID=deadbeef',
        ].join('\n');

        expect(findRunProcesses(listing, 'deadbeef')).toEqual([entry(77, 1, 77)]);
    });

    test('no match', () => {
        expect(findRunProcesses(MACOS, 'cafebabe')).toEqual([]);
    });
});

describe('checkListing', () => {
    test("a listing that shows this process's environment", () => {
        expect(checkListing(MACOS, 3484)).toEqual({ ok: true, value: undefined });
    });

    test.each([
        ['with no environment', 3485],
        ['not listed at all', 4321],
    ])("this process's line %s", (_kind, pid) => {
        expect(checkListing(MACOS, pid)).toEqual({
            ok: false,
            error: `ps didn't show this process's environment (pid ${pid}), so the run's processes can't be found by their ID.`,
        });
    });
});

describe('parseListing', () => {
    test('every process, by pid, parent and group', () => {
        expect(parseListing(PROCPS)).toEqual([
            entry(1, 0, 1),
            entry(4321, 4300, 4321),
            entry(4322, 4321, 4321),
            entry(4400, 1, 4400),
            entry(4401, 1, 4401),
        ]);
    });
});

const matching = (...pids: readonly number[]): ProcessEntry[] => {
    return pids.map((pid) => entry(pid, 1, pid));
};

describe('checkMatches: the guard against a wide match', () => {
    test('a run of the largest size trusted', () => {
        const pids = Array.from({ length: MAX_MATCHES }, (_, n) => 1000 + n);

        expect(checkMatches(matching(...pids), 50, 40)).toEqual({ ok: true, value: undefined });
    });

    test('33 matches', () => {
        const pids = Array.from({ length: 33 }, (_, n) => 1000 + n);

        expect(checkMatches(matching(...pids), 50, 40)).toEqual({
            ok: false,
            error: "33 processes carry the run's ID, more than the 32 a run is trusted to start: the match is too wide, so nothing was signalled.",
        });
    });

    test.each([
        ['process 1', 1],
        ['process 0', 0],
        ['a negative pid', -5],
        ['this process', 50],
        ['its parent', 40],
    ])('%s', (_name, pid) => {
        expect(checkMatches(matching(1000, pid, 1001), 50, 40)).toEqual({
            ok: false,
            error: `Process ${pid} carries the run's ID, but it is process 1 or below, this process or its parent, so nothing was signalled.`,
        });
    });

    test('process 2', () => {
        expect(checkMatches(matching(2), 50, 40)).toEqual({ ok: true, value: undefined });
    });
});

describe('descendants', () => {
    const LISTING = [
        entry(1, 0, 1),
        entry(10, 1, 10),
        entry(11, 10, 10),
        entry(12, 11, 12),
        entry(13, 10, 13),
        entry(20, 1, 20),
        entry(21, 20, 20),
        entry(30, 31, 30),
        entry(31, 30, 31),
    ];

    test('children, and theirs', () => {
        expect(descendants(LISTING, [10])).toEqual([
            entry(11, 10, 10),
            entry(13, 10, 13),
            entry(12, 11, 12),
        ]);
    });

    test('of several processes', () => {
        expect(descendants(LISTING, [12, 20])).toEqual([entry(21, 20, 20)]);
    });

    test('a loop in the listing ends', () => {
        expect(descendants(LISTING, [30])).toEqual([entry(31, 30, 31)]);
    });

    test('a starting process is never a descendant', () => {
        expect(descendants(LISTING, [10, 11])).toEqual([entry(13, 10, 13), entry(12, 11, 12)]);
    });

    test('none', () => {
        expect(descendants(LISTING, [13])).toEqual([]);
    });
});

describe('escalation', () => {
    const LISTING = [
        entry(1, 0, 1),
        entry(99, 1, 99),
        entry(100, 99, 99),
        entry(300, 1, 300),
        entry(301, 300, 301),
        entry(302, 300, 99),
        entry(303, 300, 1),
        entry(304, 300, 0),
        entry(305, 301, 301),
    ];

    test("the descendants' groups, never one of 1 or below, nor this process's own", () => {
        expect(escalation(LISTING, 300, 100)).toEqual([entry(301, 300, 301), entry(305, 301, 301)]);
    });

    test("when this process isn't listed, no group is", () => {
        expect(escalation(LISTING, 300, 555)).toEqual([]);
    });
});

const failure = (code: string): Error => {
    return Object.assign(new Error(`kill ${code}`), { code });
};

describe('signalProcess', () => {
    test('signals the process', () => {
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

        expect(signalProcess(4321, 'SIGTERM')).toBe(true);
        expect(kill).toHaveBeenCalledExactlyOnceWith(4321, 'SIGTERM');
    });

    test.each(['ESRCH', 'EPERM'])('skips a process it gets %s for', (code) => {
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw failure(code);
        });

        expect(signalProcess(4321, 'SIGTERM')).toBe(false);
    });

    test('throws any other failure', () => {
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw failure('EINVAL');
        });

        expect(() => signalProcess(4321, 'SIGTERM')).toThrow('kill EINVAL');
    });
});

describe('isRunning', () => {
    test('asks with signal 0', () => {
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

        expect(isRunning(4321)).toBe(true);
        expect(kill).toHaveBeenCalledExactlyOnceWith(4321, 0);
    });

    test.each([
        ['ESRCH', false],
        ['EPERM', true],
    ])('%s', (code, running) => {
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw failure(code);
        });

        expect(isRunning(4321)).toBe(running);
    });
});

const tagged = (runId: string, ...args: readonly string[]) => {
    return startHelper({ GREMLIN_RUN_ID: runId }, ...args);
};

describe('sweep', { timeout: 15_000 }, () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'sweep-'));
    });

    afterEach(async () => {
        stopLeftovers();
        await rm(dir, { recursive: true, force: true });
    });

    // A ps of the test's own, found first on PATH.
    const fakePs = async (script: string): Promise<Env> => {
        const bin = await mkdtemp(join(dir, 'bin-'));
        await writeFile(join(bin, 'ps'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });

        return { PATH: bin };
    };

    // A listing that shows this process, with its environment, then the lines given.
    const listing = async (...lines: readonly string[]): Promise<Env> => {
        const file = join(dir, 'listing');
        const own = `${process.pid} ${process.ppid} ${process.pid} node worker.js PATH=/usr/bin:/bin`;
        await writeFile(file, `${[own, ...lines].join('\n')}\n`);

        return fakePs(`/bin/cat '${file}'`);
    };

    test('tagged processes get SIGTERM, and the sweep ends once they have', async () => {
        const runId = freshRunId();
        const first = await tagged(runId);
        const second = await tagged(runId);

        // A grace far longer than the test may take: the sweep stops waiting once they've ended.
        const result = await sweep(runId, { graceMs: 60_000, parentEnv: process.env });

        expect(result).toEqual({ ok: true, value: 2 });
        expect(await first.ended).toEqual({ code: null, signal: 'SIGTERM' });
        expect(await second.ended).toEqual({ code: null, signal: 'SIGTERM' });
    });

    test('a process that shuts down cleanly gets the time it needs', async () => {
        const runId = freshRunId();
        const report = join(dir, 'cleaned');
        const quick = await tagged(runId);
        const careful = await tagged(runId, 'cleanup', report, '300');

        const result = await sweep(runId, { graceMs: 60_000, parentEnv: process.env });

        expect(result).toEqual({ ok: true, value: 2 });
        expect(await quick.ended).toEqual({ code: null, signal: 'SIGTERM' });
        expect(await careful.ended).toEqual({ code: 0, signal: null });
        expect(await readFile(report, 'utf8')).toBe('cleaned up');
    });

    test('a process that ignores SIGTERM is killed when the grace ends', async () => {
        const runId = freshRunId();
        const stubborn = await tagged(runId, 'ignore-term');

        const result = await sweep(runId, { graceMs: 300, parentEnv: process.env });

        expect(result).toEqual({ ok: true, value: 1 });
        expect(await stubborn.ended).toEqual({ code: null, signal: 'SIGKILL' });
    });

    test("a child left behind by a killed parent, and the child's own group", async () => {
        const runId = freshRunId();
        const parent = await tagged(runId, 'child', 'ignore', 'family');
        const [child = 0, grandchild = 0] = parent.ready.split(' ').slice(1).map(Number);
        track(child);
        track(grandchild);

        const result = await sweep(runId, { graceMs: 300, parentEnv: process.env });

        expect(result).toEqual({ ok: true, value: 1 });
        expect(await parent.ended).toEqual({ code: null, signal: 'SIGKILL' });
        await waitUntilGone(child);
        await waitUntilGone(grandchild);
    });

    // Were its group signalled, the signal guard would refuse a group with nobody in it.
    test('a descendant that has already ended is left alone', async () => {
        const runId = freshRunId();
        const parent = await tagged(runId, 'child', 'ignore', 'brief', '300');
        const child = track(Number(parent.ready.split(' ')[1]));
        const kill = vi.spyOn(process, 'kill');

        const result = await sweep(runId, { graceMs: 1000, parentEnv: process.env });

        expect(result).toEqual({ ok: true, value: 1 });
        expect(await parent.ended).toEqual({ code: null, signal: 'SIGKILL' });
        expect(isGone(child)).toBe(true);
        expect(kill).not.toHaveBeenCalledWith(-child, 'SIGKILL');
    });

    test('a process that stops on SIGTERM keeps its children', async () => {
        const runId = freshRunId();
        const parent = await tagged(runId, 'child', 'exit', 'idle');
        const child = track(Number(parent.ready.split(' ')[1]));
        const kill = vi.spyOn(process, 'kill');

        const result = await sweep(runId, { graceMs: 1000, parentEnv: process.env });

        expect(result).toEqual({ ok: true, value: 1 });
        expect(await parent.ended).toEqual({ code: null, signal: 'SIGTERM' });
        expect(kill).not.toHaveBeenCalledWith(-child, 'SIGKILL');
        expect(isGone(child)).toBe(false);
    });

    test("another run's processes are left running", async () => {
        const runId = freshRunId();
        const longer = await startHelper({ GREMLIN_RUN_ID: `${runId}-x` });
        const old = await startHelper({ OLD_GREMLIN_RUN_ID: runId });

        const result = await sweep(runId, { graceMs: 300, parentEnv: process.env });

        expect(result).toEqual({ ok: true, value: 0 });
        expect(isGone(Number(longer.child.pid))).toBe(false);
        expect(isGone(Number(old.child.pid))).toBe(false);
    });

    test('nothing to stop', async () => {
        expect(await sweep(freshRunId(), { graceMs: 300, parentEnv: process.env })).toEqual({
            ok: true,
            value: 0,
        });
    });

    test('a match too wide to trust signals nothing', async () => {
        const runId = freshRunId();
        // No system gives out pids this high.
        const lines = Array.from({ length: 33 }, (_, n) => {
            const pid = 99_999_901 + n;

            return `${pid} 1 ${pid} node idle.js GREMLIN_RUN_ID=${runId}`;
        });
        const parentEnv = await listing(...lines);
        const kill = vi.spyOn(process, 'kill');

        const result = await sweep(runId, { graceMs: 300, parentEnv });

        expect(result).toEqual({
            ok: false,
            error: "33 processes carry the run's ID, more than the 32 a run is trusted to start: the match is too wide, so nothing was signalled.",
        });
        expect(kill).not.toHaveBeenCalled();
    });

    test('a match that has exited since the listing is skipped, and not counted', async () => {
        const runId = freshRunId();
        const gone = await tagged(runId);
        const pid = Number(gone.child.pid);
        process.kill(pid, 'SIGKILL');
        await gone.ended;
        const parentEnv = await listing(
            `${pid} ${process.pid} ${pid} node helper.ts GREMLIN_RUN_ID=${runId}`,
        );

        expect(await sweep(runId, { graceMs: 300, parentEnv })).toEqual({ ok: true, value: 0 });
    });

    test("ps that can't be started", async () => {
        const empty = await mkdtemp(join(dir, 'empty-'));

        expect(await sweep(freshRunId(), { graceMs: 300, parentEnv: { PATH: empty } })).toEqual({
            ok: false,
            error: expect.stringMatching(/^ps couldn't be started: .*ps/),
        });
    });

    test('ps that takes too long is stopped', async () => {
        const parentEnv = await fakePs('exec /bin/sleep 30');
        const kill = vi.spyOn(process, 'kill');

        const result = await sweep(freshRunId(), { graceMs: 300, parentEnv, listTimeoutMs: 300 });
        const [ps] = kill.mock.calls
            .filter(([, signal]) => signal === 'SIGKILL')
            .map(([pid]) => pid);

        expect(result).toEqual({ ok: false, error: "ps didn't list the processes within 0.3 s." });
        expect(ps).toBeGreaterThan(1);
        await waitUntilGone(track(Number(ps)));
    });

    test("ps that can't show environments", async () => {
        const parentEnv = await fakePs('exec /bin/ps ax -o pid=,ppid=,pgid=,command=');

        expect(await sweep(freshRunId(), { graceMs: 300, parentEnv })).toEqual({
            ok: false,
            error: `ps didn't show this process's environment (pid ${process.pid}), so the run's processes can't be found by their ID.`,
        });
    });

    test('ps that fails', async () => {
        const parentEnv = await fakePs('echo broken >&2; exit 3');

        expect(await sweep(freshRunId(), { graceMs: 300, parentEnv })).toEqual({
            ok: false,
            error: 'ps failed with exit code 3: broken',
        });
    });

    test('an unexpected failure is reported, never thrown', async () => {
        const runId = freshRunId();
        const parentEnv = await listing(`99999901 1 99999901 node idle.js GREMLIN_RUN_ID=${runId}`);
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw failure('EINVAL');
        });

        expect(await sweep(runId, { graceMs: 300, parentEnv })).toEqual({
            ok: false,
            error: 'The sweep failed: kill EINVAL',
        });
    });
});
