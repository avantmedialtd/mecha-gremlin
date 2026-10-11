import type { ReasoningEffort } from "openai/resources/shared";

type Effort = Exclude<ReasoningEffort, null>;

const REASONING_EFFORTS = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
] as const satisfies readonly Effort[];

export interface Config {
    /** LM Studio's server origin, such as `http://127.0.0.1:1234`, with no trailing slash. */
    baseUrl: string;
    apiToken: string;
    /** A loaded model's key or instance id. Undefined means "the first loaded model". */
    model: string | undefined;
    reasoningEffort: Effort;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

export type Env = Record<string, string | undefined>;

/** Reads and validates the server's settings. Pure: it touches nothing but `env`. */
export function loadConfig(env: Env): ConfigResult {
    const problems: string[] = [];

    const rawBaseUrl = read(env, "LMSTUDIO_BASE_URL") ?? "http://127.0.0.1:1234";
    const baseUrl = parseOrigin(rawBaseUrl);
    if (baseUrl === undefined) {
        problems.push(
            `LMSTUDIO_BASE_URL must be LM Studio's http(s) origin, such as http://127.0.0.1:1234 (without /v1); got "${rawBaseUrl}".`,
        );
    }

    const reasoningEffort = read(env, "LMSTUDIO_REASONING_EFFORT") ?? "none";
    if (!isEffort(reasoningEffort)) {
        problems.push(
            `LMSTUDIO_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(", ")}; got "${reasoningEffort}".`,
        );
    }

    if (baseUrl === undefined || !isEffort(reasoningEffort)) return { ok: false, problems };

    return {
        ok: true,
        config: {
            baseUrl,
            apiToken: read(env, "LMSTUDIO_API_TOKEN") ?? "lm-studio",
            model: read(env, "LMSTUDIO_MODEL"),
            reasoningEffort,
        },
    };
}

/** A set variable's trimmed value; unset and blank are both undefined. */
function read(env: Env, name: string): string | undefined {
    const value = env[name]?.trim();
    return value ? value : undefined;
}

function parseOrigin(value: string): string | undefined {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    const isHttp = url.protocol === "http:" || url.protocol === "https:";
    const isOriginOnly = url.pathname === "/" && url.search === "" && url.hash === "";
    return isHttp && isOriginOnly ? url.origin : undefined;
}

function isEffort(value: string): value is Effort {
    return (REASONING_EFFORTS as readonly string[]).includes(value);
}
