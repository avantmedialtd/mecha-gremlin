import type { HistoryItem } from '@mecha-gremlin/core/history';
import { err } from '@mecha-gremlin/core/result';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '../../src/config/config.ts';
import { RESPONSE_RATE_HEADERS, createResponsesAdapter } from '../../src/model/responses-call.ts';
import { toInput } from '../../src/model/responses-history.ts';
import { call, completed, fakeFetch, message, reasoning, usage } from '../fake-model.ts';

const config: Extract<Config, { provider: 'openai' | 'lmstudio' }> = {
    provider: 'openai',
    baseUrl: 'https://models.example.com/v1',
    apiKey: 'test-key',
    model: 'test-model',
    reasoningEffort: 'low',
    skillsPath: undefined,
    maxSteps: 3,
    fileTools: 'write-edit',
    logFormat: 'json',
    workDir: '/',
};

const initial: HistoryItem[] = [
    { kind: 'instruction', text: 'Be brief.' },
    { kind: 'user', text: 'Hello' },
];

afterEach(() => vi.unstubAllGlobals());

describe('Responses adapter', () => {
    test('sends one streamed stateless request and retains native output', async () => {
        const output = [reasoning(), message('Hello')];
        const server = fakeFetch({ responses: () => completed(output) });
        vi.stubGlobal('fetch', server.fetch);
        const adapter = createResponsesAdapter(config, []);
        const result = await adapter.call({ model: config.model, history: initial });

        expect(result).toMatchObject({
            ok: true,
            value: {
                reply: { kind: 'final', text: 'Hello' },
                native: { kind: 'native', provider: 'openai', data: output },
                providerStats: { provider: 'openai', usage: { kind: 'complete', value: usage() } },
            },
        });
        expect(server.modelCallBodies()).toMatchObject([
            {
                model: 'test-model',
                stream: true,
                store: false,
                reasoning: { effort: 'low' },
                input: [
                    { role: 'developer', content: 'Be brief.' },
                    { role: 'user', content: 'Hello' },
                ],
            },
        ]);
    });

    test("takes no header, organization, project or log level from the SDK's environment", async () => {
        vi.stubEnv(
            'OPENAI_CUSTOM_HEADERS',
            'Authorization: Bearer env-key\n x-extra : injected\nnot a header',
        );
        vi.stubEnv('OPENAI_ORG_ID', 'org-env');
        vi.stubEnv('OPENAI_PROJECT_ID', 'proj-env');
        vi.stubEnv('OPENAI_LOG', 'debug');
        const debug = vi.spyOn(console, 'debug');
        const info = vi.spyOn(console, 'info');
        let headers = new Headers();
        vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
            headers = new Headers(init?.headers);

            return completed([message('Hello')]);
        });

        const result = await createResponsesAdapter(config, []).call({
            model: config.model,
            history: initial,
        });

        expect(result.ok).toBe(true);
        expect(headers.get('authorization')).toBe('Bearer test-key');
        expect(headers.get('openai-organization')).toBeNull();
        expect(headers.get('openai-project')).toBeNull();
        expect(headers.get('x-extra')).toBeNull();
        expect(debug).not.toHaveBeenCalled();
        expect(info).not.toHaveBeenCalled();
    });

    test('replays native items and tool outcomes without changing history', () => {
        const native = [reasoning(), call('read', { path: 'x' })];
        const history: HistoryItem[] = [
            ...initial,
            { kind: 'native', provider: 'openai', data: native },
            { kind: 'tool_result', callId: 'call_1', outcome: err('not found') },
        ];
        const before = structuredClone(history);
        const input = toInput(history, 'openai');

        expect(input).toMatchObject({
            ok: true,
            value: [
                ...initial.map((entry) =>
                    entry.kind === 'instruction'
                        ? { role: 'developer', content: entry.text }
                        : { role: 'user', content: 'Hello' },
                ),
                ...native,
                { type: 'function_call_output', call_id: 'call_1', output: 'Error: not found' },
            ],
        });
        expect(history).toEqual(before);
    });

    test('rejects other providers and unsupported native items', () => {
        expect(
            toInput([{ kind: 'native', provider: 'anthropic', data: [] }], 'openai'),
        ).toMatchObject({ ok: false, error: expect.stringContaining('anthropic') });
        expect(
            toInput(
                [{ kind: 'native', provider: 'openai', data: [{ type: 'made_up' }] }],
                'openai',
            ),
        ).toMatchObject({ ok: false, error: expect.stringContaining('made_up') });
    });

    test('rejects malformed history before making a request', async () => {
        const server = fakeFetch();
        vi.stubGlobal('fetch', server.fetch);
        const result = await createResponsesAdapter(config, []).call({
            model: config.model,
            history: [{ kind: 'native', provider: 'anthropic', data: [] }],
        });

        expect(result).toEqual({
            ok: false,
            error: {
                kind: 'fatal',
                detail: 'History belongs to anthropic, not openai.',
                providerStats: {
                    provider: 'openai',
                    usage: { kind: 'unavailable' },
                    rateLimits: {},
                },
            },
        });
        expect(server.requests).toHaveLength(0);
    });

    test('captures rate-limit headers on an HTTP error', async () => {
        vi.stubGlobal('fetch', async () =>
            Response.json(
                { error: { message: 'slow down' } },
                {
                    status: 429,
                    headers: { 'retry-after': '12', 'x-ratelimit-remaining-requests': '0' },
                },
            ),
        );
        const result = await createResponsesAdapter(config, []).call({
            model: config.model,
            history: initial,
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                kind: 'rate_limit',
                status: 429,
                providerStats: {
                    usage: { kind: 'unavailable' },
                    rateLimits: { 'retry-after': '12', 'x-ratelimit-remaining-requests': '0' },
                },
            },
        });
    });

    test('retains all documented headers, usage and response diagnostics', async () => {
        const headers = Object.fromEntries(
            RESPONSE_RATE_HEADERS.map((name, index) => [name, String(index)]),
        );
        const diagnostics = {
            type: 'cache_miss',
            reason: 'tools_changed',
            cache_missed_tokens: 11,
            comparison_reusable_tokens: 9,
        };
        const options = { mode: 'implicit', ttl: '30m', comparison_response_id: 'resp_previous' };
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(
                    `event: response.completed\ndata: ${JSON.stringify({
                        type: 'response.completed',
                        response: {
                            output: [message('Done')],
                            usage: usage(),
                            prompt_cache_diagnostics: diagnostics,
                            prompt_cache_options: options,
                            prompt_cache_retention: '24h',
                            service_tier: 'priority',
                        },
                    })}\n\n`,
                    { headers: { ...headers, 'content-type': 'text/event-stream' } },
                ),
        );
        const result = await createResponsesAdapter(config, []).call({
            model: config.model,
            history: initial,
        });

        expect(result).toMatchObject({
            ok: true,
            value: {
                providerStats: {
                    usage: { kind: 'complete', value: usage() },
                    prompt_cache_diagnostics: diagnostics,
                    prompt_cache_options: options,
                    prompt_cache_retention: '24h',
                    service_tier: 'priority',
                    rateLimits: headers,
                },
            },
        });
    });

    test.each([
        { type: 'cache_hit' },
        { type: 'comparison_response_not_found' },
        { type: 'unavailable' },
        {
            type: 'cache_miss',
            reason: 'input_changed',
            cache_missed_tokens: 10,
            comparison_reusable_tokens: 2,
        },
    ])('preserves $type cache diagnostics', async (diagnostics) => {
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(
                    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [message('Done')], prompt_cache_diagnostics: diagnostics } })}\n\n`,
                    { headers: { 'content-type': 'text/event-stream' } },
                ),
        );

        expect(
            await createResponsesAdapter(config, []).call({
                model: config.model,
                history: initial,
            }),
        ).toMatchObject({
            ok: true,
            value: { providerStats: { prompt_cache_diagnostics: diagnostics } },
        });
    });

    test('distinguishes a reported zero from a missing usage field', async () => {
        const partial = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(
                    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [message('Done')], usage: partial } })}\n\n`,
                    { headers: { 'content-type': 'text/event-stream' } },
                ),
        );
        const result = await createResponsesAdapter(config, []).call({
            model: config.model,
            history: initial,
        });

        expect(result).toMatchObject({
            ok: true,
            value: { providerStats: { usage: { kind: 'partial', value: partial } } },
        });

        if (!result.ok || result.value.providerStats.usage.kind !== 'partial') {
            throw new Error('expected partial usage');
        }

        expect(result.value.providerStats.usage.value).not.toHaveProperty('input_tokens_details');
    });

    test('usage reported before an interrupted stream remains partial even with every field present', async () => {
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(
                    `event: response.in_progress\ndata: ${JSON.stringify({ type: 'response.in_progress', response: { output: [], usage: usage() } })}\n\n`,
                    { headers: { 'content-type': 'text/event-stream' } },
                ),
        );
        const result = await createResponsesAdapter(config, []).call({
            model: config.model,
            history: initial,
        });

        expect(result).toMatchObject({
            ok: false,
            error: {
                kind: 'failed',
                providerStats: { usage: { kind: 'partial', value: usage() } },
            },
        });
    });

    test.each([
        { input_tokens: undefined },
        { input_tokens_details: undefined },
        { input_tokens_details: { cache_write_tokens: 0 } },
        { input_tokens_details: { cached_tokens: 0 } },
        { output_tokens: undefined },
        { output_tokens_details: undefined },
        { output_tokens_details: {} },
        { total_tokens: undefined },
    ])('reports each incomplete usage breakdown as partial: %j', async (missing) => {
        const partial = { ...usage(), ...missing };
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(
                    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [message('Done')], usage: partial } })}\n\n`,
                    { headers: { 'content-type': 'text/event-stream' } },
                ),
        );

        expect(
            await createResponsesAdapter(config, []).call({
                model: config.model,
                history: initial,
            }),
        ).toMatchObject({
            ok: true,
            value: { providerStats: { usage: { kind: 'partial' } } },
        });
    });

    test.each(['response.incomplete', 'response.failed'])(
        'terminal %s usage is complete when every field is reported',
        async (type) => {
            vi.stubGlobal(
                'fetch',
                async () =>
                    new Response(
                        `event: ${type}\ndata: ${JSON.stringify({ type, response: { output: [], usage: usage() } })}\n\n`,
                        { headers: { 'content-type': 'text/event-stream' } },
                    ),
            );

            expect(
                await createResponsesAdapter(config, []).call({
                    model: config.model,
                    history: initial,
                }),
            ).toMatchObject({
                ok: false,
                error: { providerStats: { usage: { kind: 'complete', value: usage() } } },
            });
        },
    );

    test('does not add absent diagnostic fields and leaves null usage unavailable', async () => {
        vi.stubGlobal(
            'fetch',
            async () =>
                new Response(
                    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [message('Done')], usage: null } })}\n\n`,
                    { headers: { 'content-type': 'text/event-stream' } },
                ),
        );

        expect(
            await createResponsesAdapter(config, []).call({
                model: config.model,
                history: initial,
            }),
        ).toStrictEqual({
            ok: true,
            value: {
                reply: { kind: 'final', text: 'Done' },
                native: { kind: 'native', provider: 'openai', data: [message('Done')] },
                providerStats: {
                    provider: 'openai',
                    usage: { kind: 'unavailable' },
                    rateLimits: {},
                },
            },
        });
    });
});
