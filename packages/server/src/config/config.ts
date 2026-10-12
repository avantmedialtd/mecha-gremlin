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

const PROVIDERS = ["lmstudio", "openai"] as const;

/**
 * Which kind of OpenAI-compatible service serves the model. It only changes how the model is
 * chosen: `lmstudio` can ask LM Studio which model is loaded; any other provider must name it.
 */
export type Provider = (typeof PROVIDERS)[number];

/** Per-provider defaults. A local LM Studio needs no settings at all. */
const DEFAULTS: Record<Provider, { baseUrl: string; apiKey?: string; reasoningEffort?: Effort }> = {
    // Any API key works while LM Studio's "Require Authentication" is off.
    lmstudio: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "lm-studio", reasoningEffort: "none" },
    openai: { baseUrl: "https://api.openai.com/v1" },
};

export interface Config {
    provider: Provider;
    /** The OpenAI-compatible API's base URL, such as `http://127.0.0.1:1234/v1`, with no trailing slash. */
    baseUrl: string;
    apiKey: string;
    /** The model to use. Optional with `lmstudio`, which then picks the loaded model. */
    model: string | undefined;
    /** Sent as `reasoning.effort`. Undefined leaves the model's own default. */
    reasoningEffort: Effort | undefined;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

export type Env = Record<string, string | undefined>;

/** Reads and validates the server's settings. Pure: it touches nothing but `env`. */
export function loadConfig(env: Env): ConfigResult {
    const rawProvider = read(env, "MODEL_PROVIDER") ?? "lmstudio";

    if (!isProvider(rawProvider)) {
        return {
            ok: false,
            problems: [
                `MODEL_PROVIDER must be one of ${PROVIDERS.join(", ")}; got "${rawProvider}".`,
            ],
        };
    }

    const provider = rawProvider;
    const defaults = DEFAULTS[provider];
    const problems: string[] = [];

    const rawBaseUrl = read(env, "MODEL_BASE_URL") ?? defaults.baseUrl;
    const baseUrl = parseBaseUrl(rawBaseUrl);

    if (baseUrl === undefined) {
        problems.push(
            `MODEL_BASE_URL must be an http(s) URL such as ${defaults.baseUrl}; got "${rawBaseUrl}".`,
        );
    } else if (provider === "lmstudio" && new URL(baseUrl).pathname === "/") {
        problems.push(
            `MODEL_BASE_URL is LM Studio's OpenAI-compatible base URL, which ends in /v1, such as ${defaults.baseUrl}; got "${rawBaseUrl}".`,
        );
    }

    const apiKey = read(env, "MODEL_API_KEY") ?? defaults.apiKey;

    if (apiKey === undefined) {
        problems.push(`MODEL_API_KEY is required with MODEL_PROVIDER=${provider}.`);
    }

    const model = read(env, "MODEL");

    if (model === undefined && provider !== "lmstudio") {
        problems.push(
            `MODEL is required with MODEL_PROVIDER=${provider}; only lmstudio can pick the loaded model itself.`,
        );
    }

    const rawEffort = read(env, "MODEL_REASONING_EFFORT") ?? defaults.reasoningEffort;

    if (rawEffort !== undefined && !isEffort(rawEffort)) {
        problems.push(
            `MODEL_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(", ")}; got "${rawEffort}".`,
        );
    }

    if (problems.length > 0 || baseUrl === undefined || apiKey === undefined) {
        return { ok: false, problems };
    }

    return {
        ok: true,
        config: {
            provider,
            baseUrl,
            apiKey,
            model,
            reasoningEffort: rawEffort !== undefined && isEffort(rawEffort) ? rawEffort : undefined,
        },
    };
}

/** A set variable's trimmed value; unset and blank are both undefined. */
function read(env: Env, name: string): string | undefined {
    const value = env[name]?.trim();
    return value ? value : undefined;
}

/** An http(s) URL without query or fragment, with any trailing slash removed. */
function parseBaseUrl(value: string): string | undefined {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        return undefined;
    }

    const isHttp = url.protocol === "http:" || url.protocol === "https:";

    if (!isHttp || url.search !== "" || url.hash !== "") {
        return undefined;
    }

    return url.href.replace(/\/+$/, "");
}

function isProvider(value: string): value is Provider {
    return (PROVIDERS as readonly string[]).includes(value);
}

function isEffort(value: string): value is Effort {
    return (REASONING_EFFORTS as readonly string[]).includes(value);
}
