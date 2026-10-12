// A scripted model server for the server's tests: LM Studio's native models endpoint and a
// Responses endpoint that streams completed turns built from output items.
import type {
    ResponseFunctionToolCall,
    ResponseOutputItem,
    ResponseOutputMessage,
    ResponseReasoningItem,
    ResponseUsage,
} from "openai/resources/responses/responses";
import type { Fetch } from "../src/model.ts";

export function message(text: string): ResponseOutputMessage {
    return {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
    };
}

export function reasoning(text = "I should read the file first."): ResponseReasoningItem {
    return {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        content: [{ type: "reasoning_text", text }],
    };
}

export function call(name: string, args: unknown, callId = "call_1"): ResponseFunctionToolCall {
    return {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
        status: "completed",
    };
}

export function usage(fields: Partial<ResponseUsage> = {}): ResponseUsage {
    return {
        input_tokens: 349,
        input_tokens_details: { cached_tokens: 256, cache_write_tokens: 0 },
        output_tokens: 26,
        output_tokens_details: { reasoning_tokens: 12 },
        total_tokens: 375,
        ...fields,
    };
}

/** A streamed turn that completes with these output items. */
export function completed(
    output: ResponseOutputItem[],
    turnUsage: ResponseUsage = usage(),
): Response {
    const response = {
        id: "resp_1",
        object: "response",
        status: "completed",
        error: null,
        incomplete_details: null,
        output,
        usage: turnUsage,
    };
    const event = { type: "response.completed", response };
    return new Response(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
    });
}

export function httpError(status: number, errorMessage: string): Response {
    return Response.json({ error: { message: errorMessage } }, { status });
}

/** The given turns, one per request, in order; a request beyond them gets an HTTP 500. */
export function script(...turns: Array<() => Response>): (n: number) => Response {
    return (n) => turns[n]?.() ?? httpError(500, `the script has no turn ${n + 1}`);
}

export const loadedBonsai = {
    models: [
        { type: "llm", key: "qwen2.5-0.5b-instruct-mlx", loaded_instances: [] },
        {
            type: "llm",
            key: "prism-ml/bonsai-27b",
            loaded_instances: [{ id: "prism-ml/bonsai-27b" }],
        },
    ],
};

export interface FakeServer {
    /** LM Studio's native `/api/v1/models`. */
    models?: () => Response;
    /** The answer to the n-th request (from 0) to the OpenAI-compatible `/v1/responses`. */
    responses?: (n: number) => Response;
}

export interface RecordedRequest {
    url: string;
    body: Record<string, unknown> | undefined;
    authorization: string | null;
}

/** A `fetch` that plays the fake server and records every request it gets. */
export function fakeFetch(server: FakeServer = {}) {
    const requests: RecordedRequest[] = [];
    let turns = 0;
    const fetch: Fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push({
            url,
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
            authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.endsWith("/api/v1/models")) {
            return server.models?.() ?? Response.json(loadedBonsai);
        }
        if (url.endsWith("/v1/responses")) {
            const n = turns++;
            return server.responses?.(n) ?? completed([message("Hi there!")]);
        }
        return new Response("not found", { status: 404 });
    };
    /** The bodies of the requests sent to `/v1/responses`, in order. */
    const turnBodies = () =>
        requests
            .filter((request) => request.url.endsWith("/v1/responses"))
            .map((request) => request.body);
    return { fetch, requests, turnBodies };
}
