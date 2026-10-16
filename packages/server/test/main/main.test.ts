import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { freshRunId, helperCommand, isGone, stopLeftovers, track } from '../exec/processes.ts';

// main.ts runs as soon as it's imported, so it's never imported here at the top: `startServer`
// fakes the globals it reads, then imports it afresh. Its default task is spelled out for the same
// reason.
const DEFAULT_TASK = 'Use the playwright-cli skill to find the title of https://example.com';

/** Each test sets or clears all of these, so settings in your shell can't leak in. */
const SETTINGS = [
    'LOG_FORMAT',
    'MODEL_PROVIDER',
    'MODEL_BASE_URL',
    'MODEL_API_KEY',
    'MODEL',
    'MODEL_REASONING_EFFORT',
    'WORK_DIR',
    'SKILLS_PATH',
    'MAX_TURNS',
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
// On macOS the temporary directory is reached through a link, and the server uses real paths.
let realCwd: string;
let skillsRoot: string;

const writeIn = async (path: string, text: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
};

beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'server-'));
    realCwd = await realpath(cwd);
    await writeFile(join(cwd, 'package.json'), PACKAGE_JSON);
    await writeFile(join(cwd, 'menu.txt'), MENU);
    skillsRoot = await realpath(await mkdtemp(join(tmpdir(), 'server-skills-')));
    await writeIn(
        join(skillsRoot, 'pdf', 'SKILL.md'),
        '---\nname: pdf\ndescription: Work with PDFs.\n---\n# PDF\n',
    );
    await writeIn(
        join(skillsRoot, 'browser', 'SKILL.md'),
        '---\nname: browser\ndescription: Drive a browser.\n---\n# Browser\n',
    );
});

afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(skillsRoot, { recursive: true, force: true });
});

// The servers this file starts, and the turns it holds open. A test that fails midway mustn't
// leave a server suspended, with its signal handlers installed, for the next test: after each
// test, held turns are released and servers awaited, for at most 10 s.
const startedServers: Promise<unknown>[] = [];
const heldTurns: ((output: readonly ResponseOutputItem[]) => Promise<void>)[] = [];

const within = (ms: number): Promise<unknown> => {
    return new Promise((resolve) => {
        AbortSignal.timeout(ms).addEventListener('abort', resolve);
    });
};

afterEach(async () => {
    const released = heldTurns.splice(0).map((release) => release([message('The test ended.')]));

    await Promise.race([
        Promise.allSettled([...released, ...startedServers.splice(0)]),
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

const turnsOf = (requests: readonly RecordedRequest[]): RecordedRequest[] => {
    return requests.filter((request) => request.url.endsWith('/v1/responses'));
};

/**
 * Starts the server without waiting for it to end. The log is read as JSON records, which pins
 * every field, unless a test asks for another format; the formatted output has its own tests. The
 * run ID is a fresh one, which the signal guard vouches for.
 */
const startServer = (env: Settings = {}, server: FakeServer = {}, args: readonly string[] = []) => {
    const settings: Settings = { LOG_FORMAT: 'json', ...env };

    for (const name of SETTINGS) {
        vi.stubEnv(name, settings[name]);
    }

    const { fetch, requests } = fakeFetch(server);
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    // Every reading of the clock is 1.5 s after the last, so each turn takes 1.5 s.
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
    startedServers.push(done);

    return {
        done,
        runId,
        requests,
        turns: () => turnsOf(requests),
        output: () => output,
        records: () => (settings.LOG_FORMAT === 'json' ? parseRecords(output) : []),
    };
};

const runServer = async (
    env: Settings = {},
    server: FakeServer = {},
    args: readonly string[] = [],
) => {
    const started = startServer(env, server, args);
    await started.done;
    const turns = started.turns();

    return {
        code: process.exitCode,
        output: started.output(),
        records: started.records(),
        requests: started.requests,
        turns,
        turn: turns[0],
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

    return input.filter((item) => item.type === 'function_call_output').map((item) => item.output);
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
        () => completed([reasoning(), call('read_file', { path: 'package.json' })]),
        () => completed([message('\n\nIt runs the checks.')]),
    ),
};

// A turn that stays open until it's released with the model's output, once.
const heldTurn = () => {
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

    heldTurns.push(release);

    return {
        response: () =>
            new Response(stream.readable, { headers: { 'content-type': 'text/event-stream' } }),
        release,
    };
};

describe('Carry out a task and log the answer', { timeout: 15_000 }, () => {
    test('the default task', async () => {
        const { turn } = await runServer();

        expect(turn?.body?.input).toEqual([
            { role: 'developer', content: expect.any(String) },
            { role: 'user', content: DEFAULT_TASK },
        ]);
    });

    test('a task from the arguments', async () => {
        const { turn } = await runServer({}, {}, ['Which', 'runtime', 'does README.md describe?']);

        expect(turn?.body?.input).toContainEqual({
            role: 'user',
            content: 'Which runtime does README.md describe?',
        });
    });

    test('without skills: read_file and shell, and a developer item that mentions no skills', async () => {
        const { turn } = await runServer();

        expect(turn?.body?.tools).toEqual([
            expect.objectContaining({ type: 'function', name: 'read_file', strict: true }),
            expect.objectContaining({ type: 'function', name: 'shell', strict: true }),
        ]);
        expect(developerItem(turn)).toBe(
            `You carry out tasks on this computer. You have a shell, and read_file for reading text files. The working directory is ${realCwd}, and paths that commands print are relative to it. Keep your final answer brief.`,
        );
    });

    test('with skills: activate_skill too, and the catalog ends the developer item', async () => {
        const { turn } = await runServer({ SKILLS_PATH: skillsRoot });

        expect(toolNames(turn)).toEqual(['read_file', 'shell', 'activate_skill']);
        expect(developerItem(turn)).toMatch(
            /^You carry out tasks on this computer\..*Keep your final answer brief\.\n\nSkills give you instructions/s,
        );
        expect(developerItem(turn)).toMatch(
            /<available_skills>\n<skill>\n<name>browser<\/name>\n.*<name>pdf<\/name>\n<description>Work with PDFs\.<\/description>\n<\/skill>\n<\/available_skills>$/s,
        );
    });

    test("activate_skill gives a skill's instructions, and read_file its files", async () => {
        const { turns } = await runServer(
            { SKILLS_PATH: skillsRoot },
            {
                responses: script(
                    () =>
                        completed([
                            call('activate_skill', { name: 'pdf' }, 'call_1'),
                            call(
                                'read_file',
                                { path: join(skillsRoot, 'pdf', 'SKILL.md') },
                                'call_2',
                            ),
                        ]),
                    () => completed([message('Done.')]),
                ),
            },
        );

        expect(callOutputs(turns[1])).toEqual([
            expect.stringMatching(/^<skill_content name="pdf">\n# PDF\n\nSkill directory: /),
            '---\nname: pdf\ndescription: Work with PDFs.\n---\n# PDF\n',
        ]);
    });

    test('the working directory, through a symbolic link', async () => {
        const base = await mkdtemp(join(tmpdir(), 'server-work-'));
        const real = join(await realpath(base), 'real');
        await writeIn(join(real, 'notes.txt'), 'hello');
        await symlink(real, join(base, 'link'));

        try {
            const { records, turn, turns } = await runServer(
                { WORK_DIR: join(base, 'link') },
                {
                    responses: script(
                        () =>
                            completed([
                                call('read_file', { path: 'notes.txt' }, 'call_1'),
                                call('shell', { command: 'pwd' }, 'call_2'),
                            ]),
                        () => completed([message('Done.')]),
                    ),
                },
            );

            expect(developerItem(turn)).toContain(`The working directory is ${real},`);
            expect(find(records, 'asking')).toMatchObject({ workDir: real });
            expect(callOutputs(turns[1])).toEqual(['hello', `exit code: 0\nstdout:\n${real}`]);
        } finally {
            await rm(base, { recursive: true, force: true });
        }
    });

    test('a relative WORK_DIR resolves against the current directory', async () => {
        await mkdir(join(cwd, 'work'), { recursive: true });

        const { records } = await runServer({ WORK_DIR: 'work' });

        expect(find(records, 'asking')).toMatchObject({ workDir: join(realCwd, 'work') });
    });

    test('an answer after running a command', async () => {
        const { code, records, turns } = await runServer(
            {},
            {
                responses: script(
                    () => completed([call('shell', { command: 'echo 42' })]),
                    () => completed([message('\n\nIt printed 42.')]),
                ),
            },
        );

        expect(code).toBe(0);
        expect(turns[1]?.body?.input).toContainEqual({
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'exit code: 0\nstdout:\n42',
        });
        expect(find(records, 'answer')).toMatchObject({ level: 'info', text: 'It printed 42.' });
    });

    test('the turn limit comes from MAX_TURNS', async () => {
        const { code, records, turns } = await runServer(
            { MAX_TURNS: '3' },
            {
                responses: (n) =>
                    completed([call('read_file', { path: 'package.json' }, `call_${n}`)]),
            },
        );

        expect(code).toBe(1);
        expect(turns).toHaveLength(3);
        expect(errors(records)).toEqual([
            "The model didn't answer within 3 turns: it was still calling tools. Try a narrower task, or raise MAX_TURNS.",
        ]);
    });

    test('the default turn limit is 30', async () => {
        const { turns } = await runServer(
            {},
            {
                responses: (n) =>
                    completed([call('read_file', { path: 'package.json' }, `call_${n}`)]),
            },
        );

        expect(turns).toHaveLength(30);
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

describe("Stop the session's processes when the server ends", { timeout: 15_000 }, () => {
    test('a process left behind is stopped, once', async () => {
        const { code, records, turns } = await runServer(
            {},
            leaveDaemon(() => completed([message('Started it.')])),
        );
        const daemon = daemonOf(turns[1]);

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
        const pending = heldTurn();
        const started = startServer({}, leaveDaemon(pending.response));
        await vi.waitFor(
            () => {
                expect(started.turns()).toHaveLength(2);
            },
            { timeout: 4000, interval: 20 },
        );
        const daemon = daemonOf(started.turns()[1]);

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
        const pending = heldTurn();
        const started = startServer({}, { responses: pending.response });
        await vi.waitFor(
            () => {
                expect(started.turns()).toHaveLength(1);
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
        const bin = await mkdtemp(join(tmpdir(), 'server-ps-'));
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
            const started = startServer();
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

    test('no handler outlives the server', async () => {
        const before = SIGNALS.map((signal) => process.listenerCount(signal));

        await runServer();

        expect(SIGNALS.map((signal) => process.listenerCount(signal))).toEqual(before);
    });

    test("the sweep can't run", async () => {
        const empty = await mkdtemp(join(tmpdir(), 'server-path-'));
        vi.stubEnv('PATH', empty);

        try {
            const { code, records } = await runServer();

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

describe('Log each tool call and turn', () => {
    test('the records of a tool round trip', async () => {
        const { records, runId } = await runServer({}, readThenAnswer);

        expect(records).toMatchObject([
            {
                level: 'info',
                message: 'asking',
                model: 'prism-ml/bonsai-27b',
                baseUrl: 'http://127.0.0.1:1234/v1',
                run: runId,
                workDir: realCwd,
                task: DEFAULT_TASK,
            },
            {
                level: 'info',
                message: 'turn',
                number: 1,
                inputTokens: 349,
                cachedTokens: 256,
                outputTokens: 26,
                reasoningTokens: 12,
                seconds: 1.5,
            },
            {
                level: 'info',
                message: 'tool call',
                tool: 'read_file',
                arguments: { path: 'package.json' },
            },
            {
                level: 'info',
                message: 'tool result',
                tool: 'read_file',
                bytes: Buffer.byteLength(PACKAGE_JSON),
            },
            { level: 'info', message: 'turn', number: 2 },
            { level: 'info', message: 'answer', text: 'It runs the checks.' },
        ]);
        expect(records).toHaveLength(6);
        expect(records.every((record) => !Number.isNaN(Date.parse(record.time)))).toBe(true);
    });

    test('the asking record', async () => {
        const work = await mkdtemp(join(tmpdir(), 'server-asking-'));

        try {
            const { records, runId } = await runServer({ WORK_DIR: work }, {}, ['Say', 'hi']);

            expect(runId).toMatch(/^[0-9a-f]{8}$/);
            expect(find(records, 'asking')).toEqual({
                time: expect.any(String),
                level: 'info',
                message: 'asking',
                model: 'prism-ml/bonsai-27b',
                baseUrl: 'http://127.0.0.1:1234/v1',
                run: runId,
                workDir: await realpath(work),
                task: 'Say hi',
            });
        } finally {
            await rm(work, { recursive: true, force: true });
        }
    });

    test('the skills record, before the asking record', async () => {
        const { records } = await runServer({ SKILLS_PATH: skillsRoot });

        expect(records.slice(0, 2)).toMatchObject([
            { level: 'info', message: 'skills', names: ['browser', 'pdf'] },
            { message: 'asking' },
        ]);
    });

    test('skills not loaded, and their warnings', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'server-broken-')));
        await writeIn(join(root, 'broken', 'SKILL.md'), '# Broken\n');
        await writeIn(
            join(root, 'pdf-tools', 'SKILL.md'),
            '---\nname: pdf\ndescription: Work with PDFs.\n---\n',
        );
        const missing = join(root, 'missing');

        try {
            const { records } = await runServer({ SKILLS_PATH: `${missing}:${root}` });

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
        const { records } = await runServer(
            {},
            {
                responses: script(
                    () => completed([call('read_file', { path: 'menu.txt' })]),
                    () => completed([message('A café crème costs 3 €.')]),
                ),
            },
        );

        expect(Buffer.byteLength(MENU)).toBeGreaterThan(MENU.length);
        expect(find(records, 'tool result')).toMatchObject({ bytes: Buffer.byteLength(MENU) });
    });

    test('a failed call is a warning carrying its error', async () => {
        const { records } = await runServer(
            {},
            {
                responses: script(
                    () => completed([call('read_file', { path: '.env' })]),
                    () => completed([message("I can't read that.")]),
                ),
            },
        );

        expect(find(records, 'tool failed')).toMatchObject({
            level: 'warn',
            tool: 'read_file',
            error: '".env" is an environment file. read_file doesn\'t read those: they hold secrets.',
        });
    });

    test("arguments that don't parse are logged as the model sent them", async () => {
        const { records } = await runServer(
            {},
            {
                responses: script(
                    () => completed([call('read_file', '{"path": "package.json"')]),
                    () => completed([message('Sorry.')]),
                ),
            },
        );

        expect(find(records, 'tool call')).toMatchObject({ arguments: '{"path": "package.json"' });
    });

    test('a turn without usage still reports its time', async () => {
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
        const { records } = await runServer({}, { responses: () => noUsage });

        expect(find(records, 'turn')).toEqual({
            time: expect.any(String),
            level: 'info',
            message: 'turn',
            number: 1,
            seconds: 1.5,
        });
    });

    test('usage without token details leaves those out', async () => {
        // Some OpenAI-compatible servers report only the totals.
        const totals = { input_tokens: 10, output_tokens: 5, total_tokens: 15 } as ResponseUsage;
        const { records } = await runServer(
            {},
            { responses: () => completed([message('Hi.')], totals) },
        );

        expect(find(records, 'turn')).toEqual({
            time: expect.any(String),
            level: 'info',
            message: 'turn',
            number: 1,
            inputTokens: 10,
            outputTokens: 5,
            seconds: 1.5,
        });
    });
});

describe('Formatted output by default', () => {
    test('without LOG_FORMAT, each record is a line to read', async () => {
        const { output, runId } = await runServer({ LOG_FORMAT: undefined }, readThenAnswer);
        const lines = output.trim().split('\n');

        expect(lines.every((line) => /^\d\d:\d\d:\d\d (INFO |WARN |ERROR) /.test(line))).toBe(true);
        expect(lines.map((line) => line.slice(9))).toEqual([
            `INFO  asking model=prism-ml/bonsai-27b baseUrl=http://127.0.0.1:1234/v1 run=${runId} workDir=${realCwd} task="${DEFAULT_TASK}"`,
            'INFO  turn number=1 inputTokens=349 cachedTokens=256 outputTokens=26 reasoningTokens=12 seconds=1.5',
            'INFO  tool call tool=read_file arguments={"path":"package.json"}',
            `INFO  tool result tool=read_file bytes=${Buffer.byteLength(PACKAGE_JSON)}`,
            'INFO  turn number=2 inputTokens=349 cachedTokens=256 outputTokens=26 reasoningTokens=12 seconds=1.5',
            'INFO  answer text="It runs the checks."',
        ]);
    });

    test('an unknown LOG_FORMAT fails before anything else', async () => {
        const { code, output, requests } = await runServer({ LOG_FORMAT: 'xml' });

        expect(code).toBe(1);
        expect(output).toMatch(
            /^\d\d:\d\d:\d\d ERROR LOG_FORMAT must be pretty or json; got "xml"\.\n$/,
        );
        expect(requests).toHaveLength(0);
    });

    test('LOG_FORMAT is trimmed, as every setting is', async () => {
        const { output } = await runServer({ LOG_FORMAT: ' json ' }, readThenAnswer);
        const messages = output
            .trim()
            .split('\n')
            .map((line) => (JSON.parse(line) as LogRecord).message);

        expect(messages).toEqual(['asking', 'turn', 'tool call', 'tool result', 'turn', 'answer']);
    });
});

describe('Configuration from the environment, validated at start-up', () => {
    test.each(['0', '-1', '2.5', 'lots'])('an invalid turn limit: %j', async (value) => {
        const { code, records, requests } = await runServer({ MAX_TURNS: value });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('MAX_TURNS')]);
        expect(requests).toHaveLength(0);
    });

    test.each([
        ['a path that does not exist', 'missing'],
        ['a file', 'package.json'],
    ])('a working directory that is %s', async (_kind, workDir) => {
        const { code, records, requests } = await runServer({ WORK_DIR: workDir });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            `WORK_DIR must name an existing directory; ${join(cwd, workDir)} isn't one.`,
        ]);
        expect(requests).toHaveLength(0);
    });

    test('every problem is reported', async () => {
        const { code, records, requests } = await runServer({
            MODEL_PROVIDER: 'openai',
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
});

describe('Actionable failures', () => {
    test('no answer', async () => {
        const { code, records } = await runServer(
            {},
            { responses: script(() => completed([reasoning()])) },
        );

        expect(code).toBe(1);
        expect(find(records, 'answer')).toBeUndefined();
        expect(errors(records)).toEqual([
            'The model gave no answer: its turn had neither text nor tool calls. Try again, or rephrase the task.',
        ]);
    });

    test("an item the SDK can't replay", async () => {
        const strange = { type: 'made_up' } as unknown as ResponseOutputItem;
        const { code, records } = await runServer(
            {},
            {
                responses: script(() =>
                    completed([strange, call('read_file', { path: 'package.json' })]),
                ),
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringMatching(/^The conversation can't be continued \(.*made_up/),
        ]);
    });

    test('a failed turn', async () => {
        const { code, records } = await runServer(
            {},
            { responses: () => httpError(500, 'model crashed') },
        );

        expect(code).toBe(1);
        expect(find(records, 'answer')).toBeUndefined();
        expect(errors(records)).toEqual([
            'The model server at http://127.0.0.1:1234/v1 failed the turn (500 model crashed). Try again; if it keeps failing, check its logs or status page.',
        ]);
    });

    test('a rate-limited turn', async () => {
        const { code, records } = await runServer(
            {},
            { responses: () => httpError(429, 'slow down') },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            "The model server at http://127.0.0.1:1234/v1 is limiting requests (429 slow down). Wait a minute and try again; if it keeps happening, check the account's quota.",
        ]);
    });

    test('a failed turn without a status', async () => {
        const { code, records } = await runServer(
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
            'The model server at http://127.0.0.1:1234/v1 failed the turn (server_error: it broke). Try again; if it keeps failing, check its logs or status page.',
        ]);
    });

    test('LM Studio stops during the session', async () => {
        const { code, records } = await runServer(
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
        const { code, records } = await runServer(
            { MODEL_PROVIDER: 'openai', MODEL_API_KEY: 'sk-test', MODEL: 'gpt-test' },
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

describe('run with LM Studio (the default provider)', () => {
    test('asks the loaded model and logs its answer', async () => {
        const { code, records, turn } = await runServer();

        expect(code).toBe(0);
        expect(find(records, 'answer')).toMatchObject({ text: 'Hi there!' });
        // With one model loaded there's no note about the choice: the first record is the task.
        expect(records[0]).toMatchObject({ message: 'asking', model: 'prism-ml/bonsai-27b' });
        expect(turn?.url).toBe('http://127.0.0.1:1234/v1/responses');
        expect(turn?.body).toMatchObject({
            model: 'prism-ml/bonsai-27b',
            reasoning: { effort: 'none' },
            stream: true,
            store: false,
        });
    });

    test('passes the configured reasoning effort through', async () => {
        const { code, turn } = await runServer({ MODEL_REASONING_EFFORT: 'low' });

        expect(code).toBe(0);
        expect(turn?.body).toMatchObject({ reasoning: { effort: 'low' } });
    });

    test('invalid config fails before any network call', async () => {
        const { code, records, requests } = await runServer({ MODEL_BASE_URL: 'lmstudio' });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('MODEL_BASE_URL')]);
        expect(requests).toHaveLength(0);
    });

    test('an unreachable LM Studio fails with a hint', async () => {
        const { code, records } = await runServer(
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
        const { code, records } = await runServer(
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

    test("a configured model that isn't loaded sends no turn", async () => {
        const { code, records, turn } = await runServer({ MODEL: 'qwen2.5-0.5b-instruct-mlx' });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('lms load qwen2.5-0.5b-instruct-mlx'),
        ]);
        expect(turn).toBeUndefined();
    });

    test('with several models loaded, says which it chose and how to choose another', async () => {
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
        const { code, records, turn } = await runServer(
            {},
            { models: () => Response.json(twoLoaded) },
        );

        expect(code).toBe(0);
        expect(records[0]).toMatchObject({
            level: 'info',
            message:
                'Using prism-ml/bonsai-27b, the first of 2 loaded models (prism-ml/bonsai-27b, qwen2.5-0.5b-instruct-mlx). Set MODEL to choose another.',
        });
        expect(turn?.body).toMatchObject({ model: 'prism-ml/bonsai-27b' });
    });
});

describe('run with another OpenAI-compatible provider', () => {
    const openai = { MODEL_PROVIDER: 'openai', MODEL_API_KEY: 'sk-test', MODEL: 'gpt-test' };

    test("uses the named model without asking LM Studio, and the model's own reasoning default", async () => {
        const { code, records, requests, turn } = await runServer(openai);

        expect(code).toBe(0);
        expect(find(records, 'answer')).toMatchObject({ text: 'Hi there!' });
        expect(requests.some((request) => request.url.endsWith('/api/v1/models'))).toBe(false);
        expect(turn).toMatchObject({
            url: 'https://api.openai.com/v1/responses',
            authorization: 'Bearer sk-test',
            body: { model: 'gpt-test' },
        });
        expect(turn?.body).not.toHaveProperty('reasoning');
    });

    test('needs MODEL and MODEL_API_KEY, and fails before any network call', async () => {
        const { code, records, requests } = await runServer({ MODEL_PROVIDER: 'openai' });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('MODEL_API_KEY is required'),
            expect.stringContaining('MODEL is required'),
        ]);
        expect(requests).toHaveLength(0);
    });

    test('a rejected key points at MODEL_API_KEY, not at LM Studio', async () => {
        const { code, records } = await runServer(openai, {
            responses: () => httpError(401, 'bad key'),
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('MODEL_API_KEY')]);
        expect(errors(records)[0]).not.toContain('LM Studio');
    });

    test('a forbidden key reports its own status', async () => {
        const { code, records } = await runServer(openai, {
            responses: () => httpError(403, 'forbidden'),
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('rejected the API key (HTTP 403)'),
        ]);
    });
});
