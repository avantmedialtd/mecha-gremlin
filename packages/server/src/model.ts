import type { Config } from "./config.ts";
import { fetchModels, lmStudioKeyRejected, pickModel } from "./lmstudio.ts";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ModelChoice =
    | { ok: true; model: string; note?: string }
    | { ok: false; reason: string };

/**
 * Decides which model to talk to. LM Studio is asked which model is loaded, so the app never
 * makes it load one on demand (Brief 4.9); every other provider names the model in MODEL.
 */
export async function resolveModel(config: Config, fetch: Fetch): Promise<ModelChoice> {
    if (config.provider === "lmstudio") {
        const models = await fetchModels(config, fetch);
        if (!models.ok) return models;
        return pickModel(models.payload, config.model);
    }
    // loadConfig requires MODEL for every provider except lmstudio.
    return config.model === undefined
        ? { ok: false, reason: `MODEL is required with MODEL_PROVIDER=${config.provider}.` }
        : { ok: true, model: config.model };
}

/** The message for a rejected API key, with the provider's own fix where there is one. */
export function keyRejected(config: Config, status: number): string {
    if (config.provider === "lmstudio") return lmStudioKeyRejected(status);
    return `${config.baseUrl} rejected the API key (HTTP ${status}). Check MODEL_API_KEY.`;
}
