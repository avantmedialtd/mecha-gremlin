import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { Provider } from '@mecha-gremlin/core/statistics';
import { z } from 'zod';
import type { LogFormat } from '../log/log.ts';

export type { Provider } from '@mecha-gremlin/core/statistics';

export type FileTools = 'write-edit' | 'apply-patch';
export type ResponsesEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AnthropicEffort = Exclude<ResponsesEffort, 'none' | 'minimal'>;
export type Env = Readonly<Record<string, string | undefined>>;

type CommonConfig = {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
    readonly skillsPath: string | undefined;
    readonly maxSteps: number;
    readonly fileTools: FileTools;
    readonly logFormat: LogFormat;
    readonly workDir: string;
};

export type Config = CommonConfig &
    (
        | { readonly provider: 'lmstudio' | 'openai'; readonly reasoningEffort: ResponsesEffort }
        | {
              readonly provider: 'anthropic';
              readonly reasoningEffort: AnthropicEffort;
              readonly maxOutputTokens: number;
              readonly workspaceId: string | undefined;
          }
    );

const PROVIDERS = ['lmstudio', 'openai', 'anthropic'] as const satisfies readonly Provider[];
const RESPONSE_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const ANTHROPIC_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A set variable's trimmed value; unset and blank are both undefined. */
const read = (env: Env, name: string): string | undefined => {
    const value = env[name]?.trim();

    return value ? value : undefined;
};

const required = (name: string) => z.string({ error: `${name} is required.` });

const choice = <const T extends readonly [string, ...string[]]>(name: string, values: T) =>
    z.enum(values, {
        error: (issue) =>
            issue.input === undefined
                ? `${name} is required; choose ${values.join(', ')}.`
                : `${name} must be one of ${values.join(', ')}; got ${JSON.stringify(issue.input)}.`,
    });

const baseUrl = required('MODEL_BASE_URL').transform((raw, ctx) => {
    try {
        const url = new URL(raw);

        // An empty query or fragment still leaves its `?` or `#` in the URL, and both SDKs build
        // their request URLs after it.
        if ((url.protocol === 'http:' || url.protocol === 'https:') && !/[?#]/.test(url.href)) {
            return url.href.replace(/\/+$/, '');
        }
    } catch {
        // Report the same actionable message for malformed and disallowed URLs.
    }

    ctx.addIssue(
        `MODEL_BASE_URL must be an HTTP(S) URL without a query or fragment; got ${JSON.stringify(raw)}.`,
    );
    return z.NEVER;
});

const lmStudioBaseUrl = baseUrl.refine((url) => new URL(url).pathname !== '/', {
    error: (issue) =>
        `MODEL_BASE_URL is LM Studio's OpenAI-compatible URL and must have a path such as /v1; got ${JSON.stringify(issue.input)}.`,
});

// The SDK adds /v1/messages to the base URL itself. A proxy's prefix may have any path, such as
// a gateway's /v1, but the Claude API's own origin takes none.
const anthropicBaseUrl = baseUrl.refine(
    (url) => {
        const { hostname, pathname } = new URL(url);

        return hostname !== 'api.anthropic.com' || pathname === '/';
    },
    {
        error: (issue) =>
            `MODEL_BASE_URL for the Claude API is https://api.anthropic.com, without a path: the SDK adds /v1/messages itself; got ${JSON.stringify(issue.input)}.`,
    },
);

const positiveInteger = (name: string, safe: boolean) =>
    required(name).transform((raw, ctx) => {
        const number = Number(raw);

        // Digits only: Number() would also take 1e3, 0x10 and 2.0.
        if (
            /^\d+$/.test(raw) &&
            Number.isInteger(number) &&
            number > 0 &&
            (!safe || Number.isSafeInteger(number))
        ) {
            return number;
        }

        ctx.addIssue(
            `${name} must be a positive ${safe ? 'safe ' : ''}whole number in decimal digits; got ${JSON.stringify(raw)}.`,
        );
        return z.NEVER;
    });

const workDir = required('WORK_DIR').transform((raw, ctx) => {
    const path = resolve(process.cwd(), raw);

    // Its real path is used everywhere: on macOS /tmp and /var are links, and a path built from pwd
    // would fail the file tools' lexical checks. On Node, only the native realpath also spells each
    // name as it is on disk, as pwd does, when the file system ignores case.
    try {
        const real = realpathSync.native(path);

        if (statSync(real).isDirectory()) {
            return real;
        }
    } catch {
        // A missing, unreadable or otherwise invalid directory gets the same diagnostic.
    }

    ctx.addIssue(`WORK_DIR must name an existing directory; ${path} isn't one.`);
    return z.NEVER;
});

const common = {
    MODEL_BASE_URL: baseUrl,
    MODEL_API_KEY: required('MODEL_API_KEY'),
    MODEL: required('MODEL'),
    MODEL_REASONING_EFFORT: choice('MODEL_REASONING_EFFORT', RESPONSE_EFFORTS),
    MAX_STEPS: positiveInteger('MAX_STEPS', false),
    FILE_TOOLS: choice('FILE_TOOLS', ['write-edit', 'apply-patch']),
    LOG_FORMAT: choice('LOG_FORMAT', ['pretty', 'json']),
    WORK_DIR: workDir,
    SKILLS_PATH: z.string().optional(),
};

const responsesOutputLimit = z
    .string()
    .optional()
    .refine((value) => value === undefined, {
        error: 'MODEL_MAX_OUTPUT_TOKENS is supported only with MODEL_PROVIDER=anthropic.',
    });

const providerSchema = z.discriminatedUnion('MODEL_PROVIDER', [
    z.object({
        ...common,
        MODEL_PROVIDER: z.literal('lmstudio'),
        MODEL_BASE_URL: lmStudioBaseUrl,
        MODEL_MAX_OUTPUT_TOKENS: responsesOutputLimit,
    }),
    z.object({
        ...common,
        MODEL_PROVIDER: z.literal('openai'),
        MODEL_MAX_OUTPUT_TOKENS: responsesOutputLimit,
    }),
    z.object({
        ...common,
        MODEL_PROVIDER: z.literal('anthropic'),
        MODEL_BASE_URL: anthropicBaseUrl,
        MODEL_REASONING_EFFORT: choice('MODEL_REASONING_EFFORT', ANTHROPIC_EFFORTS),
        MODEL_MAX_OUTPUT_TOKENS: positiveInteger('MODEL_MAX_OUTPUT_TOKENS', true),
        ANTHROPIC_WORKSPACE_ID: z.string().optional(),
    }),
]);

// A bad discriminator must not prevent checking all the fields common to every provider.
const commonSchema = z.object({ ...common, MODEL_PROVIDER: choice('MODEL_PROVIDER', PROVIDERS) });

/** Read before `loadConfig`, whose errors include LOG_FORMAT's, to choose how they are logged. */
export const loadLogFormat = (env: Env): LogFormat | undefined => {
    return common.LOG_FORMAT.safeParse(read(env, 'LOG_FORMAT')).data;
};

const messagesOf = (result: {
    readonly error?: { readonly issues: readonly { readonly message: string }[] };
}): string[] => {
    return result.error?.issues.map((issue) => issue.message) ?? [];
};

export const loadConfig = (env: Env): Result<Config, string[]> => {
    const raw = {
        MODEL_PROVIDER: read(env, 'MODEL_PROVIDER'),
        MODEL_BASE_URL: read(env, 'MODEL_BASE_URL'),
        MODEL_API_KEY: read(env, 'MODEL_API_KEY'),
        MODEL: read(env, 'MODEL'),
        MODEL_REASONING_EFFORT: read(env, 'MODEL_REASONING_EFFORT'),
        MODEL_MAX_OUTPUT_TOKENS: read(env, 'MODEL_MAX_OUTPUT_TOKENS'),
        ANTHROPIC_WORKSPACE_ID: read(env, 'ANTHROPIC_WORKSPACE_ID'),
        MAX_STEPS: read(env, 'MAX_STEPS'),
        FILE_TOOLS: read(env, 'FILE_TOOLS'),
        LOG_FORMAT: read(env, 'LOG_FORMAT'),
        WORK_DIR: read(env, 'WORK_DIR'),
        SKILLS_PATH: read(env, 'SKILLS_PATH'),
    };
    const formerName =
        env.MAX_TURNS === undefined
            ? []
            : ['MAX_TURNS is now MAX_STEPS; rename it in your settings.'];

    if (!PROVIDERS.some((provider) => provider === raw.MODEL_PROVIDER)) {
        return err([...messagesOf(commonSchema.safeParse(raw)), ...formerName]);
    }

    const result = providerSchema.safeParse(raw);

    if (!result.success || formerName.length > 0) {
        return err([...messagesOf(result), ...formerName]);
    }

    const value = result.data;
    const shared: CommonConfig = {
        baseUrl: value.MODEL_BASE_URL,
        apiKey: value.MODEL_API_KEY,
        model: value.MODEL,
        skillsPath: value.SKILLS_PATH,
        maxSteps: value.MAX_STEPS,
        fileTools: value.FILE_TOOLS,
        logFormat: value.LOG_FORMAT,
        workDir: value.WORK_DIR,
    };

    return value.MODEL_PROVIDER === 'anthropic'
        ? ok({
              ...shared,
              provider: value.MODEL_PROVIDER,
              reasoningEffort: value.MODEL_REASONING_EFFORT,
              maxOutputTokens: value.MODEL_MAX_OUTPUT_TOKENS,
              workspaceId: value.ANTHROPIC_WORKSPACE_ID,
          })
        : ok({
              ...shared,
              provider: value.MODEL_PROVIDER,
              reasoningEffort: value.MODEL_REASONING_EFFORT,
          });
};
