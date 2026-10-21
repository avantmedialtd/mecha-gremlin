import type {
    ResponseFunctionToolCall,
    ResponseOutputItem,
    ResponseOutputMessage,
    ResponseReasoningItem,
    ResponseUsage,
} from 'openai/resources/responses/responses';

/** Not `typeof fetch`: Bun's adds `fetch.preconnect`, which a fake has no use for. */
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const message = (text: string): ResponseOutputMessage => {
    return {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
    };
};

export const reasoning = (text = 'I should read the file first.'): ResponseReasoningItem => {
    return {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
        content: [{ type: 'reasoning_text', text }],
    };
};

export const call = (name: string, args: unknown, callId = 'call_1'): ResponseFunctionToolCall => {
    return {
        type: 'function_call',
        id: `fc_${callId}`,
        call_id: callId,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
        status: 'completed',
    };
};

export const usage = (inputTokens = 349): ResponseUsage => {
    return {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: 256, cache_write_tokens: 0 },
        output_tokens: 26,
        output_tokens_details: { reasoning_tokens: 12 },
        total_tokens: inputTokens + 26,
    };
};

export const completed = (
    output: readonly ResponseOutputItem[],
    callUsage: ResponseUsage = usage(),
): Response => {
    const response = {
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        error: null,
        incomplete_details: null,
        output,
        usage: callUsage,
    };
    const event = { type: 'response.completed', response };

    return new Response(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
    });
};

export const httpError = (status: number, errorMessage: string): Response => {
    return Response.json({ error: { message: errorMessage } }, { status });
};

export const script = (...replies: ReadonlyArray<() => Response>): ((n: number) => Response) => {
    return (n) => replies[n]?.() ?? httpError(500, `the script has no reply ${n + 1}`);
};

export const loadedBonsai = {
    models: [
        { type: 'llm', key: 'qwen2.5-0.5b-instruct-mlx', loaded_instances: [] },
        {
            type: 'llm',
            key: 'prism-ml/bonsai-27b',
            loaded_instances: [{ id: 'prism-ml/bonsai-27b' }],
        },
    ],
};

export type FakeServer = {
    readonly models?: () => Response;
    readonly responses?: (n: number) => Response;
};

export type RecordedRequest = {
    readonly url: string;
    readonly body: Readonly<Record<string, unknown>> | undefined;
    readonly authorization: string | null;
};

export const fakeFetch = (server: FakeServer = {}) => {
    const requests: RecordedRequest[] = [];
    let modelCalls = 0;
    const fetch: Fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push({
            url,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            authorization: new Headers(init?.headers).get('authorization'),
        });

        if (url.endsWith('/api/v1/models')) {
            return server.models?.() ?? Response.json(loadedBonsai);
        }

        if (url.endsWith('/v1/responses')) {
            const n = modelCalls++;

            return server.responses?.(n) ?? completed([message('Hi there!')]);
        }

        return new Response('not found', { status: 404 });
    };

    const modelCallBodies = () =>
        requests
            .filter((request) => request.url.endsWith('/v1/responses'))
            .map((request) => request.body);

    return { fetch, requests, modelCallBodies };
};
