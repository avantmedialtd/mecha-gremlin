import type {
    ModelCallError,
    ModelCallOptions,
    ModelCallRequest,
    ModelCallResult,
} from '@mecha-gremlin/core/model-call';
import { err, ok } from '@mecha-gremlin/core/result';
import type {
    PartialValue,
    ResponsesRateLimits,
    ResponsesStatistics,
    ResponsesUsage,
} from '@mecha-gremlin/core/statistics';
import type { Tool } from '@mecha-gremlin/core/tools';
import OpenAI from 'openai';
import type {
    Response as ResponsesResponse,
    ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { Config } from '../config/config.ts';
import type { ModelAdapter } from './adapter.ts';
import { classifyRequestError, describeError } from './errors.ts';
import { errorHeaders, selectHeaders, withoutCustomHeaders } from './headers.ts';
import { toInput } from './responses-history.ts';
import { classify, toFunctionTool } from './responses-tools.ts';

export const RESPONSE_RATE_HEADERS = [
    'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-reset-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-tokens',
    'x-ratelimit-reset-tokens',
    'x-ratelimit-limit-project-tokens',
    'x-ratelimit-remaining-project-tokens',
    'x-ratelimit-reset-project-tokens',
    'retry-after',
] as const satisfies readonly (keyof ResponsesRateLimits)[];

type ResponsesConfig = Extract<Config, { provider: 'openai' | 'lmstudio' }>;

const completeUsage = (usage: PartialValue<ResponsesUsage>): usage is ResponsesUsage => {
    return (
        typeof usage.input_tokens === 'number' &&
        typeof usage.input_tokens_details?.cached_tokens === 'number' &&
        typeof usage.input_tokens_details.cache_write_tokens === 'number' &&
        typeof usage.output_tokens === 'number' &&
        typeof usage.output_tokens_details?.reasoning_tokens === 'number' &&
        typeof usage.total_tokens === 'number'
    );
};

const fromResponse = (
    stats: ResponsesStatistics,
    response: ResponsesResponse,
    terminal: boolean,
): ResponsesStatistics => {
    const usage = response.usage;

    return {
        ...stats,
        ...(usage === undefined || usage === null
            ? {}
            : {
                  usage:
                      terminal && completeUsage(usage)
                          ? { kind: 'complete' as const, value: usage }
                          : { kind: 'partial' as const, value: usage },
              }),
        ...(response.prompt_cache_diagnostics === undefined
            ? {}
            : { prompt_cache_diagnostics: response.prompt_cache_diagnostics }),
        ...(response.prompt_cache_options === undefined
            ? {}
            : { prompt_cache_options: response.prompt_cache_options }),
        ...(response.prompt_cache_retention === undefined
            ? {}
            : { prompt_cache_retention: response.prompt_cache_retention }),
        ...(response.service_tier === undefined ? {} : { service_tier: response.service_tier }),
    };
};

export const createResponsesAdapter = (
    config: ResponsesConfig,
    tools: readonly Tool[],
): ModelAdapter => {
    // Left out, the SDK reads the organization, project and log level from its own environment
    // variables. Its log writes to stdout, between the agent's records. The SDK applies custom
    // headers after its own authorization, so the configured key is set again after removing them.
    const client = new OpenAI({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        maxRetries: 0,
        organization: null,
        project: null,
        logLevel: 'off',
        defaultHeaders: {
            ...withoutCustomHeaders(process.env.OPENAI_CUSTOM_HEADERS),
            authorization: `Bearer ${config.apiKey}`,
        },
    });
    const functionTools = tools.map(toFunctionTool);
    const validateHistory: ModelAdapter['validateHistory'] = (history) => {
        const input = toInput(history, config.provider);

        return input.ok ? ok(undefined) : input;
    };

    const call = async (
        request: ModelCallRequest,
        options: ModelCallOptions = {},
    ): Promise<ModelCallResult> => {
        let stats: ResponsesStatistics = {
            provider: config.provider,
            usage: { kind: 'unavailable' },
            rateLimits: {},
        };
        const input = toInput(request.history, config.provider);

        if (!input.ok) {
            return err({ kind: 'fatal', detail: input.error, providerStats: stats });
        }

        const fail = (error: ModelCallError): ModelCallResult =>
            err({ ...error, providerStats: stats });
        let stream: AsyncIterable<ResponseStreamEvent>;

        try {
            const result = await client.responses
                .create(
                    {
                        model: request.model,
                        input: input.value,
                        tools: functionTools,
                        reasoning: { effort: config.reasoningEffort },
                        store: request.store ?? false,
                        stream: true,
                    },
                    { signal: options.signal },
                )
                .withResponse();
            stream = result.data;
            stats = {
                ...stats,
                rateLimits: selectHeaders(result.response.headers, RESPONSE_RATE_HEADERS),
            };
        } catch (error) {
            stats = {
                ...stats,
                rateLimits: selectHeaders(errorHeaders(error), RESPONSE_RATE_HEADERS),
            };

            return fail(classifyRequestError(error, options.signal));
        }

        try {
            for await (const event of stream) {
                if ('response' in event) {
                    stats = fromResponse(
                        stats,
                        event.response,
                        event.type === 'response.completed' ||
                            event.type === 'response.incomplete' ||
                            event.type === 'response.failed',
                    );
                }

                switch (event.type) {
                    case 'response.completed':
                        return ok({
                            reply: classify(event.response.output),
                            native: {
                                kind: 'native',
                                provider: config.provider,
                                data: event.response.output,
                            },
                            providerStats: stats,
                        });
                    case 'response.incomplete': {
                        const reason = event.response.incomplete_details?.reason;

                        return fail({
                            kind: 'incomplete',
                            detail: reason
                                ? `the response is incomplete: ${reason}`
                                : 'the response is incomplete',
                        });
                    }
                    case 'response.failed': {
                        const failure = event.response.error;

                        return fail({
                            kind: 'failed',
                            detail: failure
                                ? `${failure.code}: ${failure.message}`
                                : 'the response failed',
                        });
                    }
                }
            }
        } catch (error) {
            return options.signal?.aborted
                ? fail({ kind: 'aborted', detail: 'the model call was aborted' })
                : fail({ kind: 'failed', detail: describeError(error) });
        }

        return options.signal?.aborted
            ? fail({ kind: 'aborted', detail: 'the model call was aborted' })
            : fail({ kind: 'failed', detail: 'the stream ended without a terminal event' });
    };

    return { provider: config.provider, validateHistory, call };
};
