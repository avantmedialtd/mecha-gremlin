import type { Fields, Json } from '../log/log.ts';
import type { StepStats } from '../session/session.ts';

/** Arguments that parse are logged as data; the rest as the model sent them. */
export const parsed = (raw: string): Json => {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
};

export const modelCallFields = ({ number, providerStats, seconds }: StepStats): Fields => {
    return {
        step: number,
        providerStats,
        seconds: Math.round(seconds * 10) / 10,
    };
};
