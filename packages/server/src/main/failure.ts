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
            return keyRejected(config, status ?? 401);
        case 'timeout':
            return `${server} didn't answer in time (${detail}). Try again, or narrow the task.`;
        case 'rate_limit':
            return `${server} is limiting requests (${detail}). Wait a minute and try again; if it keeps happening, check the account's quota.`;
        case 'bad_request':
            return `${server} rejected the request (${detail}). Check that MODEL and MODEL_REASONING_EFFORT suit it.`;
        case 'server_error':
        case 'failed':
            return `${server} failed the request (${detail}). Try again; if it keeps failing, check its logs or status page.`;
        case 'incomplete':
            return `The model stopped before finishing its reply (${detail}). Try a narrower task.`;
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
            return `The conversation can't be continued (${step.error}). The model sent something the openai SDK can't replay; try updating it.`;
    }
};
