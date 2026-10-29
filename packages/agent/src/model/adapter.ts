import type { HistoryItem } from '@mecha-gremlin/core/history';
import type {
    ModelCallOptions,
    ModelCallRequest,
    ModelCallResult,
} from '@mecha-gremlin/core/model-call';
import type { Result } from '@mecha-gremlin/core/result';
import type { Provider } from '@mecha-gremlin/core/statistics';

/** An adapter owns wire conversion and one provider client, never the session's tool loop. */
export type ModelAdapter = {
    readonly provider: Provider;
    readonly validateHistory: (history: readonly HistoryItem[]) => Result<undefined, string>;
    readonly call: (
        request: ModelCallRequest,
        options?: ModelCallOptions,
    ) => Promise<ModelCallResult>;
};
