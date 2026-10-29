import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '../../src/config/config.ts';

// Exercise defensive cases a normal SDK stream cannot produce and inspect security settings.
const fake = vi.hoisted(() => ({
    options: {} as Record<string, unknown>,
    events: [] as unknown[],
    message: { id: 'msg_1', content: [], stop_reason: 'end_turn' } as unknown,
    response: undefined as Response | null | undefined,
    error: undefined as unknown,
}));

vi.mock('@anthropic-ai/sdk', () => ({
    default: class {
        messages = {
            stream: () => {
                let listener: ((event: unknown) => void) | undefined;

                return {
                    response: fake.response,
                    on: (_event: string, callback: (event: unknown) => void) => {
                        listener = callback;
                    },
                    withResponse: async () => {
                        if (fake.error !== undefined) {
                            throw fake.error;
                        }

                        return { response: new Response(null) };
                    },
                    finalMessage: async () => {
                        for (const event of fake.events) {
                            listener?.(event);
                        }

                        return fake.message;
                    },
                    // Never emitted, so the adapter's call waits for finalMessage.
                    emitted: () => new Promise(() => {}),
                    abort: () => {},
                };
            },
        };
        constructor(options: Readonly<Record<string, unknown>>) {
            fake.options = options;
        }
    },
}));

import { createAnthropicAdapter } from '../../src/model/anthropic-call.ts';

const config: Extract<Config, { provider: 'anthropic' }> = {
    provider: 'anthropic',
    baseUrl: 'https://claude.test',
    apiKey: 'key',
    model: 'model',
    reasoningEffort: 'medium',
    maxOutputTokens: 100,
    workspaceId: undefined,
    skillsPath: undefined,
    maxSteps: 2,
    fileTools: 'write-edit',
    logFormat: 'json',
    workDir: '/',
};
const request = { model: 'model', history: [] };

beforeEach(() => {
    fake.events = [];
    fake.message = { id: 'msg_1', content: [], stop_reason: 'end_turn' };
    fake.response = undefined;
    fake.error = undefined;
});

describe('Anthropic SDK boundary', () => {
    test('disables SDK telemetry and logging', () => {
        createAnthropicAdapter(config, []);

        expect(fake.options).toMatchObject({
            logLevel: 'off',
            openTelemetry: false,
            maxRetries: 0,
        });
    });

    test('rejects a final message without message_stop even if the SDK returns one', async () => {
        expect(await createAnthropicAdapter(config, []).call(request)).toMatchObject({
            ok: false,
            error: { kind: 'failed', detail: 'the stream ended without a message_stop event' },
        });
    });

    test('classifies a request error when the SDK exposes a null response', async () => {
        fake.response = null;
        fake.error = Object.assign(new Error('denied'), { status: 401 });

        expect(await createAnthropicAdapter(config, []).call(request)).toMatchObject({
            ok: false,
            error: { kind: 'auth', status: 401, detail: 'denied' },
        });
    });

    test('preserves an omitted usage field without creating an undefined property', async () => {
        fake.events = [
            {
                type: 'message_start',
                message: { usage: { input_tokens: 3 }, diagnostics: undefined },
            },
            { type: 'message_delta', usage: { input_tokens: undefined, output_tokens: 5 } },
            { type: 'message_stop' },
        ];
        const result = await createAnthropicAdapter(config, []).call(request);

        expect(result).toStrictEqual({
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
                    usage: { kind: 'complete', value: { input_tokens: 3, output_tokens: 5 } },
                    rateLimits: {},
                },
            },
        });
    });

    test('retains a newly reported null value if no earlier value existed', async () => {
        fake.events = [
            { type: 'message_start', message: { usage: { input_tokens: 3 } } },
            { type: 'message_delta', usage: { cache_read_input_tokens: null, output_tokens: 5 } },
            { type: 'message_stop' },
        ];

        expect(await createAnthropicAdapter(config, []).call(request)).toMatchObject({
            ok: true,
            value: {
                providerStats: {
                    usage: { kind: 'complete', value: { cache_read_input_tokens: null } },
                },
            },
        });
    });

    test('handles a delta before usage has been reported', async () => {
        fake.events = [
            { type: 'message_delta', usage: { input_tokens: null, output_tokens: 5 } },
            { type: 'message_stop' },
        ];

        expect(await createAnthropicAdapter(config, []).call(request)).toMatchObject({
            ok: true,
            value: {
                providerStats: {
                    usage: {
                        kind: 'partial',
                        value: { input_tokens: null, output_tokens: 5 },
                    },
                },
            },
        });
    });

    test.each([
        [
            { type: 'text', text: '' },
            { type: 'input_json_delta', partial_json: '{}' },
        ],
        [
            { type: 'tool_use', id: 'a', name: 'read', input: {} },
            { type: 'text_delta', text: 'wrong' },
        ],
    ])('rejects a delta incompatible with its content block', async (block, delta) => {
        fake.events = [
            { type: 'content_block_start', index: 0, content_block: block },
            { type: 'content_block_delta', index: 0, delta },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_stop' },
        ];

        expect(await createAnthropicAdapter(config, []).call(request)).toMatchObject({
            ok: false,
            error: {
                kind: 'failed',
                detail: 'the response contains incomplete tool or content blocks',
            },
        });
    });
});
