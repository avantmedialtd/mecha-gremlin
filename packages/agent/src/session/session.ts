import { type HistoryItem, toInput, toOutputItem } from '@mecha-gremlin/core/history';
import { type ModelCallError, callModel } from '@mecha-gremlin/core/model-call';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import {
    type Reply,
    type ToolCall,
    type ToolOutcome,
    classify,
    toFunctionTool,
} from '@mecha-gremlin/core/tools';
import OpenAI from 'openai';
import type { ResponseUsage } from 'openai/resources/responses/responses';
import type { Config } from '../config/config.ts';
import { resolveModel } from '../model/model.ts';
import type { ToolHandler } from '../tools/tool-handler.ts';

export type SessionOptions = {
    readonly tools: readonly ToolHandler[];
    readonly history: readonly HistoryItem[];
    readonly maxSteps: number;
};

export type StepStats = {
    readonly number: number;
    readonly usage: ResponseUsage | undefined;
    readonly seconds: number;
};

export type CallResult = {
    readonly call: ToolCall;
    readonly outcome: ToolOutcome;
};

/**
 * The result of one step. A step that asks the user for input, and takes the reply back before
 * the session goes on, is meant to join these later.
 */
export type SessionStep =
    | { readonly kind: 'calls'; readonly stats: StepStats; readonly calls: readonly CallResult[] }
    | (Exclude<Reply, { kind: 'calls' }> & { readonly stats: StepStats })
    | { readonly kind: 'step_limit'; readonly stats: StepStats }
    | { readonly kind: 'model_call_failed'; readonly error: ModelCallError }
    | { readonly kind: 'history'; readonly error: string };

export type Session = {
    readonly model: string;
    /** Set when the model was picked out of several loaded ones. */
    readonly note?: string;
    readonly steps: AsyncGenerator<SessionStep, void, undefined>;
    /** Grows as the session runs. While the caller handles a step, the session is paused. */
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

/** Choosing the model can fail before any model call: LM Studio may have none loaded. */
export const createSession = async (
    config: Config,
    { tools, history: initial, maxSteps }: SessionOptions,
): Promise<Result<Session, string>> => {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
        return err(`maxSteps must be a positive integer; got ${maxSteps}.`);
    }

    const choice = await resolveModel(config);

    if (!choice.ok) {
        return choice;
    }

    const { model, note } = choice.value;
    const client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, maxRetries: 0 });
    const reasoning =
        config.reasoningEffort === undefined ? undefined : { effort: config.reasoningEffort };
    // Once per session: changing the tools mid-session invalidates the prompt cache (Brief R3.4).
    const functionTools = tools.map((handler) => toFunctionTool(handler.tool));
    const handlers = new Map(tools.map((handler) => [handler.tool.name, handler]));
    const history = [...initial];

    const run = async function* (): AsyncGenerator<SessionStep, void, undefined> {
        for (let number = 1; ; number++) {
            const input = toInput(history);

            if (!input.ok) {
                yield { kind: 'history', error: input.error };
                return;
            }

            const started = performance.now();
            // An unset `reasoning` drops out of the JSON body.
            const result = await callModel(client, {
                model,
                input: input.value,
                tools: functionTools,
                reasoning,
            });

            if (!result.ok) {
                yield { kind: 'model_call_failed', error: result.error };
                return;
            }

            const { response, usage } = result.value;
            history.push(...response.output);
            const stats = { number, usage, seconds: (performance.now() - started) / 1000 };

            const next = classify(response.output);

            if (next.kind !== 'calls') {
                yield { ...next, stats };
                return;
            }

            if (number >= maxSteps) {
                // Every call needs an output before the history can be replayed (Brief 4.5).
                for (const call of next.calls) {
                    history.push(toOutputItem(call.call_id, NOT_RUN));
                }

                yield { kind: 'step_limit', stats };
                return;
            }

            const calls: CallResult[] = [];

            for (const call of next.calls) {
                const outcome = await runCall(call, handlers);
                history.push(toOutputItem(call.call_id, outcome));
                calls.push({ call, outcome });
            }

            yield { kind: 'calls', stats, calls };
        }
    };

    return ok({ model, note, steps: run(), history });
};
