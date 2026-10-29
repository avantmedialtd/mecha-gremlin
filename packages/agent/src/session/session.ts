import type { HistoryItem } from '@mecha-gremlin/core/history';
import type { ModelCallError } from '@mecha-gremlin/core/model-call';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { ProviderStatistics } from '@mecha-gremlin/core/statistics';
import type { Reply, ToolCall, ToolOutcome } from '@mecha-gremlin/core/tools';
import type { Config } from '../config/config.ts';
import { createAnthropicAdapter } from '../model/anthropic-call.ts';
import { resolveModel } from '../model/model.ts';
import { createResponsesAdapter } from '../model/responses-call.ts';
import type { ToolHandler } from '../tools/tool-handler.ts';

export type SessionOptions = {
    readonly tools: readonly ToolHandler[];
    readonly history: readonly HistoryItem[];
    readonly maxSteps: number;
};

export type StepStats = {
    readonly number: number;
    readonly providerStats: ProviderStatistics;
    readonly seconds: number;
};

export type CallResult = { readonly call: ToolCall; readonly outcome: ToolOutcome };

export type SessionStep =
    | { readonly kind: 'calls'; readonly stats: StepStats; readonly calls: readonly CallResult[] }
    | (Exclude<Reply, { kind: 'calls' }> & { readonly stats: StepStats })
    | { readonly kind: 'step_limit'; readonly stats: StepStats }
    | {
          readonly kind: 'model_call_failed';
          readonly error: ModelCallError;
          readonly stats: StepStats;
      }
    | { readonly kind: 'history'; readonly error: string };

export type Session = {
    readonly model: string;
    readonly note?: string;
    readonly steps: AsyncGenerator<SessionStep, void, undefined>;
    /** Grows as the session runs; the generator is paused while the caller handles a step. */
    readonly history: readonly HistoryItem[];
};

const NOT_RUN: ToolOutcome = err('not run: the step limit was reached');

const runCall = async (
    call: ToolCall,
    handlers: ReadonlyMap<string, ToolHandler>,
): Promise<ToolOutcome> => {
    const handler = handlers.get(call.name);

    if (handler === undefined) {
        const available = [...handlers.keys()].join(', ');

        return err(`unknown tool ${JSON.stringify(call.name)}; available tools: ${available}`);
    }

    try {
        return await handler.invoke(call.arguments);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        return err(`${call.name} failed: ${reason}`);
    }
};

export const createSession = async (
    config: Config,
    { tools, history: initial, maxSteps }: SessionOptions,
): Promise<Result<Session, string>> => {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
        return err(`maxSteps must be a positive integer; got ${maxSteps}.`);
    }

    // Copy primitive settings and history envelopes before any await: a caller cannot change a
    // running session's provider or instructions by mutating its inputs. The tools offered and the
    // handlers that run them come from the same array, read once: changing the tools mid-session
    // invalidates the prompt cache (Brief R3.4).
    const sessionConfig = { ...config };
    const history = initial.map((entry) => ({ ...entry }));
    const definitions = tools.map((handler) => handler.tool);
    const handlers = new Map(tools.map((handler) => [handler.tool.name, handler]));
    let adapter;

    try {
        adapter =
            sessionConfig.provider === 'anthropic'
                ? createAnthropicAdapter(sessionConfig, definitions)
                : createResponsesAdapter(sessionConfig, definitions);
    } catch (error) {
        return err(
            `Can't prepare model tools: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const checked = adapter.validateHistory(history);

    if (!checked.ok) {
        return checked;
    }

    const choice = await resolveModel(sessionConfig);

    if (!choice.ok) {
        return choice;
    }

    const { model, note } = choice.value;

    const run = async function* (): AsyncGenerator<SessionStep, void, undefined> {
        for (let number = 1; ; number++) {
            const checkedHistory = adapter.validateHistory(history);

            if (!checkedHistory.ok) {
                yield { kind: 'history', error: checkedHistory.error };
                return;
            }

            const started = performance.now();
            const result = await adapter.call({ model, history });
            const seconds = (performance.now() - started) / 1000;

            if (!result.ok) {
                const providerStats: ProviderStatistics = result.error.providerStats ?? {
                    provider: sessionConfig.provider,
                    usage: { kind: 'unavailable' },
                    rateLimits: {},
                };
                yield {
                    kind: 'model_call_failed',
                    error: result.error,
                    stats: { number, seconds, providerStats },
                };
                return;
            }

            const { native, reply, providerStats } = result.value;
            history.push(native);
            const stats = { number, providerStats, seconds };

            if (reply.kind !== 'calls') {
                yield { ...reply, stats };
                return;
            }

            // Every call needs an outcome before the history can be replayed (Brief 4.5). A reply
            // that the next request couldn't replay runs none of its tools.
            const notRun = reply.calls.map((call): HistoryItem => ({
                kind: 'tool_result',
                callId: call.call_id,
                outcome: NOT_RUN,
            }));
            const replayable = adapter.validateHistory([...history, ...notRun]);

            if (!replayable.ok) {
                yield { kind: 'history', error: replayable.error };
                return;
            }

            if (number >= maxSteps) {
                history.push(...notRun);
                yield { kind: 'step_limit', stats };
                return;
            }

            const calls: CallResult[] = [];

            for (const call of reply.calls) {
                const outcome = await runCall(call, handlers);
                history.push({ kind: 'tool_result', callId: call.call_id, outcome });
                calls.push({ call, outcome });
            }

            yield { kind: 'calls', stats, calls };
        }
    };

    return ok({ model, note, steps: run(), history });
};
