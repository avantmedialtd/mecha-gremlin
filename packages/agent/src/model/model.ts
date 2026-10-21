import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { Config } from '../config/config.ts';
import { fetchModels, lmStudioKeyRejected, lmStudioUnreachable, pickModel } from './lmstudio.ts';

export type ModelChoice = Result<{ readonly model: string; readonly note?: string }, string>;

/**
 * Decides which model to talk to. LM Studio is asked which model is loaded, so the app never
 * makes it load one on demand (Brief 4.9); every other provider names the model in MODEL.
 */
export const resolveModel = async (config: Config): Promise<ModelChoice> => {
    if (config.provider === 'lmstudio') {
        const models = await fetchModels(config);

        if (!models.ok) {
            return models;
        }

        return pickModel(models.value, config.model);
    }

    // loadConfig requires MODEL for every provider except lmstudio.
    return config.model === undefined
        ? err(`MODEL is required with MODEL_PROVIDER=${config.provider}.`)
        : ok({ model: config.model });
};

/** The message for a rejected API key, with the provider's own fix where there is one. */
export const keyRejected = (config: Config, status: number): string => {
    if (config.provider === 'lmstudio') {
        return lmStudioKeyRejected(status);
    }

    return `${config.baseUrl} rejected the API key (HTTP ${status}). Check MODEL_API_KEY.`;
};

export const unreachable = (config: Config, detail: string): string => {
    if (config.provider === 'lmstudio') {
        return lmStudioUnreachable(config.baseUrl, detail);
    }

    return `Can't reach ${config.baseUrl} (${detail}). Check MODEL_BASE_URL.`;
};
