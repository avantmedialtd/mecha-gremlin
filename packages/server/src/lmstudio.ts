import type { Config } from "./config.ts";

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ModelsResult = { ok: true; payload: unknown } | { ok: false; reason: string };

export type ModelChoice =
    | { ok: true; model: string; note?: string }
    | { ok: false; reason: string };

interface LoadedModel {
    key: string;
    instanceIds: string[];
}

/**
 * Lists LM Studio's models through its native REST API. The OpenAI-compatible `/v1/models`
 * lists every downloaded model, and naming one that isn't loaded makes LM Studio JIT-load it
 * with its default context, which this app never relies on (Brief 4.9).
 */
export async function fetchModels(config: Config, fetch: Fetch): Promise<ModelsResult> {
    const url = `${config.baseUrl}/api/v1/models`;

    let response: Response;
    try {
        response = await fetch(url, {
            headers: { Authorization: `Bearer ${config.apiToken}` },
            signal: AbortSignal.timeout(10_000),
        });
    } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            reason: `Can't reach LM Studio at ${config.baseUrl} (${why}). Is its server running? Start it with \`lms server start\`, or set LMSTUDIO_BASE_URL.`,
        };
    }

    if (response.status === 401 || response.status === 403) {
        return { ok: false, reason: tokenRejected(response.status) };
    }
    if (!response.ok) {
        return { ok: false, reason: `LM Studio answered HTTP ${response.status} for ${url}.` };
    }

    try {
        return { ok: true, payload: await response.json() };
    } catch {
        return {
            ok: false,
            reason: `${url} didn't return JSON. Is ${config.baseUrl} an LM Studio server, version 0.4 or later?`,
        };
    }
}

export function tokenRejected(status: number): string {
    return `LM Studio rejected the API token (HTTP ${status}). Its "Require Authentication" setting is on, so set LMSTUDIO_API_TOKEN to one of its tokens.`;
}

/**
 * Chooses the model to talk to from a `/api/v1/models` payload. Only LLMs with a loaded
 * instance qualify. A configured model must match a loaded instance id or model key;
 * otherwise the first loaded instance is used.
 */
export function pickModel(payload: unknown, configured?: string): ModelChoice {
    const loaded = loadedModels(payload);
    if (loaded === undefined) {
        return {
            ok: false,
            reason: "LM Studio's /api/v1/models response has an unexpected shape. Is this LM Studio 0.4 or later?",
        };
    }

    const instanceIds = loaded.flatMap((model) => model.instanceIds);

    if (configured !== undefined) {
        if (
            loaded.some(
                (model) => model.key === configured || model.instanceIds.includes(configured),
            )
        ) {
            return { ok: true, model: configured };
        }
        const loadedList =
            instanceIds.length > 0 ? `Loaded: ${instanceIds.join(", ")}.` : "No model is loaded.";
        return {
            ok: false,
            reason: `LMSTUDIO_MODEL is "${configured}", but that model isn't loaded in LM Studio. ${loadedList} Load it with \`lms load ${configured}\`.`,
        };
    }

    const [first] = instanceIds;
    if (first === undefined) {
        return {
            ok: false,
            reason: "No model is loaded in LM Studio. Load one with `lms load <model>` or in the LM Studio app; models are never loaded on demand.",
        };
    }
    if (instanceIds.length > 1) {
        return {
            ok: true,
            model: first,
            note: `Using ${first}, the first of ${instanceIds.length} loaded models (${instanceIds.join(", ")}). Set LMSTUDIO_MODEL to choose another.`,
        };
    }
    return { ok: true, model: first };
}

/** The loaded LLMs in a `/api/v1/models` payload, or undefined if its shape is unexpected. */
function loadedModels(payload: unknown): LoadedModel[] | undefined {
    if (!isRecord(payload) || !Array.isArray(payload.models)) return undefined;

    const loaded: LoadedModel[] = [];
    for (const entry of payload.models) {
        if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.type !== "string")
            return undefined;
        if (entry.type !== "llm") continue;

        const instances = entry.loaded_instances ?? [];
        if (!Array.isArray(instances)) return undefined;
        const instanceIds = instances.flatMap((instance) =>
            isRecord(instance) && typeof instance.id === "string" ? [instance.id] : [],
        );
        if (instanceIds.length > 0) loaded.push({ key: entry.key, instanceIds });
    }
    return loaded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
