import {
    type ResponseInputItemLike,
    toResponseInputItems,
} from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { type Result, err, ok } from "./result.ts";
import type { ToolOutcome } from "./tools.ts";

/**
 * Keep every item exactly as received, reasoning and calls included. With `store: false` the
 * whole history is replayed on every turn (Brief C1), and a request can fail when items are
 * missing.
 */
export type HistoryItem = ResponseInputItemLike;

/** A call's output has no error flag in the Responses API, so a failure is marked in its text. */
export const toOutputItem = (
    callId: string,
    outcome: ToolOutcome,
): ResponseInputItem.FunctionCallOutput => {
    return {
        type: "function_call_output",
        call_id: callId,
        output: outcome.ok ? outcome.value : `Error: ${outcome.error}`,
    };
};

/**
 * `toResponseInputItems` strips the fields the SDK adds, such as `parsed_arguments`, and throws on
 * item types it doesn't know.
 */
export const toInput = (history: readonly HistoryItem[]): Result<ResponseInputItem[], string> => {
    try {
        return ok(toResponseInputItems(history));
    } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
    }
};
