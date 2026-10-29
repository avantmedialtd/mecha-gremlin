import type { HistoryItem } from '@mecha-gremlin/core/history';
import { err, ok } from '@mecha-gremlin/core/result';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { Config } from '../../src/config/config.ts';
import { ANTHROPIC_RATE_HEADERS, createAnthropicAdapter } from '../../src/model/anthropic-call.ts';
import { toClaudeInput } from '../../src/model/anthropic-history.ts';

const config: Extract<Config, { provider: 'anthropic' }> = {
    provider: 'anthropic',
    baseUrl: 'https://claude.example',
    apiKey: 'real-test-key',
    model: 'claude-test',
    reasoningEffort: 'medium',
    maxOutputTokens: 4096,
    workspaceId: 'ws-test',
    skillsPath: undefined,
    maxSteps: 3,
    fileTools: 'write-edit',
    logFormat: 'json',
    workDir: '/',
};
const history: HistoryItem[] = [
    { kind: 'instruction', text: 'Be brief.' },
    { kind: 'user', text: 'Hello' },
];
const usage = {
    input_tokens: 400,
    output_tokens: 0,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 500,
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 100 },
    inference_geo: 'us',
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: 'standard',
    speed: 'standard',
};

const start = (id = 'msg_1') => ({
    type: 'message_start',
    message: {
        id,
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        container: null,
        diagnostics: null,
        usage: structuredClone(usage),
    },
});
const delta = (stop = 'end_turn', outputTokens = 25) => ({
    type: 'message_delta',
    delta: {
        stop_reason: stop,
        stop_sequence: null,
        stop_details: null,
        container: null,
    },
    usage: {
        output_tokens: outputTokens,
        input_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens_details: { thinking_tokens: 5 },
        server_tool_use: null,
    },
});
const text = (value: string) => [
    {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: null },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } },
    { type: 'content_block_stop', index: 0 },
];
const sse = (events: readonly { readonly type: string; readonly [key: string]: unknown }[]) =>
    new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        {
            headers: {
                'content-type': 'text/event-stream',
                'anthropic-ratelimit-input-tokens-remaining': '123',
                'retry-after': '7',
            },
        },
    );

const withoutDetails = (change: Readonly<Record<string, unknown>>) => {
    const initial = start();
    const final = delta();

    return sse([
        { ...initial, message: { ...initial.message, usage: { ...usage, ...change } } },
        ...text('answer'),
        {
            ...final,
            usage: {
                ...final.usage,
                output_tokens_details: undefined,
                server_tool_use: undefined,
                cache_creation_input_tokens: undefined,
                cache_read_input_tokens: undefined,
            },
        },
        { type: 'message_stop' },
    ]);
};

const server = (response: () => Response) => {
    const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (typeof init?.body !== 'string') {
            throw new Error('expected JSON request body');
        }

        requests.push({
            url: input instanceof Request ? input.url : String(input),
            body: JSON.parse(init.body),
            headers: new Headers(init?.headers),
        });

        return response();
    };
    vi.stubGlobal('fetch', fetch);

    return requests;
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('Anthropic Messages adapter', () => {
    test('streams with explicit credentials, workspace, schemas and five-minute caching', async () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'wrong-key');
        vi.stubEnv('ANTHROPIC_BASE_URL', 'https://wrong.example');
        vi.stubEnv(
            'ANTHROPIC_CUSTOM_HEADERS',
            'x-api-key: wrong-header\nanthropic-version: wrong-version',
        );
        const requests = server(() =>
            sse([start(), ...text('Hello!'), delta(), { type: 'message_stop' }]),
        );
        const tool = {
            name: 'read',
            description: 'Read text',
            schema: z.object({ offset: z.number().int().min(1).optional() }).strict(),
        };
        const result = await createAnthropicAdapter(config, [tool]).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                reply: { kind: 'final', text: 'Hello!' },
                providerStats: {
                    provider: 'anthropic',
                    usage: {
                        kind: 'complete',
                        value: {
                            input_tokens: 400,
                            output_tokens: 25,
                            cache_creation_input_tokens: 100,
                            cache_read_input_tokens: 500,
                            output_tokens_details: { thinking_tokens: 5 },
                        },
                    },
                    rateLimits: {
                        'anthropic-ratelimit-input-tokens-remaining': '123',
                        'retry-after': '7',
                    },
                },
            },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe('https://claude.example/v1/messages');
        expect(requests[0]?.headers.get('x-api-key')).toBe('real-test-key');
        expect(requests[0]?.headers.get('anthropic-version')).toBe('2026-10-21');
        expect(requests[0]?.headers.get('anthropic-workspace-id')).toBe('ws-test');
        expect(requests[0]?.body).toMatchObject({
            model: 'claude-test',
            stream: true,
            max_tokens: 4096,
            output_config: { effort: 'medium' },
            system: 'Be brief.',
            messages: [{ role: 'user', content: 'Hello' }],
            cache_control: { type: 'ephemeral', ttl: '5m' },
            diagnostics: { previous_message_id: null },
            tools: [
                {
                    name: 'read',
                    input_schema: { type: 'object', properties: { offset: { minimum: 1 } } },
                },
            ],
        });
        expect(
            ((requests[0]?.body.tools ?? []) as Record<string, unknown>[])[0],
        ).not.toHaveProperty('strict');
    });

    test('replays thinking and two calls with grouped ordered results', () => {
        const blocks = [
            { type: 'thinking', thinking: 'reasoning', signature: 'signature' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'Reading', citations: null },
            { type: 'tool_use', id: 'a', name: 'read', input: { path: 'a' } },
            { type: 'tool_use', id: 'b', name: 'read', input: { path: 'b' } },
        ];
        const conversation: HistoryItem[] = [
            ...history,
            { kind: 'native', provider: 'anthropic', data: { id: 'msg_1', content: blocks } },
            { kind: 'tool_result', callId: 'a', outcome: err('missing') },
            { kind: 'tool_result', callId: 'b', outcome: ok('contents') },
        ];
        const before = structuredClone(conversation);

        expect(toClaudeInput(conversation)).toEqual({
            ok: true,
            value: {
                system: 'Be brief.',
                previousMessageId: 'msg_1',
                messages: [
                    { role: 'user', content: 'Hello' },
                    { role: 'assistant', content: blocks },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: 'a',
                                content: 'missing',
                                is_error: true,
                            },
                            { type: 'tool_result', tool_use_id: 'b', content: 'contents' },
                        ],
                    },
                ],
            },
        });
        expect(conversation).toEqual(before);
    });

    test('assembles partial tool JSON and returns a client call only after message_stop', async () => {
        server(() =>
            sse([
                start(),
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                        type: 'tool_use',
                        id: 'a',
                        name: 'read',
                        input: {},
                        caller: { type: 'direct' },
                    },
                },
                {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '{"path":' },
                },
                {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '"a"}' },
                },
                { type: 'content_block_stop', index: 0 },
                delta('tool_use'),
                { type: 'message_stop' },
            ]),
        );
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                reply: {
                    kind: 'calls',
                    calls: [{ call_id: 'a', name: 'read', arguments: '{"path":"a"}' }],
                },
                native: {
                    data: {
                        id: 'msg_1',
                        content: [{ type: 'tool_use', id: 'a', input: { path: 'a' } }],
                    },
                },
            },
        });
    });

    test('replays streamed signed thinking and multiple calls unchanged with grouped results', async () => {
        let count = 0;
        const first = [
            start(),
            {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '', signature: '' },
            },
            {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'reasoning' },
            },
            {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'signed' },
            },
            { type: 'content_block_stop', index: 0 },
            {
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'redacted_thinking', data: 'opaque' },
            },
            { type: 'content_block_stop', index: 1 },
            {
                type: 'content_block_start',
                index: 2,
                content_block: { type: 'text', text: '', citations: null },
            },
            {
                type: 'content_block_delta',
                index: 2,
                delta: { type: 'text_delta', text: 'Reading.' },
            },
            { type: 'content_block_stop', index: 2 },
            ...['a', 'b'].flatMap((id, n) => [
                {
                    type: 'content_block_start',
                    index: n + 3,
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
                    index: n + 3,
                    delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: id }) },
                },
                { type: 'content_block_stop', index: n + 3 },
            ]),
            delta('tool_use'),
            { type: 'message_stop' },
        ];
        const requests = server(() =>
            sse(
                count++ === 0
                    ? first
                    : [start(), ...text('Done'), delta(), { type: 'message_stop' }],
            ),
        );
        const adapter = createAnthropicAdapter(config, []);
        const response = await adapter.call({ model: config.model, history });

        expect(response).toMatchObject({
            ok: true,
            value: {
                reply: { kind: 'calls', calls: [{ call_id: 'a' }, { call_id: 'b' }] },
                native: {
                    data: {
                        content: [
                            { type: 'thinking', thinking: 'reasoning', signature: 'signed' },
                            { type: 'redacted_thinking', data: 'opaque' },
                            { type: 'text', text: 'Reading.' },
                            { type: 'tool_use', id: 'a', input: { path: 'a' } },
                            { type: 'tool_use', id: 'b', input: { path: 'b' } },
                        ],
                    },
                },
            },
        });

        if (!response.ok) {
            throw new Error(response.error.detail);
        }

        const replay: HistoryItem[] = [
            ...history,
            response.value.native,
            { kind: 'tool_result', callId: 'a', outcome: err('missing') },
            { kind: 'tool_result', callId: 'b', outcome: ok('contents') },
        ];
        const second = await adapter.call({ model: config.model, history: replay });

        expect(second).toMatchObject({
            ok: true,
            value: { reply: { kind: 'final', text: 'Done' } },
        });
        expect(requests[1]?.body.messages).toEqual([
            { role: 'user', content: 'Hello' },
            {
                role: 'assistant',
                content: (response.value.native.data as { content: unknown }).content,
            },
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'a', content: 'missing', is_error: true },
                    { type: 'tool_result', tool_use_id: 'b', content: 'contents' },
                ],
            },
        ]);
        expect(requests[0]?.body.system).toEqual(requests[1]?.body.system);
        expect(requests[0]?.body.tools).toEqual(requests[1]?.body.tools);
        expect(requests[0]?.body.cache_control).toEqual(requests[1]?.body.cache_control);
    });

    test('asks for cache diagnostics against the previous reply', async () => {
        let count = 0;
        const requests = server(() =>
            sse([start(`msg_${++count}`), ...text('Done'), delta(), { type: 'message_stop' }]),
        );
        const adapter = createAnthropicAdapter(config, []);
        const first = await adapter.call({ model: config.model, history });

        if (!first.ok) {
            throw new Error(first.error.detail);
        }

        await adapter.call({
            model: config.model,
            history: [...history, first.value.native, { kind: 'user', text: 'Again' }],
        });

        expect(first.value.native.data).toMatchObject({ id: 'msg_1' });
        expect(requests.map((request) => request.body.diagnostics)).toEqual([
            { previous_message_id: null },
            { previous_message_id: 'msg_1' },
        ]);
    });

    test('reports max_tokens as incomplete and preserves usage', async () => {
        server(() =>
            sse([start(), ...text('unfinished'), delta('max_tokens'), { type: 'message_stop' }]),
        );
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                kind: 'incomplete',
                detail: expect.stringContaining('max_tokens'),
                providerStats: { usage: { kind: 'complete', value: { output_tokens: 25 } } },
            },
        });
    });

    test('does not accept a truncated tool input when max_tokens is reached', async () => {
        server(() =>
            sse([
                start(),
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                        type: 'tool_use',
                        id: 'a',
                        name: 'read',
                        input: {},
                        caller: { type: 'direct' },
                    },
                },
                {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '{"path":' },
                },
                { type: 'content_block_stop', index: 0 },
                delta('max_tokens'),
                { type: 'message_stop' },
            ]),
        );
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'incomplete', detail: expect.stringContaining('max_tokens') },
        });
    });

    test('does not add cumulative output usage updates together', async () => {
        server(() =>
            sse([
                start(),
                ...text('answer'),
                delta('end_turn', 10),
                delta('end_turn', 25),
                { type: 'message_stop' },
            ]),
        );
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: true,
            value: { providerStats: { usage: { kind: 'complete', value: { output_tokens: 25 } } } },
        });
    });

    test('returns a refusal as visible answer text', async () => {
        server(() =>
            sse([
                start(),
                ...text('I cannot help with that.'),
                delta('refusal'),
                { type: 'message_stop' },
            ]),
        );

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({
            ok: true,
            value: { reply: { kind: 'final', text: 'I cannot help with that.' } },
        });
    });

    test('trims a final answer and exposes the adapter and native response tags', async () => {
        server(() => sse([start(), ...text('  answer \n'), delta(), { type: 'message_stop' }]));
        const adapter = createAnthropicAdapter(config, []);

        expect(adapter.provider).toBe('anthropic');
        expect(await adapter.call({ model: config.model, history })).toMatchObject({
            ok: true,
            value: {
                reply: { kind: 'final', text: 'answer' },
                native: { kind: 'native', provider: 'anthropic' },
            },
        });
    });

    test('rejects malformed history without networking', async () => {
        const requests = server(() => sse([]));
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history: [{ kind: 'native', provider: 'openai', data: [] }],
        });

        expect(result).toEqual({
            ok: false,
            error: {
                kind: 'fatal',
                detail: 'History belongs to openai, not anthropic.',
                providerStats: {
                    provider: 'anthropic',
                    usage: { kind: 'unavailable' },
                    rateLimits: {},
                },
            },
        });
        expect(requests).toHaveLength(0);
    });

    test.each([
        { type: 'tool_use', name: 'read', input: {} },
        { type: 'tool_use', id: 'a', input: {} },
        { type: 'tool_use', id: 'a', name: 'read' },
    ])('rejects a malformed streamed tool block %j', async (block) => {
        server(() =>
            sse([
                start(),
                { type: 'content_block_start', index: 0, content_block: block },
                { type: 'content_block_stop', index: 0 },
                delta('tool_use'),
                { type: 'message_stop' },
            ]),
        );

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({
            ok: false,
            error: { kind: 'failed', detail: 'the response has a malformed tool-use block' },
        });
    });

    test('rejects a tool call with a final stop reason', async () => {
        server(() =>
            sse([
                start(),
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'tool_use', id: 'a', name: 'read', input: {} },
                },
                { type: 'content_block_stop', index: 0 },
                delta(),
                { type: 'message_stop' },
            ]),
        );

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({
            ok: false,
            error: { kind: 'failed', detail: 'unexpected end_turn stop with client tool calls' },
        });
    });

    test('reports cumulative input and cache updates without retaining stale values', async () => {
        const final = delta();
        const updated = {
            ...final,
            usage: {
                ...final.usage,
                input_tokens: 410,
                cache_creation_input_tokens: 101,
                cache_read_input_tokens: 501,
            },
        };
        server(() => sse([start(), ...text('answer'), updated, { type: 'message_stop' }]));

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({
            ok: true,
            value: {
                providerStats: {
                    usage: {
                        kind: 'complete',
                        value: {
                            input_tokens: 410,
                            cache_creation_input_tokens: 101,
                            cache_read_input_tokens: 501,
                        },
                    },
                },
            },
        });
    });

    test.each([null, undefined])('keeps absent initial usage unavailable: %j', async (missing) => {
        const initial = start();
        const withoutUsage = {
            ...initial,
            message: {
                ...initial.message,
                stop_reason: 'end_turn',
                usage: missing,
                diagnostics: undefined,
            },
        };
        server(() => sse([withoutUsage, { type: 'message_stop' }]));

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toStrictEqual({
            ok: true,
            value: {
                reply: { kind: 'empty' },
                native: {
                    kind: 'native',
                    provider: 'anthropic',
                    data: { id: 'msg_1', content: [] },
                },
                providerStats: {
                    provider: 'anthropic',
                    usage: { kind: 'unavailable' },
                    rateLimits: {
                        'anthropic-ratelimit-input-tokens-remaining': '123',
                        'retry-after': '7',
                    },
                },
            },
        });
    });

    test('a missing output count is partial even at the end of a stream', async () => {
        const initial = start();
        const withoutOutput = {
            ...initial,
            message: { ...initial.message, usage: { ...usage, output_tokens: undefined } },
        };
        const final = delta();
        server(() =>
            sse([
                withoutOutput,
                ...text('answer'),
                { ...final, usage: { ...final.usage, output_tokens: undefined } },
                { type: 'message_stop' },
            ]),
        );

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({ ok: true, value: { providerStats: { usage: { kind: 'partial' } } } });
    });

    test.each(
        [
            [
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '', citations: null },
                },
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '', citations: null },
                },
                { type: 'content_block_stop', index: 0 },
            ],
            [
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '', citations: null },
                },
                { type: 'content_block_stop', index: 0 },
                {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: 'late' },
                },
            ],
            [
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '', citations: null },
                },
                { type: 'content_block_stop', index: 0 },
                { type: 'content_block_stop', index: 0 },
            ],
            [
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '', citations: null },
                },
            ],
        ].map((events) => [events]),
    )('rejects unordered or unclosed content blocks', async (events) => {
        server(() => sse([start(), ...events, delta(), { type: 'message_stop' }]));

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({
            ok: false,
            error: {
                kind: 'failed',
                detail: 'the response contains incomplete tool or content blocks',
            },
        });
    });

    test('returns an empty reply when no answer or client tool was produced', async () => {
        server(() => sse([start(), delta(), { type: 'message_stop' }]));

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({ ok: true, value: { reply: { kind: 'empty' } } });
    });

    test.each(['tool_use', 'pause_turn'])(
        'rejects an unsupported or malformed %s stop',
        async (stop) => {
            server(() => sse([start(), delta(stop), { type: 'message_stop' }]));

            expect(
                await createAnthropicAdapter(config, []).call({
                    model: config.model,
                    history,
                }),
            ).toMatchObject({
                ok: false,
                error: { kind: 'failed', detail: expect.stringContaining(stop) },
            });
        },
    );

    test('classifies context exhaustion as incomplete', async () => {
        server(() =>
            sse([
                start(),
                ...text('unfinished'),
                delta('model_context_window_exceeded'),
                { type: 'message_stop' },
            ]),
        );

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({
            ok: false,
            error: {
                kind: 'incomplete',
                detail: expect.stringContaining('model_context_window_exceeded'),
            },
        });
    });

    test('rejects a malformed completed tool input', async () => {
        server(() =>
            sse([
                start(),
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: {
                        type: 'tool_use',
                        id: 'a',
                        name: 'read',
                        input: {},
                        caller: { type: 'direct' },
                    },
                },
                {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '{"path":' },
                },
                { type: 'content_block_stop', index: 0 },
                delta('tool_use'),
                { type: 'message_stop' },
            ]),
        );

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({ ok: false, error: { kind: 'failed' } });
    });

    test.each([
        [400, 'bad_request'],
        [401, 'auth'],
        [403, 'auth'],
        [429, 'rate_limit'],
        [500, 'server_error'],
    ] as const)('classifies HTTP %i as %s and retains headers', async (status, kind) => {
        const requests = server(() =>
            Response.json(
                { type: 'error', error: { type: 'api_error', message: 'server said no' } },
                { status, headers: { 'retry-after': '5' } },
            ),
        );
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: false,
            error: { kind, status, providerStats: { rateLimits: { 'retry-after': '5' } } },
        });
        expect(requests).toHaveLength(1);
    });

    test('a caller abort is classified as aborted', async () => {
        server(() => sse([start(), ...text('answer'), delta(), { type: 'message_stop' }]));
        const controller = new AbortController();
        controller.abort();

        expect(
            await createAnthropicAdapter(config, []).call(
                { model: config.model, history },
                { signal: controller.signal },
            ),
        ).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    });

    test('classifies a connection failure as unreachable', async () => {
        vi.stubGlobal('fetch', async () => {
            throw new TypeError('fetch failed');
        });

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({
            ok: false,
            error: { kind: 'unreachable', detail: expect.stringContaining('fetch failed') },
        });
    });

    test('classifies a caller abort after streaming starts', async () => {
        const bytes = new TextEncoder().encode(
            `event: message_start\ndata: ${JSON.stringify(start())}\n\n`,
        );
        vi.stubGlobal(
            'fetch',
            async (_input: string | URL | Request, init?: RequestInit) =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(bytes);
                            init?.signal?.addEventListener('abort', () =>
                                controller.error(new DOMException('aborted', 'AbortError')),
                            );
                        },
                    }),
                    { headers: { 'content-type': 'text/event-stream' } },
                ),
        );
        const controller = new AbortController();
        const pending = createAnthropicAdapter(config, []).call(
            { model: config.model, history },
            { signal: controller.signal },
        );
        setTimeout(() => controller.abort(), 20);

        expect(await pending).toMatchObject({
            ok: false,
            error: {
                kind: 'aborted',
                detail: 'the model call was aborted',
                providerStats: { usage: { kind: 'partial', value: { input_tokens: 400 } } },
            },
        });
    });

    test('captures all documented rate headers and complete diagnostics', async () => {
        const headers = Object.fromEntries(
            ANTHROPIC_RATE_HEADERS.map((name, index) => [name, String(index)]),
        );
        const initial = start();
        const withDiagnostics = {
            ...initial,
            message: {
                ...initial.message,
                diagnostics: {
                    cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 17 },
                },
            },
        };
        server(() => {
            const final = delta();
            const withServerUsage = {
                ...final,
                usage: {
                    ...final.usage,
                    server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 },
                },
            };
            const response = sse([
                withDiagnostics,
                ...text('done'),
                withServerUsage,
                { type: 'message_stop' },
            ]);

            return new Response(response.body, {
                headers: { ...headers, 'content-type': 'text/event-stream' },
            });
        });
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                providerStats: {
                    diagnostics: {
                        cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 17 },
                    },
                    rateLimits: headers,
                    usage: {
                        kind: 'complete',
                        value: {
                            ...usage,
                            output_tokens: 25,
                            output_tokens_details: { thinking_tokens: 5 },
                            server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 },
                        },
                    },
                },
            },
        });
    });

    test.each([
        { type: 'model_changed', cache_missed_input_tokens: 1 },
        { type: 'system_changed', cache_missed_input_tokens: 2 },
        { type: 'tools_changed', cache_missed_input_tokens: 3 },
        { type: 'messages_changed', cache_missed_input_tokens: 4 },
        { type: 'previous_message_not_found' },
        { type: 'unavailable' },
    ])('preserves $type cache diagnostics', async (reason) => {
        const initial = start();
        const withDiagnostics = {
            ...initial,
            message: { ...initial.message, diagnostics: { cache_miss_reason: reason } },
        };
        server(() => sse([withDiagnostics, ...text('done'), delta(), { type: 'message_stop' }]));

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({
            ok: true,
            value: { providerStats: { diagnostics: { cache_miss_reason: reason } } },
        });
    });

    test('keeps missing usage fields absent instead of inventing zeroes', async () => {
        const initial = start();
        const partialStart = {
            ...initial,
            message: {
                ...initial.message,
                usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0 },
            },
        };
        server(() => sse([partialStart, ...text('answer'), delta(), { type: 'message_stop' }]));
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                providerStats: {
                    usage: {
                        kind: 'complete',
                        value: { input_tokens: 10, output_tokens: 25, cache_read_input_tokens: 0 },
                    },
                },
            },
        });

        if (!result.ok || result.value.providerStats.usage.kind !== 'complete') {
            throw new Error('expected complete usage');
        }

        expect(result.value.providerStats.usage.value).not.toHaveProperty('cache_creation');
    });

    test('marks an incomplete nested usage breakdown as partial', async () => {
        const initial = start();
        const partialStart = {
            ...initial,
            message: {
                ...initial.message,
                usage: { ...usage, cache_creation: { ephemeral_5m_input_tokens: 100 } },
            },
        };
        server(() => sse([partialStart, ...text('answer'), delta(), { type: 'message_stop' }]));
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                providerStats: {
                    usage: {
                        kind: 'partial',
                        value: { cache_creation: { ephemeral_5m_input_tokens: 100 } },
                    },
                },
            },
        });
    });

    test.each([
        { input_tokens: null },
        { cache_creation_input_tokens: '100' },
        { cache_read_input_tokens: '500' },
        { inference_geo: 7 },
        { cache_creation: { ephemeral_1h_input_tokens: 0 } },
        { cache_creation: { ephemeral_5m_input_tokens: 1 } },
        { output_tokens_details: {} },
        { server_tool_use: { web_fetch_requests: 2 } },
        { server_tool_use: { web_search_requests: 2 } },
        { service_tier: 'other' },
        { speed: 'other' },
    ])('marks incomplete or malformed usage %j as partial', async (change) => {
        server(() => withoutDetails(change));

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({ ok: true, value: { providerStats: { usage: { kind: 'partial' } } } });
    });

    test.each([
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
        'inference_geo',
        'cache_creation',
        'output_tokens_details',
        'server_tool_use',
        'service_tier',
        'speed',
    ])(
        'final usage without %s, which the API leaves out when it does not apply, is complete',
        async (field) => {
            server(() => withoutDetails({ [field]: undefined }));
            const result = await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            });

            expect(result).toMatchObject({
                ok: true,
                value: { providerStats: { usage: { kind: 'complete' } } },
            });
            expect(result.ok && result.value.providerStats.usage).not.toHaveProperty(
                `value.${field}`,
            );
        },
    );

    test.each([
        {
            service_tier: null,
            speed: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            inference_geo: null,
        },
        { service_tier: 'priority', speed: 'fast' },
        { service_tier: 'batch', speed: 'standard' },
        { cache_creation: null, output_tokens_details: null, server_tool_use: null },
    ])('accepts complete nullable and service usage %j', async (change) => {
        const initial = start();
        const withUsage = {
            ...initial,
            message: { ...initial.message, usage: { ...usage, ...change } },
        };
        const final = delta();
        server(() =>
            sse([
                withUsage,
                ...text('answer'),
                { ...final, usage: { ...final.usage, output_tokens_details: null } },
                { type: 'message_stop' },
            ]),
        );

        expect(
            await createAnthropicAdapter(config, []).call({
                model: config.model,
                history,
            }),
        ).toMatchObject({
            ok: true,
            value: { providerStats: { usage: { kind: 'complete', value: change } } },
        });
    });

    test('retains partial usage when a stream breaks mid-message', async () => {
        const bytes = new TextEncoder().encode(
            `event: message_start\ndata: ${JSON.stringify(start())}\n\n`,
        );
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(bytes);
                            setTimeout(() => controller.error(new Error('socket broke')), 10);
                        },
                    }),
                    { headers: { 'content-type': 'text/event-stream' } },
                ),
        );
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                kind: 'failed',
                detail: expect.stringContaining('socket broke'),
                providerStats: { usage: { kind: 'partial', value: { input_tokens: 400 } } },
            },
        });
    });

    test('does not take a workspace from SDK environment headers when unset', async () => {
        vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'anthropic-workspace-id: unexpected');
        const requests = server(() =>
            sse([start(), ...text('answer'), delta(), { type: 'message_stop' }]),
        );
        await createAnthropicAdapter({ ...config, workspaceId: undefined }, []).call({
            model: config.model,
            history,
        });

        expect(requests[0]?.headers.get('anthropic-workspace-id')).toBeNull();
    });

    test('sends none of the other headers in ANTHROPIC_CUSTOM_HEADERS', async () => {
        vi.stubEnv(
            'ANTHROPIC_CUSTOM_HEADERS',
            'anthropic-beta: some-beta-2026\n x-gateway-key : secret\nnot a header',
        );
        const requests = server(() =>
            sse([start(), ...text('answer'), delta(), { type: 'message_stop' }]),
        );

        await createAnthropicAdapter(config, []).call({ model: config.model, history });

        expect(requests[0]?.headers.get('anthropic-beta')).toBeNull();
        expect(requests[0]?.headers.get('x-gateway-key')).toBeNull();
        expect(requests[0]?.headers.get('x-api-key')).toBe('real-test-key');
    });

    test('answers at message_stop, and drops a body that stays open', async () => {
        const events = [start(), ...text('answer'), delta(), { type: 'message_stop' }];
        const frames = events.map(
            (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
        let signal: AbortSignal | undefined;
        vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
            signal = init?.signal ?? undefined;

            return new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(frames.join('')));
                        signal?.addEventListener('abort', () =>
                            controller.error(new DOMException('aborted', 'AbortError')),
                        );
                    },
                }),
                { headers: { 'content-type': 'text/event-stream' } },
            );
        });

        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: true,
            value: { reply: { kind: 'final', text: 'answer' } },
        });
        expect(signal?.aborted).toBe(true);
    });

    test('keeps only the fields the API sent in the native blocks', async () => {
        server(() =>
            sse([
                start(),
                {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
                },
                {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' },
                },
                { type: 'content_block_stop', index: 0 },
                ...text('Reading it.').map((event) => ({ ...event, index: 1 })),
                delta('tool_use'),
                { type: 'message_stop' },
            ]),
        );

        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });
        const blocks = result.ok ? (result.value.native.data as { content: object[] }).content : [];

        expect(blocks).toHaveLength(2);
        expect(blocks.map((block) => Object.getOwnPropertyNames(block))).toEqual(
            blocks.map((block) => Object.keys(block)),
        );
    });

    test('fails a stream without message_stop and retains partial usage', async () => {
        server(() => sse([start(), ...text('unfinished'), delta()]));
        const result = await createAnthropicAdapter(config, []).call({
            model: config.model,
            history,
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                kind: 'failed',
                providerStats: {
                    usage: { kind: 'partial', value: { input_tokens: 400, output_tokens: 25 } },
                },
            },
        });
    });

    test('refuses incomplete and cross-provider history', () => {
        expect(toClaudeInput([{ kind: 'native', provider: 'openai', data: [] }])).toMatchObject({
            ok: false,
            error: expect.stringContaining('openai'),
        });
        expect(
            toClaudeInput([
                {
                    kind: 'native',
                    provider: 'anthropic',
                    data: { content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] },
                },
            ]),
        ).toMatchObject({ ok: false, error: expect.stringContaining('tool call a') });
        expect(
            toClaudeInput([
                {
                    kind: 'native',
                    provider: 'anthropic',
                    data: { content: [{ type: 'thinking', thinking: 'missing signature' }] },
                },
            ]),
        ).toMatchObject({ ok: false, error: expect.stringContaining('thinking') });
    });
});
