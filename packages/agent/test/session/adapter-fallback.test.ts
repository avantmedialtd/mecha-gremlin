import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '../../src/config/config.ts';

const state = vi.hoisted(() => ({ failHistory: false }));

vi.mock('../../src/model/anthropic-call.ts', () => ({
    createAnthropicAdapter: () => ({
        provider: 'anthropic',
        validateHistory: () =>
            state.failHistory
                ? { ok: false, error: 'history cannot be replayed' }
                : { ok: true, value: undefined },
        call: async () => ({ ok: false, error: { kind: 'fatal', detail: 'adapter failed' } }),
    }),
}));

import { createSession } from '../../src/session/session.ts';

beforeEach(() => {
    state.failHistory = false;
});

describe('session adapter failures', () => {
    test('exposes unavailable provider statistics if the adapter has none', async () => {
        const config: Config = {
            provider: 'anthropic',
            baseUrl: 'https://claude.test',
            apiKey: 'key',
            model: 'model',
            reasoningEffort: 'medium',
            maxOutputTokens: 100,
            workspaceId: undefined,
            skillsPath: undefined,
            maxSteps: 2,
            fileTools: 'write-edit',
            logFormat: 'json',
            workDir: '/',
        };
        const created = await createSession(config, { tools: [], history: [], maxSteps: 1 });

        if (!created.ok) {
            throw new Error(created.error);
        }

        expect((await created.value.steps.next()).value).toMatchObject({
            kind: 'model_call_failed',
            error: { kind: 'fatal', detail: 'adapter failed' },
            stats: {
                number: 1,
                providerStats: {
                    provider: 'anthropic',
                    usage: { kind: 'unavailable' },
                    rateLimits: {},
                },
            },
        });
    });

    test('stops before a model call if history fails validation after session creation', async () => {
        const config: Config = {
            provider: 'anthropic',
            baseUrl: 'https://claude.test',
            apiKey: 'key',
            model: 'model',
            reasoningEffort: 'medium',
            maxOutputTokens: 100,
            workspaceId: undefined,
            skillsPath: undefined,
            maxSteps: 2,
            fileTools: 'write-edit',
            logFormat: 'json',
            workDir: '/',
        };
        const created = await createSession(config, { tools: [], history: [], maxSteps: 1 });

        if (!created.ok) {
            throw new Error(created.error);
        }

        state.failHistory = true;

        expect((await created.value.steps.next()).value).toEqual({
            kind: 'history',
            error: 'history cannot be replayed',
        });
        expect((await created.value.steps.next()).done).toBe(true);
    });
});
