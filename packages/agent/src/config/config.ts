import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { ReasoningEffort } from 'openai/resources/shared';
import type { LogFormat } from '../log/log.ts';

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

// Room for about a dozen page actions, at two steps each.
const DEFAULT_MAX_STEPS = 30;

/**
 * Which kind of OpenAI-compatible service serves the model. It only changes how the model is
 * chosen: `lmstudio` can ask LM Studio which model is loaded; any other provider must name it.
 */
export type Provider = (typeof PROVIDERS)[number];

/** The tools that write files: `write` and `edit`, or `apply_patch` in their place. */
export type FileTools = 'write-edit' | 'apply-patch';

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
    // The skills roots, separated by `:` as in PATH. Undefined loads no skill.
    readonly skillsPath: string | undefined;
    readonly maxSteps: number;
    readonly fileTools: FileTools;
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

// Digits only: Number() would also take 1e3, 0x10 and 2.0.
const checkMaxSteps = (raw: string | undefined): Result<number, string> => {
    if (raw === undefined) {
        return ok(DEFAULT_MAX_STEPS);
    }

    if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        return err(`MAX_STEPS must be a positive whole number, such as 30; got "${raw}".`);
    }

    return ok(Number(raw));
};

// An ignored MAX_TURNS would quietly put the step limit back to its default.
const checkFormerName = (raw: string | undefined): Result<undefined, string> => {
    return raw === undefined
        ? ok(undefined)
        : err('MAX_TURNS is now MAX_STEPS; rename it in your settings.');
};

// The two sets are never offered together: two ways to do one thing make for worse tool choices.
const checkFileTools = (raw: string | undefined): Result<FileTools, string> => {
    const value = raw ?? 'write-edit';

    return value === 'write-edit' || value === 'apply-patch'
        ? ok(value)
        : err(`FILE_TOOLS must be write-edit or apply-patch; got "${value}".`);
};

const problemsOf = (checks: readonly Result<unknown, string>[]): string[] => {
    return checks.flatMap((check) => (check.ok ? [] : [check.error]));
};

const checkEffort = (raw: string | undefined): Result<Effort | undefined, string> => {
    if (raw === undefined || isEffort(raw)) {
        return ok(raw);
    }

    return err(
        `MODEL_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(', ')}; got "${raw}".`,
    );
};

/** Apart from `loadConfig`, and read before it: the log reports what's wrong with the rest. */
export const loadLogFormat = (env: Env): Result<LogFormat, string> => {
    const format = read(env, 'LOG_FORMAT') ?? 'pretty';

    return format === 'pretty' || format === 'json'
        ? ok(format)
        : err(`LOG_FORMAT must be pretty or json; got "${format}".`);
};

// Apart from `loadConfig`, like the log format, so that main.ts can check it even when the rest
// of the settings are wrong, and report every problem at once.
export const loadWorkDir = (env: Env): string | undefined => {
    return read(env, 'WORK_DIR');
};

/** Reads and validates the agent's settings. Pure: it touches nothing but `env`. */
export const loadConfig = (env: Env): Result<Config, string[]> => {
    // Checked whatever the provider, so an unknown provider doesn't hide their errors.
    const maxSteps = checkMaxSteps(read(env, 'MAX_STEPS'));
    const formerName = checkFormerName(read(env, 'MAX_TURNS'));
    const fileTools = checkFileTools(read(env, 'FILE_TOOLS'));
    const rawProvider = read(env, 'MODEL_PROVIDER') ?? 'lmstudio';

    if (!isProvider(rawProvider)) {
        return err([
            `MODEL_PROVIDER must be one of ${PROVIDERS.join(', ')}; got "${rawProvider}".`,
            ...problemsOf([maxSteps, formerName, fileTools]),
        ]);
    }

    const provider = rawProvider;
    const defaults = DEFAULTS[provider];
    const baseUrl = checkBaseUrl(provider, read(env, 'MODEL_BASE_URL') ?? defaults.baseUrl);
    const apiKey = checkKey(provider, read(env, 'MODEL_API_KEY') ?? defaults.apiKey);
    const model = checkModel(provider, read(env, 'MODEL'));
    const effort = checkEffort(read(env, 'MODEL_REASONING_EFFORT') ?? defaults.reasoningEffort);

    if (
        !baseUrl.ok ||
        !apiKey.ok ||
        !model.ok ||
        !effort.ok ||
        !maxSteps.ok ||
        !formerName.ok ||
        !fileTools.ok
    ) {
        return err(problemsOf([baseUrl, apiKey, model, effort, maxSteps, formerName, fileTools]));
    }

    return ok({
        provider,
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
        model: model.value,
        reasoningEffort: effort.value,
        skillsPath: read(env, 'SKILLS_PATH'),
        maxSteps: maxSteps.value,
        fileTools: fileTools.value,
    });
};
