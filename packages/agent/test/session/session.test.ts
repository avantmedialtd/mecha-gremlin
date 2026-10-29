import type { HistoryItem } from '@mecha-gremlin/core/history';
import { err, ok } from '@mecha-gremlin/core/result';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import type { ResponseOutputItem, ResponseUsage } from 'openai/resources/responses/responses';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { Config } from '../../src/config/config.ts';
import { toFunctionTool } from '../../src/model/responses-tools.ts';
import {
    type Session,
    type SessionOptions,
    type SessionStep,
    type StepStats,
    createSession,
} from '../../src/session/session.ts';
import { defineTool } from '../../src/tools/tool-handler.ts';
import {
    type FakeServer,
    call,
    completed,
    fakeFetch,
    httpError,
    loadedBonsai,
    message,
    reasoning,
    script,
    usage,
} from '../fake-model.ts';

const START: HistoryItem[] = [
    { kind: 'instruction', text: 'Read files before answering.' },
    { kind: 'user', text: 'What does the check script run?' },
];
const WIRE_START = [
    { role: 'developer', content: 'Read files before answering.' },
    { role: 'user', content: 'What does the check script run?' },
];

const CONFIG: Config = {
    provider: 'openai',
    baseUrl: 'http://model.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: 'none',
    skillsPath: undefined,
    maxSteps: 30,
    fileTools: 'write-edit',
    logFormat: 'json',
    workDir: '/',
};

const output = (callId: string, text: string) => {
    return { type: 'function_call_output', call_id: callId, output: text };
};
const native = (data: readonly ResponseOutputItem[]): HistoryItem => ({
    kind: 'native',
    provider: 'openai',
    data,
});
const historyOutput = (callId: string, outcome: ToolOutcome): HistoryItem => ({
    kind: 'tool_result',
    callId,
    outcome,
});
const callView = ({ call_id, name, arguments: args }: ReturnType<typeof call>) => ({
    call_id,
    name,
    arguments: args,
});

const recordingTool = (
    run: (path: string) => Promise<ToolOutcome> = async (path) => ok(`contents of ${path}`),
) => {
    const paths: string[] = [];
    const handler = defineTool(
        {
            name: 'read',
            description: 'Read a file',
            schema: z.strictObject({ path: z.string() }),
        },
        async ({ path }) => {
            paths.push(path);

            return run(path);
        },
    );

    return { handler, paths };
};

const stats = (number: number, callUsage: ResponseUsage = usage()): StepStats => {
    return {
        number,
        providerStats: {
            provider: 'openai',
            usage: { kind: 'complete', value: callUsage },
            rateLimits: {},
        },
        seconds: 1.5,
    };
};

const start = async (config: Config, options: SessionOptions): Promise<Session> => {
    const created = await createSession(config, options);

    if (!created.ok) {
        throw new Error(`the session didn't start: ${created.error}`);
    }

    return created.value;
};

const runSession = async (
    server: FakeServer,
    options: Partial<SessionOptions> = {},
    config: Config = CONFIG,
) => {
    const { fetch, requests, modelCallBodies } = fakeFetch(server);
    vi.stubGlobal('fetch', fetch);
    const tool = recordingTool();
    // Every reading of the clock is 1.5 s after the last, so each model call takes 1.5 s.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 1500));

    const session = await start(config, {
        tools: [tool.handler],
        history: START,
        maxSteps: config.maxSteps,
        ...options,
    });
    const steps: SessionStep[] = [];

    for await (const step of session.steps) {
        steps.push(step);
    }

    return {
        session,
        steps,
        last: steps.at(-1),
        history: session.history,
        requests,
        bodies: modelCallBodies(),
        paths: tool.paths,
        handler: tool.handler,
    };
};

const roundTrip = [reasoning(), call('read', { path: 'package.json' }, 'call_1')];

const readThenAnswer = () => {
    return script(
        () => completed(roundTrip),
        () => completed([message('Done.')]),
    );
};

const LM_STUDIO: Config = {
    ...CONFIG,
    provider: 'lmstudio',
    baseUrl: 'http://lmstudio.test:1234/v1',
    model: 'prism-ml/bonsai-27b',
};

describe('Create a session from the configuration and a step limit', () => {
    test('another provider uses the configured model', async () => {
        const { session, bodies } = await runSession({ responses: readThenAnswer() });

        expect(session.model).toBe('test-model');
        expect(bodies.map((body) => body?.model)).toEqual(['test-model', 'test-model']);
    });

    test('with LM Studio, the session uses the loaded model', async () => {
        const { session, requests, bodies } = await runSession(
            { responses: readThenAnswer() },
            {},
            LM_STUDIO,
        );

        expect(requests[0]?.url).toBe('http://lmstudio.test:1234/api/v1/models');
        expect(session).toMatchObject({ model: 'prism-ml/bonsai-27b', note: undefined });
        expect(bodies.map((body) => body?.model)).toEqual([
            'prism-ml/bonsai-27b',
            'prism-ml/bonsai-27b',
        ]);
    });

    test('with several models loaded, the configured model is used', async () => {
        const second = { type: 'llm', key: 'qwen3', loaded_instances: [{ id: 'qwen3' }] };
        const { session } = await runSession(
            {
                models: () => Response.json({ models: [...loadedBonsai.models, second] }),
                responses: readThenAnswer(),
            },
            {},
            LM_STUDIO,
        );

        expect(session.model).toBe('prism-ml/bonsai-27b');
        expect(session.note).toBeUndefined();
    });

    test("with no model to use, the session doesn't start", async () => {
        const { fetch, modelCallBodies } = fakeFetch({
            models: () => Response.json({ models: [] }),
        });
        vi.stubGlobal('fetch', fetch);
        const created = await createSession(LM_STUDIO, {
            tools: [],
            history: START,
            maxSteps: LM_STUDIO.maxSteps,
        });

        expect(created).toEqual({ ok: false, error: expect.stringContaining('lms load') });
        expect(modelCallBodies()).toHaveLength(0);
    });
});

describe('Alternate model calls and tool calls until the model answers', () => {
    test('an answer without tools', async () => {
        const { steps, history, bodies } = await runSession({
            responses: script(() => completed([message('42')])),
        });

        expect(steps).toEqual([{ kind: 'final', stats: stats(1), text: '42' }]);
        expect(history).toEqual([...START, native([message('42')])]);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({
            model: 'test-model',
            input: WIRE_START,
            stream: true,
            store: false,
        });
    });

    test('one tool round trip replays the whole history', async () => {
        const afterCall = [
            ...START,
            native(roundTrip),
            historyOutput('call_1', ok('contents of package.json')),
        ];
        const { steps, history, bodies } = await runSession({
            responses: script(
                () => completed(roundTrip, usage(100)),
                () => completed([message('\n\nIt runs the checks.')], usage(200)),
            ),
        });

        expect(bodies).toHaveLength(2);
        expect(bodies[1]?.input).toEqual([
            ...WIRE_START,
            ...roundTrip,
            output('call_1', 'contents of package.json'),
        ]);
        expect(steps).toEqual([
            {
                kind: 'calls',
                stats: stats(1, usage(100)),
                calls: [
                    {
                        call: callView(call('read', { path: 'package.json' }, 'call_1')),
                        outcome: { ok: true, value: 'contents of package.json' },
                    },
                ],
            },
            {
                kind: 'final',
                stats: stats(2, usage(200)),
                text: 'It runs the checks.',
            },
        ]);
        expect(history).toEqual([...afterCall, native([message('\n\nIt runs the checks.')])]);
    });

    test('the client comes from the config', async () => {
        const { requests } = await runSession({ responses: readThenAnswer() });

        expect(requests.map((request) => [request.url, request.authorization])).toEqual([
            ['http://model.test/v1/responses', 'Bearer test-key'],
            ['http://model.test/v1/responses', 'Bearer test-key'],
        ]);
    });

    test('tools are frozen for the session', async () => {
        const { bodies, handler } = await runSession({ responses: readThenAnswer() });

        expect(bodies[0]?.tools).toEqual([toFunctionTool(handler.tool)]);
        expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
    });

    test('the configured reasoning effort goes with every model call', async () => {
        const low = await runSession(
            { responses: readThenAnswer() },
            {},
            { ...CONFIG, reasoningEffort: 'low' },
        );

        expect(low.bodies.map((body) => body?.reasoning)).toEqual([
            { effort: 'low' },
            { effort: 'low' },
        ]);

        const explicit = await runSession({ responses: readThenAnswer() });

        expect(explicit.bodies.map((body) => body?.reasoning)).toEqual([
            { effort: 'none' },
            { effort: 'none' },
        ]);
    });

    test('the tools it runs are the tools it offers, whatever the caller does to its array', async () => {
        const { fetch } = fakeFetch({ responses: readThenAnswer() });
        vi.stubGlobal('fetch', fetch);
        const tool = recordingTool();
        const tools = [tool.handler];
        const pending = createSession(CONFIG, { tools, history: START, maxSteps: 2 });
        tools.pop();
        const created = await pending;

        if (!created.ok) {
            throw new Error(created.error);
        }

        const first = await created.value.steps.next();

        expect(first.value).toMatchObject({ kind: 'calls', calls: [{ outcome: { ok: true } }] });
        expect(tool.paths).toEqual(['package.json']);
    });

    test('the session starts from a copy of the history it was given', async () => {
        const given = [...START];
        const { history } = await runSession({ responses: readThenAnswer() }, { history: given });

        expect(given).toEqual(START);
        expect(history.length).toBeGreaterThan(START.length);
    });
});

describe('Run every tool call in order and answer each exactly once', () => {
    test('two calls in one reply', async () => {
        const a = call('read', { path: 'a.txt' }, 'call_a');
        const b = call('read', { path: 'b.txt' }, 'call_b');
        const { history, paths } = await runSession({
            responses: script(
                () => completed([a, b]),
                () => completed([message('Done.')]),
            ),
        });

        expect(paths).toEqual(['a.txt', 'b.txt']);
        expect(history).toEqual([
            ...START,
            native([a, b]),
            historyOutput('call_a', ok('contents of a.txt')),
            historyOutput('call_b', ok('contents of b.txt')),
            native([message('Done.')]),
        ]);
    });

    test('an unknown tool', async () => {
        const note = defineTool(
            {
                name: 'take_note',
                description: 'Take a note',
                schema: z.strictObject({ text: z.string() }),
            },
            async () => ok('noted'),
        );
        const { bodies } = await runSession(
            {
                responses: script(
                    () => completed([call('delete', { path: 'x.txt' })]),
                    () => completed([message('Done.')]),
                ),
            },
            { tools: [recordingTool().handler, note] },
        );

        expect(bodies).toHaveLength(2);
        expect(bodies[1]?.input).toContainEqual(
            output('call_1', 'Error: unknown tool "delete"; available tools: read, take_note'),
        );
    });

    test('invalid arguments', async () => {
        const { bodies, paths } = await runSession({
            responses: script(
                () => completed([call('read', { file: 'x.txt' })]),
                () => completed([message('Done.')]),
            ),
        });

        expect(paths).toEqual([]);
        expect(bodies[1]?.input).toContainEqual(
            output(
                'call_1',
                expect.stringMatching(
                    /^Error: The arguments for read don't match its schema:\n- path: /,
                ),
            ),
        );
    });

    test.each([
        [new Error('disk on fire'), 'Error: read failed: disk on fire'],
        ['a thrown string', 'Error: read failed: a thrown string'],
    ])('a handler that throws %j', async (thrown, expected) => {
        const failing = recordingTool(async () => {
            throw thrown;
        });
        const { bodies } = await runSession(
            { responses: readThenAnswer() },
            { tools: [failing.handler] },
        );

        expect(bodies).toHaveLength(2);
        expect(bodies[1]?.input).toContainEqual(output('call_1', expected));
    });
});

describe('Stop at the step limit', () => {
    const endless: FakeServer = {
        responses: (n) => completed([call('read', { path: `f${n}.txt` }, `call_${n}`)]),
    };

    test('the model never stops calling tools', async () => {
        const { steps, last, history, bodies, paths } = await runSession(endless, { maxSteps: 8 });

        expect(bodies).toHaveLength(8);
        expect(paths).toEqual([
            'f0.txt',
            'f1.txt',
            'f2.txt',
            'f3.txt',
            'f4.txt',
            'f5.txt',
            'f6.txt',
        ]);
        expect(steps.map((step) => step.kind)).toEqual([...Array(7).fill('calls'), 'step_limit']);
        expect(last).toEqual({ kind: 'step_limit', stats: stats(8) });
        expect(history.at(-1)).toEqual(
            historyOutput('call_7', err('not run: the step limit was reached')),
        );
    });

    test('the caller can set another limit', async () => {
        const { last, bodies, paths } = await runSession(endless, { maxSteps: 2 });

        expect(bodies).toHaveLength(2);
        expect(paths).toEqual(['f0.txt']);
        expect(last).toMatchObject({ kind: 'step_limit' });
    });

    test('a limit of 1 calls the model once', async () => {
        const { last, bodies, paths } = await runSession(endless, { maxSteps: 1 });

        expect(bodies).toHaveLength(1);
        expect(paths).toEqual([]);
        expect(last).toEqual({ kind: 'step_limit', stats: stats(1) });
    });

    // undefined: a JavaScript caller can leave the limit out, though TypeScript requires it.
    test.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
        "a limit of %s isn't a positive integer, so nothing is sent",
        async (maxSteps) => {
            const { fetch, requests } = fakeFetch(endless);
            vi.stubGlobal('fetch', fetch);
            const options = { tools: [], history: START, maxSteps } as SessionOptions;
            const created = await createSession(LM_STUDIO, options);

            expect(created).toEqual({
                ok: false,
                error: `maxSteps must be a positive integer; got ${maxSteps}.`,
            });
            expect(requests).toHaveLength(0);
        },
    );
});

describe('End every session with a step, not a throw', () => {
    test('a later model call fails', async () => {
        const { last, history } = await runSession({
            responses: script(
                () => completed(roundTrip),
                () => httpError(500, 'the engine fell over'),
            ),
        });

        expect(last).toMatchObject({
            kind: 'model_call_failed',
            error: {
                kind: 'server_error',
                status: 500,
                detail: expect.stringContaining('the engine fell over'),
            },
        });
        expect(history).toEqual([
            ...START,
            native(roundTrip),
            historyOutput('call_1', ok('contents of package.json')),
        ]);
    });

    test('no answer', async () => {
        const { steps, history, bodies } = await runSession({
            responses: script(() => completed([reasoning()])),
        });

        expect(steps).toEqual([{ kind: 'empty', stats: stats(1) }]);
        expect(history).toEqual([...START, native([reasoning()])]);
        expect(bodies).toHaveLength(1);
    });

    test("a history that can't be replayed", async () => {
        const broken: HistoryItem[] = [
            ...START,
            { kind: 'native', provider: 'openai', data: [{ type: 'made_up' }] },
        ];
        const { fetch, requests } = fakeFetch();
        vi.stubGlobal('fetch', fetch);

        expect(
            await createSession(CONFIG, { tools: [], history: broken, maxSteps: 2 }),
        ).toMatchObject({ ok: false, error: expect.stringContaining('made_up') });
        expect(requests).toHaveLength(0);
    });
});

describe('Yield each step as it completes', () => {
    test('a step comes before the next model call, with the history up to date', async () => {
        const { fetch, modelCallBodies } = fakeFetch({ responses: readThenAnswer() });
        vi.stubGlobal('fetch', fetch);
        const session = await start(CONFIG, {
            tools: [recordingTool().handler],
            history: START,
            maxSteps: CONFIG.maxSteps,
        });

        expect((await session.steps.next()).value).toMatchObject({ kind: 'calls' });
        expect(modelCallBodies()).toHaveLength(1);
        expect(session.history).toEqual([
            ...START,
            native(roundTrip),
            historyOutput('call_1', ok('contents of package.json')),
        ]);

        expect((await session.steps.next()).value).toMatchObject({ kind: 'final' });
        expect(modelCallBodies()).toHaveLength(2);
        expect(session.history.at(-1)).toEqual(native([message('Done.')]));

        expect(await session.steps.next()).toEqual({ done: true, value: undefined });
    });

    test("a step's calls carry their outcomes, failures included", async () => {
        const euro = recordingTool(async () => ok('€'));
        const a = call('read', { path: 'a' }, 'call_a');
        const b = call('read', {}, 'call_b');
        const { steps } = await runSession(
            {
                responses: script(
                    () => completed([a, b]),
                    () => completed([message('Done.')]),
                ),
            },
            { tools: [euro.handler] },
        );

        expect(steps[0]).toMatchObject({
            kind: 'calls',
            calls: [
                { call: callView(a), outcome: { ok: true, value: '€' } },
                {
                    call: callView(b),
                    outcome: {
                        ok: false,
                        error: expect.stringContaining("don't match its schema"),
                    },
                },
            ],
        });
    });
});
