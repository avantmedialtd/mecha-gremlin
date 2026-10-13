import type { Fields, Json } from '../log/log.ts';
import type { TurnStats } from '../session/session.ts';

/** Arguments that parse are logged as data; the rest as the model sent them. */
export const parsed = (raw: string): Json => {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
};

export const turnFields = ({ number, usage, seconds }: TurnStats): Fields => {
    return {
        number,
        inputTokens: usage?.input_tokens,
        cachedTokens: usage?.input_tokens_details?.cached_tokens,
        outputTokens: usage?.output_tokens,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
        seconds: Math.round(seconds * 10) / 10,
    };
};
