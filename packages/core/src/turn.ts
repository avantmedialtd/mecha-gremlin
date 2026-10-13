import type OpenAI from "openai";
import type {
    Response,
    ResponseCreateParamsStreaming,
    ResponseStreamEvent,
    ResponseUsage,
} from "openai/resources/responses/responses";

/** A Responses API request. `runTurn` always streams it, so `stream` is not part of it. */
export type TurnRequest = Omit<ResponseCreateParamsStreaming, "stream">;

export type TurnErrorKind =
    | "unreachable"
    | "timeout"
    | "auth"
    | "rate_limit"
    | "bad_request"
    | "server_error"
    | "incomplete"
    | "failed"
    | "aborted"
    | "fatal";

export type TurnResult =
    | { ok: true; text: string; response: Response; usage: ResponseUsage | undefined }
    | { ok: false; error: TurnErrorKind; detail: string; status?: number };

export interface TurnOptions {
    signal?: AbortSignal;
}

export type TurnFailure = Extract<TurnResult, { ok: false }>;

/** Concatenates the `output_text` parts of every message item, in order. */
const outputText = (response: Response): string => {
    let text = "";

    for (const item of response.output) {
        if (item.type !== "message") {
            continue;
        }

        for (const part of item.content) {
            if (part.type === "output_text") {
                text += part.text;
            }
        }
    }

    return text;
};

const aborted = (): TurnFailure => {
    return { ok: false, error: "aborted", detail: "the turn was aborted" };
};

const statusOf = (error: unknown): number | undefined => {
    if (typeof error !== "object" || error === null || !("status" in error)) {
        return undefined;
    }

    return typeof error.status === "number" ? error.status : undefined;
};

/** True if `value`'s class, or any class it extends, has the given name. */
const hasClassName = (value: unknown, name: string): boolean => {
    let proto: unknown =
        typeof value === "object" && value !== null ? Object.getPrototypeOf(value) : null;

    while (typeof proto === "object" && proto !== null) {
        if (proto.constructor.name === name) {
            return true;
        }

        proto = Object.getPrototypeOf(proto);
    }

    return false;
};

const describe = (error: unknown): string => {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const cause = error.cause instanceof Error ? error.cause.message : undefined;
    return cause && cause !== error.message ? `${error.message} (${cause})` : error.message;
};

/**
 * Classifies a failure to start the turn. Uses the HTTP status and the error's class name
 * rather than `instanceof`, so it still works if the caller's `openai` is a different copy.
 */
const classifyRequestError = (error: unknown, signal: AbortSignal | undefined): TurnFailure => {
    if (signal?.aborted || hasClassName(error, "APIUserAbortError")) {
        return aborted();
    }

    const status = statusOf(error);

    if (status !== undefined) {
        const kind: TurnErrorKind =
            status === 401 || status === 403
                ? "auth"
                : status === 429
                  ? "rate_limit"
                  : status >= 500
                    ? "server_error"
                    : "bad_request";
        return { ok: false, error: kind, status, detail: describe(error) };
    }

    if (hasClassName(error, "APIConnectionTimeoutError")) {
        return { ok: false, error: "timeout", detail: describe(error) };
    }

    if (hasClassName(error, "APIConnectionError")) {
        return { ok: false, error: "unreachable", detail: describe(error) };
    }

    return { ok: false, error: "fatal", detail: describe(error) };
};

/**
 * Runs one model turn over the Responses API. The request is always streamed, and stored
 * only if the caller sets `store: true`. Model, HTTP and transport failures come back as
 * `{ ok: false }` values; this function does not throw for them.
 */
export const runTurn = async (
    client: OpenAI,
    request: TurnRequest,
    options: TurnOptions = {},
): Promise<TurnResult> => {
    const { signal } = options;

    let stream: AsyncIterable<ResponseStreamEvent>;

    try {
        stream = await client.responses.create(
            { ...request, store: request.store ?? false, stream: true },
            { signal },
        );
    } catch (error) {
        return classifyRequestError(error, signal);
    }

    try {
        for await (const event of stream) {
            switch (event.type) {
                case "response.completed":
                    return {
                        ok: true,
                        text: outputText(event.response),
                        response: event.response,
                        usage: event.response.usage,
                    };
                case "response.incomplete": {
                    const reason = event.response.incomplete_details?.reason;
                    return {
                        ok: false,
                        error: "incomplete",
                        detail: reason
                            ? `the response is incomplete: ${reason}`
                            : "the response is incomplete",
                    };
                }
                case "response.failed": {
                    const error = event.response.error;
                    return {
                        ok: false,
                        error: "failed",
                        detail: error ? `${error.code}: ${error.message}` : "the response failed",
                    };
                }
                case "error":
                    return { ok: false, error: "failed", detail: event.message };
            }
        }
    } catch (error) {
        if (signal?.aborted) {
            return aborted();
        }

        // The stream had started, so the endpoint was reachable: whatever broke it is a failed turn.
        return { ok: false, error: "failed", detail: describe(error) };
    }

    // The SDK ends iteration quietly when the request is aborted mid-stream.
    if (signal?.aborted) {
        return aborted();
    }

    return { ok: false, error: "failed", detail: "the stream ended without a terminal event" };
};
