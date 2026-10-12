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
import type { ToolHandler } from "../tools/tool-handler.ts";

/** The brief's hard cap on iterations; budgets and a context check come later (Brief C8). */
export const MAX_TURNS = 8;

export interface LoopOptions {
    model: string;
    reasoning?: Reasoning;
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
 * the loop goes on, is meant to join these later.
 */
export type LoopStep =
    | { kind: "calls"; turn: TurnStats; calls: CallResult[]; history: HistoryItem[] }
    | { kind: "answer"; turn: TurnStats; text: string; history: HistoryItem[] }
    | {
          kind: "stop";
          reason: "turn_failed" | "empty" | "turn_limit" | "history";
          detail: string;
          /** Set when the model completed the turn that stopped the loop. */
          turn?: TurnStats;
          /** Only for `turn_failed`. */
          error?: TurnErrorKind;
          status?: number;
          /** So a stopped run can still be inspected or stored. */
          history: HistoryItem[];
      };

const NOT_RUN: ToolOutcome = { ok: false, error: "not run: the turn limit was reached" };

export async function* runLoop(
    client: OpenAI,
    options: LoopOptions,
): AsyncGenerator<LoopStep, void, undefined> {
    const { model, reasoning, tools, maxTurns = MAX_TURNS } = options;
    const history = [...options.history];
    // Steps outlive the turn that made them, while the loop keeps appending to `history`.
    const snapshot = (): HistoryItem[] => [...history];
    // Once per run: changing the tools mid-run invalidates the prompt cache (Brief R3.4).
    const functionTools = tools.map((handler) => toFunctionTool(handler.tool));
    const handlers = new Map(tools.map((handler) => [handler.tool.name, handler]));

    for (let number = 1; ; number++) {
        const input = toInput(history);
        if (!input.ok) {
            yield { kind: "stop", reason: "history", detail: input.detail, history: snapshot() };
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
            const { error, detail, status } = result;
            yield {
                kind: "stop",
                reason: "turn_failed",
                error,
                detail,
                status,
                history: snapshot(),
            };
            return;
        }

        const { output } = result.response;
        history.push(...output);
        const turn = { number, usage: result.usage, seconds: (performance.now() - started) / 1000 };

        const next = classify(output);
        if (next.kind === "final") {
            yield { kind: "answer", turn, text: next.text, history: snapshot() };
            return;
        }

        if (next.kind === "empty") {
            const detail = "the model's turn had neither tool calls nor text";
            yield { kind: "stop", reason: "empty", detail, turn, history: snapshot() };
            return;
        }

        if (number >= maxTurns) {
            // Every call needs an output before the history can be replayed (Brief 4.5).
            for (const call of next.calls) {
                history.push(toOutputItem(call.call_id, NOT_RUN));
            }

            const detail = `the model was still calling tools after ${number} turns`;
            yield { kind: "stop", reason: "turn_limit", detail, turn, history: snapshot() };
            return;
        }

        const calls: CallResult[] = [];
        for (const call of next.calls) {
            const outcome = await runCall(call, handlers);
            history.push(toOutputItem(call.call_id, outcome));
            calls.push({ call, outcome });
        }

        yield { kind: "calls", turn, calls, history: snapshot() };
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
