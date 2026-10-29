import { describe, expect, test, vi } from 'vitest';
import type { ModelCallOptions, ModelCallRequest } from '@mecha-gremlin/core/model-call';
import type { ModelAdapter } from '../../src/model/adapter.ts';
import { classifyRequestError } from '../../src/model/errors.ts';
import { createResponsesAdapter } from '../../src/model/responses-call.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A real Responses adapter whose HTTP layer is `handler`; records each JSON request body. */
const makeClient = (handler: Handler) => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body === 'string') {
            bodies.push(JSON.parse(init.body));
        }

        return handler(input instanceof Request ? input.url : String(input), init);
    });
    const client = createResponsesAdapter(
        {
            provider: 'openai',
            apiKey: 'test-key',
            baseUrl: 'http://model.test/v1',
            model: 'test-model',
            reasoningEffort: 'low',
            maxSteps: 2,
            fileTools: 'write-edit',
            logFormat: 'json',
            workDir: '/',
            skillsPath: undefined,
        },
        [],
    );

    return { client, bodies };
};

const sseFrame = (event: Readonly<Record<string, unknown>>): string => {
    return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
};

const sse = (...events: ReadonlyArray<Readonly<Record<string, unknown>>>): Response => {
    return new Response(events.map(sseFrame).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
};

const responseObject = (fields: Readonly<Record<string, unknown>> = {}) => {
    return {
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        output: [],
        error: null,
        incomplete_details: null,
        ...fields,
    };
};

const message = (text: string) => {
    return {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
    };
};

const jsonError = (status: number, errorMessage: string): Response => {
    return new Response(JSON.stringify({ error: { message: errorMessage } }), {
        status,
        headers: { 'content-type': 'application/json' },
    });
};

const usage = {
    input_tokens: 21,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 12,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 33,
};

const created = { type: 'response.created', response: responseObject({ status: 'in_progress' }) };
const request = {
    model: 'test-model',
    history: [{ kind: 'user' as const, text: 'Hi!' }],
};
const callModel = (client: ModelAdapter, params: ModelCallRequest, options?: ModelCallOptions) =>
    client.call(params, options);

describe('Return the reply text and usage when the call completes', () => {
    test('a completed call returns the reply text and usage', async () => {
        const { client } = makeClient(() =>
            sse(
                created,
                { type: 'response.output_text.delta', delta: 'Hello there!' },
                {
                    type: 'response.completed',
                    response: responseObject({ output: [message('Hello there!')], usage }),
                },
            ),
        );

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: true,
            value: {
                reply: { kind: 'final', text: 'Hello there!' },
                providerStats: { usage: { value: { output_tokens: 12 } } },
            },
        });
    });

    test('reasoning items are not part of the text', async () => {
        const reasoning = {
            type: 'reasoning',
            id: 'rs_1',
            summary: [],
            content: [{ type: 'reasoning_text', text: 'The user greets me.' }],
        };
        const { client } = makeClient(() =>
            sse(created, {
                type: 'response.completed',
                response: responseObject({ output: [reasoning, message('Hi!')] }),
            }),
        );

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: true,
            value: { reply: { kind: 'final', text: 'Hi!' } },
        });
    });

    test('the text leaves out refusals and tool calls', async () => {
        const call = {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read',
            arguments: '{}',
            status: 'completed',
        };
        const answer = {
            ...message('Partly.'),
            content: [
                { type: 'output_text', text: 'Partly.', annotations: [] },
                { type: 'refusal', refusal: 'Not the rest.' },
            ],
        };
        const { client } = makeClient(() =>
            sse(created, {
                type: 'response.completed',
                response: responseObject({ output: [call, answer] }),
            }),
        );

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: true,
            value: { reply: { kind: 'calls', calls: [{ call_id: 'call_1' }] } },
        });
    });
});

describe('Call the model once, streamed and stateless', () => {
    test('the request is streamed and not stored by default', async () => {
        const { client, bodies } = makeClient(() =>
            sse(created, {
                type: 'response.completed',
                response: responseObject({ output: [message('ok')] }),
            }),
        );

        await callModel(client, request);

        expect(bodies[0]).toMatchObject({
            model: 'test-model',
            input: [{ role: 'user', content: 'Hi!' }],
            stream: true,
            store: false,
        });
    });

    test('an explicit store: true is kept', async () => {
        const { client, bodies } = makeClient(() =>
            sse(created, {
                type: 'response.completed',
                response: responseObject({ output: [message('ok')] }),
            }),
        );

        await callModel(client, { ...request, store: true });

        expect(bodies[0]).toMatchObject({ store: true, stream: true });
    });
});

describe("Classify a call's failures as values", () => {
    test.each([
        [400, 'bad_request'],
        [401, 'auth'],
        [403, 'auth'],
        [429, 'rate_limit'],
        [500, 'server_error'],
    ])('HTTP %i is %s', async (status, kind) => {
        const { client } = makeClient(() => jsonError(status, 'boom'));

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind, status, detail: `${status} boom` },
        });
    });

    test('a connection failure is unreachable, with its cause', async () => {
        const { client } = makeClient(() => {
            throw new TypeError('fetch failed');
        });

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'unreachable', detail: 'Connection error. (fetch failed)' },
        });
    });

    test('a connection that times out is a timeout', async () => {
        // How undici reports its own connect timeout.
        const { client } = makeClient(() => {
            throw new TypeError('fetch failed', { cause: new Error('Connect Timeout Error') });
        });

        const result = await callModel(client, request);

        expect(result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    });

    test.each([
        ['an Error', new Error('boom'), 'boom'],
        [
            'an Error caused by the same message',
            new Error('boom', { cause: new Error('boom') }),
            'boom',
        ],
        ['a string', 'boom', 'boom'],
        ['null', null, 'null'],
        ['an object whose status is not a number', { status: '500' }, '[object Object]'],
    ])('anything else the client throws is fatal: %s', async (_name, thrown, detail) => {
        expect(classifyRequestError(thrown)).toEqual({ kind: 'fatal', detail });
    });

    test('a response that ends incomplete is incomplete, with the reason', async () => {
        const { client } = makeClient(() =>
            sse(created, {
                type: 'response.incomplete',
                response: responseObject({
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' },
                }),
            }),
        );

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'incomplete', detail: expect.stringContaining('max_output_tokens') },
        });
    });

    test('a response that ends incomplete without a reason is still incomplete', async () => {
        const { client } = makeClient(() =>
            sse(created, {
                type: 'response.incomplete',
                response: responseObject({ status: 'incomplete' }),
            }),
        );

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'incomplete', detail: 'the response is incomplete' },
        });
    });

    test('a response that fails mid-stream is failed, with the error message', async () => {
        const { client } = makeClient(() =>
            sse(created, {
                type: 'response.failed',
                response: responseObject({
                    status: 'failed',
                    error: { code: 'server_error', message: 'model crashed' },
                }),
            }),
        );

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'failed', detail: expect.stringContaining('model crashed') },
        });
    });

    test('a response that fails mid-stream without an error is still failed', async () => {
        const { client } = makeClient(() =>
            sse(created, {
                type: 'response.failed',
                response: responseObject({ status: 'failed' }),
            }),
        );

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'failed', detail: 'the response failed' },
        });
    });

    test('an SSE error event is failed', async () => {
        const { client } = makeClient(() =>
            sse(created, {
                type: 'error',
                code: 'engine_error',
                message: 'Failed to parse tool call',
                param: null,
            }),
        );

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'failed', detail: expect.stringContaining('Failed to parse tool call') },
        });
    });

    test('a stream that ends without a terminal event is failed', async () => {
        const { client } = makeClient(() =>
            sse(created, { type: 'response.output_text.delta', delta: 'Hel' }),
        );

        const result = await callModel(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'failed', detail: 'the stream ended without a terminal event' },
        });
    });

    test('aborting before the request starts is aborted', async () => {
        const { client } = makeClient(() => sse(created));
        const controller = new AbortController();
        controller.abort();

        const result = await callModel(client, request, { signal: controller.signal });

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'aborted', detail: 'the model call was aborted' },
        });
    });

    // The SDK ends the stream quietly on an AbortError, but passes any other failure on.
    test.each([
        ['an AbortError', new DOMException('The operation was aborted.', 'AbortError')],
        ['a broken connection', new Error('socket hang up')],
    ])(
        'aborting mid-stream is aborted, when the stream then fails with %s',
        async (_name, failure) => {
            const encoder = new TextEncoder();
            const { client } = makeClient((_url, init) => {
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(encoder.encode(sseFrame(created)));
                        init?.signal?.addEventListener('abort', () => controller.error(failure));
                    },
                });

                return new Response(body, {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                });
            });
            const controller = new AbortController();

            const pending = callModel(client, request, { signal: controller.signal });
            setTimeout(() => controller.abort(), 20);

            expect(await pending).toMatchObject({
                ok: false,
                error: { kind: 'aborted', detail: 'the model call was aborted' },
            });
        },
    );
});
