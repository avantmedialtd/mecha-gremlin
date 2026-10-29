import type { ModelCallError } from '@mecha-gremlin/core/model-call';
import { describe, expect, test } from 'vitest';
import type { Config } from '../../src/config/config.ts';
import { failure } from '../../src/main/failure.ts';

const LMSTUDIO: Config = {
    provider: 'lmstudio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'lm-studio',
    model: 'test-model',
    reasoningEffort: 'none',
    skillsPath: undefined,
    maxSteps: 30,
    fileTools: 'write-edit',
    logFormat: 'json',
    workDir: '/',
};

const OPENAI: Config = {
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    reasoningEffort: 'low',
    skillsPath: undefined,
    maxSteps: 30,
    fileTools: 'write-edit',
    logFormat: 'json',
    workDir: '/',
};

const ANTHROPIC: Config = {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
    model: 'claude-test',
    reasoningEffort: 'medium',
    maxOutputTokens: 4096,
    workspaceId: undefined,
    skillsPath: undefined,
    maxSteps: 30,
    fileTools: 'write-edit',
    logFormat: 'json',
    workDir: '/',
};

const stats = {
    number: 1,
    providerStats: {
        provider: 'openai' as const,
        usage: { kind: 'unavailable' as const },
        rateLimits: {},
    },
    seconds: 1,
};

const modelCallFailed = (error: ModelCallError, config: Config = OPENAI): string => {
    return failure({ kind: 'model_call_failed', error, stats }, config);
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
            'The model server at https://api.example.com/v1 rejected the request (400 unknown model). Check that MODEL, MODEL_REASONING_EFFORT and any MODEL_MAX_OUTPUT_TOKENS suit it.',
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

    test("an incomplete Claude reply names Claude's output-token limit", () => {
        const error: ModelCallError = {
            kind: 'incomplete',
            detail: 'the response is incomplete: max_tokens',
        };

        expect(modelCallFailed(error, ANTHROPIC)).toBe(
            'The model stopped before finishing its reply (the response is incomplete: max_tokens). Try a narrower task, or, if it stopped at max_tokens, raise MODEL_MAX_OUTPUT_TOKENS from 4096.',
        );
    });

    test('another unreachable provider', () => {
        expect(modelCallFailed({ kind: 'unreachable', detail: 'Connection error.' })).toBe(
            "Can't reach https://api.example.com/v1 (Connection error.). Check MODEL_BASE_URL.",
        );
    });

    test('a rejected key', () => {
        expect(modelCallFailed({ kind: 'auth', status: 403, detail: '403 forbidden' })).toBe(
            'https://api.example.com/v1 rejected the API key (HTTP 403). Check MODEL_API_KEY. (403 forbidden)',
        );
    });

    test("the step limit counts the session's own steps", () => {
        const stepStats = { ...stats, number: 3 };

        expect(failure({ kind: 'step_limit', stats: stepStats }, OPENAI)).toBe(
            "The model didn't answer within 3 steps: it was still calling tools. Try a narrower task, or raise MAX_STEPS.",
        );
    });

    test('no answer', () => {
        expect(failure({ kind: 'empty', stats }, OPENAI)).toBe(
            'The model gave no answer: its reply had neither text nor tool calls. Try again, or rephrase the task.',
        );
    });

    test("a history the SDK can't replay", () => {
        expect(failure({ kind: 'history', error: 'Unsupported item type: made_up' }, OPENAI)).toBe(
            "The conversation can't be continued (Unsupported item type: made_up). Check the history and provider, or try updating the provider SDK.",
        );
    });
});
