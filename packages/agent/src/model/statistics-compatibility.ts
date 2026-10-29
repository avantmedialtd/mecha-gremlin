// These compile-time checks live beside the SDKs, not in core. They deliberately check keys as
// well as assignability: an SDK can add an optional field without breaking structural assignment.
import type {
    AnthropicCacheMissReason,
    AnthropicDiagnostics,
    AnthropicFinalUsage,
    AnthropicRateLimits,
    AnthropicUsage,
    ResponsesCacheDiagnostics,
    ResponsesRateLimits,
    ResponsesStatistics,
    ResponsesUsage,
} from '@mecha-gremlin/core/statistics';
import type { CacheMissReason, Diagnostics, Usage } from '@anthropic-ai/sdk/resources/messages';
import type { Response, ResponseUsage } from 'openai/resources/responses/responses';
import type { ANTHROPIC_RATE_HEADERS } from './anthropic-call.ts';
import type { RESPONSE_RATE_HEADERS } from './responses-call.ts';

type Assert<T extends true> = T;
type KeysMatch<A, B> = [Exclude<keyof A, keyof B>, Exclude<keyof B, keyof A>] extends [never, never]
    ? true
    : false;
type AssignableBothWays<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Variant<T, K> = Extract<T, { type: K }>;

export type StatisticsCompatibility = [
    Assert<KeysMatch<ResponsesUsage, ResponseUsage>>,
    Assert<AssignableBothWays<ResponsesUsage, ResponseUsage>>,
    Assert<KeysMatch<ResponsesUsage['input_tokens_details'], ResponseUsage.InputTokensDetails>>,
    Assert<KeysMatch<ResponsesUsage['output_tokens_details'], ResponseUsage.OutputTokensDetails>>,
    Assert<
        AssignableBothWays<
            ResponsesCacheDiagnostics,
            NonNullable<Response['prompt_cache_diagnostics']>
        >
    >,
    Assert<KeysMatch<Variant<ResponsesCacheDiagnostics, 'cache_miss'>, Response.CacheMiss>>,
    Assert<KeysMatch<Variant<ResponsesCacheDiagnostics, 'cache_hit'>, Response.CacheHit>>,
    Assert<
        KeysMatch<
            Variant<ResponsesCacheDiagnostics, 'comparison_response_not_found'>,
            Response.ComparisonResponseNotFound
        >
    >,
    Assert<KeysMatch<Variant<ResponsesCacheDiagnostics, 'unavailable'>, Response.Unavailable>>,
    Assert<
        KeysMatch<
            NonNullable<ResponsesStatistics['prompt_cache_options']>,
            Response.PromptCacheOptions
        >
    >,
    Assert<
        AssignableBothWays<
            NonNullable<ResponsesStatistics['prompt_cache_options']>,
            Response.PromptCacheOptions
        >
    >,
    Assert<AssignableBothWays<ResponsesStatistics['service_tier'], Response['service_tier']>>,
    Assert<KeysMatch<AnthropicUsage, Usage>>,
    Assert<AssignableBothWays<AnthropicUsage, Usage>>,
    Assert<KeysMatch<AnthropicFinalUsage, Usage>>,
    Assert<
        KeysMatch<
            NonNullable<AnthropicUsage['cache_creation']>,
            NonNullable<Usage['cache_creation']>
        >
    >,
    Assert<
        KeysMatch<
            NonNullable<AnthropicUsage['server_tool_use']>,
            NonNullable<Usage['server_tool_use']>
        >
    >,
    Assert<
        KeysMatch<
            NonNullable<AnthropicUsage['output_tokens_details']>,
            NonNullable<Usage['output_tokens_details']>
        >
    >,
    Assert<KeysMatch<AnthropicDiagnostics, Diagnostics>>,
    Assert<AssignableBothWays<AnthropicDiagnostics, Diagnostics>>,
    Assert<AssignableBothWays<AnthropicCacheMissReason, CacheMissReason>>,
    Assert<
        KeysMatch<
            Variant<AnthropicCacheMissReason, 'model_changed'>,
            Variant<CacheMissReason, 'model_changed'>
        >
    >,
    Assert<
        KeysMatch<
            Variant<AnthropicCacheMissReason, 'system_changed'>,
            Variant<CacheMissReason, 'system_changed'>
        >
    >,
    Assert<
        KeysMatch<
            Variant<AnthropicCacheMissReason, 'tools_changed'>,
            Variant<CacheMissReason, 'tools_changed'>
        >
    >,
    Assert<
        KeysMatch<
            Variant<AnthropicCacheMissReason, 'messages_changed'>,
            Variant<CacheMissReason, 'messages_changed'>
        >
    >,
    Assert<
        KeysMatch<
            Variant<AnthropicCacheMissReason, 'previous_message_not_found'>,
            Variant<CacheMissReason, 'previous_message_not_found'>
        >
    >,
    Assert<
        KeysMatch<
            Variant<AnthropicCacheMissReason, 'unavailable'>,
            Variant<CacheMissReason, 'unavailable'>
        >
    >,
    Assert<KeysMatch<ResponsesRateLimits, Record<(typeof RESPONSE_RATE_HEADERS)[number], string>>>,
    Assert<KeysMatch<AnthropicRateLimits, Record<(typeof ANTHROPIC_RATE_HEADERS)[number], string>>>,
];
