import { describe, expect, test } from 'vitest';
import { loadConfig, loadLogFormat, loadWorkDir } from '../../src/config/config.ts';

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
                skillsPath: undefined,
                maxSteps: 30,
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
                skillsPath: undefined,
                maxSteps: 30,
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
        expect(
            loadConfig({
                MODEL_BASE_URL: 'nope',
                MODEL_REASONING_EFFORT: 'extreme',
                MAX_STEPS: 'lots',
                MAX_TURNS: '5',
            }),
        ).toEqual({
            ok: false,
            error: [
                expect.stringContaining('MODEL_BASE_URL'),
                expect.stringContaining('MODEL_REASONING_EFFORT'),
                expect.stringContaining('MAX_STEPS must be'),
                'MAX_TURNS is now MAX_STEPS; rename it in your settings.',
            ],
        });
    });

    test('SKILLS_PATH is passed through, trimmed', () => {
        expect(loadConfig({ SKILLS_PATH: ' /skills:relative ' })).toMatchObject({
            ok: true,
            value: { skillsPath: '/skills:relative' },
        });
        expect(loadConfig({ SKILLS_PATH: '   ' })).toMatchObject({
            ok: true,
            value: { skillsPath: undefined },
        });
    });

    test.each([
        ['1', 1],
        ['3', 3],
        ['12', 12],
        ['007', 7],
        [' 5 ', 5],
    ])('MAX_STEPS=%j is a step limit of %d', (value, steps) => {
        expect(loadConfig({ MAX_STEPS: value })).toMatchObject({
            ok: true,
            value: { maxSteps: steps },
        });
    });

    test.each(['0', '-1', '2.5', 'lots', '+12', '1e3', '0x10', '2.0'])(
        'MAX_STEPS=%j is refused',
        (value) => {
            expect(loadConfig({ MAX_STEPS: value })).toEqual({
                ok: false,
                error: [`MAX_STEPS must be a positive whole number, such as 30; got "${value}".`],
            });
        },
    );

    test("an unknown provider doesn't hide an invalid MAX_STEPS", () => {
        expect(loadConfig({ MODEL_PROVIDER: 'anthropic', MAX_STEPS: '0' })).toEqual({
            ok: false,
            error: [
                'MODEL_PROVIDER must be one of lmstudio, openai; got "anthropic".',
                'MAX_STEPS must be a positive whole number, such as 30; got "0".',
            ],
        });
    });

    test.each([
        ['alone', { MAX_TURNS: '5' }],
        ['beside a valid MAX_STEPS', { MAX_TURNS: '5', MAX_STEPS: '12' }],
    ])('MAX_TURNS is refused, set %s', (_where, env) => {
        expect(loadConfig(env)).toEqual({
            ok: false,
            error: ['MAX_TURNS is now MAX_STEPS; rename it in your settings.'],
        });
    });

    test("an unknown provider doesn't hide MAX_TURNS", () => {
        expect(loadConfig({ MODEL_PROVIDER: 'anthropic', MAX_TURNS: '5' })).toEqual({
            ok: false,
            error: [
                'MODEL_PROVIDER must be one of lmstudio, openai; got "anthropic".',
                'MAX_TURNS is now MAX_STEPS; rename it in your settings.',
            ],
        });
    });
});

describe('loadWorkDir', () => {
    test.each([
        [undefined, undefined],
        ['', undefined],
        ['  ', undefined],
        [' ../work ', '../work'],
    ])('%j gives %j', (value, workDir) => {
        expect(loadWorkDir({ WORK_DIR: value })).toBe(workDir);
    });
});

describe('loadLogFormat', () => {
    test.each([
        [undefined, 'pretty'],
        ['', 'pretty'],
        ['  ', 'pretty'],
        ['pretty', 'pretty'],
        ['json', 'json'],
        [' json ', 'json'],
    ])('%j means %j', (value, format) => {
        expect(loadLogFormat({ LOG_FORMAT: value })).toEqual({ ok: true, value: format });
    });

    test.each(['JSON', 'xml'])('%j is refused', (value) => {
        expect(loadLogFormat({ LOG_FORMAT: value })).toEqual({
            ok: false,
            error: `LOG_FORMAT must be pretty or json; got "${value}".`,
        });
    });
});
