// Tests start real processes and signal them. A bug, or a Stryker mutant that widens a match,
// could aim a signal at the developer's own processes, so every signal a test sends passes this
// guard. Stryker never mutates it, and it shares no code with the server's own matching, so one
// mutant can't widen both. A refused signal is never sent, and it fails the test even when the
// code under test swallows the error.
import { ChildProcess, spawnSync } from 'node:child_process';
import { afterEach } from 'vitest';

export type Listed = {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
    readonly text: string;
};

export type Vouching = {
    readonly ownPid: number;
    readonly parentPid: number;
    readonly runIds: ReadonlySet<string>;
    readonly spawned: ReadonlySet<number>;
    readonly remembered: ReadonlySet<number>;
};

const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s/;

export const parseListing = (output: string): Listed[] => {
    return output.split('\n').flatMap((text) => {
        const match = LINE.exec(text);

        return match === null
            ? []
            : [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), text }];
    });
};

const carries = (text: string, runId: string): boolean => {
    const word = ` GREMLIN_RUN_ID=${runId}`;

    return text.includes(`${word} `) || text.endsWith(word);
};

export const vouchedIn = (listing: readonly Listed[], vouching: Vouching): Set<number> => {
    const tagged = listing.filter((entry) =>
        [...vouching.runIds].some((runId) => carries(entry.text, runId)),
    );
    const vouched = new Set(tagged.map((entry) => entry.pid));
    const parents = [vouching.ownPid, ...vouched];

    for (const parent of parents) {
        for (const entry of listing) {
            if (entry.ppid === parent && !vouched.has(entry.pid)) {
                vouched.add(entry.pid);
                parents.push(entry.pid);
            }
        }
    }

    return vouched;
};

// Returns why the signal is refused, or undefined when the test vouches for everything it reaches.
export const judge = (
    pid: number,
    listing: readonly Listed[],
    vouching: Vouching,
): string | undefined => {
    if (!Number.isInteger(pid) || pid === 0 || pid === -1 || pid === 1) {
        return `${pid} would reach the test's own process group, every process, or init`;
    }

    const { ownPid, parentPid, spawned } = vouching;
    const vouched = new Set([...vouching.remembered, ...vouchedIn(listing, vouching)]);

    if (pid > 0) {
        if (pid === ownPid || pid === parentPid) {
            return `process ${pid} is the test process or its parent`;
        }

        const group = listing.find((entry) => entry.pid === pid)?.pgid;
        const groupSpawned = group !== undefined && spawned.has(group);

        return vouched.has(pid) || spawned.has(pid) || groupSpawned
            ? undefined
            : `process ${pid} isn't one the test started`;
    }

    // On macOS a member that has been reparented hides its environment, so a group's leader,
    // spawned by this worker, vouches for every member.
    const group = -pid;
    const members = listing.filter((entry) => entry.pgid === group);

    if (members.some((member) => member.pid === ownPid || member.pid === parentPid)) {
        return `process group ${group} holds the test process or its parent`;
    }

    // A group none of whose members were listed is refused: the listing may have failed.
    const allVouched = members.length > 0 && members.every((member) => vouched.has(member.pid));

    return spawned.has(group) || allVouched
        ? undefined
        : `process group ${group} holds processes the test didn't start`;
};

const refusals: string[] = [];
// Kept for as long as this module lives, a test file's run: a command or a sweep that outlives a
// test that failed may still signal its processes during a later test. They only ever hold what
// this worker's processes started, and the run IDs its tests made up.
const runIds = new Set<string>();
const spawned = new Set<number>();
const remembered = new Set<number>();

export const vouchForRun = (runId: string): void => {
    runIds.add(runId);
};

// Tests that check a refusal take it back, so it doesn't fail them.
export const takeRefusals = (): string[] => {
    return refusals.splice(0);
};

// A fixed PATH, because tests stub PATH, and a buffer big enough for every process's environment.
export const listProcesses = (): Listed[] => {
    const ps = spawnSync('ps', ['axeww', '-o', 'pid=,ppid=,pgid=,command='], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
        maxBuffer: 256 * 1024 * 1024,
    });

    return parseListing(ps.stdout);
};

export const runProcesses = (): number[] => {
    return listProcesses()
        .filter((entry) => [...runIds].some((runId) => carries(entry.text, runId)))
        .map((entry) => entry.pid);
};

const record = (pid: number | undefined): void => {
    if (pid !== undefined) {
        spawned.add(pid);
    }
};

const kill = process.kill.bind(process);

process.kill = (pid: number, signal?: string | number): true => {
    if (signal !== 0) {
        const listing = listProcesses();
        const vouching = {
            ownPid: process.pid,
            parentPid: process.ppid,
            runIds,
            spawned,
            remembered,
        };
        const refusal = judge(pid, listing, vouching);

        // A descendant still counts once its parent has ended and it has been reparented.
        for (const vouched of vouchedIn(listing, vouching)) {
            remembered.add(vouched);
        }

        if (refusal !== undefined) {
            refusals.push(`process.kill(${pid}, ${String(signal)}): ${refusal}`);

            throw new Error(`The signal guard refused process.kill(${pid}): ${refusal}`);
        }
    }

    return kill(pid, signal);
};

// `node:child_process` starts every child through this method, on Node and on Bun.
const startChild: unknown = Reflect.get(ChildProcess.prototype, 'spawn');

if (typeof startChild === 'function') {
    Reflect.set(
        ChildProcess.prototype,
        'spawn',
        new Proxy(startChild, {
            apply: (target, child: unknown, args: readonly unknown[]): unknown => {
                const result: unknown = Reflect.apply(target, child, args);

                record(child instanceof ChildProcess ? child.pid : undefined);

                return result;
            },
        }),
    );
}

if (typeof Bun !== 'undefined') {
    Reflect.set(
        Bun,
        'spawn',
        new Proxy(Bun.spawn, {
            apply: (target, self, args) => {
                const proc = Reflect.apply(target, self, args);

                record(proc.pid);

                return proc;
            },
        }),
    );
}

// Runs after the test file's own afterEach hooks, so their signals are checked too. A refusal
// between two tests fails the later one.
afterEach(() => {
    const refused = refusals.splice(0);

    if (refused.length > 0) {
        throw new Error(`The signal guard refused signals:\n${refused.join('\n')}`);
    }
});
