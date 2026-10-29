import type { HistoryItem, NativeResponse } from './history.ts';
import type { Result } from './result.ts';
import type { ProviderStatistics } from './statistics.ts';
import type { Reply } from './tools.ts';

/**
 * The adapter owns protocol settings, and the tools it was created with, which stay fixed for the
 * prompt cache; the session supplies the history on every call.
 */
export type ModelCallRequest = {
    readonly model: string;
    readonly history: readonly HistoryItem[];
    /** Responses only. The API stores a response unless told not to, so unset means `false`. */
    readonly store?: boolean;
};

export type ModelCallErrorKind =
    | 'unreachable'
    | 'timeout'
    | 'auth'
    | 'rate_limit'
    | 'bad_request'
    | 'server_error'
    | 'incomplete'
    | 'failed'
    | 'aborted'
    | 'fatal';

export type ModelCallError = {
    readonly kind: ModelCallErrorKind;
    readonly detail: string;
    readonly status?: number;
    readonly providerStats?: ProviderStatistics;
};

export type ModelCallResult = Result<
    {
        readonly reply: Reply;
        readonly native: NativeResponse;
        readonly providerStats: ProviderStatistics;
    },
    ModelCallError
>;

export type ModelCallOptions = { readonly signal?: AbortSignal };
