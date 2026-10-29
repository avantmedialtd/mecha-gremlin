import type { ModelCallError } from '@mecha-gremlin/core/model-call';
import type { Config } from '../config/config.ts';
import { keyRejected, unreachable } from '../model/model.ts';
import type { SessionStep } from '../session/session.ts';

/** The SDK's error messages already start with the HTTP status, as in "429 slow down". */
const modelCallFailed = ({ kind, detail, status }: ModelCallError, config: Config): string => {
    const server = `The model server at ${config.baseUrl}`;

    switch (kind) {
        case 'unreachable':
            return unreachable(config, detail);
        case 'auth':
            return `${keyRejected(config, status ?? 401)} (${detail})`;
        case 'timeout':
            return `${server} didn't answer in time (${detail}). Try again, or narrow the task.`;
        case 'rate_limit':
            return `${server} is limiting requests (${detail}). Wait a minute and try again; if it keeps happening, check the account's quota.`;
        case 'bad_request':
            return `${server} rejected the request (${detail}). Check that MODEL, MODEL_REASONING_EFFORT and any MODEL_MAX_OUTPUT_TOKENS suit it.`;
        case 'server_error':
        case 'failed':
            return `${server} failed the request (${detail}). Try again; if it keeps failing, check its logs or status page.`;
        // Only Claude's output-token limit is a setting, and only its max_tokens stop is cured by
        // raising it: a longer reply doesn't fit a full context window.
        case 'incomplete':
            return config.provider === 'anthropic'
                ? `The model stopped before finishing its reply (${detail}). Try a narrower task, or, if it stopped at max_tokens, raise MODEL_MAX_OUTPUT_TOKENS from ${config.maxOutputTokens}.`
                : `The model stopped before finishing its reply (${detail}). Try a narrower task.`;
        case 'aborted':
            return `The model call didn't finish (${detail}). Run the command again.`;
        case 'fatal':
            return `The model call failed unexpectedly (${detail}). Try again; if it keeps happening, report it as a bug.`;
    }
};

export const failure = (
    step: Exclude<SessionStep, { kind: 'calls' | 'final' }>,
    config: Config,
): string => {
    switch (step.kind) {
        case 'model_call_failed':
            return modelCallFailed(step.error, config);
        case 'step_limit':
            return `The model didn't answer within ${step.stats.number} steps: it was still calling tools. Try a narrower task, or raise MAX_STEPS.`;
        case 'empty':
            return 'The model gave no answer: its reply had neither text nor tool calls. Try again, or rephrase the task.';
        case 'history':
            return `The conversation can't be continued (${step.error}). Check the history and provider, or try updating the provider SDK.`;
    }
};
