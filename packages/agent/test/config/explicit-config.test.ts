import { realpathSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadConfig, loadLogFormat } from '../../src/config/config.ts';
import { parseArgs } from '../../src/main/args.ts';
import { pickModel } from '../../src/model/lmstudio.ts';

const common = {
    MODEL_BASE_URL: 'https://models.example.com/v1/',
    MODEL_API_KEY: 'test-key',
    MODEL: 'test-model',
    MODEL_REASONING_EFFORT: 'medium',
    MAX_STEPS: '3',
    FILE_TOOLS: 'write-edit',
    LOG_FORMAT: 'json',
    WORK_DIR: '.',
};

describe('explicit configuration', () => {
    test('reports all independently checkable missing values', () => {
        const result = loadConfig({});

        expect(result.ok).toBe(false);

        if (result.ok) {
            throw new Error('configuration unexpectedly succeeded');
        }

        for (const name of [
            'MODEL_PROVIDER',
            'MODEL_BASE_URL',
            'MODEL_API_KEY',
            'MODEL',
            'MODEL_REASONING_EFFORT',
            'MAX_STEPS',
            'FILE_TOOLS',
            'LOG_FORMAT',
            'WORK_DIR',
        ]) {
            expect(result.error.some((message) => message.includes(name))).toBe(true);
        }
    });

    test.each(['lmstudio', 'openai'] as const)('accepts explicit %s settings', (provider) => {
        expect(loadConfig({ ...common, MODEL_PROVIDER: provider })).toMatchObject({
            ok: true,
            value: {
                provider,
                baseUrl: 'https://models.example.com/v1',
                model: 'test-model',
                workDir: realpathSync('.'),
            },
        });
    });

    test('accepts Anthropic settings and preserves its workspace', () => {
        expect(
            loadConfig({
                ...common,
                MODEL_PROVIDER: 'anthropic',
                MODEL_MAX_OUTPUT_TOKENS: '4096',
                ANTHROPIC_WORKSPACE_ID: ' ws_1 ',
            }),
        ).toMatchObject({
            ok: true,
            value: {
                provider: 'anthropic',
                reasoningEffort: 'medium',
                maxOutputTokens: 4096,
                workspaceId: 'ws_1',
            },
        });
    });

    test.each(['', '0', '-1', '2.5', '1e3', '9007199254740992'])(
        'rejects Anthropic output limit %j',
        (limit) => {
            const result = loadConfig({
                ...common,
                MODEL_PROVIDER: 'anthropic',
                MODEL_MAX_OUTPUT_TOKENS: limit,
            });

            expect(result.ok).toBe(false);

            if (result.ok) {
                throw new Error('configuration unexpectedly succeeded');
            }

            expect(result.error.join(' ')).toContain('MODEL_MAX_OUTPUT_TOKENS');
        },
    );

    test.each(['none', 'minimal'])('rejects Anthropic effort %s', (effort) => {
        expect(
            loadConfig({
                ...common,
                MODEL_PROVIDER: 'anthropic',
                MODEL_MAX_OUTPUT_TOKENS: '4096',
                MODEL_REASONING_EFFORT: effort,
            }),
        ).toMatchObject({ ok: false, error: [expect.stringContaining('MODEL_REASONING_EFFORT')] });
    });

    test('rejects a Responses output limit rather than ignoring it', () => {
        expect(
            loadConfig({ ...common, MODEL_PROVIDER: 'openai', MODEL_MAX_OUTPUT_TOKENS: '4096' }),
        ).toMatchObject({ ok: false, error: [expect.stringContaining('MODEL_MAX_OUTPUT_TOKENS')] });
    });

    test('reports errors even when the provider and log format are invalid', () => {
        const result = loadConfig({
            ...common,
            MODEL_PROVIDER: 'nope',
            LOG_FORMAT: 'xml',
            MAX_STEPS: '0',
            WORK_DIR: './does-not-exist',
        });

        expect(result.ok).toBe(false);

        if (result.ok) {
            throw new Error('configuration unexpectedly succeeded');
        }

        for (const name of ['MODEL_PROVIDER', 'LOG_FORMAT', 'MAX_STEPS', 'WORK_DIR']) {
            expect(result.error.some((message) => message.includes(name))).toBe(true);
        }

        expect(loadLogFormat({ LOG_FORMAT: 'xml' })).toBeUndefined();
        expect(loadLogFormat({})).toBeUndefined();
    });

    test('rejects MAX_TURNS even when it is blank', () => {
        expect(loadConfig({ ...common, MODEL_PROVIDER: 'openai', MAX_TURNS: '' })).toMatchObject({
            ok: false,
            error: [expect.stringContaining('MAX_TURNS')],
        });
    });

    test('requires an actual task', () => {
        expect(parseArgs([])).toMatchObject({ ok: false, error: expect.stringContaining('task') });
        expect(parseArgs([' ', '  '])).toMatchObject({ ok: false });
        expect(parseArgs(['What', 'runs?'])).toEqual({ ok: true, value: 'What runs?' });
    });

    test('never selects an unnamed LM Studio model', () => {
        const models = {
            models: [{ type: 'llm', key: 'test-model', loaded_instances: [{ id: 'instance' }] }],
        };

        expect(pickModel(models)).toMatchObject({
            ok: false,
            error: expect.stringContaining('MODEL'),
        });
        expect(pickModel(models, 'test-model')).toMatchObject({
            ok: true,
            value: { model: 'test-model' },
        });
        expect(pickModel(models, 'instance')).toMatchObject({
            ok: true,
            value: { model: 'instance' },
        });
        expect(pickModel(models, 'other')).toMatchObject({
            ok: false,
            error: expect.stringContaining('lms load other'),
        });
    });
});
