import type { HistoryItem } from '@mecha-gremlin/core/history';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { ResponsesStatistics } from '@mecha-gremlin/core/statistics';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import {
    type ResponseInputItemLike,
    toResponseInputItems,
} from 'openai/lib/responses/ResponseInputItems';
import type { ResponseInputItem } from 'openai/resources/responses/responses';

/** A Responses tool result has no error flag, so a failure is marked in its text. */
export const toOutputItem = (
    callId: string,
    outcome: ToolOutcome,
): ResponseInputItem.FunctionCallOutput => {
    return {
        type: 'function_call_output',
        call_id: callId,
        output: outcome.ok ? outcome.value : `Error: ${outcome.error}`,
    };
};

/** Convert only at the provider boundary, leaving the stored native data untouched. */
export const toInput = (
    history: readonly HistoryItem[],
    provider: ResponsesStatistics['provider'],
): Result<ResponseInputItem[], string> => {
    const items: ResponseInputItemLike[] = [];

    for (const entry of history) {
        switch (entry.kind) {
            case 'instruction':
                items.push({ role: 'developer', content: entry.text });
                break;
            case 'user':
                items.push({ role: 'user', content: entry.text });
                break;
            case 'tool_result':
                items.push(toOutputItem(entry.callId, entry.outcome));
                break;
            case 'native':
                if (entry.provider !== provider) {
                    return err(`History belongs to ${entry.provider}, not ${provider}.`);
                }

                if (
                    !Array.isArray(entry.data) ||
                    !entry.data.every(
                        (item) => typeof item === 'object' && item !== null && 'type' in item,
                    )
                ) {
                    return err('Responses history contains malformed native output.');
                }

                // The SDK helper validates its supported item types and strips its own fields.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                items.push(...(entry.data as ResponseInputItemLike[]));
                break;
        }
    }

    try {
        return ok(toResponseInputItems(items));
    } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
    }
};
