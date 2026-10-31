import { existsSync } from 'node:fs';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDataSource } from '@mecha-gremlin/store/connection';
import { findCredentials, saveCredential } from '@mecha-gremlin/store/credential';
import { type NewMcpServer, addMcpServer } from '@mecha-gremlin/store/mcp-server';
import { closeStore, openStore } from '@mecha-gremlin/store/store';
import type { ResponseOutputItem, ResponseUsage } from 'openai/resources/responses/responses';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
    type FakeServer,
    type RecordedRequest,
    call,
    completed,
    fakeFetch,
    httpError,
    message,
    reasoning,
    script,
} from '../fake-model.ts';
import { listProcesses } from '../../../../test/signal-guard.ts';
import { freshRunId, helperCommand, isGone, stopLeftovers, track } from '../exec/processes.ts';
import { claudeReply } from '../fake-anthropic.ts';
import { startAuthServer } from '../mcp/auth-server.ts';
import { startHttpServer } from '../mcp/http-server.ts';

// The test helper supplies a task explicitly; the application no longer supplies one.
const TEST_TASK = 'Carry out the test task.';

/** Each test sets or clears all of these, so settings in your shell can't leak in. */
const SETTINGS = [
    'LOG_FORMAT',
    'MODEL_PROVIDER',
    'MODEL_BASE_URL',
    'MODEL_API_KEY',
    'MODEL',
    'MODEL_REASONING_EFFORT',
    'MODEL_MAX_OUTPUT_TOKENS',
    'ANTHROPIC_WORKSPACE_ID',
    'WORK_DIR',
    'DATA_DIR',
    'SKILLS_PATH',
    'MAX_STEPS',
    'MAX_TURNS',
    'FILE_TOOLS',
] as const;
type Settings = Readonly<Partial<Record<(typeof SETTINGS)[number], string>>>;

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type LogRecord = {
    readonly time: string;
    readonly level: string;
    readonly message: string;
    readonly [field: string]: unknown;
};

const PACKAGE_JSON = `${JSON.stringify({ scripts: { check: 'bun run lint && bun run test' } }, null, 4)}\n`;
const MENU = 'Café crème: 3 €\n';

let cwd: string;
// On macOS the temporary directory is reached through a link, and the agent uses real paths.
let realCwd: string;
let skillsRoot: string;
// Migrated before the tests, so that only the tests that give a data folder of their own see the
// migrated record.
let dataDir: string;

// Opens a store there, as a later run would, and closes it again.
const reopen = async (folder: string) => {
    const opened = await openStore(folder);

    if (opened.ok) {
        await closeStore(opened.value.store);
    }

    return opened;
};

const writeIn = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};

beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'agent-'));
    realCwd = await realpath(cwd);
    await writeFile(join(cwd, 'package.json'), PACKAGE_JSON);
    await writeFile(join(cwd, 'menu.txt'), MENU);
    skillsRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-skills-')));
    await writeIn(
        join(skillsRoot, 'pdf', 'SKILL.md'),
        '---\nname: pdf\ndescription: Work with PDFs.\n---\n# PDF\n',
    );
    await writeIn(
        join(skillsRoot, 'browser', 'SKILL.md'),
        '---\nname: browser\ndescription: Drive a browser.\n---\n# Browser\n',
    );
    dataDir = await mkdtemp(join(tmpdir(), 'agent-data-'));
    await reopen(dataDir);
});

afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(skillsRoot, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
});

// The agents this file starts, and the model calls it holds open. A test that fails midway
// mustn't leave an agent suspended, with its signal handlers installed, for the next test: after
// each test, held model calls are released and agents awaited, for at most 10 s.
const startedAgents: Promise<unknown>[] = [];
const heldModelCalls: ((output: readonly ResponseOutputItem[]) => Promise<void>)[] = [];

const within = (ms: number): Promise<unknown> => {
    return new Promise((resolve) => {
        AbortSignal.timeout(ms).addEventListener('abort', resolve);
    });
};

afterEach(async () => {
    const released = heldModelCalls
        .splice(0)
        .map((release) => release([message('The test ended.')]));

    await Promise.race([
        Promise.allSettled([...released, ...startedAgents.splice(0)]),
        within(10_000),
    ]);

    stopLeftovers();
    process.exitCode = undefined;
}, 20_000);

const parseRecords = (output: string): LogRecord[] => {
    return output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LogRecord);
};

const modelCallsOf = (requests: readonly RecordedRequest[]): RecordedRequest[] => {
    return requests.filter(
        (request) => request.url.endsWith('/v1/responses') || request.url.endsWith('/v1/messages'),
    );
};

/**
 * Starts the agent without waiting for it to end. The log is read as JSON records, which pins
 * every field, unless a test asks for another format; the formatted output has its own tests. The
 * run ID is a fresh one, which the signal guard vouches for.
 */
const startAgent = (
    env: Settings = {},
    server: FakeServer = {},
    args: readonly string[] = [TEST_TASK],
) => {
    const settings: Settings = {
        LOG_FORMAT: 'json',
        MODEL_PROVIDER: 'lmstudio',
        MODEL_BASE_URL: 'http://127.0.0.1:1234/v1',
        MODEL_API_KEY: 'lm-studio',
        MODEL: 'prism-ml/bonsai-27b',
        MODEL_REASONING_EFFORT: 'none',
        MAX_STEPS: '30',
        FILE_TOOLS: 'write-edit',
        WORK_DIR: cwd,
        DATA_DIR: dataDir,
        ...env,
    };

    for (const name of SETTINGS) {
        vi.stubEnv(name, settings[name]);
    }

    const { fetch, requests } = fakeFetch(server);
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    // Every reading of the clock is 1.5 s after the last, so each model call takes 1.5 s.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 1500));
    const runId = freshRunId();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
        `${runId}-0000-4000-8000-000000000000` as ReturnType<typeof crypto.randomUUID>,
    );

    const argv = process.argv;
    process.argv = [...argv.slice(0, 1), 'main.ts', ...args];
    let output = '';
    // Vitest replaces `console` in its workers, so spying on stdout itself wouldn't see the log.
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        output += `${String(line)}\n`;
    });

    // A module runs only once until the registry is reset.
    vi.resetModules();
    const done = import('../../src/main/main.ts').finally(() => {
        process.argv = argv;
        log.mockRestore();
    });
    startedAgents.push(done);

    return {
        done,
        runId,
        requests,
        modelCalls: () => modelCallsOf(requests),
        output: () => output,
        records: () => (settings.LOG_FORMAT === 'json' ? parseRecords(output) : []),
    };
};

const runAgent = async (
    env: Settings = {},
    server: FakeServer = {},
    args: readonly string[] = [TEST_TASK],
) => {
    const started = startAgent(env, server, args);
    await started.done;
    const modelCalls = started.modelCalls();

    return {
        code: process.exitCode,
        output: started.output(),
        records: started.records(),
        requests: started.requests,
        modelCalls,
        modelCall: modelCalls[0],
        runId: started.runId,
    };
};

const find = (records: readonly LogRecord[], wanted: string): LogRecord | undefined => {
    return records.find((record) => record.message === wanted);
};

const all = (records: readonly LogRecord[], wanted: string): LogRecord[] => {
    return records.filter((record) => record.message === wanted);
};

const errors = (records: readonly LogRecord[]): string[] => {
    return records.filter((record) => record.level === 'error').map((record) => record.message);
};

// The outputs of the tool calls that a request carries back to the model.
const callOutputs = (request: RecordedRequest | undefined): unknown[] => {
    const input = (request?.body?.input ?? []) as readonly { type?: string; output?: unknown }[];

    if (input.length > 0) {
        return input
            .filter((item) => item.type === 'function_call_output')
            .map((item) => item.output);
    }

    const messages = (request?.body?.messages ?? []) as readonly {
        role?: string;
        content?: unknown;
    }[];

    return messages.flatMap((item) =>
        Array.isArray(item.content)
            ? item.content
                  .filter((block) => block.type === 'tool_result')
                  .map((block) => block.content)
            : [],
    );
};

const toolNames = (request: RecordedRequest | undefined): unknown[] => {
    return ((request?.body?.tools ?? []) as readonly { name: string }[]).map((tool) => tool.name);
};

const developerItem = (request: RecordedRequest | undefined): string => {
    const input = (request?.body?.input ?? []) as readonly { role?: string; content?: string }[];

    return input.find((item) => item.role === 'developer')?.content ?? '';
};

const readThenAnswer: FakeServer = {
    responses: script(
        () => completed([reasoning(), call('read', { path: 'package.json' })]),
        () => completed([message('\n\nIt runs the checks.')]),
    ),
};

// A model call that stays open until it's released with the model's output, once.
const heldModelCall = () => {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    let released = false;
    const release = async (output: readonly ResponseOutputItem[]): Promise<void> => {
        if (released) {
            return;
        }

        released = true;
        await writer.write(new Uint8Array(await completed(output).arrayBuffer()));
        await writer.close();
    };

    heldModelCalls.push(release);

    return {
        response: () =>
            new Response(stream.readable, { headers: { 'content-type': 'text/event-stream' } }),
        release,
    };
};

describe('Carry out a task through the agent loop, and log the answer', { timeout: 15_000 }, () => {
    test.each([[[]], [[' ', '  ']]])(
        'a missing or blank task fails without a request',
        async (args) => {
            const { code, requests, records } = await runAgent({}, {}, args);

            expect(code).toBe(1);
            expect(errors(records)).toEqual([expect.stringContaining('task is required')]);
            expect(requests).toHaveLength(0);
        },
    );

    test('a task from the arguments', async () => {
        const { modelCall } = await runAgent({}, {}, [
            'Which',
            'runtime',
            'does README.md describe?',
        ]);

        expect(modelCall?.body?.input).toContainEqual({
            role: 'user',
            content: 'Which runtime does README.md describe?',
        });
    });

    test('without skills: read, write, edit and shell, and a developer item that mentions no skills', async () => {
        const { modelCall } = await runAgent();

        expect(modelCall?.body?.tools).toEqual([
            expect.objectContaining({ type: 'function', name: 'read', strict: true }),
            expect.objectContaining({ type: 'function', name: 'write', strict: true }),
            expect.objectContaining({ type: 'function', name: 'edit', strict: true }),
            expect.objectContaining({ type: 'function', name: 'shell', strict: true }),
        ]);
        expect(developerItem(modelCall)).toBe(
            `You carry out tasks on this computer. You have a shell, read for reading text files, write for creating or replacing a file, and edit for changing part of one. The working directory is ${realCwd}, and paths that commands print are relative to it. Keep your final answer brief.`,
        );
    });

    test('the patch tool set', async () => {
        const { modelCalls } = await runAgent(
            { FILE_TOOLS: 'apply-patch' },
            {
                responses: script(
                    () => completed([call('read', { path: 'package.json' })]),
                    () => completed([message('Done.')]),
                ),
            },
        );

        expect(modelCalls.map((request) => toolNames(request))).toEqual([
            ['read', 'apply_patch', 'shell'],
            ['read', 'apply_patch', 'shell'],
        ]);
        expect(developerItem(modelCalls[0])).toBe(
            `You carry out tasks on this computer. You have a shell, read for reading text files, and apply_patch for writing and changing them. The working directory is ${realCwd}, and paths that commands print are relative to it. Keep your final answer brief.`,
        );
    });

    test('with skills: activate_skill too, and the catalog ends the developer item', async () => {
        const { modelCall } = await runAgent({ SKILLS_PATH: skillsRoot });

        expect(toolNames(modelCall)).toEqual(['read', 'write', 'edit', 'shell', 'activate_skill']);
        expect(developerItem(modelCall)).toMatch(
            /^You carry out tasks on this computer\..*Keep your final answer brief\.\n\nSkills give you instructions/s,
        );
        expect(developerItem(modelCall)).toMatch(
            /<available_skills>\n<skill>\n<name>browser<\/name>\n.*<name>pdf<\/name>\n<description>Work with PDFs\.<\/description>\n<\/skill>\n<\/available_skills>$/s,
        );
    });

    test("activate_skill gives a skill's instructions, and read its files", async () => {
        const { modelCalls } = await runAgent(
            { SKILLS_PATH: skillsRoot },
            {
                responses: script(
                    () =>
                        completed([
                            call('activate_skill', { name: 'pdf' }, 'call_1'),
                            call('read', { path: join(skillsRoot, 'pdf', 'SKILL.md') }, 'call_2'),
                        ]),
                    () => completed([message('Done.')]),
                ),
            },
        );

        expect(callOutputs(modelCalls[1])).toEqual([
            expect.stringMatching(/^<skill_content name="pdf">\n# PDF\n\nSkill directory: /),
            '---\nname: pdf\ndescription: Work with PDFs.\n---\n# PDF\n',
        ]);
    });

    test('the working directory, through a symbolic link', async () => {
        const base = await mkdtemp(join(tmpdir(), 'agent-work-'));
        const real = join(await realpath(base), 'real');
        await writeIn(join(real, 'notes.txt'), 'hello');
        await symlink(real, join(base, 'link'));

        try {
            const { records, modelCall, modelCalls } = await runAgent(
                { WORK_DIR: join(base, 'link') },
                {
                    responses: script(
                        () =>
                            completed([
                                call('read', { path: 'notes.txt' }, 'call_1'),
                                call('write', { path: 'new.txt', content: 'new\n' }, 'call_2'),
                                call(
                                    'edit',
                                    {
                                        path: 'notes.txt',
                                        old_string: 'hello',
                                        new_string: 'bye',
                                        replace_all: false,
                                    },
                                    'call_3',
                                ),
                                call('shell', { command: 'pwd' }, 'call_4'),
                            ]),
                        () => completed([message('Done.')]),
                    ),
                },
            );

            expect(developerItem(modelCall)).toContain(`The working directory is ${real},`);
            expect(find(records, 'asking')).toMatchObject({ workDir: real });
            expect(callOutputs(modelCalls[1])).toEqual([
                'hello',
                'Created new.txt (1 line, 4 bytes).',
                'Replaced 1 occurrence in notes.txt.',
                `exit code: 0\nstdout:\n${real}`,
            ]);
            expect(await readFile(join(real, 'new.txt'), 'utf8')).toBe('new\n');
            expect(await readFile(join(real, 'notes.txt'), 'utf8')).toBe('bye');
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test('a relative WORK_DIR resolves against the current directory', async () => {
        await mkdir(join(cwd, 'work'), { recursive: true });

        const { records } = await runAgent({ WORK_DIR: 'work' });

        expect(find(records, 'asking')).toMatchObject({ workDir: join(realCwd, 'work') });
    });

    test('an answer after running a command', async () => {
        const { code, records, modelCalls } = await runAgent(
            {},
            {
                responses: script(
                    () => completed([call('shell', { command: 'echo 42' })]),
                    () => completed([message('\n\nIt printed 42.')]),
                ),
            },
        );

        expect(code).toBe(0);
        expect(modelCalls[1]?.body?.input).toContainEqual({
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'exit code: 0\nstdout:\n42',
        });
        expect(find(records, 'answer')).toMatchObject({ level: 'info', text: 'It printed 42.' });
    });

    test('the step limit comes from the settings', async () => {
        const { code, records, modelCalls } = await runAgent(
            { MAX_STEPS: '3' },
            {
                responses: (n) => completed([call('read', { path: 'package.json' }, `call_${n}`)]),
            },
        );

        expect(code).toBe(1);
        expect(modelCalls).toHaveLength(3);
        expect(errors(records)).toEqual([
            "The model didn't answer within 3 steps: it was still calling tools. Try a narrower task, or raise MAX_STEPS.",
        ]);
    });

    test('the step limit is required', async () => {
        const { modelCalls, records, code } = await runAgent({ MAX_STEPS: undefined });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('MAX_STEPS')]);
        expect(modelCalls).toHaveLength(0);
    });

    test('the store opens, and migrates, before any network request', async () => {
        const data = await mkdtemp(join(tmpdir(), 'agent-data-'));
        // Whether db.sqlite existed, and how many records had been logged, at the first request.
        const atFirstRequest: unknown[] = [];

        try {
            const { code, records } = await runAgent(
                { DATA_DIR: data },
                {
                    models: () => {
                        atFirstRequest.push(
                            existsSync(join(data, 'db.sqlite')),
                            vi.mocked(console.log).mock.calls.length,
                        );
                        throw new TypeError('Unable to connect');
                    },
                },
            );

            expect(code).toBe(1);
            expect(atFirstRequest).toEqual([true, 1]);
            expect(records.map((record) => record.message)).toEqual([
                'migrated',
                expect.stringMatching(/^Can't reach LM Studio at /),
            ]);
            expect(await reopen(data)).toMatchObject({ ok: true, value: { migrated: [] } });
        } finally {
            await rm(data, { recursive: true, force: true });
        }
    });

    test("a data folder the store can't open fails before any network request", async () => {
        const data = await mkdtemp(join(tmpdir(), 'agent-data-'));
        await mkdir(join(data, 'db.sqlite'));

        try {
            const { code, records, requests } = await runAgent({ DATA_DIR: data });

            expect(code).toBe(1);
            expect(errors(records)).toEqual([
                `Can't open the database at ${join(await realpath(data), 'db.sqlite')}: unable to open database file`,
            ]);
            expect(requests).toHaveLength(0);
        } finally {
            await rm(data, { recursive: true, force: true });
        }
    });

    test('the file tools refuse the data folder inside the working directory', async () => {
        const work = await mkdtemp(join(tmpdir(), 'agent-work-'));
        await mkdir(join(work, 'data'));

        try {
            const { records } = await runAgent(
                { WORK_DIR: work, DATA_DIR: join(work, 'data') },
                {
                    responses: script(
                        () =>
                            completed([
                                call('read', { path: 'data/db.sqlite' }, 'call_1'),
                                call('write', { path: 'data/x.txt', content: 'x' }, 'call_2'),
                            ]),
                        () => completed([message('I may not.')]),
                    ),
                },
            );

            expect(all(records, 'tool failed')).toMatchObject([
                {
                    tool: 'read',
                    error: '"data/db.sqlite" is inside the data folder. The read tool doesn\'t read there: it holds the agent\'s database.',
                },
                {
                    tool: 'write',
                    error: '"data/x.txt" is inside the data folder. The write tool doesn\'t write there: it holds the agent\'s database.',
                },
            ]);
            expect(existsSync(join(work, 'data', 'x.txt'))).toBe(false);
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    });
});

const leaveDaemon = (then: () => Response): FakeServer => {
    return {
        responses: script(
            () => completed([call('shell', { command: helperCommand('leave', 'ignore') })]),
            then,
        ),
    };
};

const daemonOf = (request: RecordedRequest | undefined): number => {
    const [output] = callOutputs(request);

    return track(Number(/stdout:\n(\d+)$/.exec(String(output))?.[1]));
};

const anthropicSettings: Settings = {
    MODEL_PROVIDER: 'anthropic',
    MODEL_BASE_URL: 'https://api.anthropic.test',
    MODEL_API_KEY: 'key',
    MODEL: 'claude-test',
    MODEL_REASONING_EFFORT: 'medium',
    MODEL_MAX_OUTPUT_TOKENS: '4096',
};

describe("Stop the session's processes when the agent ends", { timeout: 15_000 }, () => {
    test('a process left behind is stopped, once', async () => {
        const { code, records, modelCalls } = await runAgent(
            {},
            leaveDaemon(() => completed([message('Started it.')])),
        );
        const daemon = daemonOf(modelCalls[1]);

        expect(code).toBe(0);
        expect(all(records, 'stopped')).toEqual([
            expect.objectContaining({ level: 'info', count: 1 }),
        ]);
        expect(isGone(daemon)).toBe(true);
    });

    test('a process left behind by Claude is stopped', async () => {
        const { code, records, modelCalls } = await runAgent(anthropicSettings, {
            messages: script(
                () =>
                    claudeReply({
                        name: 'shell',
                        args: { command: helperCommand('leave', 'ignore') },
                    }),
                () => claudeReply({ text: 'Started it.' }),
            ),
        });
        const daemon = daemonOf(modelCalls[1]);

        expect(code).toBe(0);
        expect(all(records, 'stopped')).toEqual([
            expect.objectContaining({ level: 'info', count: 1 }),
        ]);
        expect(isGone(daemon)).toBe(true);
    });

    test.each([
        ['SIGINT', 130],
        ['SIGTERM', 143],
        ['SIGHUP', 129],
    ] as const)('%s during the session', async (signal, code) => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const pending = heldModelCall();
        const started = startAgent({}, leaveDaemon(pending.response));
        await vi.waitFor(
            () => {
                expect(started.modelCalls()).toHaveLength(2);
            },
            { timeout: 4000, interval: 20 },
        );
        const daemon = daemonOf(started.modelCalls()[1]);

        process.emit(signal, signal);
        await vi.waitFor(
            () => {
                expect(exit).toHaveBeenCalled();
            },
            { timeout: 4000, interval: 20 },
        );
        await pending.release([message('Too late.')]);
        await started.done;
        const records = started.records();

        expect(exit).toHaveBeenCalledExactlyOnceWith(code);
        expect(process.exitCode).toBe(code);
        expect(all(records, 'interrupted')).toEqual([
            expect.objectContaining({ level: 'warn', signal }),
        ]);
        expect(all(records, 'stopped')).toEqual([expect.objectContaining({ count: 1 })]);
        expect(find(records, 'answer')).toBeUndefined();
        expect(isGone(daemon)).toBe(true);
    });

    test('Ctrl-C twice', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const pending = heldModelCall();
        const started = startAgent({}, { responses: pending.response });
        await vi.waitFor(
            () => {
                expect(started.modelCalls()).toHaveLength(1);
            },
            { timeout: 4000, interval: 20 },
        );

        process.emit('SIGINT', 'SIGINT');
        process.emit('SIGINT', 'SIGINT');
        await vi.waitFor(
            () => {
                expect(exit).toHaveBeenCalled();
            },
            { timeout: 4000, interval: 20 },
        );
        await pending.release([message('Too late.')]);
        await started.done;

        expect(exit).toHaveBeenCalledExactlyOnceWith(130);
        expect(all(started.records(), 'interrupted')).toHaveLength(1);
    });

    test('a signal while the processes are being stopped is ignored', async () => {
        const bin = await mkdtemp(join(tmpdir(), 'agent-ps-'));
        const listing = join(bin, 'listing');
        // A ps that says when the sweep has started, then takes its time.
        await writeFile(
            join(bin, 'ps'),
            `#!/bin/sh\n/usr/bin/touch '${listing}'\n/bin/sleep 0.5\nexec /bin/ps "$@"\n`,
            { mode: 0o755 },
        );
        vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

        try {
            const started = startAgent();
            await vi.waitFor(() => stat(listing), { timeout: 4000, interval: 20 });

            process.emit('SIGINT', 'SIGINT');
            await started.done;
            const records = started.records();

            expect(exit).not.toHaveBeenCalled();
            expect(process.exitCode).toBe(0);
            expect(find(records, 'answer')).toMatchObject({ text: 'Hi there!' });
            expect(find(records, 'interrupted')).toBeUndefined();
        } finally {
            await rm(bin, { recursive: true, force: true });
        }
    });

    test('no handler outlives the agent', async () => {
        const before = SIGNALS.map((signal) => process.listenerCount(signal));

        await runAgent();

        expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
    });

    // A clean close removes the -wal and -shm files.
    test.each([
        ['an answer', 0, {}],
        ['a failure', 1, { responses: () => httpError(500, 'model crashed') }],
    ] as const)('the store is closed after %s', async (_after, code, server) => {
        const data = await mkdtemp(join(tmpdir(), 'agent-data-'));

        try {
            const run = await runAgent({ DATA_DIR: data }, server);

            expect(run.code).toBe(code);
            expect(existsSync(join(data, 'db.sqlite-wal'))).toBe(false);
            expect(existsSync(join(data, 'db.sqlite-shm'))).toBe(false);
            expect(await reopen(data)).toMatchObject({ ok: true, value: { migrated: [] } });
        } finally {
            await rm(data, { recursive: true, force: true });
        }
    });

    test('the store is closed after SIGINT', async () => {
        const data = await mkdtemp(join(tmpdir(), 'agent-data-'));
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const pending = heldModelCall();

        try {
            const started = startAgent({ DATA_DIR: data }, { responses: pending.response });
            await vi.waitFor(
                () => {
                    expect(started.modelCalls()).toHaveLength(1);
                },
                { timeout: 4000, interval: 20 },
            );

            process.emit('SIGINT', 'SIGINT');
            await vi.waitFor(
                () => {
                    expect(exit).toHaveBeenCalled();
                },
                { timeout: 4000, interval: 20 },
            );
            const closed = [
                existsSync(join(data, 'db.sqlite-wal')),
                existsSync(join(data, 'db.sqlite-shm')),
            ];
            await pending.release([message('Too late.')]);
            await started.done;

            expect(exit).toHaveBeenCalledExactlyOnceWith(130);
            expect(closed).toEqual([false, false]);
            expect(await reopen(data)).toMatchObject({ ok: true, value: { migrated: [] } });
        } finally {
            await rm(data, { recursive: true, force: true });
        }
    });

    test("the sweep can't run", async () => {
        const empty = await mkdtemp(join(tmpdir(), 'agent-path-'));
        vi.stubEnv('PATH', empty);

        try {
            const { code, records } = await runAgent();

            expect(code).toBe(0);
            expect(find(records, 'cleanup failed')).toMatchObject({
                level: 'warn',
                error: expect.stringMatching(/^ps couldn't be started: /),
            });
        } finally {
            await rm(empty, { recursive: true, force: true });
        }
    });
});

describe('Log each model call and tool call', () => {
    test('the records of a tool round trip', async () => {
        const { records, runId } = await runAgent({}, readThenAnswer);

        expect(records).toMatchObject([
            {
                level: 'info',
                message: 'asking',
                model: 'prism-ml/bonsai-27b',
                baseUrl: 'http://127.0.0.1:1234/v1',
                run: runId,
                workDir: realCwd,
                task: TEST_TASK,
            },
            {
                level: 'info',
                message: 'model call',
                step: 1,
                providerStats: {
                    provider: 'lmstudio',
                    usage: {
                        kind: 'complete',
                        value: {
                            input_tokens: 349,
                            input_tokens_details: { cached_tokens: 256, cache_write_tokens: 0 },
                            output_tokens: 26,
                            output_tokens_details: { reasoning_tokens: 12 },
                            total_tokens: 375,
                        },
                    },
                    rateLimits: {},
                },
                seconds: 1.5,
            },
            {
                level: 'info',
                message: 'tool call',
                tool: 'read',
                arguments: { path: 'package.json' },
            },
            {
                level: 'info',
                message: 'tool result',
                tool: 'read',
                bytes: Buffer.byteLength(PACKAGE_JSON),
            },
            { level: 'info', message: 'model call', step: 2 },
            { level: 'info', message: 'answer', text: 'It runs the checks.' },
        ]);
        expect(records).toHaveLength(6);
        expect(records.every((record) => !Number.isNaN(Date.parse(record.time)))).toBe(true);
    });

    test('Claude statistics appear in both JSON and pretty logs without the API key', async () => {
        const json = await runAgent(anthropicSettings, {
            messages: () => claudeReply({ text: 'Done' }),
        });

        expect(json.code).toBe(0);
        expect(find(json.records, 'model call')).toMatchObject({
            providerStats: {
                provider: 'anthropic',
                usage: {
                    kind: 'complete',
                    value: {
                        input_tokens: 10,
                        output_tokens: 2,
                        cache_read_input_tokens: 0,
                        cache_creation_input_tokens: 0,
                    },
                },
            },
        });
        expect(json.output).not.toContain('"apiKey"');
        const pretty = await runAgent(
            { ...anthropicSettings, LOG_FORMAT: 'pretty' },
            { messages: () => claudeReply({ text: 'Done' }) },
        );

        expect(pretty.code).toBe(0);
        expect(pretty.output).toContain('providerStats={"provider":"anthropic"');
        expect(pretty.output).toContain('"cache_read_input_tokens":0');
    });

    test('the asking record', async () => {
        const work = await mkdtemp(join(tmpdir(), 'agent-asking-'));
        const data = await mkdtemp(join(tmpdir(), 'agent-data-'));

        try {
            const { records, runId } = await runAgent({ WORK_DIR: work, DATA_DIR: data }, {}, [
                'Say',
                'hi',
            ]);

            expect(runId).toMatch(/^[0-9a-f]{8}$/);
            expect(find(records, 'asking')).toEqual({
                time: expect.any(String),
                level: 'info',
                message: 'asking',
                model: 'prism-ml/bonsai-27b',
                baseUrl: 'http://127.0.0.1:1234/v1',
                run: runId,
                workDir: await realpath(work),
                dataDir: await realpath(data),
                task: 'Say hi',
            });
        } finally {
            await rm(work, { recursive: true, force: true });
            await rm(data, { recursive: true, force: true });
        }
    });

    test('the migrated record, logged before asking, on the first run only', async () => {
        const data = await mkdtemp(join(tmpdir(), 'agent-data-'));

        try {
            const first = await runAgent({ DATA_DIR: data });
            const second = await runAgent({ DATA_DIR: data });

            expect(first.records.slice(0, 2)).toEqual([
                {
                    time: expect.any(String),
                    level: 'info',
                    message: 'migrated',
                    names: ['CreateCredential1793232000000', 'CreateMcpServer1793318400000'],
                },
                expect.objectContaining({ message: 'asking' }),
            ]);
            expect(second.records[0]).toMatchObject({ message: 'asking' });
            expect(find(second.records, 'migrated')).toBeUndefined();
        } finally {
            await rm(data, { recursive: true, force: true });
        }
    });

    test('the skills record, before the asking record', async () => {
        const { records } = await runAgent({ SKILLS_PATH: skillsRoot });

        expect(records.slice(0, 2)).toMatchObject([
            { level: 'info', message: 'skills', names: ['browser', 'pdf'] },
            { message: 'asking' },
        ]);
    });

    test('skills not loaded, and their warnings', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-broken-')));
        await writeIn(join(root, 'broken', 'SKILL.md'), '# Broken\n');
        await writeIn(
            join(root, 'pdf-tools', 'SKILL.md'),
            '---\nname: pdf\ndescription: Work with PDFs.\n---\n',
        );
        const missing = join(root, 'missing');

        try {
            const { records } = await runAgent({ SKILLS_PATH: `${missing}:${root}` });

            expect(records.filter((record) => record.level === 'warn')).toEqual([
                {
                    time: expect.any(String),
                    level: 'warn',
                    message: 'skill not loaded',
                    path: missing,
                    reason: expect.stringContaining("the skills root can't be read"),
                },
                {
                    time: expect.any(String),
                    level: 'warn',
                    message: 'skill not loaded',
                    path: join(root, 'broken', 'SKILL.md'),
                    reason: 'it has no frontmatter: SKILL.md must start with a --- line',
                },
                {
                    time: expect.any(String),
                    level: 'warn',
                    message: 'skill warning',
                    skill: 'pdf',
                    warning: "its name, pdf, differs from its directory's, pdf-tools",
                },
            ]);
            expect(find(records, 'skills')).toMatchObject({ names: ['pdf'] });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test('sizes are in bytes, not characters', async () => {
        const { records } = await runAgent(
            {},
            {
                responses: script(
                    () => completed([call('read', { path: 'menu.txt' })]),
                    () => completed([message('A café crème costs 3 €.')]),
                ),
            },
        );

        expect(Buffer.byteLength(MENU)).toBeGreaterThan(MENU.length);
        expect(find(records, 'tool result')).toMatchObject({ bytes: Buffer.byteLength(MENU) });
    });

    test('a failed call is a warning carrying its error', async () => {
        const { records } = await runAgent(
            {},
            {
                responses: script(
                    () => completed([call('read', { path: '.env' })]),
                    () => completed([message("I can't read that.")]),
                ),
            },
        );

        expect(find(records, 'tool failed')).toMatchObject({
            level: 'warn',
            tool: 'read',
            error: '".env" is an environment file. The read tool doesn\'t read those: they hold secrets.',
        });
    });

    test("arguments that don't parse are logged as the model sent them", async () => {
        const { records } = await runAgent(
            {},
            {
                responses: script(
                    () => completed([call('read', '{"path": "package.json"')]),
                    () => completed([message('Sorry.')]),
                ),
            },
        );

        expect(find(records, 'tool call')).toMatchObject({ arguments: '{"path": "package.json"' });
    });

    test('a model call without usage still reports its time', async () => {
        const noUsage = new Response(
            `event: response.completed\ndata: ${JSON.stringify({
                type: 'response.completed',
                response: {
                    id: 'r',
                    object: 'response',
                    status: 'completed',
                    output: [message('Hi.')],
                },
            })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
        );
        const { records } = await runAgent({}, { responses: () => noUsage });

        expect(find(records, 'model call')).toEqual({
            time: expect.any(String),
            level: 'info',
            message: 'model call',
            step: 1,
            providerStats: { provider: 'lmstudio', usage: { kind: 'unavailable' }, rateLimits: {} },
            seconds: 1.5,
        });
    });

    test('usage without token details leaves those out', async () => {
        // Some OpenAI-compatible servers report only the totals.
        const totals = { input_tokens: 10, output_tokens: 5, total_tokens: 15 } as ResponseUsage;
        const { records } = await runAgent(
            {},
            { responses: () => completed([message('Hi.')], totals) },
        );

        expect(find(records, 'model call')).toEqual({
            time: expect.any(String),
            level: 'info',
            message: 'model call',
            step: 1,
            providerStats: {
                provider: 'lmstudio',
                usage: {
                    kind: 'partial',
                    value: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
                },
                rateLimits: {},
            },
            seconds: 1.5,
        });
    });

    test('a failed model call logs reported usage before the final error', async () => {
        const reported = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
        const incomplete = new Response(
            `event: response.incomplete\ndata: ${JSON.stringify({
                type: 'response.incomplete',
                response: {
                    status: 'incomplete',
                    output: [],
                    usage: reported,
                    incomplete_details: { reason: 'max_output_tokens' },
                },
            })}\n\n`,
            {
                headers: {
                    'content-type': 'text/event-stream',
                    'x-ratelimit-remaining-tokens': '42',
                },
            },
        );
        const { code, records } = await runAgent({}, { responses: () => incomplete });

        expect(code).toBe(1);
        expect(records.map((record) => record.message)).toEqual([
            'asking',
            'model call',
            expect.stringContaining('stopped before finishing'),
        ]);
        expect(find(records, 'model call')).toMatchObject({
            providerStats: {
                provider: 'lmstudio',
                usage: { kind: 'partial', value: reported },
                rateLimits: { 'x-ratelimit-remaining-tokens': '42' },
            },
        });
        expect(find(records, 'answer')).toBeUndefined();
    });
});

describe('Formatted output when selected', () => {
    test('pretty records expose the full provider statistics', async () => {
        const { output, runId } = await runAgent({ LOG_FORMAT: 'pretty' }, readThenAnswer);
        const lines = output.trim().split('\n');

        expect(lines.every((line) => /^\d\d:\d\d:\d\d (INFO |WARN |ERROR) /.test(line))).toBe(true);
        expect(lines[0]).toContain(`run=${runId}`);
        expect(lines.filter((line) => line.includes('model call'))).toHaveLength(2);
        expect(lines[1]).toContain('providerStats={"provider":"lmstudio"');
        expect(lines[1]).toContain('"cache_write_tokens":0');
        expect(lines.at(-1)).toContain('answer text="It runs the checks."');
    });

    test('an unknown LOG_FORMAT fails before anything else', async () => {
        const { code, output, requests } = await runAgent({ LOG_FORMAT: 'xml' });

        expect(code).toBe(1);
        expect(output).toMatch(
            /^\d\d:\d\d:\d\d ERROR LOG_FORMAT must be one of pretty, json; got "xml"\.\n$/,
        );
        expect(requests).toHaveLength(0);
    });

    test('an invalid LOG_FORMAT does not hide other startup errors', async () => {
        const { code, output, requests } = await runAgent({
            LOG_FORMAT: 'xml',
            MAX_STEPS: '0',
            WORK_DIR: 'missing',
        });

        expect(code).toBe(1);
        expect(output).toContain('LOG_FORMAT');
        expect(output).toContain('MAX_STEPS');
        expect(output).toContain('WORK_DIR');
        expect(requests).toHaveLength(0);
    });

    test('LOG_FORMAT is trimmed, as every setting is', async () => {
        const { output } = await runAgent({ LOG_FORMAT: ' json ' }, readThenAnswer);
        const messages = output
            .trim()
            .split('\n')
            .map((line) => (JSON.parse(line) as LogRecord).message);

        expect(messages).toEqual([
            'asking',
            'model call',
            'tool call',
            'tool result',
            'model call',
            'answer',
        ]);
    });
});

describe('Read the configuration from the environment, and validate it at start-up', () => {
    test.each(['0', '-1', '2.5', 'lots'])('an invalid step limit: %j', async (value) => {
        const { code, records, requests } = await runAgent({ MAX_STEPS: value });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('MAX_STEPS')]);
        expect(requests).toHaveLength(0);
    });

    test.each([
        ['without MAX_STEPS', { MAX_TURNS: '5' }],
        ['with MAX_STEPS', { MAX_TURNS: '5', MAX_STEPS: '12' }],
    ])("the step limit's former name, %s", async (_with, env) => {
        const { code, records, requests } = await runAgent(env);

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            'MAX_TURNS is now MAX_STEPS; rename it in your settings.',
        ]);
        expect(requests).toHaveLength(0);
    });

    test.each([
        ['a path that does not exist', 'missing'],
        ['a file', 'package.json'],
    ])('a working directory that is %s', async (_kind, workDir) => {
        const { code, records, requests } = await runAgent({ WORK_DIR: workDir });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            `WORK_DIR must name an existing directory; ${join(cwd, workDir)} isn't one.`,
        ]);
        expect(requests).toHaveLength(0);
    });

    test('every problem is reported', async () => {
        const { code, records, requests } = await runAgent({
            MODEL_PROVIDER: 'openai',
            MODEL_API_KEY: undefined,
            MODEL: undefined,
            WORK_DIR: 'missing',
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('MODEL_API_KEY is required'),
            expect.stringContaining('MODEL is required'),
            expect.stringContaining('WORK_DIR'),
        ]);
        expect(requests).toHaveLength(0);
    });

    test('an invalid file tools setting', async () => {
        const { code, records, requests } = await runAgent({ FILE_TOOLS: 'both' });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            'FILE_TOOLS must be one of write-edit, apply-patch; got "both".',
        ]);
        expect(requests).toHaveLength(0);
    });

    test('the data folder is required', async () => {
        const { code, records, requests } = await runAgent({ DATA_DIR: undefined });

        expect(code).toBe(1);
        expect(errors(records)).toEqual(['DATA_DIR is required.']);
        expect(requests).toHaveLength(0);
    });

    test.each([
        ['a path that does not exist', 'missing'],
        ['a file', 'package.json'],
    ])('a data folder that is %s', async (_kind, data) => {
        const { code, records, requests } = await runAgent({ DATA_DIR: data });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            `DATA_DIR must name an existing directory; ${join(cwd, data)} isn't one.`,
        ]);
        expect(requests).toHaveLength(0);
    });

    test('a relative data folder resolves against the current directory', async () => {
        await mkdir(join(cwd, 'data'), { recursive: true });

        const { records } = await runAgent({ DATA_DIR: 'data' });

        expect(find(records, 'asking')).toMatchObject({ dataDir: join(realCwd, 'data') });
        expect(existsSync(join(cwd, 'data', 'db.sqlite'))).toBe(true);
    });

    test('a data folder given through a link: the store opens in its real path', async () => {
        const base = await mkdtemp(join(tmpdir(), 'agent-data-'));
        const real = join(await realpath(base), 'real');
        await mkdir(real);
        await symlink(real, join(base, 'link'));

        try {
            const { records } = await runAgent({ DATA_DIR: join(base, 'link') });

            expect(find(records, 'asking')).toMatchObject({ dataDir: real });
            expect(existsSync(join(real, 'db.sqlite'))).toBe(true);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test.each([
        ['the working directory', 'work', '.'],
        ['a directory that holds it', 'work', '..'],
    ])('a data folder that is %s', async (_kind, work, data) => {
        await mkdir(join(cwd, work), { recursive: true });

        const { code, records, requests } = await runAgent({
            WORK_DIR: work,
            DATA_DIR: join(work, data),
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            `DATA_DIR must not be or contain WORK_DIR, since the file tools refuse everything in the data folder: DATA_DIR is ${join(realCwd, work, data)}, and WORK_DIR is ${join(realCwd, work)}.`,
        ]);
        expect(requests).toHaveLength(0);
    });
});

describe('Actionable failure messages', () => {
    test('no answer', async () => {
        const { code, records } = await runAgent(
            {},
            { responses: script(() => completed([reasoning()])) },
        );

        expect(code).toBe(1);
        expect(find(records, 'answer')).toBeUndefined();
        expect(errors(records)).toEqual([
            'The model gave no answer: its reply had neither text nor tool calls. Try again, or rephrase the task.',
        ]);
    });

    test("an item the SDK can't replay", async () => {
        const strange = { type: 'made_up' } as unknown as ResponseOutputItem;
        const { code, records } = await runAgent(
            {},
            {
                responses: script(() =>
                    completed([strange, call('read', { path: 'package.json' })]),
                ),
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringMatching(/^The conversation can't be continued \(.*made_up/),
        ]);
    });

    test('a failed model call', async () => {
        const { code, records } = await runAgent(
            {},
            { responses: () => httpError(500, 'model crashed') },
        );

        expect(code).toBe(1);
        expect(find(records, 'answer')).toBeUndefined();
        expect(errors(records)).toEqual([
            'The model server at http://127.0.0.1:1234/v1 failed the request (500 model crashed). Try again; if it keeps failing, check its logs or status page.',
        ]);
    });

    test('a rate-limited model call', async () => {
        const { code, records } = await runAgent(
            {},
            { responses: () => httpError(429, 'slow down') },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            "The model server at http://127.0.0.1:1234/v1 is limiting requests (429 slow down). Wait a minute and try again; if it keeps happening, check the account's quota.",
        ]);
    });

    test('a failed model call without a status', async () => {
        const { code, records } = await runAgent(
            {},
            {
                responses: () =>
                    new Response(
                        `event: response.failed\ndata: ${JSON.stringify({
                            type: 'response.failed',
                            response: {
                                id: 'r',
                                object: 'response',
                                status: 'failed',
                                output: [],
                                error: { code: 'server_error', message: 'it broke' },
                            },
                        })}\n\n`,
                        { headers: { 'content-type': 'text/event-stream' } },
                    ),
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            'The model server at http://127.0.0.1:1234/v1 failed the request (server_error: it broke). Try again; if it keeps failing, check its logs or status page.',
        ]);
    });

    test('LM Studio stops during the session', async () => {
        const { code, records } = await runAgent(
            {},
            {
                responses: () => {
                    throw new TypeError('Unable to connect');
                },
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            "Can't reach LM Studio at http://127.0.0.1:1234/v1 (Connection error. (Unable to connect)). Is its server running? Start it with `lms server start`, or set MODEL_BASE_URL.",
        ]);
    });

    test("another provider that can't be reached", async () => {
        const { code, records } = await runAgent(
            {
                MODEL_PROVIDER: 'openai',
                MODEL_BASE_URL: 'https://api.openai.com/v1',
                MODEL_API_KEY: 'sk-test',
                MODEL: 'gpt-test',
            },
            {
                responses: () => {
                    throw new TypeError('Unable to connect');
                },
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            "Can't reach https://api.openai.com/v1 (Connection error. (Unable to connect)). Check MODEL_BASE_URL.",
        ]);
    });
});

describe('run with explicitly configured LM Studio', () => {
    test('asks the loaded model and logs its answer', async () => {
        const { code, records, modelCall } = await runAgent();

        expect(code).toBe(0);
        expect(find(records, 'answer')).toMatchObject({ text: 'Hi there!' });
        // With one model loaded there's no note about the choice: the first record is the task.
        expect(records[0]).toMatchObject({ message: 'asking', model: 'prism-ml/bonsai-27b' });
        expect(modelCall?.url).toBe('http://127.0.0.1:1234/v1/responses');
        expect(modelCall?.body).toMatchObject({
            model: 'prism-ml/bonsai-27b',
            reasoning: { effort: 'none' },
            stream: true,
            store: false,
        });
    });

    test('passes the configured reasoning effort through', async () => {
        const { code, modelCall } = await runAgent({ MODEL_REASONING_EFFORT: 'low' });

        expect(code).toBe(0);
        expect(modelCall?.body).toMatchObject({ reasoning: { effort: 'low' } });
    });

    test('invalid config fails before any network call', async () => {
        const { code, records, requests } = await runAgent({ MODEL_BASE_URL: 'lmstudio' });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('MODEL_BASE_URL')]);
        expect(requests).toHaveLength(0);
    });

    test('an unreachable LM Studio fails with a hint', async () => {
        const { code, records } = await runAgent(
            {},
            {
                models: () => {
                    throw new TypeError('Unable to connect');
                },
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('lms server start')]);
    });

    test("a rejected key fails with LM Studio's hint", async () => {
        const { code, records } = await runAgent(
            {},
            { models: () => new Response('denied', { status: 401 }) },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringMatching(
                /Require Authentication.*MODEL_API_KEY|MODEL_API_KEY.*Require Authentication/,
            ),
        ]);
    });

    test("a configured model that isn't loaded isn't called", async () => {
        const { code, records, modelCall } = await runAgent({
            MODEL: 'qwen2.5-0.5b-instruct-mlx',
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('lms load qwen2.5-0.5b-instruct-mlx'),
        ]);
        expect(modelCall).toBeUndefined();
    });

    test('with several models loaded, uses the explicitly named model', async () => {
        const twoLoaded = {
            models: [
                {
                    type: 'llm',
                    key: 'prism-ml/bonsai-27b',
                    loaded_instances: [{ id: 'prism-ml/bonsai-27b' }],
                },
                {
                    type: 'llm',
                    key: 'qwen2.5-0.5b-instruct-mlx',
                    loaded_instances: [{ id: 'qwen2.5-0.5b-instruct-mlx' }],
                },
            ],
        };
        const { code, records, modelCall } = await runAgent(
            {},
            { models: () => Response.json(twoLoaded) },
        );

        expect(code).toBe(0);
        expect(records[0]).toMatchObject({
            level: 'info',
            message: 'asking',
            model: 'prism-ml/bonsai-27b',
        });
        expect(modelCall?.body).toMatchObject({ model: 'prism-ml/bonsai-27b' });
    });
});

describe('run with another OpenAI-compatible provider', () => {
    const openai = {
        MODEL_PROVIDER: 'openai',
        MODEL_BASE_URL: 'https://api.openai.com/v1',
        MODEL_API_KEY: 'sk-test',
        MODEL: 'gpt-test',
        MODEL_REASONING_EFFORT: 'low',
    };

    test('uses the named model and explicit effort without asking LM Studio', async () => {
        const { code, records, requests, modelCall } = await runAgent(openai);

        expect(code).toBe(0);
        expect(find(records, 'answer')).toMatchObject({ text: 'Hi there!' });
        expect(requests.some((request) => request.url.endsWith('/api/v1/models'))).toBe(false);
        expect(modelCall).toMatchObject({
            url: 'https://api.openai.com/v1/responses',
            authorization: 'Bearer sk-test',
            body: { model: 'gpt-test' },
        });
        expect(modelCall?.body).toHaveProperty('reasoning', { effort: 'low' });
    });

    test('needs MODEL and MODEL_API_KEY, and fails before any network call', async () => {
        const { code, records, requests } = await runAgent({
            MODEL_PROVIDER: 'openai',
            MODEL_API_KEY: undefined,
            MODEL: undefined,
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('MODEL_API_KEY is required'),
            expect.stringContaining('MODEL is required'),
        ]);
        expect(requests).toHaveLength(0);
    });

    test('a rejected key points at MODEL_API_KEY, not at LM Studio', async () => {
        const { code, records } = await runAgent(openai, {
            responses: () => httpError(401, 'bad key'),
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('MODEL_API_KEY')]);
        expect(errors(records)[0]).not.toContain('LM Studio');
    });

    test('a forbidden key reports its own status', async () => {
        const { code, records } = await runAgent(openai, {
            responses: () => httpError(403, 'forbidden'),
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('rejected the API key (HTTP 403)'),
        ]);
    });
});

const FAKE_MCP = fileURLToPath(new URL('../mcp/stdio-server.ts', import.meta.url));

const MCP_TIMEOUTS = { startupTimeoutMs: 10_000, toolTimeoutMs: 10_000 };

const PROXIES = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
];

type FakeMcp = {
    readonly mode?: string;
    readonly tools?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly entry?: Readonly<Record<string, unknown>>;
    readonly disabled?: boolean;
};

// A server of the fake stdio kind, as the store keeps it. A $ in an entry's value is written $$.
const fakeMcp = (
    name: string,
    { mode = 'serve', tools = [], env = {}, entry = {}, disabled = false }: FakeMcp = {},
): NewMcpServer => {
    const pages = [
        { tools: tools.map((tool) => ({ name: tool, inputSchema: { type: 'object' } })) },
    ];

    return {
        name,
        prefix: name.toLowerCase(),
        entry: {
            command: process.execPath,
            args: [FAKE_MCP, mode],
            env: { FAKE_PAGES: JSON.stringify(pages).replaceAll('$', '$$$$'), ...env },
            ...MCP_TIMEOUTS,
            ...entry,
        },
        disabled,
    };
};

// A data folder, migrated, that holds the servers.
const dataWithServers = async (servers: readonly NewMcpServer[]): Promise<string> => {
    const folder = await mkdtemp(join(tmpdir(), 'agent-data-'));
    const opened = await openStore(folder);

    if (!opened.ok) {
        throw new Error(opened.error);
    }

    for (const server of servers) {
        await addMcpServer(opened.value.store, server);
    }

    await closeStore(opened.value.store);

    return folder;
};

// The processes that carry the run's ID, as ps shows them.
const processesOf = (runId: string): number[] => {
    return listProcesses()
        .filter(({ text }) => text.includes(` GREMLIN_RUN_ID=${runId}`))
        .map(({ pid }) => pid);
};

// The run's directories for stdio servers in the temporary directory the test chose.
const runDirectories = async (temporary: string): Promise<string[]> => {
    return (await readdir(temporary)).filter((name) => name.startsWith('gremlin-mcp-'));
};

describe('MCP servers in a run', { timeout: 20_000 }, () => {
    let folders: string[] = [];
    let temporary: string;

    const tracked = async (folder: Promise<string>): Promise<string> => {
        const path = await folder;
        folders.push(path);

        return path;
    };

    beforeAll(async () => {
        temporary = await realpath(await mkdtemp(join(tmpdir(), 'agent-tmp-')));
    });

    afterAll(async () => {
        await rm(temporary, { recursive: true, force: true });
    });

    afterEach(async () => {
        await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
        folders = [];
    });

    const prepare = (): void => {
        vi.stubEnv('TMPDIR', temporary);

        for (const name of PROXIES) {
            vi.stubEnv(name, undefined);
        }

        vi.stubEnv('NO_PROXY', '127.0.0.1,localhost');
    };

    test('MCP tools after the built-in ones, not strict', async () => {
        prepare();
        const data = await tracked(dataWithServers([fakeMcp('docs', { tools: ['search'] })]));

        const { code, modelCall } = await runAgent({ DATA_DIR: data });

        expect(code).toBe(0);
        expect(toolNames(modelCall)).toEqual([
            'read',
            'write',
            'edit',
            'shell',
            'mcp__docs__search',
        ]);
        expect(modelCall?.body?.tools).toContainEqual(
            expect.objectContaining({ name: 'mcp__docs__search', strict: false }),
        );
    });

    test("the servers' records, in name order, before asking", async () => {
        prepare();
        const data = await tracked(
            dataWithServers([fakeMcp('b', { tools: ['x'] }), fakeMcp('a', { tools: ['y'] })]),
        );

        const { records } = await runAgent({ DATA_DIR: data });

        expect(records.slice(0, 3)).toMatchObject([
            { level: 'info', message: 'mcp server', name: 'a', tools: ['mcp__a__y'] },
            { level: 'info', message: 'mcp server', name: 'b', tools: ['mcp__b__x'] },
            { message: 'asking' },
        ]);
    });

    test('a disabled server is not started, and none of its tools is offered', async () => {
        prepare();
        const data = await tracked(
            dataWithServers([fakeMcp('docs', { tools: ['search'], disabled: true })]),
        );

        const { code, records, modelCall, runId } = await runAgent({ DATA_DIR: data });

        expect(code).toBe(0);
        expect(toolNames(modelCall)).toEqual(['read', 'write', 'edit', 'shell']);
        expect(find(records, 'mcp server')).toBeUndefined();
        expect(processesOf(runId)).toEqual([]);
    });

    test("MCP servers that can't be listed fail the run before any request", async () => {
        prepare();
        const data = await tracked(dataWithServers([]));
        const opened = await openStore(data);

        if (opened.ok) {
            await withDataSource(opened.value.store, 'drop the table', (dataSource) => {
                return dataSource.query('DROP TABLE mcp_server');
            });
            await closeStore(opened.value.store);
        }

        const { code, records, requests } = await runAgent({ DATA_DIR: data });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            `Can't list the MCP servers in the database at ${join(await realpath(data), 'db.sqlite')}: SqliteError: no such table: mcp_server`,
        ]);
        expect(requests).toEqual([]);
    });

    test('an unset reference fails the run before any request, and the store is closed', async () => {
        prepare();
        const data = await tracked(
            dataWithServers([fakeMcp('docs', { env: { DOCS_TOKEN: '${DOCS_TOKEN_NOT_SET}' } })]),
        );

        const { code, records, requests } = await runAgent({ DATA_DIR: data });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            "The MCP server docs can't start. It refers to DOCS_TOKEN_NOT_SET, which is unset or blank: set it in .env. To run without it: bun run mcp disable docs.",
        ]);
        expect(requests).toEqual([]);
        expect(existsSync(join(data, 'db.sqlite-wal'))).toBe(false);
    });

    test('a server that fails to start fails the run, and the store is closed', async () => {
        prepare();
        const data = await tracked(
            dataWithServers([fakeMcp('docs', { mode: 'exit', env: { FAKE_EXIT: '3' } })]),
        );

        const { code, records, modelCalls } = await runAgent({ DATA_DIR: data });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            "The MCP server docs couldn't start: it exited with code 3 before it was ready.\nTo run without it: bun run mcp disable docs.",
        ]);
        expect(modelCalls).toEqual([]);
        expect(existsSync(join(data, 'db.sqlite-wal'))).toBe(false);
        expect(existsSync(join(data, 'db.sqlite-shm'))).toBe(false);
        expect(await reopen(data)).toMatchObject({ ok: true, value: { migrated: [] } });
        expect(await runDirectories(temporary)).toEqual([]);
    });

    test("the servers are closed first: none of a server's processes left, and its directory gone", async () => {
        prepare();
        const data = await tracked(dataWithServers([fakeMcp('docs', { tools: ['cwd'] })]));

        const { code, records, runId } = await runAgent(
            { DATA_DIR: data },
            {
                responses: script(
                    () => completed([call('mcp__docs__cwd', {})]),
                    () => completed([message('Done.')]),
                ),
            },
        );

        expect(code).toBe(0);
        expect(find(records, 'tool result')).toMatchObject({ tool: 'mcp__docs__cwd' });
        expect(find(records, 'stopped')).toBeUndefined();
        expect(processesOf(runId)).toEqual([]);
        expect(await runDirectories(temporary)).toEqual([]);
    });

    test('SIGINT during the session closes the servers first too', async () => {
        prepare();
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const pending = heldModelCall();
        const data = await tracked(dataWithServers([fakeMcp('docs', { tools: ['search'] })]));
        const started = startAgent({ DATA_DIR: data }, { responses: pending.response });
        await vi.waitFor(
            () => {
                expect(started.modelCalls()).toHaveLength(1);
            },
            { timeout: 8000, interval: 20 },
        );
        const running = processesOf(started.runId);

        process.emit('SIGINT', 'SIGINT');
        await vi.waitFor(
            () => {
                expect(exit).toHaveBeenCalled();
            },
            { timeout: 8000, interval: 20 },
        );
        await pending.release([message('Too late.')]);
        await started.done;

        expect(running).not.toEqual([]);
        expect(exit).toHaveBeenCalledExactlyOnceWith(130);
        expect(find(started.records(), 'stopped')).toBeUndefined();
        expect(processesOf(started.runId)).toEqual([]);
        expect(await runDirectories(temporary)).toEqual([]);
    });

    test('a signal while the servers connect: no error about them, nothing left, exit 143', async () => {
        prepare();
        const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
        const data = await tracked(dataWithServers([fakeMcp('slow', { mode: 'silent' })]));
        const started = startAgent({ DATA_DIR: data });
        await vi.waitFor(
            async () => {
                expect(processesOf(started.runId)).not.toEqual([]);
                expect(await runDirectories(temporary)).not.toEqual([]);
            },
            { timeout: 8000, interval: 20 },
        );

        process.emit('SIGTERM', 'SIGTERM');
        await vi.waitFor(
            () => {
                expect(exit).toHaveBeenCalled();
            },
            { timeout: 8000, interval: 20 },
        );
        await started.done;
        const records = started.records();

        expect(exit).toHaveBeenCalledExactlyOnceWith(143);
        expect(process.exitCode).toBe(143);
        expect(records.map((record) => record.message)).toEqual(['interrupted']);
        expect(started.modelCalls()).toEqual([]);
        expect(processesOf(started.runId)).toEqual([]);
        expect(await runDirectories(temporary)).toEqual([]);
    });

    test('no secret in the logs, in JSON or pretty output, whether the server answers or not', async () => {
        prepare();
        const server = await startHttpServer({
            tools: [
                { name: 'lookup', call: () => ({ content: [{ type: 'text', text: 'found' }] }) },
            ],
        });
        const origin = 'https://docs.example.test';
        const base = server.url.replace('/mcp', '');
        vi.stubEnv('DOCS_TOKEN', 't0k');
        vi.stubEnv('DOCS_KEY', 't0k');
        const entry = {
            url: `${origin}/mcp?key=\${DOCS_KEY}`,
            headers: { Authorization: 'Bearer ${DOCS_TOKEN}' },
            ...MCP_TIMEOUTS,
        };
        const data = await tracked(
            dataWithServers([{ name: 'docs', prefix: 'docs', entry, disabled: false }]),
        );

        try {
            const answered = [
                await runAgent({ DATA_DIR: data }, { mcp: { [origin]: base } }),
                await runAgent(
                    { DATA_DIR: data, LOG_FORMAT: 'pretty' },
                    { mcp: { [origin]: base } },
                ),
            ];
            await server.close();
            const unanswered = [
                await runAgent({ DATA_DIR: data }, { mcp: { [origin]: base } }),
                await runAgent(
                    { DATA_DIR: data, LOG_FORMAT: 'pretty' },
                    { mcp: { [origin]: base } },
                ),
            ];

            expect(answered.map((run) => run.code)).toEqual([0, 0]);
            expect(server.requests[0]?.headers.authorization).toBe('Bearer t0k');
            expect(server.requests[0]?.url).toBe('/mcp?key=t0k');
            expect(unanswered.map((run) => run.code)).toEqual([1, 1]);
            expect(errors(unanswered[0]?.records ?? [])).toEqual([
                expect.stringMatching(/^The MCP server docs couldn't start: /),
            ]);

            for (const run of [...answered, ...unanswered]) {
                expect(run.output).not.toContain('t0k');
            }
        } finally {
            await server.close();
        }
    });

    test('nothing but records is written, by a server that announces no tools', async () => {
        prepare();
        const others = (['debug', 'info', 'warn', 'error'] as const).map((method) =>
            vi.spyOn(console, method),
        );
        const data = await tracked(
            dataWithServers([fakeMcp('quiet', { env: { FAKE_CAPABILITIES: '{}' } })]),
        );

        const { code, output, records } = await runAgent({ DATA_DIR: data });

        expect(code).toBe(0);
        expect(others.flatMap((spy) => spy.mock.calls)).toEqual([]);
        expect(output.trim().split('\n')).toHaveLength(records.length);
        expect(find(records, 'mcp server')).toMatchObject({ name: 'quiet', tools: [] });
    });

    test('a saved login: refreshed ahead of expiry and sent, and once spent, the run fails before any request', async () => {
        prepare();
        const auth = await startAuthServer();
        let url = '';
        const server = await startHttpServer({
            tools: [
                { name: 'lookup', call: () => ({ content: [{ type: 'text', text: 'found' }] }) },
            ],
            answer: (request) => auth.guard(request, url),
        });
        url = server.url;
        const origin = new URL(url).origin;
        const routes = { mcp: { [origin]: origin }, origins: [auth.issuer] };
        const data = await tracked(
            dataWithServers([
                { name: 'docs', prefix: 'docs', entry: { url, ...MCP_TIMEOUTS }, disabled: false },
            ]),
        );
        auth.grant({ clientId: 'client-1', accessToken: 'at1', refreshToken: 'rt1' });
        const opened = await openStore(data);

        if (!opened.ok) {
            throw new Error(opened.error);
        }

        await saveCredential(opened.value.store, {
            server: 'docs',
            url,
            issuer: auth.issuer,
            client: { client_id: 'client-1', issuer: auth.issuer },
            tokens: { access_token: 'at1', token_type: 'Bearer', refresh_token: 'rt1' },
            discovery: { authorizationServerUrl: auth.issuer },
            expiresAt: Date.now() + 60_000,
        });
        await closeStore(opened.value.store);

        try {
            const used = await runAgent({ DATA_DIR: data }, routes);
            const reopened = await openStore(data);
            const found = reopened.ok
                ? await findCredentials(reopened.value.store, { server: 'docs', url })
                : reopened;

            if (reopened.ok) {
                await withDataSource(reopened.value.store, 'spend the login', (dataSource) => {
                    return dataSource.query('UPDATE credential SET needs_login = 1');
                });
                await closeStore(reopened.value.store);
            }

            const sent = server.requests.length;
            const spent = await runAgent({ DATA_DIR: data }, routes);
            const token = found.ok ? Object(found.value[0]?.tokens).access_token : undefined;

            expect(used.code).toBe(0);
            expect(toolNames(used.modelCall)).toContain('mcp__docs__lookup');
            expect(auth.tokenRequests).toMatchObject([{ grant_type: 'refresh_token' }]);
            expect(server.requests.at(-1)?.headers.authorization).toBe(`Bearer ${token}`);
            expect(spent.code).toBe(1);
            expect(errors(spent.records)).toEqual([
                "The MCP server docs can't start. Its login was refused when refreshed, so it needs a new login: bun run mcp login docs. To run without it: bun run mcp disable docs.",
            ]);
            expect(server.requests).toHaveLength(sent);
            expect(spent.output).not.toContain(String(token));
        } finally {
            await server.close();
            await auth.close();
        }
    });
});
