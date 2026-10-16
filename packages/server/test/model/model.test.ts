import { describe, expect, test } from 'vitest';
import type { Config } from '../../src/config/config.ts';
import { keyRejected, resolveModel, unreachable } from '../../src/model/model.ts';

const OPENAI: Config = {
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    reasoningEffort: undefined,
    skillsPath: undefined,
    maxTurns: 30,
};

describe('resolveModel', () => {
    test('uses MODEL with any provider but LM Studio', async () => {
        expect(await resolveModel(OPENAI)).toEqual({ ok: true, value: { model: 'gpt-test' } });
    });

    // loadConfig already requires MODEL here, but resolveModel doesn't count on it.
    test('fails without MODEL with any provider but LM Studio', async () => {
        expect(await resolveModel({ ...OPENAI, model: undefined })).toEqual({
            ok: false,
            error: 'MODEL is required with MODEL_PROVIDER=openai.',
        });
    });
});

describe('keyRejected', () => {
    test("points at LM Studio's own setting", () => {
        expect(keyRejected({ ...OPENAI, provider: 'lmstudio' }, 401)).toBe(
            'LM Studio rejected the API key (HTTP 401). Its "Require Authentication" setting is on, so set MODEL_API_KEY to one of its tokens.',
        );
    });

    test('names the base URL with any other provider', () => {
        expect(keyRejected(OPENAI, 403)).toBe(
            'https://api.example.com/v1 rejected the API key (HTTP 403). Check MODEL_API_KEY.',
        );
    });
});

describe('unreachable', () => {
    test("suggests starting LM Studio's server", () => {
        expect(unreachable({ ...OPENAI, provider: 'lmstudio' }, 'Connection error.')).toBe(
            "Can't reach LM Studio at https://api.example.com/v1 (Connection error.). Is its server running? Start it with `lms server start`, or set MODEL_BASE_URL.",
        );
    });

    test('names the base URL with any other provider', () => {
        expect(unreachable(OPENAI, 'Connection error.')).toBe(
            "Can't reach https://api.example.com/v1 (Connection error.). Check MODEL_BASE_URL.",
        );
    });
});
