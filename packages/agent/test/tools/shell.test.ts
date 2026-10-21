import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ToolOutcome, toFunctionTool } from '@mecha-gremlin/core/tools';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type Limits, type Shell, type ShellOptions, createShell } from '../../src/tools/shell.ts';
import {
    freshRunId,
    helperCommand,
    isGone,
    stopLeftovers,
    track,
    waitUntilGone,
} from '../exec/processes.ts';

const LIMITS: Limits = {
    timeoutMs: 10_000,
    graceMs: 300,
    pipeWaitMs: 200,
    captureBytes: 32 * 1024,
};

const NOT_RUN = { ok: false, error: 'the session is stopping; the command was not run' };

const CUT_NOTE =
    "The output was cut. To see the rest, run the command again with its output written to a file in the working directory, then search the file with grep, or print the part you need with sed -n or tail -c: read_file shows only a file's first 32 KiB.";

let workDir: string;

beforeEach(async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), 'shell-')));
});

afterEach(async () => {
    stopLeftovers();
    await rm(workDir, { recursive: true, force: true });
});

const shellFor = (overrides: Partial<ShellOptions> = {}): Shell => {
    return createShell({
        workDir,
        runId: freshRunId(),
        parentEnv: process.env,
        limits: LIMITS,
        ...overrides,
    });
};

const run = (shell: Shell, command: string): Promise<ToolOutcome> => {
    return shell.handler.invoke(JSON.stringify({ command }));
};

const outputOf = async (command: string, overrides?: Partial<ShellOptions>): Promise<string> => {
    const outcome = await run(shellFor(overrides), command);

    expect(outcome).toMatchObject({ ok: true });

    return outcome.ok ? outcome.value : '';
};

const exists = async (path: string): Promise<boolean> => {
    return stat(path).then(
        () => true,
        () => false,
    );
};

describe('Run a command with bash in the working directory', { timeout: 15_000 }, () => {
    test('the model sees a closed schema', () => {
        const tool = toFunctionTool(shellFor().handler.tool);

        expect(tool).toMatchObject({ type: 'function', name: 'shell', strict: true });
        expect(tool.parameters).toEqual({
            type: 'object',
            properties: { command: { type: 'string' } },
            required: ['command'],
            additionalProperties: false,
        });
    });

    test('the description, from the default limits', () => {
        const shell = createShell({ workDir, runId: 'a1b2c3d4', parentEnv: {} });

        expect(shell.handler.tool.description).toBe(
            "Run a command with bash in the working directory, and get its exit code and output. Each call is a fresh shell, so cd and variables don't carry over, and stdin is closed. Background processes stop when the command ends, unless they leave its process group, as playwright-cli's browser does. Each output stream keeps its first and last 16 KiB, and a command is stopped after 120 s. Commands run on this computer as its user, so stop only what you started: close a playwright-cli browser with `playwright-cli close`, never `kill-all` or `close-all`, which reach other tools' browsers. The session's processes are stopped when it ends anyway.",
        );
    });

    test('the description follows the limits', () => {
        const limits = { ...LIMITS, timeoutMs: 1500, captureBytes: 4096 };

        expect(shellFor({ limits }).handler.tool.description).toContain(
            'Each output stream keeps its first and last 2 KiB, and a command is stopped after 1.5 s.',
        );
    });

    test('runs in the working directory', async () => {
        expect(await outputOf('pwd')).toBe(`exit code: 0\nstdout:\n${workDir}`);
    });

    test('no input', async () => {
        expect(await outputOf('cat; echo done')).toBe('exit code: 0\nstdout:\ndone');
    });

    test('extra arguments are rejected', async () => {
        const outcome = await shellFor().handler.invoke('{"command":"true","timeout":5}');

        expect(outcome).toEqual({
            ok: false,
            error: expect.stringContaining('(root): Unrecognized key: "timeout"'),
        });
    });
});

describe('Report the exit code and both streams', { timeout: 15_000 }, () => {
    test('success', async () => {
        expect(await outputOf('echo hi')).toBe('exit code: 0\nstdout:\nhi');
    });

    test('a failing command', async () => {
        expect(await outputOf('echo oops >&2; exit 3')).toBe('exit code: 3\nstderr:\noops');
    });

    test('both streams, stdout first', async () => {
        expect(await outputOf('echo err >&2; echo out')).toBe(
            'exit code: 0\nstdout:\nout\nstderr:\nerr',
        );
    });

    test('no output', async () => {
        expect(await outputOf('true')).toBe('exit code: 0\n(no output)');
    });

    test('only the end of a stream is trimmed', async () => {
        expect(await outputOf("printf '  indented\\n\\n'")).toBe(
            'exit code: 0\nstdout:\n  indented',
        );
    });

    test('ended by a signal', async () => {
        expect(await outputOf('kill -TERM $$')).toBe('killed by SIGTERM\n(no output)');
    });

    test('a cut stream ends with how to see the rest', async () => {
        const output = await outputOf(
            "printf start; head -c 100000 /dev/zero | tr '\\0' x; printf end; echo short >&2",
        );

        expect(output).toBe(
            [
                'exit code: 0',
                'stdout:',
                `start${'x'.repeat(16_379)}`,
                '[… 67240 bytes omitted …]',
                `${'x'.repeat(16_381)}end`,
                'stderr:',
                'short',
                CUT_NOTE,
            ].join('\n'),
        );
    });

    test("bash can't be started", async () => {
        const empty = await mkdtemp(join(workDir, 'empty-'));
        const kill = vi.spyOn(process, 'kill');

        const outcome = await run(shellFor({ parentEnv: { PATH: empty } }), 'echo hi');

        expect(outcome).toEqual({
            ok: false,
            error: expect.stringMatching(/^bash couldn't be started: .*bash/),
        });
        expect(kill).not.toHaveBeenCalled();
    });

    test('the working directory is gone', async () => {
        const shell = shellFor();
        await rm(workDir, { recursive: true });

        expect(await run(shell, 'echo hi')).toEqual({
            ok: false,
            error: `The working directory ${workDir} doesn't exist.`,
        });
        expect(await exists(workDir)).toBe(false);
    });
});

describe("Build the command's environment from scratch", { timeout: 15_000 }, () => {
    test("the agent's secrets stay out", async () => {
        vi.stubEnv('MODEL_API_KEY', 'sk-test-secret');

        const output = await outputOf('env');

        expect(output).not.toContain('MODEL_API_KEY');
        expect(output).not.toContain('sk-test-secret');
    });

    test("the command's variables", async () => {
        const lines = (await outputOf('env', { runId: 'a1b2c3d4' })).split('\n');

        expect(lines).toEqual(
            expect.arrayContaining([
                'GREMLIN_RUN_ID=a1b2c3d4',
                'PLAYWRIGHT_CLI_SESSION=gremlin-a1b2c3d4',
                'PLAYWRIGHT_MCP_IDLE_TIMEOUT=900000',
                'CI=1',
                'PAGER=cat',
                `PATH=${process.env.PATH}`,
            ]),
        );
    });

    test("playwright-cli's workspace", async () => {
        await outputOf('true');

        expect((await stat(join(workDir, '.playwright'))).isDirectory()).toBe(true);
    });

    test("a workspace that can't be made doesn't stop the command", async () => {
        await writeFile(join(workDir, '.playwright'), 'not a directory');

        expect(await outputOf('echo hi')).toBe('exit code: 0\nstdout:\nhi');
    });
});

describe("Stop the command's process group", { timeout: 15_000 }, () => {
    test('a command that never ends', async () => {
        const output = await outputOf('echo started $$; sleep 30', {
            limits: { ...LIMITS, timeoutMs: 1000 },
        });
        const bash = Number(/started (\d+)/.exec(output)?.[1]);

        expect(output).toBe(`killed by SIGTERM\ntimed out after 1 s\nstdout:\nstarted ${bash}`);
        // Signal 0 to the group fails once no process is left in it.
        await vi.waitFor(
            () => {
                expect(() => process.kill(-bash, 0)).toThrow('ESRCH');
            },
            { timeout: 4000, interval: 20 },
        );
    });

    test('a command that ignores SIGTERM', async () => {
        const output = await outputOf("trap '' TERM; echo ready; sleep 30", {
            limits: { ...LIMITS, timeoutMs: 1000 },
        });

        expect(output).toBe('killed by SIGKILL\ntimed out after 1 s\nstdout:\nready');
    });

    test('a child cleans up after the timeout, within the grace', async () => {
        const file = join(workDir, 'cleaned');

        // `; true` keeps bash from exec-ing the child in its own place.
        const output = await outputOf(`${helperCommand('cleanup', file, '400')}; true`, {
            limits: { ...LIMITS, timeoutMs: 1500, graceMs: 1500, pipeWaitMs: 100 },
        });

        expect(output).toBe('killed by SIGTERM\ntimed out after 1.5 s\nstdout:\nready');
        expect(await readFile(file, 'utf8')).toBe('cleaned up');
    });

    test('a background job', async () => {
        const output = await outputOf('sleep 30 > /dev/null 2>&1 & echo $!');
        const job = track(Number(/stdout:\n(\d+)$/.exec(output)?.[1]));

        expect(output).toBe(`exit code: 0\nstdout:\n${job}`);
        await waitUntilGone(job);
    });

    test('a background job holding the output', async () => {
        expect(await outputOf('(sleep 30; echo late) & echo started')).toBe(
            'exit code: 0\nstdout:\nstarted',
        );
    });

    test('the timeout counts only while bash runs', async () => {
        const output = await outputOf('(sleep 30; echo late) & echo started', {
            limits: { ...LIMITS, timeoutMs: 2000, pipeWaitMs: 3000 },
        });

        expect(output).toBe('exit code: 0\nstdout:\nstarted');
    });

    test('a background job that ends within the pipe wait has its output read', async () => {
        const output = await outputOf('(sleep 0.2; echo late) & echo started', {
            limits: { ...LIMITS, pipeWaitMs: 3000 },
        });

        expect(output).toBe('exit code: 0\nstdout:\nstarted\nlate');
    });

    test('a process in a session of its own', async () => {
        const output = await outputOf(helperCommand('leave', 'ignore'));
        const daemon = track(Number(/stdout:\n(\d+)$/.exec(output)?.[1]));

        expect(output).toBe(`exit code: 0\nstdout:\n${daemon}`);
        expect(isGone(daemon)).toBe(false);
    });

    test('a process outside the group holding the output', async () => {
        const report = join(workDir, 'report');

        const output = await outputOf(`echo started; ${helperCommand('leave', 'hold', report)}`);

        expect(output).toMatch(/^exit code: 0\nstdout:\nstarted\n/);

        for (const stream of ['stdout', 'stderr']) {
            const written = await vi.waitFor(() => readFile(`${report}-${stream}`, 'utf8'), {
                timeout: 4000,
                interval: 20,
            });

            expect(written).toBe('EPIPE');
        }
    });
});

describe('Cap each stream', { timeout: 15_000 }, () => {
    test('NUL bytes', async () => {
        expect(await outputOf("printf 'a\\0b'")).toBe('exit code: 0\nstdout:\na␀b');
    });

    test('invalid UTF-8', async () => {
        expect(await outputOf("printf '\\x80'")).toBe('exit code: 0\nstdout:\n�');
    });
});

describe('Stop every process a session started', { timeout: 15_000 }, () => {
    test('a process that left the group', async () => {
        const shell = shellFor();
        const outcome = await run(shell, helperCommand('leave', 'ignore'));
        const daemon = track(Number(/stdout:\n(\d+)$/.exec(outcome.ok ? outcome.value : '')?.[1]));

        expect(isGone(daemon)).toBe(false);
        expect(await shell.dispose()).toEqual({ ok: true, value: 1 });
        await waitUntilGone(daemon);
    });

    test('a running command is killed, and waited for', async () => {
        const shell = shellFor();
        const pending = run(shell, 'touch started; sleep 30');
        const finished = vi.fn<() => void>();
        void pending.then(finished);
        await vi.waitFor(() => stat(join(workDir, 'started')), { timeout: 4000, interval: 20 });
        // Slow cancels keep the command's call going well after the sweep would have ended.
        const cancel = Reflect.get(ReadableStreamDefaultReader.prototype, 'cancel') as (
            reason?: unknown,
        ) => Promise<void>;
        vi.spyOn(ReadableStreamDefaultReader.prototype, 'cancel').mockImplementation(
            async function (this: unknown, reason?: unknown) {
                await new Promise((resolve) => {
                    setTimeout(resolve, 500);
                });

                return Reflect.apply(cancel, this, [reason]);
            },
        );

        const result = await shell.dispose();

        expect(finished).toHaveBeenCalledOnce();
        expect(await pending).toEqual({ ok: true, value: 'killed by SIGKILL\n(no output)' });
        expect(result).toEqual({ ok: true, value: 0 });
    });

    test('no command after dispose', async () => {
        const shell = shellFor();
        await shell.dispose();

        expect(await run(shell, 'touch started')).toEqual(NOT_RUN);
        expect(await exists(join(workDir, 'started'))).toBe(false);
    });

    test("a call that began before dispose, and hadn't started its command", async () => {
        const shell = shellFor();
        const pending = run(shell, 'touch started');
        const disposed = shell.dispose();

        expect(await pending).toEqual(NOT_RUN);
        expect(await disposed).toEqual({ ok: true, value: 0 });
        expect(await exists(join(workDir, 'started'))).toBe(false);
    });

    test('a second call', async () => {
        const shell = shellFor();
        const first = shell.dispose();

        expect(shell.dispose()).toBe(first);
        expect(await first).toEqual({ ok: true, value: 0 });
    });

    test("a sweep that can't run", async () => {
        const empty = await mkdtemp(join(workDir, 'empty-'));

        expect(await shellFor({ parentEnv: { PATH: empty } }).dispose()).toEqual({
            ok: false,
            error: expect.stringMatching(/^ps couldn't be started: /),
        });
    });
});
