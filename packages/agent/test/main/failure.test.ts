import type { ModelCallError } from '@mecha-gremlin/core/model-call';
import { describe, expect, test } from 'vitest';
import type { Config } from '../../src/config/config.ts';
import { failure } from '../../src/main/failure.ts';

const LMSTUDIO: Config = {
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    model: undefined,
    reasoningEffort: 'none',
    skillsPath: undefined,
    maxSteps: 30,
    fileTools: 'write-edit',
};

const OPENAI: Config = {
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    reasoningEffort: undefined,
    skillsPath: undefined,
    maxSteps: 30,
    fileTools: 'write-edit',
};

const modelCallFailed = (error: ModelCallError, config: Config = OPENAI): string => {
    return failure({ kind: 'model_call_failed', error }, config);
};

describe('Actionable failure messages', () => {
    test.each<[string, ModelCallError, string]>([
        [
            'a timeout',
            { kind: 'timeout', detail: 'Request timed out.' },
            "The model server at https://api.example.com/v1 didn't answer in time (Request timed out.). Try again, or narrow the task.",
        ],
        [
            'a rate limit',
            { kind: 'rate_limit', status: 429, detail: '429 slow down' },
            "The model server at https://api.example.com/v1 is limiting requests (429 slow down). Wait a minute and try again; if it keeps happening, check the account's quota.",
        ],
        [
            'a rejected request',
            { kind: 'bad_request', status: 400, detail: '400 unknown model' },
            'The model server at https://api.example.com/v1 rejected the request (400 unknown model). Check that MODEL and MODEL_REASONING_EFFORT suit it.',
        ],
        [
            'a server error',
            { kind: 'server_error', status: 500, detail: '500 model crashed' },
            'The model server at https://api.example.com/v1 failed the request (500 model crashed). Try again; if it keeps failing, check its logs or status page.',
        ],
        [
            'a failed response',
            { kind: 'failed', detail: 'server_error: it broke' },
            'The model server at https://api.example.com/v1 failed the request (server_error: it broke). Try again; if it keeps failing, check its logs or status page.',
        ],
        [
            'an incomplete response',
            { kind: 'incomplete', detail: 'the response is incomplete: max_output_tokens' },
            'The model stopped before finishing its reply (the response is incomplete: max_output_tokens). Try a narrower task.',
        ],
        [
            'an aborted model call',
            { kind: 'aborted', detail: 'the model call was aborted' },
            "The model call didn't finish (the model call was aborted). Run the command again.",
        ],
        [
            'anything else',
            { kind: 'fatal', detail: 'boom' },
            'The model call failed unexpectedly (boom). Try again; if it keeps happening, report it as a bug.',
        ],
    ])('%s', (_name, error, message) => {
        expect(modelCallFailed(error)).toBe(message);
    });

    test('an unreachable LM Studio gets the same message as at start-up', () => {
        expect(
            modelCallFailed({ kind: 'unreachable', detail: 'Connection error.' }, LMSTUDIO),
        ).toBe(
            "Can't reach LM Studio at http://127.0.0.1:1234/v1 (Connection error.). Is its server running? Start it with `lms server start`, or set MODEL_BASE_URL.",
        );
    });

    test('another unreachable provider', () => {
        expect(modelCallFailed({ kind: 'unreachable', detail: 'Connection error.' })).toBe(
            "Can't reach https://api.example.com/v1 (Connection error.). Check MODEL_BASE_URL.",
        );
    });

    test('a rejected key', () => {
        expect(modelCallFailed({ kind: 'auth', status: 403, detail: '403 forbidden' })).toBe(
            'https://api.example.com/v1 rejected the API key (HTTP 403). Check MODEL_API_KEY.',
        );
    });

    test("the step limit counts the session's own steps", () => {
        const stats = { number: 3, usage: undefined, seconds: 1 };

        expect(failure({ kind: 'step_limit', stats }, OPENAI)).toBe(
            "The model didn't answer within 3 steps: it was still calling tools. Try a narrower task, or raise MAX_STEPS.",
        );
    });

    test('no answer', () => {
        const stats = { number: 1, usage: undefined, seconds: 1 };

        expect(failure({ kind: 'empty', stats }, OPENAI)).toBe(
            'The model gave no answer: its reply had neither text nor tool calls. Try again, or rephrase the task.',
        );
    });

    test("a history the SDK can't replay", () => {
        expect(failure({ kind: 'history', error: 'Unsupported item type: made_up' }, OPENAI)).toBe(
            "The conversation can't be continued (Unsupported item type: made_up). The model sent something the openai SDK can't replay; try updating it.",
        );
    });
});
