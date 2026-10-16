import { spawn } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { type Vouching, judge, parseListing, takeRefusals, vouchedIn } from './signal-guard.ts';

// No signal in this file reaches a process the test didn't start: the guard's decisions are
// checked on a made-up listing, and the one refusal it really makes is for a pid no system uses.
const LISTING = parseListing(
    [
        '  PID  PPID  PGID COMMAND',
        '    1     0     1 /sbin/launchd',
        '   99     1    99 node vitest',
        '  100    99    99 node worker',
        '  200   100   200 bash -c sleep 30',
        '  201   200   200 sleep 30',
        '  300     1   300 node daemon.js GREMLIN_RUN_ID=abcd1234 PATH=/usr/bin:/bin',
        '  301   300   301 chrome --headless',
        '  302     1   302 node other.js GREMLIN_RUN_ID=abcd1234-x',
        '  303     1   303 node old.js OLD_GREMLIN_RUN_ID=abcd1234',
        '  304     1   304 node last.js GREMLIN_RUN_ID=abcd1234',
        '  500     1   500 vim notes.txt',
        '  501     1   500 less notes.txt',
        '',
    ].join('\n'),
);

const vouching = (overrides: Partial<Vouching> = {}): Vouching => {
    return {
        ownPid: 100,
        parentPid: 99,
        runIds: new Set(['abcd1234']),
        spawned: new Set(),
        remembered: new Set(),
        ...overrides,
    };
};

describe('The listing', () => {
    test('skips lines without three numbers in front', () => {
        expect(LISTING.map((entry) => entry.pid)).toEqual([
            1, 99, 100, 200, 201, 300, 301, 302, 303, 304, 500, 501,
        ]);
        expect(LISTING[3]).toEqual({
            pid: 200,
            ppid: 100,
            pgid: 200,
            text: '  200   100   200 bash -c sleep 30',
        });
    });

    test("vouches for the test's descendants, tagged processes and theirs", () => {
        expect([...vouchedIn(LISTING, vouching())].toSorted((a, b) => a - b)).toEqual([
            200, 201, 300, 301, 304,
        ]);
    });
});

describe('The guard refuses', () => {
    test.each([0, -1, 1, 2.5])('%s', (pid) => {
        expect(judge(pid, LISTING, vouching())).toMatch(/would reach/);
    });

    test.each([100, 99])('the test process or its parent: %d', (pid) => {
        expect(judge(pid, LISTING, vouching({ remembered: new Set([pid]) }))).toBe(
            `process ${pid} is the test process or its parent`,
        );
    });

    test.each([302, 303, 500, 501, 12345])("a process the test can't vouch for: %d", (pid) => {
        expect(judge(pid, LISTING, vouching())).toBe(`process ${pid} isn't one the test started`);
    });

    test('the group of the test process', () => {
        expect(judge(-99, LISTING, vouching({ spawned: new Set([99]) }))).toBe(
            'process group 99 holds the test process or its parent',
        );
    });

    test("a group with a member the test can't vouch for", () => {
        expect(judge(-500, LISTING, vouching({ remembered: new Set([500]) }))).toBe(
            "process group 500 holds processes the test didn't start",
        );
    });

    test('a group with no member listed', () => {
        expect(judge(-777, LISTING, vouching())).toBe(
            "process group 777 holds processes the test didn't start",
        );
    });

    test('a real signal, without sending it', () => {
        // No system gives out a pid this high, so even a broken guard couldn't hurt anything.
        const pid = 2 ** 30;

        expect(() => process.kill(pid, 'SIGTERM')).toThrow(
            `The signal guard refused process.kill(${pid})`,
        );
        expect(takeRefusals()).toEqual([
            `process.kill(${pid}, SIGTERM): process ${pid} isn't one the test started`,
        ]);
    });
});

describe('The guard allows', () => {
    test.each([200, 201, 300, 301, 304])('a vouched process: %d', (pid) => {
        expect(judge(pid, LISTING, vouching())).toBeUndefined();
    });

    test('a group whose members are all vouched for', () => {
        expect(judge(-200, LISTING, vouching())).toBeUndefined();
    });

    test('a process remembered from an earlier listing', () => {
        expect(judge(12345, LISTING, vouching({ remembered: new Set([12345]) }))).toBeUndefined();
    });

    test('a group whose leader was spawned during the test, and its members', () => {
        const spawned = vouching({ spawned: new Set([500]) });

        expect(judge(-500, LISTING, spawned)).toBeUndefined();
        expect(judge(501, LISTING, spawned)).toBeUndefined();
    });

    test('signal 0, to anything', () => {
        expect(process.kill(process.pid, 0)).toBe(true);
    });

    test('a signal to a child of the test', async () => {
        const child = spawn('sleep', ['30'], { stdio: 'ignore' });
        const exited = new Promise((resolve) => {
            child.once('exit', (_code, signal) => resolve(signal));
        });

        process.kill(Number(child.pid), 'SIGTERM');

        expect(await exited).toBe('SIGTERM');
    });
});
