import { type Result, err, ok } from '@mecha-gremlin/core';
import type { ReasoningEffort } from 'openai/resources/shared';

type Effort = Exclude<ReasoningEffort, null>;

const REASONING_EFFORTS = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const satisfies readonly Effort[];

const PROVIDERS = ['lmstudio', 'openai'] as const;

/**
 * Which kind of OpenAI-compatible service serves the model. It only changes how the model is
 * chosen: `lmstudio` can ask LM Studio which model is loaded; any other provider must name it.
 */
export type Provider = (typeof PROVIDERS)[number];

type Defaults = {
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly reasoningEffort?: Effort;
};

/** Per-provider defaults. A local LM Studio needs no settings at all. */
const DEFAULTS: Readonly<Record<Provider, Defaults>> = {
    // Any API key works while LM Studio's "Require Authentication" is off.
    lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'lm-studio', reasoningEffort: 'none' },
    openai: { baseUrl: 'https://api.openai.com/v1' },
};

export type Config = {
    readonly provider: Provider;
    /** The OpenAI-compatible API's base URL, such as `http://127.0.0.1:1234/v1`, with no trailing slash. */
    readonly baseUrl: string;
    readonly apiKey: string;
    /** The model to use. Optional with `lmstudio`, which then picks the loaded model. */
    readonly model: string | undefined;
    /** Sent as `reasoning.effort`. Undefined leaves the model's own default. */
    readonly reasoningEffort: Effort | undefined;
};

export type Env = Readonly<Record<string, string | undefined>>;

/** A set variable's trimmed value; unset and blank are both undefined. */
const read = (env: Env, name: string): string | undefined => {
    const value = env[name]?.trim();

    return value ? value : undefined;
};

/** An http(s) URL without query or fragment, with any trailing slash removed. */
const parseBaseUrl = (value: string): string | undefined => {
    let url: URL;

    try {
        url = new URL(value);
    } catch {
        return undefined;
    }

    const isHttp = url.protocol === 'http:' || url.protocol === 'https:';

    if (!isHttp || url.search !== '' || url.hash !== '') {
        return undefined;
    }

    return url.href.replace(/\/+$/, '');
};

const isProvider = (value: string): value is Provider => {
    return (PROVIDERS as readonly string[]).includes(value);
};

const isEffort = (value: string): value is Effort => {
    return (REASONING_EFFORTS as readonly string[]).includes(value);
};

const checkBaseUrl = (provider: Provider, raw: string): Result<string, string> => {
    const example = DEFAULTS[provider].baseUrl;
    const baseUrl = parseBaseUrl(raw);

    if (baseUrl === undefined) {
        return err(`MODEL_BASE_URL must be an http(s) URL such as ${example}; got "${raw}".`);
    }

    if (provider === 'lmstudio' && new URL(baseUrl).pathname === '/') {
        return err(
            `MODEL_BASE_URL is LM Studio's OpenAI-compatible base URL, which ends in /v1, such as ${example}; got "${raw}".`,
        );
    }

    return ok(baseUrl);
};

const checkKey = (provider: Provider, raw: string | undefined): Result<string, string> => {
    return raw === undefined
        ? err(`MODEL_API_KEY is required with MODEL_PROVIDER=${provider}.`)
        : ok(raw);
};

const checkModel = (
    provider: Provider,
    raw: string | undefined,
): Result<string | undefined, string> => {
    if (raw === undefined && provider !== 'lmstudio') {
        return err(
            `MODEL is required with MODEL_PROVIDER=${provider}; only lmstudio can pick the loaded model itself.`,
        );
    }

    return ok(raw);
};

const checkEffort = (raw: string | undefined): Result<Effort | undefined, string> => {
    if (raw === undefined || isEffort(raw)) {
        return ok(raw);
    }

    return err(
        `MODEL_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(', ')}; got "${raw}".`,
    );
};

/** Reads and validates the server's settings. Pure: it touches nothing but `env`. */
export const loadConfig = (env: Env): Result<Config, string[]> => {
    const rawProvider = read(env, 'MODEL_PROVIDER') ?? 'lmstudio';

    if (!isProvider(rawProvider)) {
        return err([
            `MODEL_PROVIDER must be one of ${PROVIDERS.join(', ')}; got "${rawProvider}".`,
        ]);
    }

    const provider = rawProvider;
    const defaults = DEFAULTS[provider];
    const baseUrl = checkBaseUrl(provider, read(env, 'MODEL_BASE_URL') ?? defaults.baseUrl);
    const apiKey = checkKey(provider, read(env, 'MODEL_API_KEY') ?? defaults.apiKey);
    const model = checkModel(provider, read(env, 'MODEL'));
    const effort = checkEffort(read(env, 'MODEL_REASONING_EFFORT') ?? defaults.reasoningEffort);

    if (!baseUrl.ok || !apiKey.ok || !model.ok || !effort.ok) {
        const checks = [baseUrl, apiKey, model, effort];

        return err(checks.flatMap((check) => (check.ok ? [] : [check.error])));
    }

    return ok({
        provider,
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
        model: model.value,
        reasoningEffort: effort.value,
    });
};
