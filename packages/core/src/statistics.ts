/** The provider is fixed for the lifetime of a session, even for two Responses providers. */
export type Provider = 'lmstudio' | 'openai' | 'anthropic';

/** A partial stream need not have reported every field of the provider's final usage. */
export type PartialValue<T> = T extends object
    ? { readonly [K in keyof T]?: PartialValue<T[K]> }
    : T;

export type UsageState<Complete, Partial = PartialValue<Complete>> =
    | { readonly kind: 'complete'; readonly value: Complete }
    | { readonly kind: 'partial'; readonly value: Partial }
    | { readonly kind: 'unavailable' };

/** The Responses API's usage, including all the SDK's nested usage fields. */
export type ResponsesUsage = {
    readonly input_tokens: number;
    readonly input_tokens_details: {
        readonly cached_tokens: number;
        readonly cache_write_tokens: number;
    };
    readonly output_tokens: number;
    readonly output_tokens_details: { readonly reasoning_tokens: number };
    readonly total_tokens: number;
};

export type ResponsesCacheDiagnostics =
    | {
          readonly type: 'cache_miss';
          readonly cache_missed_tokens: number;
          readonly reason:
              | 'model_changed'
              | 'prompt_cache_key_changed'
              | 'tools_changed'
              | 'text_format_changed'
              | 'reasoning_effort_changed'
              | 'verbosity_changed'
              | 'context_compacted'
              | 'input_changed'
              | 'service_tier_changed';
          readonly comparison_reusable_tokens?: number;
      }
    | { readonly type: 'cache_hit' }
    | { readonly type: 'comparison_response_not_found' }
    | { readonly type: 'unavailable' };

export type ResponsesRateLimits = {
    readonly 'x-ratelimit-limit-requests'?: string;
    readonly 'x-ratelimit-remaining-requests'?: string;
    readonly 'x-ratelimit-reset-requests'?: string;
    readonly 'x-ratelimit-limit-tokens'?: string;
    readonly 'x-ratelimit-remaining-tokens'?: string;
    readonly 'x-ratelimit-reset-tokens'?: string;
    readonly 'x-ratelimit-limit-project-tokens'?: string;
    readonly 'x-ratelimit-remaining-project-tokens'?: string;
    readonly 'x-ratelimit-reset-project-tokens'?: string;
    readonly 'retry-after'?: string;
};

export type ResponsesStatistics = {
    readonly provider: 'openai' | 'lmstudio';
    readonly usage: UsageState<ResponsesUsage>;
    readonly prompt_cache_diagnostics?: ResponsesCacheDiagnostics;
    readonly prompt_cache_options?: {
        readonly mode: 'implicit' | 'explicit';
        readonly ttl: '30m';
        readonly comparison_response_id?: string | null;
    };
    readonly prompt_cache_retention?: 'in_memory' | '24h' | null;
    readonly service_tier?:
        | 'auto'
        | 'default'
        | 'flex'
        | 'scale'
        | 'priority'
        | 'fast'
        | 'ultrafast'
        | null;
    readonly rateLimits: ResponsesRateLimits;
};

/** The Messages API's usage, preserving the distinction between null and zero. */
export type AnthropicUsage = {
    readonly cache_creation: {
        readonly ephemeral_1h_input_tokens: number;
        readonly ephemeral_5m_input_tokens: number;
    } | null;
    readonly cache_creation_input_tokens: number | null;
    readonly cache_read_input_tokens: number | null;
    readonly inference_geo: string | null;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly output_tokens_details: { readonly thinking_tokens: number } | null;
    readonly server_tool_use: {
        readonly web_fetch_requests: number;
        readonly web_search_requests: number;
    } | null;
    readonly service_tier: 'standard' | 'priority' | 'batch' | null;
    readonly speed: 'standard' | 'fast' | null;
};

/**
 * A finished message's usage. The API leaves out the fields that don't apply to a message, though
 * the SDK types them as null, so only the token counts are always there.
 */
export type AnthropicFinalUsage = Pick<AnthropicUsage, 'input_tokens' | 'output_tokens'> &
    Partial<Omit<AnthropicUsage, 'input_tokens' | 'output_tokens'>>;

/** Streaming message deltas allow a null input count even though final usage does not. */
export type AnthropicPartialUsage = Omit<PartialValue<AnthropicUsage>, 'input_tokens'> & {
    readonly input_tokens?: number | null;
};

type CacheMissWithTokens<T extends string> = T extends string
    ? { readonly type: T; readonly cache_missed_input_tokens: number }
    : never;

export type AnthropicCacheMissReason =
    | CacheMissWithTokens<'model_changed' | 'system_changed' | 'tools_changed' | 'messages_changed'>
    | { readonly type: 'previous_message_not_found' }
    | { readonly type: 'unavailable' };

export type AnthropicDiagnostics = {
    readonly cache_miss_reason: AnthropicCacheMissReason | null;
};

export type AnthropicRateLimits = {
    readonly 'anthropic-ratelimit-requests-limit'?: string;
    readonly 'anthropic-ratelimit-requests-remaining'?: string;
    readonly 'anthropic-ratelimit-requests-reset'?: string;
    readonly 'anthropic-ratelimit-tokens-limit'?: string;
    readonly 'anthropic-ratelimit-tokens-remaining'?: string;
    readonly 'anthropic-ratelimit-tokens-reset'?: string;
    readonly 'anthropic-ratelimit-input-tokens-limit'?: string;
    readonly 'anthropic-ratelimit-input-tokens-remaining'?: string;
    readonly 'anthropic-ratelimit-input-tokens-reset'?: string;
    readonly 'anthropic-ratelimit-output-tokens-limit'?: string;
    readonly 'anthropic-ratelimit-output-tokens-remaining'?: string;
    readonly 'anthropic-ratelimit-output-tokens-reset'?: string;
    readonly 'anthropic-priority-input-tokens-limit'?: string;
    readonly 'anthropic-priority-input-tokens-remaining'?: string;
    readonly 'anthropic-priority-input-tokens-reset'?: string;
    readonly 'anthropic-priority-output-tokens-limit'?: string;
    readonly 'anthropic-priority-output-tokens-remaining'?: string;
    readonly 'anthropic-priority-output-tokens-reset'?: string;
    readonly 'anthropic-fast-input-tokens-limit'?: string;
    readonly 'anthropic-fast-input-tokens-remaining'?: string;
    readonly 'anthropic-fast-input-tokens-reset'?: string;
    readonly 'anthropic-fast-output-tokens-limit'?: string;
    readonly 'anthropic-fast-output-tokens-remaining'?: string;
    readonly 'anthropic-fast-output-tokens-reset'?: string;
    readonly 'retry-after'?: string;
};

export type AnthropicStatistics = {
    readonly provider: 'anthropic';
    readonly usage: UsageState<AnthropicFinalUsage, AnthropicPartialUsage>;
    readonly diagnostics?: AnthropicDiagnostics | null;
    readonly rateLimits: AnthropicRateLimits;
};

export type ProviderStatistics = ResponsesStatistics | AnthropicStatistics;
