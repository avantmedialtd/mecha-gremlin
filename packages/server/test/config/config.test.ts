import { describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/config.ts';

describe('loadConfig', () => {
    test('defaults to a local LM Studio with nothing set', () => {
        expect(loadConfig({})).toEqual({
            ok: true,
            value: {
                provider: 'lmstudio',
                baseUrl: 'http://127.0.0.1:1234/v1',
                apiKey: 'lm-studio',
                model: undefined,
                reasoningEffort: 'none',
            },
        });
    });

    test('blank values count as unset', () => {
        expect(loadConfig({ MODEL: '  ', MODEL_API_KEY: '' })).toMatchObject({
            ok: true,
            value: { model: undefined, apiKey: 'lm-studio' },
        });
    });

    test('trailing slashes on the base URL are removed', () => {
        expect(loadConfig({ MODEL_BASE_URL: 'http://studio.local:1234/v1//' })).toMatchObject({
            ok: true,
            value: { baseUrl: 'http://studio.local:1234/v1' },
        });
    });

    test('model, key and reasoning effort are passed through', () => {
        expect(
            loadConfig({
                MODEL: 'prism-ml/bonsai-27b',
                MODEL_API_KEY: 'sk-lm-secret',
                MODEL_REASONING_EFFORT: 'low',
            }),
        ).toMatchObject({
            ok: true,
            value: {
                model: 'prism-ml/bonsai-27b',
                apiKey: 'sk-lm-secret',
                reasoningEffort: 'low',
            },
        });
    });

    test('the openai provider has its own defaults and leaves reasoning to the model', () => {
        expect(
            loadConfig({ MODEL_PROVIDER: 'openai', MODEL_API_KEY: 'sk-test', MODEL: 'gpt-test' }),
        ).toEqual({
            ok: true,
            value: {
                provider: 'openai',
                baseUrl: 'https://api.openai.com/v1',
                apiKey: 'sk-test',
                model: 'gpt-test',
                reasoningEffort: undefined,
            },
        });
    });

    test('any other provider may use a base URL without a path', () => {
        expect(
            loadConfig({
                MODEL_PROVIDER: 'openai',
                MODEL_BASE_URL: 'https://models.example.com',
                MODEL_API_KEY: 'sk-test',
                MODEL: 'gpt-test',
            }),
        ).toMatchObject({ ok: true, value: { baseUrl: 'https://models.example.com' } });
    });

    test('the openai provider needs MODEL_API_KEY and MODEL', () => {
        expect(loadConfig({ MODEL_PROVIDER: 'openai' })).toEqual({
            ok: false,
            error: [
                expect.stringContaining('MODEL_API_KEY is required'),
                expect.stringContaining('MODEL is required'),
            ],
        });
    });

    test.each([
        [{ MODEL: 'gpt-test' }, 'MODEL_API_KEY is required'],
        [{ MODEL_API_KEY: 'sk-test' }, 'MODEL is required'],
    ])('the openai provider fails with only %j set', (env, problem) => {
        expect(loadConfig({ MODEL_PROVIDER: 'openai', ...env })).toEqual({
            ok: false,
            error: [expect.stringContaining(problem)],
        });
    });

    test('rejects an unknown provider, listing the known ones', () => {
        expect(loadConfig({ MODEL_PROVIDER: 'anthropic' })).toEqual({
            ok: false,
            error: ['MODEL_PROVIDER must be one of lmstudio, openai; got "anthropic".'],
        });
    });

    test.each([
        'not a url',
        'ftp://127.0.0.1:1234/v1',
        'http://127.0.0.1:1234/v1?x=1',
        'http://127.0.0.1:1234/v1#top',
    ])('rejects MODEL_BASE_URL=%s', (value) => {
        expect(loadConfig({ MODEL_BASE_URL: value })).toEqual({
            ok: false,
            error: [expect.stringContaining('MODEL_BASE_URL')],
        });
    });

    test("explains that LM Studio's base URL ends in /v1", () => {
        expect(loadConfig({ MODEL_BASE_URL: 'http://127.0.0.1:1234' })).toEqual({
            ok: false,
            error: [expect.stringContaining('ends in /v1')],
        });
    });

    test('rejects an unknown reasoning effort, listing the known ones', () => {
        expect(loadConfig({ MODEL_REASONING_EFFORT: 'extreme' })).toEqual({
            ok: false,
            error: [
                'MODEL_REASONING_EFFORT must be one of none, minimal, low, medium, high, xhigh, max; got "extreme".',
            ],
        });
    });

    test('reports every invalid variable at once', () => {
        expect(loadConfig({ MODEL_BASE_URL: 'nope', MODEL_REASONING_EFFORT: 'extreme' })).toEqual({
            ok: false,
            error: [
                expect.stringContaining('MODEL_BASE_URL'),
                expect.stringContaining('MODEL_REASONING_EFFORT'),
            ],
        });
    });
});
