import { ChildProcess, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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

const MIB = 1024 * 1024;

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
            // A group whose processes have all ended can't be signalled. On macOS, one whose last
            // member is a zombie waiting to be reaped answers EPERM instead of ESRCH.
            if (!['ESRCH', 'EPERM'].includes(Object(error).code)) {
                throw error;
            }
        }
    }

    groups.clear();
});

const options = (overrides: Partial<SpawnOptions> = {}): SpawnOptions => {
    return {
        cwd: dir,
        env: { PATH: '/usr/bin:/bin' },
        detached: false,
        stdin: 'ignore',
        ...overrides,
    };
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

// The stdin of a process started with `stdin: 'pipe'`, in a group of its own.
const piped = async (
    spawn: Spawner,
    argv: Argv,
    overrides?: Partial<SpawnOptions>,
): Promise<{ readonly proc: Subprocess; readonly stdin: WritableStream<Uint8Array> }> => {
    const proc = await startGroup(spawn, argv, { ...overrides, stdin: 'pipe' });

    expect(proc.stdin).toBeInstanceOf(WritableStream);

    return { proc, stdin: proc.stdin as WritableStream<Uint8Array> };
};

const text = (stream: ReadableStream<Uint8Array>): Promise<string> => {
    return new Response(stream).text();
};

const bytes = (value: string): Uint8Array => {
    return new TextEncoder().encode(value);
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

// A write that fails, as the error it fails with.
const failure = async (
    stdin: WritableStream<Uint8Array>,
    chunk: Uint8Array = bytes('late\n'),
): Promise<unknown> => {
    const writer = stdin.getWriter();

    try {
        return await writer.write(chunk).then(
            () => 'written',
            (error: unknown) => error,
        );
    } finally {
        writer.releaseLock();
    }
};

// The unref script, run to its end, and the pid of the `sleep` it started.
const runUnrefScript = (implementation: 'bun' | 'node', stdin: 'ignore' | 'pipe') => {
    const script = spawnSync(process.execPath, [UNREF_SCRIPT, implementation, stdin], {
        encoding: 'utf8',
    });

    return { script, sleep: Number(script.stdout) };
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

    test("a working directory that can't be used, with a stdin pipe", async () => {
        const missing = await spawn(['pwd'], options({ cwd: join(dir, 'missing'), stdin: 'pipe' }));
        const file = await spawn(['pwd'], options({ cwd: join(dir, 'file.txt'), stdin: 'pipe' }));

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

    test('stdin is empty, and there is no stream to write to', async () => {
        const proc = await started(spawn, ['bash', '-c', 'cat; echo done']);
        const [stdout, stderr, exit] = await Promise.all([
            text(proc.stdout),
            text(proc.stderr),
            proc.exited,
        ]);

        expect(proc.stdin).toBeUndefined();
        expect({ stdout, stderr, exit }).toEqual({
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
        const { script, sleep } = runUnrefScript(implementation, 'ignore');

        expect(script).toMatchObject({ status: 0, stderr: '' });
        expect(sleep).toBeGreaterThan(1);
        // Signal 0 only asks whether the sleep is still running. It isn't this file's process,
        // so it's left to end on its own.
        expect(process.kill(sleep, 0)).toBe(true);
    });
};

// Every scenario of writing to a process's stdin. `closedStdin` is false only where the runtime
// can't detect a process that closed its stdin.
const writes = (spawn: Spawner, implementation: 'bun' | 'node', closedStdin: boolean): void => {
    test('written and read', async () => {
        const { proc, stdin } = await piped(spawn, ['cat']);
        const writer = stdin.getWriter();

        await writer.write(bytes('hi\n'));
        await writer.close();
        const [stdout, exit] = await Promise.all([text(proc.stdout), proc.exited]);

        expect(stdout).toBe('hi\n');
        expect(exit).toEqual({ exitCode: 0, signal: null });
    });

    test('a write reaches the process before stdin is closed', async () => {
        const { proc, stdin } = await piped(spawn, ['cat']);
        const writer = stdin.getWriter();
        const reader = proc.stdout.getReader();

        await writer.write(bytes('hi\n'));
        const echoed = await reader.read();
        await writer.close();

        expect(new TextDecoder().decode(echoed.value)).toBe('hi\n');
        expect(await reader.read()).toEqual({ done: true, value: undefined });
        expect(await proc.exited).toEqual({ exitCode: 0, signal: null });
    });

    test('a write waits while the pipe is full', async () => {
        // The process creates it just before it starts reading.
        const mark = join(dir, `reading-${implementation}`);
        await rm(mark, { force: true });
        const { proc, stdin } = await piped(
            spawn,
            ['bash', '-c', 'sleep 1; : > "$MARK"; exec wc -c'],
            { env: { PATH: '/usr/bin:/bin', MARK: mark } },
        );
        const writer = stdin.getWriter();
        const counted = text(proc.stdout);

        await writer.write(new Uint8Array(4 * MIB));
        const readingWhenWritten = existsSync(mark);
        await writer.close();

        expect(readingWhenWritten).toBe(true);
        expect((await counted).trim()).toBe(String(4 * MIB));
        expect(await proc.exited).toEqual({ exitCode: 0, signal: null });
    });

    test('closing after the exit', async () => {
        const { proc, stdin } = await piped(spawn, ['bash', '-c', 'exit 0']);

        await proc.exited;

        await expect(stdin.close()).resolves.toBeUndefined();
    });

    test('aborting gives the process end-of-file at once', async () => {
        const { proc, stdin } = await piped(spawn, ['bash', '-c', 'echo ready; cat; echo eof']);
        const reader = proc.stdout.getReader();
        const ready = await reader.read();
        let rest = '';

        await stdin.abort();

        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            rest += new TextDecoder().decode(chunk.value);
        }

        expect(new TextDecoder().decode(ready.value)).toBe('ready\n');
        expect(rest).toBe('eof\n');
        expect(await proc.exited).toEqual({ exitCode: 0, signal: null });
    });

    test('writes after the exit fail with EPIPE', async () => {
        const { proc, stdin } = await piped(spawn, ['bash', '-c', 'exit 0']);
        await proc.exited;

        const first = await failure(stdin);
        const second = await failure(stdin);

        expect(first).toMatchObject({ code: 'EPIPE', message: 'write EPIPE' });
        expect(second).toMatchObject({ code: 'EPIPE' });
    });

    test('a write after a signal fails with EPIPE', async () => {
        const { proc, stdin } = await piped(spawn, ['bash', '-c', 'kill -TERM $$']);

        expect(await proc.exited).toEqual({ exitCode: null, signal: 'SIGTERM' });
        expect(await failure(stdin)).toMatchObject({ code: 'EPIPE' });
    });

    test.runIf(closedStdin)(
        'a write after the process closed its stdin fails with EPIPE',
        async () => {
            const { proc, stdin } = await piped(spawn, [
                'bash',
                '-c',
                'exec 0<&-; echo closed; sleep 30',
            ]);
            const reader = proc.stdout.getReader();

            const closed = await reader.read();
            const written = await failure(stdin);

            expect(new TextDecoder().decode(closed.value)).toBe('closed\n');
            expect(written).toMatchObject({ code: 'EPIPE' });
        },
    );

    // A write held by a full pipe when the process exits fails too, and on both runtimes Node's
    // stream then also emits an `error` event.
    test('a failed write escapes nowhere', async () => {
        const escaped: unknown[] = [];
        const record = (error: unknown): void => {
            escaped.push(error);
        };
        const failures: unknown[] = [];
        process.on('uncaughtException', record);
        process.on('unhandledRejection', record);

        try {
            const { proc, stdin } = await piped(spawn, ['bash', '-c', 'echo started; sleep 0.2']);
            const reader = proc.stdout.getReader();
            await reader.read();

            failures.push(await failure(stdin, new Uint8Array(4 * MIB)));
            await proc.exited;
            failures.push(await failure(stdin), await failure(stdin));
            await new Promise((resolve) => {
                setTimeout(resolve, 50);
            });
        } finally {
            process.off('uncaughtException', record);
            process.off('unhandledRejection', record);
        }

        expect(failures).toMatchObject([{ code: 'EPIPE' }, { code: 'EPIPE' }, { code: 'EPIPE' }]);
        expect(escaped).toEqual([]);
    });

    test('an idle stdin pipe and unref let the caller exit', () => {
        const { script, sleep } = runUnrefScript(implementation, 'pipe');

        expect(script).toMatchObject({ status: 0, stderr: '' });
        expect(sleep).toBeGreaterThan(1);
        expect(process.kill(sleep, 0)).toBe(true);
    });
};

describe('spawnWithNode', { timeout: 15_000 }, () => {
    behaves(spawnWithNode, 'node');
    // On Bun, node:child_process drops writes to a process that closed its stdin, without an
    // error.
    writes(spawnWithNode, 'node', typeof Bun === 'undefined');

    test("unref() calls the child process's own", async () => {
        const unref = vi.spyOn(ChildProcess.prototype, 'unref');
        const proc = await started(spawnWithNode, ['bash', '-c', 'exit 0']);

        expect(unref).not.toHaveBeenCalled();

        proc.unref();

        expect(unref).toHaveBeenCalledOnce();
        expect(await proc.exited).toEqual({ exitCode: 0, signal: null });
    });
});

describe.runIf(typeof Bun !== 'undefined')('spawnWithBun', { timeout: 15_000 }, () => {
    behaves(spawnWithBun, 'bun');
    writes(spawnWithBun, 'bun', true);

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
