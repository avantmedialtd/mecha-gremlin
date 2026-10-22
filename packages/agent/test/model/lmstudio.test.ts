import { describe, expect, test, vi } from 'vitest';
import type { Config } from '../../src/config/config.ts';
import { fetchModels, pickModel } from '../../src/model/lmstudio.ts';

type Entry = {
    readonly key: string;
    readonly type?: string;
    readonly instances?: readonly string[];
};

const config: Config = {
    provider: 'lmstudio',
    baseUrl: 'http://lmstudio.test:1234/v1',
    apiKey: 'test-key',
    model: undefined,
    reasoningEffort: 'none',
    skillsPath: undefined,
    maxSteps: 30,
    fileTools: 'write-edit',
};

/** A `/api/v1/models` payload, shaped like LM Studio 0.4's. */
const modelsPayload = (...entries: readonly Entry[]) => {
    return {
        models: entries.map(({ key, type = 'llm', instances = [] }) => ({
            type,
            key,
            display_name: key,
            loaded_instances: instances.map((id) => ({
                id,
                config: { context_length: 8192, parallel: 4 },
            })),
        })),
    };
};

describe('pickModel', () => {
    test('uses the one loaded model', () => {
        const payload = modelsPayload(
            { key: 'qwen2.5-0.5b-instruct-mlx' },
            { key: 'prism-ml/bonsai-27b', instances: ['prism-ml/bonsai-27b'] },
        );

        expect(pickModel(payload)).toEqual({ ok: true, value: { model: 'prism-ml/bonsai-27b' } });
    });

    test('uses the first of several and says so', () => {
        const payload = modelsPayload(
            { key: 'a', instances: ['a'] },
            { key: 'b', instances: ['b'] },
        );
        const choice = pickModel(payload);

        expect(choice).toMatchObject({
            ok: true,
            value: { model: 'a', note: expect.stringContaining('first of 2') },
        });
        expect(choice).toMatchObject({ value: { note: expect.stringContaining('Set MODEL') } });
    });

    test('accepts a configured instance id or model key that is loaded', () => {
        const payload = modelsPayload(
            { key: 'b', instances: ['b'] },
            { key: 'qwen3', instances: ['qwen3:1', 'qwen3:2'] },
        );

        expect(pickModel(payload, 'qwen3:2')).toEqual({ ok: true, value: { model: 'qwen3:2' } });
        expect(pickModel(payload, 'qwen3')).toEqual({ ok: true, value: { model: 'qwen3' } });
    });

    test('rejects a configured model that is not loaded, listing what is', () => {
        const payload = modelsPayload(
            { key: 'a', instances: ['a'] },
            { key: 'c', instances: ['c'] },
            { key: 'b' },
        );
        const choice = pickModel(payload, 'b');

        expect(choice).toMatchObject({
            ok: false,
            error: expect.stringContaining('Loaded: a, c.'),
        });
        expect(choice).toMatchObject({ error: expect.stringContaining('lms load b') });
    });

    test('rejects a configured model when nothing is loaded', () => {
        expect(pickModel(modelsPayload({ key: 'a' }), 'a')).toEqual({
            ok: false,
            error: 'MODEL is "a", but that model isn\'t loaded in LM Studio. No model is loaded. Load it with `lms load a`.',
        });
    });

    test('fails when no model is loaded', () => {
        const choice = pickModel(modelsPayload({ key: 'a' }, { key: 'b' }));

        expect(choice).toMatchObject({
            ok: false,
            error: expect.stringContaining('lms load <model>'),
        });
    });

    test('ignores loaded embedding models', () => {
        const payload = modelsPayload({
            key: 'nomic-embed',
            type: 'embedding',
            instances: ['nomic-embed'],
        });
        const choice = pickModel(payload);

        expect(choice).toMatchObject({
            ok: false,
            error: expect.stringContaining('No model is loaded'),
        });
    });

    test('an LLM without loaded_instances is not loaded', () => {
        expect(pickModel({ models: [{ type: 'llm', key: 'a' }] })).toMatchObject({
            ok: false,
            error: expect.stringContaining('No model is loaded'),
        });
    });

    test('skips loaded instances without a string id', () => {
        const payload = {
            models: [{ type: 'llm', key: 'a', loaded_instances: [{ id: 1 }, null, { id: 'a:2' }] }],
        };

        expect(pickModel(payload)).toEqual({ ok: true, value: { model: 'a:2' } });
    });

    // Each case is wrapped in its own row: test.each spreads array rows into arguments.
    test.each([
        [undefined],
        [null],
        [[]],
        [{ data: [] }],
        [{ models: [null] }],
        [{ models: [{ key: 1 }] }],
        [{ models: [{ key: 1, type: 'llm' }] }],
        [{ models: [{ key: 'a' }] }],
        [{ models: [{ key: 'a', type: 'llm', loaded_instances: {} }] }],
    ])('reports an unexpected payload shape: %j', (payload: unknown) => {
        expect(pickModel(payload)).toMatchObject({
            ok: false,
            error: expect.stringContaining('unexpected shape'),
        });
    });
});

/** `fetchModels`, with the global `fetch` faked by `fake`. */
const fetchModelsWith = (
    fake: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) => {
    vi.stubGlobal('fetch', fake);

    return fetchModels(config);
};

describe('fetchModels', () => {
    test('calls the native models endpoint with the bearer token', async () => {
        const seen: { readonly url: string; readonly auth: string | null }[] = [];
        const result = await fetchModelsWith(async (input, init) => {
            seen.push({
                url: input instanceof Request ? input.url : String(input),
                auth: new Headers(init?.headers).get('authorization'),
            });

            return Response.json(modelsPayload());
        });

        expect(result.ok).toBe(true);
        expect(seen).toEqual([
            { url: 'http://lmstudio.test:1234/api/v1/models', auth: 'Bearer test-key' },
        ]);
    });

    test('explains an unreachable server', async () => {
        const result = await fetchModelsWith(async () => {
            throw new TypeError('Unable to connect');
        });

        expect(result).toMatchObject({
            ok: false,
            error: expect.stringContaining('http://lmstudio.test:1234'),
        });
        expect(result).toMatchObject({ error: expect.stringContaining('lms server start') });
    });

    test.each([401, 403])('explains a rejected token (HTTP %d)', async (status) => {
        const result = await fetchModelsWith(async () => new Response('denied', { status }));

        expect(result).toMatchObject({
            ok: false,
            error: expect.stringContaining('MODEL_API_KEY'),
        });
    });

    test('reports any other HTTP error', async () => {
        const result = await fetchModelsWith(async () => new Response('nope', { status: 404 }));

        expect(result).toEqual({
            ok: false,
            error: 'LM Studio answered HTTP 404 for http://lmstudio.test:1234/api/v1/models.',
        });
    });

    test('reports a body that is not JSON', async () => {
        const result = await fetchModelsWith(async () => new Response('<html>', { status: 200 }));

        expect(result).toMatchObject({
            ok: false,
            error: expect.stringContaining("didn't return JSON"),
        });
    });
});
