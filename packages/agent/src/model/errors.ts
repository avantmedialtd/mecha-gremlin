import type { ModelCallError, ModelCallErrorKind } from '@mecha-gremlin/core/model-call';

const hasClassName = (value: unknown, name: string): boolean => {
    let proto: object | null = Object.getPrototypeOf(Object(value));

    while (proto !== null) {
        if (proto.constructor.name === name) {
            return true;
        }

        proto = Object.getPrototypeOf(proto);
    }

    return false;
};

export const describeError = (error: unknown): string => {
    if (!(error instanceof Error)) {
        return String(error);
    }

    const cause = error.cause instanceof Error ? error.cause.message : undefined;

    return cause && cause !== error.message ? `${error.message} (${cause})` : error.message;
};

export const classifyRequestError = (error: unknown, signal?: AbortSignal): ModelCallError => {
    if (signal?.aborted) {
        return { kind: 'aborted', detail: 'the model call was aborted' };
    }

    const status: unknown = Object(error).status;

    if (typeof status === 'number') {
        const kind: ModelCallErrorKind =
            status === 401 || status === 403
                ? 'auth'
                : status === 429
                  ? 'rate_limit'
                  : status >= 500
                    ? 'server_error'
                    : 'bad_request';

        return { kind, status, detail: describeError(error) };
    }

    if (hasClassName(error, 'APIConnectionTimeoutError')) {
        return { kind: 'timeout', detail: describeError(error) };
    }

    if (hasClassName(error, 'APIConnectionError')) {
        return { kind: 'unreachable', detail: describeError(error) };
    }

    return { kind: 'fatal', detail: describeError(error) };
};
