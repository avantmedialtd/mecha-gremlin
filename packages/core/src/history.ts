import type { Provider } from './statistics.ts';
import type { ToolOutcome } from './tools.ts';

/** Native replay data belongs to the adapter; the shared loop must not interpret it. */
export type NativeResponse = {
    readonly kind: 'native';
    readonly provider: Provider;
    readonly data: unknown;
};

/** The data kept in memory for the entire session, in conversation order. */
export type HistoryItem =
    | { readonly kind: 'instruction'; readonly text: string }
    | { readonly kind: 'user'; readonly text: string }
    | NativeResponse
    | { readonly kind: 'tool_result'; readonly callId: string; readonly outcome: ToolOutcome };
