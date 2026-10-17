import { ChildProcess, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Result } from '@mecha-gremlin/core/result';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
    type Argv,
    type SpawnOptions,
    type Spawner,
    type Subprocess,
    chooseSpawner,
    spawnProcess,
    spawnWithBun,
    spawnWithNode,
} from '../src/spawn.ts';

const UNREF_SCRIPT = fileURLToPath(new URL('unref-script.ts', import.meta.url));

const NOT_FOUND =
    typeof Bun === 'undefined'
        ? 'spawn no-such-program-gremlin ENOENT'
        : 'Executable not found in $PATH: "no-such-program-gremlin"';

// Node and Bun ignore SIGPIPE, so a write to a closed pipe fails with EPIPE instead of ending the
// writer. It keeps writing until a write fails, so it doesn't matter when the test cancels.
const WRITER = [
    "const { writeFileSync } = require('node:fs');",
    "process.stdout.on('error', (error) => { writeFileSync(process.env.REPORT, String(error.code)); process.exit(0); });",
    "const write = () => process.stdout.write('late\\n', (error) => { if (!error) { setTimeout(write, 20); } });",
    'setTimeout(write, 50);',
].join('\n');

let dir: string;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spawn-'));
    await writeFile(join(dir, 'file.txt'), 'not a directory');
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

// The groups that detached processes this file started lead, each checked with ps.
const groups = new Set<number>();

// Only a group this file started, and never 0 or 1: process.kill(-0) would signal the test
// runner's own group, and process.kill(-1) every process the user may signal.
const signalGroup = (group: number, signal: NodeJS.Signals): void => {
    if (group <= 1 || !groups.has(group)) {
        throw new Error(`Group ${group} wasn't started by this test file`);
    }

    process.kill(-group, signal);
};

afterEach(() => {
    for (const group of groups) {
        try {
            signalGroup(group, 'SIGKILL');
        } catch (error) {
            // A group whose processes have all ended can't be signalled.
            if (Object(error).code !== 'ESRCH') {
                throw error;
            }
        }
    }

    groups.clear();
});

const options = (overrides: Partial<SpawnOptions> = {}): SpawnOptions => {
    return { cwd: dir, env: { PATH: '/usr/bin:/bin' }, detached: false, ...overrides };
};

const started = async (
    spawn: Spawner,
    argv: Argv,
    overrides?: Partial<SpawnOptions>,
): Promise<Subprocess> => {
    const result = await spawn(argv, options(overrides));

    expect(result).toEqual({ ok: true, value: expect.anything() });

    return (result as Extract<Result<Subprocess, string>, { ok: true }>).value;
};

// ps runs as soon as the spawn resolves, so a leader that exits at once is still there: the
// runtime reaps it only on a later turn of its event loop.
const startGroup = async (
    spawn: Spawner,
    argv: Argv,
    overrides?: Partial<SpawnOptions>,
): Promise<Subprocess> => {
    const proc = await started(spawn, argv, { ...overrides, detached: true });
    const ps = spawnSync('ps', ['-o', 'pgid=', '-p', String(proc.pid)], { encoding: 'utf8' });

    expect(ps.stdout.trim(), `process ${proc.pid} leads its own group`).toBe(String(proc.pid));
    groups.add(proc.pid);

    return proc;
};

const text = (stream: ReadableStream<Uint8Array>): Promise<string> => {
    return new Response(stream).text();
};

const run = async (spawn: Spawner, argv: Argv, overrides?: Partial<SpawnOptions>) => {
    const proc = await started(spawn, argv, overrides);
    const [stdout, stderr, exit] = await Promise.all([
        text(proc.stdout),
        text(proc.stderr),
        proc.exited,
    ]);

    return { stdout, stderr, exit };
};

const groupOf = (pid: number): string => {
    return spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
};

// A process warning prints on stderr, so it counts as output too.
const watchOutput = (): (() => unknown[]) => {
    const warnings = vi.spyOn(process, 'emitWarning');
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');

    return () => [...warnings.mock.calls, ...stdout.mock.calls, ...stderr.mock.calls];
};

const behaves = (spawn: Spawner, implementation: 'bun' | 'node'): void => {
    test('output and exit code', async () => {
        expect(await run(spawn, ['bash', '-c', 'echo out; echo err >&2; exit 3'])).toEqual({
            stdout: 'out\n',
            stderr: 'err\n',
            exit: { exitCode: 3, signal: null },
        });
    });

    test("a program that isn't found fails quietly, with the runtime's message", async () => {
        const output = watchOutput();

        const result = await spawn(['no-such-program-gremlin'], options());

        expect(result).toEqual({ ok: false, error: NOT_FOUND });
        expect(output()).toEqual([]);
    });

    test("a working directory that can't be used", async () => {
        const missing = await spawn(['pwd'], options({ cwd: join(dir, 'missing') }));
        const file = await spawn(['pwd'], options({ cwd: join(dir, 'file.txt') }));

        expect(missing).toEqual({ ok: false, error: expect.any(String) });
        expect(file).toEqual({ ok: false, error: expect.any(String) });
    });

    test('the working directory', async () => {
        const { stdout } = await run(spawn, ['pwd']);

        expect(stdout).toBe(`${await realpath(dir)}\n`);
    });

    test('only the given environment', async () => {
        const { stdout } = await run(spawn, ['bash', '-c', 'env | cut -d= -f1'], {
            env: { PATH: '/usr/bin:/bin', FOO: 'bar' },
        });

        // bash sets PWD, SHLVL and _ itself.
        expect(stdout.trim().split('\n').toSorted()).toEqual(['FOO', 'PATH', 'PWD', 'SHLVL', '_']);
    });

    test('the program is looked up in the given PATH', async () => {
        const env = { PATH: '/nonexistent-gremlin' };

        const bare = await spawn(['bash', '-c', 'echo found'], options({ env }));
        const absolute = await run(spawn, ['/bin/bash', '-c', 'echo found'], { env });

        expect(bare).toEqual({ ok: false, error: expect.any(String) });
        expect(absolute.stdout).toBe('found\n');
    });

    test('stdin is empty', async () => {
        expect(await run(spawn, ['bash', '-c', 'cat; echo done'])).toEqual({
            stdout: 'done\n',
            stderr: '',
            exit: { exitCode: 0, signal: null },
        });
    });

    test('a process group of its own', async () => {
        const detached = await started(spawn, ['bash', '-c', 'ps -o pgid= -p $$'], {
            detached: true,
        });
        const own = (await text(detached.stdout)).trim();
        const shared = await run(spawn, ['bash', '-c', 'ps -o pgid= -p $$']);

        expect(own).toBe(String(detached.pid));
        expect(shared.stdout.trim()).toBe(groupOf(process.pid));
    });

    test('ended by a signal', async () => {
        const { exit } = await run(spawn, ['bash', '-c', 'kill -TERM $$']);

        expect(exit).toEqual({ exitCode: null, signal: 'SIGTERM' });
    });

    test('a group signalled by the caller', async () => {
        const proc = await startGroup(spawn, ['bash', '-c', 'sleep 30']);

        signalGroup(proc.pid, 'SIGTERM');

        expect(await proc.exited).toEqual({ exitCode: null, signal: 'SIGTERM' });
    });

    test('a background child holds stdout', async () => {
        const proc = await startGroup(spawn, ['bash', '-c', 'sleep 30 & echo started']);
        const reader = proc.stdout.getReader();
        const first = await reader.read();
        let settled = false;
        const pending = reader.read().then((read) => {
            settled = true;

            return read;
        });

        const exit = await proc.exited;

        expect(new TextDecoder().decode(first.value)).toBe('started\n');
        expect(exit).toEqual({ exitCode: 0, signal: null });
        // The sleep still holds stdout, so the read waits on.
        expect(settled).toBe(false);

        await reader.cancel();

        expect(await pending).toEqual({ done: true, value: undefined });

        signalGroup(proc.pid, 'SIGKILL');

        // stderr ends once the sleep, the last process holding it, has ended.
        expect(await text(proc.stderr)).toBe('');
    });

    test('cancelling closes the pipe', async () => {
        const report = join(dir, `epipe-${implementation}`);
        const proc = await startGroup(spawn, ['bash', '-c', 'node -e "$WRITER" & echo started'], {
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', WRITER, REPORT: report },
        });
        const reader = proc.stdout.getReader();

        const first = await reader.read();
        await reader.cancel();
        await proc.stderr.cancel();
        const written = await vi.waitFor(() => readFile(report, 'utf8'), {
            timeout: 4000,
            interval: 20,
        });

        expect(new TextDecoder().decode(first.value)).toMatch(/^started\n/);
        expect(written).toBe('EPIPE');
    });

    test('unref lets the caller exit', () => {
        const script = spawnSync(process.execPath, [UNREF_SCRIPT, implementation], {
            encoding: 'utf8',
        });
        const pid = Number(script.stdout);

        expect(script).toMatchObject({ status: 0, stderr: '' });
        expect(pid).toBeGreaterThan(1);
        // Signal 0 only asks whether the sleep is still running. It isn't this file's process,
        // so it's left to end on its own.
        expect(process.kill(pid, 0)).toBe(true);
    });
};

describe('spawnWithNode', () => {
    behaves(spawnWithNode, 'node');

    test("unref() calls the child process's own", async () => {
        const unref = vi.spyOn(ChildProcess.prototype, 'unref');
        const proc = await started(spawnWithNode, ['bash', '-c', 'exit 0']);

        expect(unref).not.toHaveBeenCalled();

        proc.unref();

        expect(unref).toHaveBeenCalledOnce();
        expect(await proc.exited).toEqual({ exitCode: 0, signal: null });
    });
});

describe.runIf(typeof Bun !== 'undefined')('spawnWithBun', () => {
    behaves(spawnWithBun, 'bun');

    test("unref() calls the subprocess's own", async () => {
        const spawn = Bun.spawn;
        const unrefs: unknown[] = [];
        vi.spyOn(Bun, 'spawn').mockImplementation((...args) => {
            const proc = spawn(...args);
            unrefs.push(vi.spyOn(proc, 'unref'));

            return proc;
        });
        const proc = await started(spawnWithBun, ['bash', '-c', 'exit 0']);
        const [unref] = unrefs as ReturnType<typeof vi.fn>[];

        expect(unref).not.toHaveBeenCalled();

        proc.unref();

        expect(unref).toHaveBeenCalledOnce();
        expect(await proc.exited).toEqual({ exitCode: 0, signal: null });
    });

    test('a spawn that throws something other than an error', async () => {
        vi.spyOn(Bun, 'spawn').mockImplementation(() => {
            throw 'broken';
        });

        expect(await spawnWithBun(['bash', '-c', 'exit 0'], options())).toEqual({
            ok: false,
            error: 'broken',
        });
    });
});

describe('The choice of implementation', () => {
    test('Bun.spawn when the global object has Bun, node:child_process otherwise', () => {
        expect(chooseSpawner({ Bun: {} })).toBe(spawnWithBun);
        expect(chooseSpawner({})).toBe(spawnWithNode);
    });

    test("this runtime's global object", () => {
        expect(spawnProcess).toBe(typeof Bun === 'undefined' ? spawnWithNode : spawnWithBun);
    });

    test('spawnProcess runs the chosen implementation', async () => {
        expect(await run(spawnProcess, ['bash', '-c', 'echo out'])).toEqual({
            stdout: 'out\n',
            stderr: '',
            exit: { exitCode: 0, signal: null },
        });
    });
});
