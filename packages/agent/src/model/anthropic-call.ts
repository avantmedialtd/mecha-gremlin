import type {
    ModelCallError,
    ModelCallOptions,
    ModelCallRequest,
    ModelCallResult,
} from '@mecha-gremlin/core/model-call';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type {
    AnthropicFinalUsage,
    AnthropicPartialUsage,
    AnthropicRateLimits,
    AnthropicStatistics,
} from '@mecha-gremlin/core/statistics';
import { type Reply, type Tool, type ToolCall, toolJsonSchema } from '@mecha-gremlin/core/tools';
import Anthropic from '@anthropic-ai/sdk';
import type { Message, Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages';
import type { Config } from '../config/config.ts';
import type { ModelAdapter } from './adapter.ts';
import { toClaudeInput } from './anthropic-history.ts';
import { classifyRequestError, describeError } from './errors.ts';
import { errorHeaders, selectHeaders, withoutCustomHeaders } from './headers.ts';

type AnthropicConfig = Extract<Config, { provider: 'anthropic' }>;

export const ANTHROPIC_RATE_HEADERS = [
    'anthropic-ratelimit-requests-limit',
    'anthropic-ratelimit-requests-remaining',
    'anthropic-ratelimit-requests-reset',
    'anthropic-ratelimit-tokens-limit',
    'anthropic-ratelimit-tokens-remaining',
    'anthropic-ratelimit-tokens-reset',
    'anthropic-ratelimit-input-tokens-limit',
    'anthropic-ratelimit-input-tokens-remaining',
    'anthropic-ratelimit-input-tokens-reset',
    'anthropic-ratelimit-output-tokens-limit',
    'anthropic-ratelimit-output-tokens-remaining',
    'anthropic-ratelimit-output-tokens-reset',
    'anthropic-priority-input-tokens-limit',
    'anthropic-priority-input-tokens-remaining',
    'anthropic-priority-input-tokens-reset',
    'anthropic-priority-output-tokens-limit',
    'anthropic-priority-output-tokens-remaining',
    'anthropic-priority-output-tokens-reset',
    'anthropic-fast-input-tokens-limit',
    'anthropic-fast-input-tokens-remaining',
    'anthropic-fast-input-tokens-reset',
    'anthropic-fast-output-tokens-limit',
    'anthropic-fast-output-tokens-remaining',
    'anthropic-fast-output-tokens-reset',
    'retry-after',
] as const satisfies readonly (keyof AnthropicRateLimits)[];

const toClaudeTool = (tool: Tool): AnthropicTool => {
    const schema = toolJsonSchema(tool);

    if (schema.type !== 'object') {
        throw new Error(`The input schema for ${tool.name} must be an object.`);
    }

    return {
        name: tool.name,
        description: tool.description,
        input_schema: { ...schema, type: 'object' },
    };
};

const unreported = (value: unknown): value is null | undefined =>
    value === null || value === undefined;

const finalUsage = (usage: AnthropicPartialUsage): usage is AnthropicFinalUsage => {
    return (
        typeof usage.input_tokens === 'number' &&
        typeof usage.output_tokens === 'number' &&
        (unreported(usage.cache_creation_input_tokens) ||
            typeof usage.cache_creation_input_tokens === 'number') &&
        (unreported(usage.cache_read_input_tokens) ||
            typeof usage.cache_read_input_tokens === 'number') &&
        (unreported(usage.inference_geo) || typeof usage.inference_geo === 'string') &&
        (unreported(usage.cache_creation) ||
            (typeof usage.cache_creation.ephemeral_5m_input_tokens === 'number' &&
                typeof usage.cache_creation.ephemeral_1h_input_tokens === 'number')) &&
        (unreported(usage.output_tokens_details) ||
            typeof usage.output_tokens_details.thinking_tokens === 'number') &&
        (unreported(usage.server_tool_use) ||
            (typeof usage.server_tool_use.web_fetch_requests === 'number' &&
                typeof usage.server_tool_use.web_search_requests === 'number')) &&
        (unreported(usage.service_tier) ||
            usage.service_tier === 'standard' ||
            usage.service_tier === 'priority' ||
            usage.service_tier === 'batch') &&
        (unreported(usage.speed) || usage.speed === 'standard' || usage.speed === 'fast')
    );
};

// The SDK's Message contains mutable arrays, but this function only reads them.
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
const replyOf = (message: Message): Result<Reply, string> => {
    const calls: ToolCall[] = [];
    let text = '';

    for (const block of message.content) {
        if (block.type === 'text') {
            text += block.text;
        } else if (block.type === 'tool_use') {
            const args = JSON.stringify(block.input);

            if (
                typeof block.id !== 'string' ||
                typeof block.name !== 'string' ||
                args === undefined
            ) {
                return err('the response has a malformed tool-use block');
            }

            calls.push({ call_id: block.id, name: block.name, arguments: args });
        }
    }

    if (message.stop_reason === 'tool_use') {
        return calls.length > 0
            ? ok({ kind: 'calls', calls })
            : err('tool_use stop without a client tool call');
    }

    if (calls.length > 0) {
        return err(`unexpected ${message.stop_reason} stop with client tool calls`);
    }

    if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'refusal') {
        return err(`unsupported stop reason: ${message.stop_reason}`);
    }

    const trimmed = text.trim();

    return ok(trimmed ? { kind: 'final', text: trimmed } : { kind: 'empty' });
};

const validateHistory: ModelAdapter['validateHistory'] = (history) => {
    const input = toClaudeInput(history);

    return input.ok ? ok(undefined) : input;
};

export const createAnthropicAdapter = (
    config: AnthropicConfig,
    tools: readonly Tool[],
): ModelAdapter => {
    const client = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        maxRetries: 0,
        logLevel: 'off',
        openTelemetry: false,
        defaultHeaders: {
            ...withoutCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
            'x-api-key': config.apiKey,
            'anthropic-version': '2026-10-21',
            'anthropic-workspace-id': config.workspaceId ?? null,
            authorization: null,
        },
    });
    const clientTools = tools.map(toClaudeTool);
    const call = async (
        request: ModelCallRequest,
        options: ModelCallOptions = {},
    ): Promise<ModelCallResult> => {
        let stats: AnthropicStatistics = {
            provider: 'anthropic',
            usage: { kind: 'unavailable' },
            rateLimits: {},
        };
        const input = toClaudeInput(request.history);

        if (!input.ok) {
            return err({ kind: 'fatal', detail: input.error, providerStats: stats });
        }

        let partial: AnthropicPartialUsage | undefined;
        let terminal = false;
        const openBlocks = new Set<number>();
        const toolJson = new Map<number, string[]>();
        let malformedJson = false;
        let malformedStream = false;
        const update = <K extends keyof AnthropicPartialUsage>(
            key: K,
            value: AnthropicPartialUsage[K],
        ): void => {
            if (value === undefined || (value === null && partial?.[key] !== undefined)) {
                return;
            }

            partial = { ...partial, [key]: value };
        };

        const stream = client.messages.stream(
            {
                model: request.model,
                max_tokens: config.maxOutputTokens,
                output_config: { effort: config.reasoningEffort },
                system: input.value.system,
                messages: input.value.messages,
                tools: clientTools,
                cache_control: { type: 'ephemeral', ttl: '5m' },
                diagnostics: { previous_message_id: input.value.previousMessageId },
            },
            { signal: options.signal },
        );

        stream.on('streamEvent', (event) => {
            switch (event.type) {
                case 'message_start':
                    if (event.message.usage !== undefined && event.message.usage !== null) {
                        partial = { ...event.message.usage };
                    }

                    if (event.message.diagnostics !== undefined) {
                        stats = { ...stats, diagnostics: event.message.diagnostics };
                    }

                    break;
                case 'message_delta':
                    update('input_tokens', event.usage.input_tokens);
                    update('output_tokens', event.usage.output_tokens);
                    update('cache_creation_input_tokens', event.usage.cache_creation_input_tokens);
                    update('cache_read_input_tokens', event.usage.cache_read_input_tokens);
                    update('output_tokens_details', event.usage.output_tokens_details);
                    update('server_tool_use', event.usage.server_tool_use);
                    break;
                case 'content_block_start':
                    if (openBlocks.has(event.index)) {
                        malformedStream = true;
                    }

                    openBlocks.add(event.index);

                    if (event.content_block.type === 'tool_use') {
                        toolJson.set(event.index, []);
                    }

                    break;
                case 'content_block_delta':
                    if (!openBlocks.has(event.index)) {
                        malformedStream = true;
                    }

                    if (event.delta.type === 'input_json_delta') {
                        const chunks = toolJson.get(event.index);

                        if (chunks === undefined) {
                            malformedStream = true;
                        } else {
                            chunks.push(event.delta.partial_json);
                        }
                    } else if (toolJson.has(event.index)) {
                        malformedStream = true;
                    }

                    break;
                case 'content_block_stop': {
                    if (!openBlocks.has(event.index)) {
                        malformedStream = true;
                    }

                    openBlocks.delete(event.index);
                    const raw = toolJson.get(event.index)?.join('');

                    if (raw) {
                        try {
                            JSON.parse(raw);
                        } catch {
                            malformedJson = true;
                        }
                    }

                    break;
                }
                case 'message_stop':
                    terminal = true;
                    break;
            }

            if (partial !== undefined) {
                stats = { ...stats, usage: { kind: 'partial', value: partial } };
            }
        });

        const fail = (error: ModelCallError): ModelCallResult =>
            err({ ...error, providerStats: stats });
        let message: Message;

        try {
            const connected = await stream.withResponse();
            stats = {
                ...stats,
                rateLimits: selectHeaders(connected.response.headers, ANTHROPIC_RATE_HEADERS),
            };
            // finalMessage() waits for the response body to close, which a proxy may hold open
            // after message_stop. The SDK emits 'message' at message_stop, so the body is dropped.
            message = await Promise.race([stream.finalMessage(), stream.emitted('message')]);
            stream.abort();
        } catch (error) {
            if (stream.response === undefined || stream.response === null) {
                stats = {
                    ...stats,
                    rateLimits: selectHeaders(errorHeaders(error), ANTHROPIC_RATE_HEADERS),
                };

                return fail(classifyRequestError(error, options.signal));
            }

            return options.signal?.aborted
                ? fail({ kind: 'aborted', detail: 'the model call was aborted' })
                : fail({ kind: 'failed', detail: describeError(error) });
        }

        if (!terminal) {
            return fail({
                kind: 'failed',
                detail: 'the stream ended without a message_stop event',
            });
        }

        if (partial !== undefined && finalUsage(partial)) {
            stats = { ...stats, usage: { kind: 'complete', value: partial } };
        }

        if (
            message.stop_reason === 'max_tokens' ||
            message.stop_reason === 'model_context_window_exceeded'
        ) {
            return fail({
                kind: 'incomplete',
                detail: `the response is incomplete: ${message.stop_reason}`,
            });
        }

        if (openBlocks.size > 0 || malformedJson || malformedStream) {
            return fail({
                kind: 'failed',
                detail: 'the response contains incomplete tool or content blocks',
            });
        }

        const reply = replyOf(message);

        if (!reply.ok) {
            return fail({ kind: 'failed', detail: reply.error });
        }

        return ok({
            reply: reply.value,
            native: {
                kind: 'native',
                provider: 'anthropic',
                data: {
                    // The next request names this ID to get cache diagnostics against this one.
                    id: message.id,
                    // The SDK also keeps each streamed tool input's raw JSON on its block, out of
                    // sight. A copy keeps only the fields the API sent, so history doesn't hold
                    // inputs twice.
                    content: message.content.map((block) => ({ ...block })),
                },
            },
            providerStats: stats,
        });
    };

    return { provider: 'anthropic', validateHistory, call };
};
