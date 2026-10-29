// LM Studio specifics: finding out which model is loaded, through LM Studio's native REST API.
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { Config } from '../config/config.ts';
import type { ModelChoice } from './model.ts';

type LoadedModel = {
    readonly key: string;
    readonly instanceIds: readonly string[];
};

export const lmStudioKeyRejected = (status: number): string => {
    return `LM Studio rejected the API key (HTTP ${status}). Its "Require Authentication" setting is on, so set MODEL_API_KEY to one of its tokens.`;
};

export const lmStudioUnreachable = (baseUrl: string, why: string): string => {
    return `Can't reach LM Studio at ${baseUrl} (${why}). Is its server running? Start it with \`lms server start\`, or set MODEL_BASE_URL.`;
};

/**
 * Lists LM Studio's models through its native REST API, which lives at the server's origin.
 * The OpenAI-compatible `/v1/models` lists every downloaded model, and naming one that isn't
 * loaded makes LM Studio JIT-load it with its default context, which this app never relies on
 * (Brief 4.9).
 */
export const fetchModels = async (config: Config): Promise<Result<unknown, string>> => {
    const url = `${new URL(config.baseUrl).origin}/api/v1/models`;

    let response: Response;

    try {
        response = await fetch(url, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            signal: AbortSignal.timeout(10_000),
        });
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error);

        return err(lmStudioUnreachable(config.baseUrl, why));
    }

    if (response.status === 401 || response.status === 403) {
        return err(lmStudioKeyRejected(response.status));
    }

    if (!response.ok) {
        return err(`LM Studio answered HTTP ${response.status} for ${url}.`);
    }

    try {
        return ok(await response.json());
    } catch {
        return err(
            `${url} didn't return JSON. Is ${config.baseUrl} an LM Studio server, version 0.4 or later?`,
        );
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** The loaded LLMs in a `/api/v1/models` payload, or undefined if its shape is unexpected. */
const loadedModels = (payload: unknown): readonly LoadedModel[] | undefined => {
    if (!isRecord(payload) || !Array.isArray(payload.models)) {
        return undefined;
    }

    const loaded: LoadedModel[] = [];

    for (const entry of payload.models) {
        if (!isRecord(entry) || typeof entry.key !== 'string' || typeof entry.type !== 'string') {
            return undefined;
        }

        if (entry.type !== 'llm' || entry.loaded_instances === undefined) {
            continue;
        }

        const instances = entry.loaded_instances;

        if (!Array.isArray(instances)) {
            return undefined;
        }

        const instanceIds = instances.flatMap((instance) =>
            isRecord(instance) && typeof instance.id === 'string' ? [instance.id] : [],
        );

        if (instanceIds.length > 0) {
            loaded.push({ key: entry.key, instanceIds });
        }
    }

    return loaded;
};

/**
 * Chooses the model to talk to from a `/api/v1/models` payload. Only LLMs with a loaded
 * instance qualify. The configured model must match a loaded instance ID or model key.
 */
export const pickModel = (payload: unknown, configured?: string): ModelChoice => {
    const loaded = loadedModels(payload);

    if (loaded === undefined) {
        return err(
            "LM Studio's /api/v1/models response has an unexpected shape. Is this LM Studio 0.4 or later?",
        );
    }

    const instanceIds = loaded.flatMap((model) => model.instanceIds);

    if (configured === undefined || configured.trim() === '') {
        return err('MODEL is required with MODEL_PROVIDER=lmstudio; name a loaded model.');
    }

    if (
        loaded.some((model) => model.key === configured || model.instanceIds.includes(configured))
    ) {
        return ok({ model: configured });
    }

    const loadedList =
        instanceIds.length > 0 ? `Loaded: ${instanceIds.join(', ')}.` : 'No model is loaded.';

    return err(
        `MODEL is "${configured}", but that model isn't loaded in LM Studio. ${loadedList} Load it with \`lms load ${configured}\`.`,
    );
};
