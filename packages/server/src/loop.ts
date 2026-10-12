import {
    type HistoryItem,
    type ToolCall,
    type ToolOutcome,
    type TurnErrorKind,
    classify,
    runTurn,
    toFunctionTool,
    toInput,
    toOutputItem,
} from "@mecha-gremlin/core";
import type OpenAI from "openai";
import type { ResponseUsage } from "openai/resources/responses/responses";
import type { Reasoning } from "openai/resources/shared";
import type { ToolHandler } from "./tool-handler.ts";

/** The brief's hard cap on iterations; budgets and a context check come later (Brief C8). */
export const MAX_TURNS = 8;

export interface LoopOptions {
    model: string;
    reasoning?: Reasoning;
    tools: readonly ToolHandler[];
    history: readonly HistoryItem[];
    maxTurns?: number;
    onEvent?: (event: LoopEvent) => void;
}

export type LoopEvent =
    | { type: "turn"; turn: number; usage: ResponseUsage | undefined; seconds: number }
    | { type: "call"; name: string; arguments: string }
    | { type: "result"; name: string; ok: true; bytes: number }
    | { type: "result"; name: string; ok: false; error: string };

export type LoopResult =
    | { ok: true; text: string; history: HistoryItem[] }
    | {
          ok: false;
          reason: "turn_failed" | "empty" | "turn_limit" | "history";
          detail: string;
          /** Only for `turn_failed`. */
          error?: TurnErrorKind;
          status?: number;
          /** So a failed run can still be inspected or stored. */
          history: HistoryItem[];
      };

const NOT_RUN: ToolOutcome = { ok: false, error: "not run: the turn limit was reached" };

export async function runLoop(client: OpenAI, options: LoopOptions): Promise<LoopResult> {
    const { model, reasoning, tools, maxTurns = MAX_TURNS, onEvent = () => {} } = options;
    const history = [...options.history];
    // Once per run: changing the tools mid-run invalidates the prompt cache (Brief R3.4).
    const functionTools = tools.map((handler) => toFunctionTool(handler.tool));
    const handlers = new Map(tools.map((handler) => [handler.tool.name, handler]));

    for (let turn = 1; ; turn++) {
        const input = toInput(history);
        if (!input.ok) {
            return { ok: false, reason: "history", detail: input.detail, history };
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
            const { error, detail, status } = result;
            return { ok: false, reason: "turn_failed", error, detail, status, history };
        }

        const { output } = result.response;
        history.push(...output);
        const seconds = (performance.now() - started) / 1000;
        onEvent({ type: "turn", turn, usage: result.usage, seconds });

        const next = classify(output);
        if (next.kind === "final") {
            return { ok: true, text: next.text, history };
        }

        if (next.kind === "empty") {
            const detail = "the model's turn had neither tool calls nor text";
            return { ok: false, reason: "empty", detail, history };
        }

        if (turn >= maxTurns) {
            // Every call needs an output before the history can be replayed (Brief 4.5).
            for (const call of next.calls) {
                history.push(toOutputItem(call.call_id, NOT_RUN));
            }

            const detail = `the model was still calling tools after ${turn} turns`;
            return { ok: false, reason: "turn_limit", detail, history };
        }

        for (const call of next.calls) {
            onEvent({ type: "call", name: call.name, arguments: call.arguments });
            const outcome = await runCall(call, handlers);
            onEvent(resultEvent(call.name, outcome));
            history.push(toOutputItem(call.call_id, outcome));
        }
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

function resultEvent(name: string, outcome: ToolOutcome): LoopEvent {
    return outcome.ok
        ? {
              type: "result",
              name,
              ok: true,
              bytes: new TextEncoder().encode(outcome.output).byteLength,
          }
        : { type: "result", name, ok: false, error: outcome.error };
}
