import {
    type HistoryItem,
    type ToolCall,
    type ToolOutcome,
    type Turn,
    type TurnFailure,
    classify,
    runTurn,
    toFunctionTool,
    toInput,
    toOutputItem,
} from "@mecha-gremlin/core";
import OpenAI from "openai";
import type { ResponseUsage } from "openai/resources/responses/responses";
import type { Config } from "../config/config.ts";
import { resolveModel } from "../model/model.ts";
import type { ToolHandler } from "../tools/tool-handler.ts";

/** The brief's hard cap on iterations; budgets and a context check come later (Brief C8). */
export const MAX_TURNS = 8;

export interface SessionOptions {
    tools: readonly ToolHandler[];
    history: readonly HistoryItem[];
    maxTurns?: number;
}

export interface TurnStats {
    number: number;
    usage: ResponseUsage | undefined;
    seconds: number;
}

export interface CallResult {
    call: ToolCall;
    outcome: ToolOutcome;
}

/**
 * The result of one turn. A step that asks the user for input, and takes the reply back before
 * the session goes on, is meant to join these later.
 */
export type SessionStep =
    | { kind: "calls"; turn: TurnStats; calls: CallResult[] }
    | (Exclude<Turn, { kind: "calls" }> & { turn: TurnStats })
    | { kind: "turn_limit"; turn: TurnStats }
    | { kind: "turn_failed"; failure: TurnFailure }
    | { kind: "history"; detail: string };

export interface Session {
    model: string;
    /** Set when the model was picked out of several loaded ones. */
    note?: string;
    steps: AsyncGenerator<SessionStep, void, undefined>;
    /** Grows as the session runs. While the caller handles a step, the session is paused. */
    history: readonly HistoryItem[];
}

const NOT_RUN: ToolOutcome = { ok: false, error: "not run: the turn limit was reached" };

/** The model is chosen first, which can fail before any turn: LM Studio may have none loaded. */
export async function createSession(
    config: Config,
    options: SessionOptions,
): Promise<({ ok: true } & Session) | { ok: false; reason: string }> {
    const choice = await resolveModel(config);
    if (!choice.ok) {
        return choice;
    }

    const client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey, maxRetries: 0 });
    const history = [...options.history];
    const steps = run(client, config, choice.model, options, history);
    return { ok: true, model: choice.model, note: choice.note, steps, history };
}

async function* run(
    client: OpenAI,
    config: Config,
    model: string,
    { tools, maxTurns = MAX_TURNS }: SessionOptions,
    history: HistoryItem[],
): AsyncGenerator<SessionStep, void, undefined> {
    const reasoning =
        config.reasoningEffort === undefined ? undefined : { effort: config.reasoningEffort };
    // Once per session: changing the tools mid-session invalidates the prompt cache (Brief R3.4).
    const functionTools = tools.map((handler) => toFunctionTool(handler.tool));
    const handlers = new Map(tools.map((handler) => [handler.tool.name, handler]));

    for (let number = 1; ; number++) {
        const input = toInput(history);
        if (!input.ok) {
            yield { kind: "history", detail: input.detail };
            return;
        }

        const started = performance.now();
        // An unset `reasoning` drops out of the JSON body.
        const result = await runTurn(client, {
            model,
            input: input.input,
            tools: functionTools,
            reasoning,
        });
        if (!result.ok) {
            yield { kind: "turn_failed", failure: result };
            return;
        }

        const { output } = result.response;
        history.push(...output);
        const turn = { number, usage: result.usage, seconds: (performance.now() - started) / 1000 };

        const next = classify(output);
        if (next.kind !== "calls") {
            yield { ...next, turn };
            return;
        }

        if (number >= maxTurns) {
            // Every call needs an output before the history can be replayed (Brief 4.5).
            for (const call of next.calls) {
                history.push(toOutputItem(call.call_id, NOT_RUN));
            }

            yield { kind: "turn_limit", turn };
            return;
        }

        const calls: CallResult[] = [];
        for (const call of next.calls) {
            const outcome = await runCall(call, handlers);
            history.push(toOutputItem(call.call_id, outcome));
            calls.push({ call, outcome });
        }

        yield { kind: "calls", turn, calls };
    }
}

async function runCall(
    call: ToolCall,
    handlers: ReadonlyMap<string, ToolHandler>,
): Promise<ToolOutcome> {
    const handler = handlers.get(call.name);
    if (handler === undefined) {
        const available = [...handlers.keys()].join(", ");
        return {
            ok: false,
            error: `unknown tool ${JSON.stringify(call.name)}; available tools: ${available}`,
        };
    }

    try {
        return await handler.invoke(call.arguments);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `${call.name} failed: ${reason}` };
    }
}
