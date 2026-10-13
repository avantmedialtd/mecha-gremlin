import type { TurnError } from '@mecha-gremlin/core/turn';
import type { Config } from '../config/config.ts';
import { keyRejected, unreachable } from '../model/model.ts';
import type { SessionStep } from '../session/session.ts';

/** The SDK's error messages already start with the HTTP status, as in "429 slow down". */
const turnFailed = ({ kind, detail, status }: TurnError, config: Config): string => {
    const server = `The model server at ${config.baseUrl}`;

    switch (kind) {
        case 'unreachable':
            return unreachable(config, detail);
        case 'auth':
            return keyRejected(config, status ?? 401);
        case 'timeout':
            return `${server} didn't answer in time (${detail}). Try again, or ask about a smaller file.`;
        case 'rate_limit':
            return `${server} is limiting requests (${detail}). Wait a minute and try again; if it keeps happening, check the account's quota.`;
        case 'bad_request':
            return `${server} rejected the request (${detail}). Check that MODEL and MODEL_REASONING_EFFORT suit it.`;
        case 'server_error':
        case 'failed':
            return `${server} failed the turn (${detail}). Try again; if it keeps failing, check its logs or status page.`;
        case 'incomplete':
            return `The model stopped before finishing its turn (${detail}). Try a narrower question or a smaller file.`;
        case 'aborted':
            return `The turn didn't finish (${detail}). Run the command again.`;
        case 'fatal':
            return `The turn failed unexpectedly (${detail}). Try again; if it keeps happening, report it as a bug.`;
    }
};

export const failure = (
    step: Exclude<SessionStep, { kind: 'calls' | 'final' }>,
    config: Config,
): string => {
    switch (step.kind) {
        case 'turn_failed':
            return turnFailed(step.error, config);
        case 'turn_limit':
            return `The model didn't answer within ${step.turn.number} turns: it was still calling tools. Try a narrower question.`;
        case 'empty':
            return 'The model gave no answer: its turn had neither text nor tool calls. Try again, or rephrase the question.';
        case 'history':
            return `The conversation can't be continued (${step.error}). The model sent something the openai SDK can't replay; try updating it.`;
    }
};
