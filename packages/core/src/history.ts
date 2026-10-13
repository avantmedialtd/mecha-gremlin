import {
    type ResponseInputItemLike,
    toResponseInputItems,
} from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { ToolOutcome } from "./tools.ts";

/**
 * Keep every item exactly as received, reasoning and calls included. With `store: false` the
 * whole history is replayed on every turn (Brief C1), and a request can fail when items are
 * missing.
 */
export type HistoryItem = ResponseInputItemLike;

export type InputResult = { ok: true; input: ResponseInputItem[] } | { ok: false; detail: string };

/** A call's output has no error flag in the Responses API, so a failure is marked in its text. */
export const toOutputItem = (
    callId: string,
    outcome: ToolOutcome,
): ResponseInputItem.FunctionCallOutput => {
    return {
        type: "function_call_output",
        call_id: callId,
        output: outcome.ok ? outcome.output : `Error: ${outcome.error}`,
    };
};

/**
 * `toResponseInputItems` strips the fields the SDK adds, such as `parsed_arguments`, and throws on
 * item types it doesn't know.
 */
export const toInput = (history: readonly HistoryItem[]): InputResult => {
    try {
        return { ok: true, input: toResponseInputItems(history) };
    } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
};
