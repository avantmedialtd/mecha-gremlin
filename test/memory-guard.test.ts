import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { type Listed, overLimit, parseListing } from './memory-guard.ts';

const GUARD = fileURLToPath(new URL('memory-guard.ts', import.meta.url));

const LIMIT_KIB = 3 * 1024 * 1024;

// In KiB, as ps gives them: the command, 100, two processes under it over the limit, one within
// it, and a process outside the command's tree over it.
const LISTING = parseListing(
    [
        '    1     0    9000',
        '  100     1   20000',
        '  101   100 4000000',
        '  102   100   10000',
        '  103   102 5000000',
        '  200     1 9000000',
        '  PID  PPID    RSS',
        '',
    ].join('\n'),
);

const pidsOf = (entries: readonly Listed[]): number[] => {
    return entries.map((entry) => entry.pid);
};

type Ended = {
    readonly code: number | null;
    readonly stderr: string;
};

// Every process the guard starts here ends within 30 seconds, even if the guard doesn't end it.
const runGuard = (
    env: Readonly<Record<string, string>>,
    command: readonly string[],
): Promise<Ended> => {
    const child = spawn(process.execPath, [GUARD, ...command], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });

    return new Promise((resolve) => {
        child.once('close', (code) => {
            resolve({ code, stderr });
        });
    });
};

describe('The listing', () => {
    test('skips lines that are not three numbers', () => {
        expect(pidsOf(LISTING)).toEqual([1, 100, 101, 102, 103, 200]);
        expect(LISTING[2]).toEqual({ pid: 101, ppid: 100, rss: 4_000_000 });
    });
});

describe('Over the limit', () => {
    test('the processes under the command, at any depth, and none outside its tree', () => {
        expect(pidsOf(overLimit(LISTING, 100, LIMIT_KIB))).toEqual([101, 103]);
    });

    test('the command itself', () => {
        expect(pidsOf(overLimit(LISTING, 200, LIMIT_KIB))).toEqual([200]);
    });

    test('a pid that ps lists twice, reused while it ran, is walked once', () => {
        const listing = parseListing(
            ['  100     1  10', '  101   100  10', '  102   101  10', '  101   102  10'].join('\n'),
        );

        expect(pidsOf(overLimit(listing, 100, 0))).toEqual([100, 101, 102]);
    });
});

describe('The guard', () => {
    test('exits as its command does', async () => {
        expect(await runGuard({}, [process.execPath, '-e', 'process.exit(3)'])).toEqual({
            code: 3,
            stderr: '',
        });
    });

    test('exits as a signal ended its command', async () => {
        const command = [process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"];

        expect(await runGuard({}, command)).toEqual({ code: 143, stderr: '' });
    });

    test('ends a process whose memory passes the limit', async () => {
        const command = [
            process.execPath,
            '-e',
            'globalThis.kept = Buffer.alloc(384 * 1024 * 1024, 1); setTimeout(() => {}, 30_000);',
        ];

        const { code, stderr } = await runGuard({ MEMORY_LIMIT_MIB: '128' }, command);

        expect(code).toBe(137);
        expect(stderr).toMatch(
            /^The memory guard ended process \d+, which held \d+ MiB, over its limit of 128 MiB\.\n$/,
        );
    });

    test('needs a command', async () => {
        expect(await runGuard({}, [])).toEqual({
            code: 2,
            stderr: 'Usage: bun ./test/memory-guard.ts <command> [<argument>…]\n',
        });
    });

    test.each(['0', 'lots'])('needs a positive limit, not %s', async (limit) => {
        expect(await runGuard({ MEMORY_LIMIT_MIB: limit }, [process.execPath, '-e', ''])).toEqual({
            code: 2,
            stderr: `MEMORY_LIMIT_MIB must be a positive number of MiB, not '${limit}'.\n`,
        });
    });

    test("reports a command that can't start", async () => {
        const { code, stderr } = await runGuard({}, ['/no/such/command']);

        expect(code).toBe(2);
        expect(stderr).toMatch(/^The memory guard couldn't start \/no\/such\/command: .+\n$/);
    });
});
