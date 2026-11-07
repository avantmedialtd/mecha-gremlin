// Runs a command, Stryker's in `bun run mutation`, and ends any process of its tree, the command
// included, whose memory passes a limit. A mutant can make a loop endless, and Stryker's hit limit
// can't end one that catches the error the limit throws: drain's in mcp/stdio.ts then pushes an
// Error each turn. Bun's heap has no limit, so such a loop grows by hundreds of megabytes a second
// until Stryker's timeout, which gives a mutant that slow tests cover minutes: two or three side by
// side took down GitHub's runner. The loop holds its test's thread, so the watch runs out here.
// Stryker restarts a test runner that ends this way and tries the mutant once more, then reports a
// runtime error, which the mutation score leaves out.
import { spawn, spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';
import { constants } from 'node:os';

export type Listed = {
    readonly pid: number;
    readonly ppid: number;
    // Resident memory in KiB, as ps gives it.
    readonly rss: number;
};

// Stryker starts a test runner per core, four on GitHub's runners, which have 16 GB. A process's
// resident memory stops growing once memory runs short, as macOS compresses it and Linux swaps it
// out, so four at the limit have to leave plenty to spare.
export const DEFAULT_LIMIT_MIB = 2048;

// A loop growing by 300 MB a second passes the limit by 150 MB at most before it's seen.
const POLL_MS = 500;

const KIB_PER_MIB = 1024;

const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/;

export const parseListing = (output: string): Listed[] => {
    return output.split('\n').flatMap((text) => {
        const match = LINE.exec(text);

        if (match === null) {
            return [];
        }

        return [{ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]) }];
    });
};

export const overLimit = (listing: readonly Listed[], root: number, limitKib: number): Listed[] => {
    const tree = listing.filter((entry) => entry.pid === root);
    const parents = [root];

    for (const parent of parents) {
        for (const entry of listing) {
            // ps doesn't list every process at the same instant, and a pid can be reused in
            // between, so a pid already walked is never walked again.
            if (entry.ppid === parent && !parents.includes(entry.pid)) {
                tree.push(entry);
                parents.push(entry.pid);
            }
        }
    }

    return tree.filter((entry) => entry.rss > limitKib);
};

// Written at once: the guard may exit right after, and a pipe's writes can lag.
const report = (message: string): void => {
    writeSync(2, `${message}\n`);
};

// A fixed PATH, so that the ps that runs is the system's.
const listProcesses = (): Listed[] | undefined => {
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });

    if (ps.status !== 0) {
        return undefined;
    }

    return parseListing(ps.stdout);
};

const endOverLimit = (root: number, limitKib: number): void => {
    // A listing that failed is taken again at the next poll.
    for (const { pid, rss } of overLimit(listProcesses() ?? [], root, limitKib)) {
        report(
            `The memory guard ended process ${pid}, which held ${Math.round(rss / KIB_PER_MIB)} MiB, over its limit of ${limitKib / KIB_PER_MIB} MiB.`,
        );

        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            // It has ended since the listing.
        }
    }
};

const exitCodeOf = (code: number | null, signal: NodeJS.Signals | null): number => {
    if (signal !== null) {
        return 128 + constants.signals[signal];
    }

    return code ?? 1;
};

const fail = (message: string): never => {
    report(message);
    return process.exit(2);
};

const guard = (argv: readonly string[], limitText: string | undefined): void => {
    const [command, ...args] = argv;
    const limitMib = Number(limitText ?? DEFAULT_LIMIT_MIB);

    if (command === undefined) {
        return fail('Usage: bun ./test/memory-guard.ts <command> [<argument>…]');
    }

    if (!(limitMib > 0)) {
        return fail(`MEMORY_LIMIT_MIB must be a positive number of MiB, not '${limitText}'.`);
    }

    if (listProcesses() === undefined) {
        return fail("ps couldn't list the processes, so the memory guard couldn't watch them.");
    }

    const child = spawn(command, args, { stdio: 'inherit' });
    const timer = setInterval(() => {
        if (child.pid !== undefined) {
            endOverLimit(child.pid, limitMib * KIB_PER_MIB);
        }
    }, POLL_MS);

    // Ctrl-C reaches the command too, and Stryker stops on its own: the guard waits for it.
    process.on('SIGINT', () => {});
    process.on('SIGTERM', () => {
        child.kill('SIGTERM');
    });

    child.once('error', (error) => {
        clearInterval(timer);
        fail(`The memory guard couldn't start ${command}: ${error.message}`);
    });

    child.once('exit', (code, signal) => {
        clearInterval(timer);
        process.exit(exitCodeOf(code, signal));
    });
};

if (import.meta.main) {
    guard(process.argv.slice(2), process.env.MEMORY_LIMIT_MIB);
}
