import {
    type ResponseInputItemLike,
    toResponseInputItems,
} from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { ToolOutcome } from "./tools.ts";

/**
 * One item of a conversation, kept exactly as it was sent or received: the caller's messages,
 * every output item of every turn (reasoning, messages and calls alike), and the calls' outputs.
 * With `store: false` the whole history is sent again on every turn (Brief C1).
 */
export type HistoryItem = ResponseInputItemLike;

export type InputResult = { ok: true; input: ResponseInputItem[] } | { ok: false; detail: string };

/** The history item answering a call. The model sees a failure as `Error: <error>`. */
export function toOutputItem(
    callId: string,
    outcome: ToolOutcome,
): ResponseInputItem.FunctionCallOutput {
    return {
        type: "function_call_output",
        call_id: callId,
        output: outcome.ok ? outcome.output : `Error: ${outcome.error}`,
    };
}

/**
 * The history as input for the next request, through the SDK's `toResponseInputItems`, which
 * strips SDK-only fields such as `parsed_arguments`. The SDK throws on an item type it doesn't
 * know; that comes back as a value instead.
 */
export function toInput(history: readonly HistoryItem[]): InputResult {
    try {
        return { ok: true, input: toResponseInputItems(history) };
    } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
}
