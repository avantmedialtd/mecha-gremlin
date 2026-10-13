import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import OpenAI from 'openai';
import { runTurn } from '../src/index.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A real OpenAI client whose HTTP layer is `handler`; records each JSON request body. */
const makeClient = (handler: Handler) => {
    const bodies: Record<string, unknown>[] = [];
    const client = new OpenAI({
        apiKey: 'test-key',
        baseURL: 'http://model.test/v1',
        maxRetries: 0,
        fetch: async (input, init) => {
            if (typeof init?.body === 'string') {
                bodies.push(JSON.parse(init.body));
            }

            return handler(input instanceof Request ? input.url : String(input), init);
        },
    });

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
const request = { model: 'test-model', input: 'Hi!' };

describe('runTurn', () => {
    test('a completed turn returns the reply text and usage', async () => {
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

        const result = await runTurn(client, request);

        expect(result).toMatchObject({
            ok: true,
            value: {
                text: 'Hello there!',
                usage: { output_tokens: 12 },
                response: { id: 'resp_1' },
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

        const result = await runTurn(client, request);

        expect(result).toMatchObject({ ok: true, value: { text: 'Hi!' } });
    });

    test('the request is streamed and not stored by default', async () => {
        const { client, bodies } = makeClient(() =>
            sse(created, {
                type: 'response.completed',
                response: responseObject({ output: [message('ok')] }),
            }),
        );

        await runTurn(client, request);

        expect(bodies[0]).toMatchObject({
            model: 'test-model',
            input: 'Hi!',
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

        await runTurn(client, { ...request, store: true });

        expect(bodies[0]).toMatchObject({ store: true, stream: true });
    });

    test('HTTP 401 is an auth failure', async () => {
        const { client } = makeClient(() => jsonError(401, 'invalid token'));

        const result = await runTurn(client, request);

        expect(result).toMatchObject({ ok: false, error: { kind: 'auth', status: 401 } });
    });

    test('HTTP 500 is a server error', async () => {
        const { client } = makeClient(() => jsonError(500, 'boom'));

        const result = await runTurn(client, request);

        expect(result).toMatchObject({ ok: false, error: { kind: 'server_error', status: 500 } });
    });

    test('a connection failure is unreachable', async () => {
        const { client } = makeClient(() => {
            throw new TypeError('fetch failed');
        });

        const result = await runTurn(client, request);

        expect(result).toMatchObject({ ok: false, error: { kind: 'unreachable' } });
    });

    test('response.incomplete is incomplete, with the reason', async () => {
        const { client } = makeClient(() =>
            sse(created, {
                type: 'response.incomplete',
                response: responseObject({
                    status: 'incomplete',
                    incomplete_details: { reason: 'max_output_tokens' },
                }),
            }),
        );

        const result = await runTurn(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'incomplete', detail: expect.stringContaining('max_output_tokens') },
        });
    });

    test('response.failed is failed, with the error message', async () => {
        const { client } = makeClient(() =>
            sse(created, {
                type: 'response.failed',
                response: responseObject({
                    status: 'failed',
                    error: { code: 'server_error', message: 'model crashed' },
                }),
            }),
        );

        const result = await runTurn(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'failed', detail: expect.stringContaining('model crashed') },
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

        const result = await runTurn(client, request);

        expect(result).toMatchObject({
            ok: false,
            error: { kind: 'failed', detail: expect.stringContaining('Failed to parse tool call') },
        });
    });

    test('a stream that ends without a terminal event is failed', async () => {
        const { client } = makeClient(() =>
            sse(created, { type: 'response.output_text.delta', delta: 'Hel' }),
        );

        const result = await runTurn(client, request);

        expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } });
    });

    test('aborting before the request starts is aborted', async () => {
        const { client } = makeClient(() => sse(created));
        const controller = new AbortController();
        controller.abort();

        const result = await runTurn(client, request, { signal: controller.signal });

        expect(result).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    });

    test('aborting mid-stream is aborted', async () => {
        const encoder = new TextEncoder();
        const { client } = makeClient((_url, init) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode(sseFrame(created)));
                    init?.signal?.addEventListener('abort', () =>
                        controller.error(
                            new DOMException('The operation was aborted.', 'AbortError'),
                        ),
                    );
                },
            });

            return new Response(body, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            });
        });
        const controller = new AbortController();

        const pending = runTurn(client, request, { signal: controller.signal });
        setTimeout(() => controller.abort(), 20);

        expect(await pending).toMatchObject({ ok: false, error: { kind: 'aborted' } });
    });
});

// That core never reads the environment, writes to the console or uses Bun APIs is enforced by
// oxlint (the packages/core/src override in .oxlintrc.json), not by scanning source text here.
describe('core boundaries', () => {
    test('openai is a peer dependency', async () => {
        const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

        expect(pkg.peerDependencies).toHaveProperty('openai');
    });
});
