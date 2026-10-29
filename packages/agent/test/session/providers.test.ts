import type { HistoryItem } from '@mecha-gremlin/core/history';
import { ok } from '@mecha-gremlin/core/result';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import type { ResponseOutputItem } from 'openai/resources/responses/responses';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { Config } from '../../src/config/config.ts';
import { createSession } from '../../src/session/session.ts';
import { defineTool } from '../../src/tools/tool-handler.ts';
import { call, completed, message } from '../fake-model.ts';

const base = {
    baseUrl: 'https://example.test/v1',
    apiKey: 'test',
    model: 'test-model',
    reasoningEffort: 'medium' as const,
    skillsPath: undefined,
    maxSteps: 2,
    fileTools: 'write-edit' as const,
    logFormat: 'json' as const,
    workDir: '/',
};
const configs: readonly Config[] = [
    { ...base, provider: 'openai' },
    {
        ...base,
        provider: 'anthropic',
        baseUrl: 'https://example.test',
        maxOutputTokens: 4096,
        workspaceId: undefined,
    },
];
const initial: readonly HistoryItem[] = [
    { kind: 'instruction', text: 'Be brief.' },
    { kind: 'user', text: 'Read it.' },
];
const usage = {
    input_tokens: 10,
    output_tokens: 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
};

const sseOf = (
    events: readonly { readonly type: string; readonly [key: string]: unknown }[],
): Response => {
    return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
    );
};

const anthropicReply = (toolCall: boolean, name = 'read', args = '{"path":"file"}'): Response => {
    const events = [
        {
            type: 'message_start',
            message: {
                id: 'msg',
                type: 'message',
                role: 'assistant',
                model: 'test-model',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                stop_details: null,
                container: null,
                diagnostics: null,
                usage,
            },
        },
        ...(toolCall
            ? [
                  {
                      type: 'content_block_start',
                      index: 0,
                      content_block: {
                          type: 'tool_use',
                          id: 'call_1',
                          name,
                          input: {},
                          caller: { type: 'direct' },
                      },
                  },
                  {
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'input_json_delta', partial_json: args },
                  },
              ]
            : [
                  {
                      type: 'content_block_start',
                      index: 0,
                      content_block: { type: 'text', text: '', citations: null },
                  },
                  {
                      type: 'content_block_delta',
                      index: 0,
                      delta: { type: 'text_delta', text: 'Done' },
                  },
              ]),
        { type: 'content_block_stop', index: 0 },
        {
            type: 'message_delta',
            delta: {
                stop_reason: toolCall ? 'tool_use' : 'end_turn',
                stop_sequence: null,
                stop_details: null,
                container: null,
            },
            usage: {
                output_tokens: 2,
                input_tokens: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                output_tokens_details: null,
                server_tool_use: null,
            },
        },
        { type: 'message_stop' },
    ];

    return sseOf(events);
};

const anthropicTwoCalls = (): Response => {
    const events = [
        {
            type: 'message_start',
            message: {
                id: 'msg',
                type: 'message',
                role: 'assistant',
                model: 'test-model',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                stop_details: null,
                container: null,
                diagnostics: null,
                usage,
            },
        },
        ...['a', 'b'].flatMap((id, index) => [
            {
                type: 'content_block_start',
                index,
                content_block: {
                    type: 'tool_use',
                    id,
                    name: 'read',
                    input: {},
                    caller: { type: 'direct' },
                },
            },
            {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: id }) },
            },
            { type: 'content_block_stop', index },
        ]),
        {
            type: 'message_delta',
            delta: {
                stop_reason: 'tool_use',
                stop_sequence: null,
                stop_details: null,
                container: null,
            },
            usage: {
                output_tokens: 2,
                input_tokens: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                output_tokens_details: null,
                server_tool_use: null,
            },
        },
        { type: 'message_stop' },
    ];

    return sseOf(events);
};

const fake = (provider: Config['provider'], name = 'read', args = '{"path":"file"}') => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== 'string') {
            throw new Error('expected JSON request body');
        }

        bodies.push(JSON.parse(init.body));
        const first = bodies.length === 1;

        return provider === 'anthropic'
            ? anthropicReply(first, name, args)
            : completed(first ? [call(name, args)] : [message('Done')]);
    });

    return bodies;
};

const resultsOf = (
    provider: Config['provider'],
    body: Readonly<Record<string, unknown>> | undefined,
): unknown[] => {
    if (provider === 'anthropic') {
        const messages = body?.messages as readonly { readonly content?: unknown }[] | undefined;
        const content = messages?.at(-1)?.content;

        return Array.isArray(content) ? content : [];
    }

    const input = body?.input as readonly { readonly type?: string }[] | undefined;

    return input?.filter((item) => item.type === 'function_call_output') ?? [];
};

afterEach(() => vi.unstubAllGlobals());

describe('shared provider-bound loop', () => {
    test('reports a non-object Anthropic tool schema before networking', async () => {
        const config = configs[1];

        if (config === undefined) {
            throw new Error('missing test config');
        }

        const requests = fake('anthropic');
        const tool = defineTool(
            { name: 'bad', description: 'Bad schema', schema: z.string() },
            async () => ok('unused'),
        );

        expect(
            await createSession(config, { tools: [tool], history: initial, maxSteps: 2 }),
        ).toEqual({
            ok: false,
            error: "Can't prepare model tools: The input schema for bad must be an object.",
        });
        expect(requests).toHaveLength(0);
    });

    test.each(configs)(
        'runs a tool round trip with $provider, pausing between calls',
        async (config) => {
            const bodies = fake(config.provider);
            const run = vi.fn<() => Promise<ToolOutcome>>(async () => ok('contents'));
            const tool = defineTool(
                {
                    name: 'read',
                    description: 'Read',
                    schema: z.object({ path: z.string() }).strict(),
                },
                run,
            );
            const starting = structuredClone(initial);
            const created = await createSession(config, {
                tools: [tool],
                history: starting,
                maxSteps: 2,
            });

            expect(created.ok).toBe(true);

            if (!created.ok) {
                throw new Error(created.error);
            }

            const first = await created.value.steps.next();

            expect(first.value).toMatchObject({
                kind: 'calls',
                calls: [
                    {
                        call: { call_id: 'call_1', name: 'read' },
                        outcome: { ok: true, value: 'contents' },
                    },
                ],
            });
            expect(bodies).toHaveLength(1);
            expect(run).toHaveBeenCalledOnce();
            expect(created.value.history.at(-1)).toMatchObject({
                kind: 'tool_result',
                callId: 'call_1',
            });
            const second = await created.value.steps.next();

            expect(second.value).toMatchObject({
                kind: 'final',
                text: 'Done',
                stats: { number: 2, providerStats: { provider: config.provider } },
            });
            expect(bodies).toHaveLength(2);
            expect(starting).toEqual(initial);
            const expectedResult =
                config.provider === 'anthropic'
                    ? { type: 'tool_result', tool_use_id: 'call_1', content: 'contents' }
                    : { type: 'function_call_output', call_id: 'call_1', output: 'contents' };

            expect(resultsOf(config.provider, bodies[1])).toMatchObject([expectedResult]);
            expect(bodies[0]?.cache_control).toEqual(bodies[1]?.cache_control);
            expect(bodies[0]?.tools).toEqual(bodies[1]?.tools);
        },
    );

    test.each(configs)(
        'records a not-run result at the step limit for $provider',
        async (config) => {
            fake(config.provider);
            const run = vi.fn<() => Promise<ToolOutcome>>(async () => ok('contents'));
            const tool = defineTool(
                {
                    name: 'read',
                    description: 'Read',
                    schema: z.object({ path: z.string() }).strict(),
                },
                run,
            );
            const session = await createSession(config, {
                tools: [tool],
                history: initial,
                maxSteps: 1,
            });

            if (!session.ok) {
                throw new Error(session.error);
            }

            expect((await session.value.steps.next()).value).toMatchObject({ kind: 'step_limit' });
            expect(run).not.toHaveBeenCalled();
            expect(session.value.history.at(-1)).toMatchObject({
                kind: 'tool_result',
                callId: 'call_1',
                outcome: { ok: false, error: expect.stringContaining('step limit') },
            });
        },
    );

    test.each(configs)(
        'runs two calls sequentially and returns both in order with $provider',
        async (config) => {
            const bodies: Record<string, unknown>[] = [];
            vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
                if (typeof init?.body !== 'string') {
                    throw new Error('expected JSON request body');
                }

                bodies.push(JSON.parse(init.body));

                if (bodies.length > 1) {
                    return config.provider === 'anthropic'
                        ? anthropicReply(false)
                        : completed([message('Done')]);
                }

                return config.provider === 'anthropic'
                    ? anthropicTwoCalls()
                    : completed([
                          call('read', { path: 'a' }, 'a'),
                          call('read', { path: 'b' }, 'b'),
                      ]);
            });
            const order: string[] = [];
            const tool = defineTool(
                {
                    name: 'read',
                    description: 'Read',
                    schema: z.object({ path: z.string() }).strict(),
                },
                async ({ path }) => {
                    order.push(`start ${path}`);
                    await Promise.resolve();
                    order.push(`end ${path}`);

                    return ok(`contents ${path}`);
                },
            );
            const created = await createSession(config, {
                tools: [tool],
                history: initial,
                maxSteps: 2,
            });

            if (!created.ok) {
                throw new Error(created.error);
            }

            expect((await created.value.steps.next()).value).toMatchObject({
                kind: 'calls',
                calls: [
                    { call: { call_id: 'a' }, outcome: { ok: true, value: 'contents a' } },
                    { call: { call_id: 'b' }, outcome: { ok: true, value: 'contents b' } },
                ],
            });
            expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
            expect((await created.value.steps.next()).value).toMatchObject({ kind: 'final' });
            const expectedResults =
                config.provider === 'anthropic'
                    ? [
                          { type: 'tool_result', tool_use_id: 'a', content: 'contents a' },
                          { type: 'tool_result', tool_use_id: 'b', content: 'contents b' },
                      ]
                    : [
                          { type: 'function_call_output', call_id: 'a', output: 'contents a' },
                          { type: 'function_call_output', call_id: 'b', output: 'contents b' },
                      ];

            expect(resultsOf(config.provider, bodies[1])).toMatchObject(expectedResults);
        },
    );

    test.each(configs)(
        'records every not-run call on the last step for $provider',
        async (config) => {
            vi.stubGlobal('fetch', async () =>
                config.provider === 'anthropic'
                    ? anthropicTwoCalls()
                    : completed([
                          call('read', { path: 'a' }, 'a'),
                          call('read', { path: 'b' }, 'b'),
                      ]),
            );
            const run = vi.fn<() => Promise<ToolOutcome>>(async () => ok('contents'));
            const tool = defineTool(
                {
                    name: 'read',
                    description: 'Read',
                    schema: z.object({ path: z.string() }).strict(),
                },
                run,
            );
            const created = await createSession(config, {
                tools: [tool],
                history: initial,
                maxSteps: 1,
            });

            if (!created.ok) {
                throw new Error(created.error);
            }

            expect((await created.value.steps.next()).value).toMatchObject({ kind: 'step_limit' });
            expect(run).not.toHaveBeenCalled();
            expect(created.value.history.slice(-2)).toMatchObject([
                {
                    kind: 'tool_result',
                    callId: 'a',
                    outcome: { ok: false, error: expect.stringContaining('step limit') },
                },
                {
                    kind: 'tool_result',
                    callId: 'b',
                    outcome: { ok: false, error: expect.stringContaining('step limit') },
                },
            ]);
        },
    );

    test.each(configs)(
        'recovers from unknown tools and invalid inputs with $provider',
        async (config) => {
            for (const [name, args, expected] of [
                ['missing', '{}', 'unknown tool'],
                ['read', '{}', "don't match its schema"],
            ] as const) {
                const bodies = fake(config.provider, name, args);
                const run = vi.fn<() => Promise<ToolOutcome>>(async () => ok('contents'));
                const tool = defineTool(
                    {
                        name: 'read',
                        description: 'Read',
                        schema: z.object({ path: z.string() }).strict(),
                    },
                    run,
                );
                const created = await createSession(config, {
                    tools: [tool],
                    history: initial,
                    maxSteps: 2,
                });

                if (!created.ok) {
                    throw new Error(created.error);
                }

                const first = await created.value.steps.next();

                expect(first.value).toMatchObject({
                    kind: 'calls',
                    calls: [{ outcome: { ok: false, error: expect.stringContaining(expected) } }],
                });
                expect(run).not.toHaveBeenCalled();
                expect((await created.value.steps.next()).value).toMatchObject({
                    kind: 'final',
                    text: 'Done',
                });
                expect(bodies).toHaveLength(2);
                const errorText = expect.stringContaining(expected);
                const expectedResult =
                    config.provider === 'anthropic'
                        ? { type: 'tool_result', is_error: true, content: errorText }
                        : { type: 'function_call_output', call_id: 'call_1', output: errorText };

                expect(resultsOf(config.provider, bodies[1])).toMatchObject([expectedResult]);
            }
        },
    );

    test.each(configs)('recovers from a thrown handler with $provider', async (config) => {
        fake(config.provider);
        const tool = defineTool(
            { name: 'read', description: 'Read', schema: z.object({ path: z.string() }).strict() },
            async () => {
                throw new Error('disk on fire');
            },
        );
        const created = await createSession(config, {
            tools: [tool],
            history: initial,
            maxSteps: 2,
        });

        if (!created.ok) {
            throw new Error(created.error);
        }

        expect((await created.value.steps.next()).value).toMatchObject({
            kind: 'calls',
            calls: [{ outcome: { ok: false, error: expect.stringContaining('disk on fire') } }],
        });
        expect((await created.value.steps.next()).value).toMatchObject({
            kind: 'final',
            text: 'Done',
        });
    });

    test.each(configs)(
        "runs none of a reply's tools when the next request couldn't replay it, with $provider",
        async (config) => {
            vi.stubGlobal('fetch', async () =>
                config.provider === 'anthropic'
                    ? sseOf([
                          {
                              type: 'message_start',
                              message: {
                                  id: 'msg',
                                  type: 'message',
                                  role: 'assistant',
                                  model: 'test-model',
                                  content: [],
                                  stop_reason: null,
                                  stop_sequence: null,
                                  stop_details: null,
                                  container: null,
                                  diagnostics: null,
                                  usage,
                              },
                          },
                          {
                              type: 'content_block_start',
                              index: 0,
                              content_block: { type: 'container_upload', file_id: 'file_1' },
                          },
                          { type: 'content_block_stop', index: 0 },
                          {
                              type: 'content_block_start',
                              index: 1,
                              content_block: {
                                  type: 'tool_use',
                                  id: 'call_1',
                                  name: 'read',
                                  input: {},
                              },
                          },
                          {
                              type: 'content_block_delta',
                              index: 1,
                              delta: { type: 'input_json_delta', partial_json: '{"path":"file"}' },
                          },
                          { type: 'content_block_stop', index: 1 },
                          {
                              type: 'message_delta',
                              delta: {
                                  stop_reason: 'tool_use',
                                  stop_sequence: null,
                                  stop_details: null,
                                  container: null,
                              },
                              usage: {
                                  output_tokens: 2,
                                  input_tokens: null,
                                  cache_creation_input_tokens: null,
                                  cache_read_input_tokens: null,
                                  output_tokens_details: null,
                                  server_tool_use: null,
                              },
                          },
                          { type: 'message_stop' },
                      ])
                    : completed([
                          { type: 'future_item', id: 'fi_1' } as unknown as ResponseOutputItem,
                          call('read', '{"path":"file"}'),
                      ]),
            );
            const run = vi.fn<() => Promise<ToolOutcome>>(async () => ok('contents'));
            const tool = defineTool(
                {
                    name: 'read',
                    description: 'Read',
                    schema: z.object({ path: z.string() }).strict(),
                },
                run,
            );
            const created = await createSession(config, {
                tools: [tool],
                history: initial,
                maxSteps: 2,
            });

            if (!created.ok) {
                throw new Error(created.error);
            }

            const step = await created.value.steps.next();

            expect(step.value).toMatchObject({
                kind: 'history',
                error: expect.stringContaining(
                    config.provider === 'anthropic' ? 'container_upload' : 'future_item',
                ),
            });
            expect(run).not.toHaveBeenCalled();
            expect((await created.value.steps.next()).done).toBe(true);
        },
    );

    test('rejects cross-provider native history before requesting a model', async () => {
        const bodies = fake('anthropic');
        const config = configs[1];

        if (config === undefined) {
            throw new Error('missing test config');
        }

        const result = await createSession(config, {
            tools: [],
            history: [...initial, { kind: 'native', provider: 'openai', data: [] }],
            maxSteps: 1,
        });

        expect(result).toMatchObject({ ok: false, error: expect.stringContaining('openai') });
        expect(bodies).toHaveLength(0);
    });
});
