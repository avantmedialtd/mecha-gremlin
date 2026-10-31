import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import { loadConfig, loadLogFormat, loadMcpConfig } from '../../src/config/config.ts';

// A data folder of its own, outside the working directory, which is the current one.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'gremlin-data-'));

afterAll(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
});

const BASE = {
    MODEL_PROVIDER: 'lmstudio',
    MODEL_BASE_URL: 'http://localhost:1234/v1',
    MODEL_API_KEY: 'key',
    MODEL: 'model',
    MODEL_REASONING_EFFORT: 'none',
    MAX_STEPS: '30',
    FILE_TOOLS: 'write-edit',
    LOG_FORMAT: 'pretty',
    WORK_DIR: '.',
    DATA_DIR,
};

const overlapping = (data: string, work: string) => {
    return {
        ok: false,
        error: [
            `DATA_DIR must not be or contain WORK_DIR, since the file tools refuse everything in the data folder: DATA_DIR is ${data}, and WORK_DIR is ${work}.`,
        ],
    };
};

// macOS's file system ignores case by default, so a path typed in another case names the same
// directory there.
const ignoresCase = (() => {
    const probe = mkdtempSync(join(tmpdir(), 'gremlin-Case-'));

    try {
        return existsSync(probe.toLowerCase());
    } finally {
        rmSync(probe, { recursive: true, force: true });
    }
})();

describe('loadConfig', () => {
    test('Responses configuration contains no Anthropic-only fields', () => {
        const result = loadConfig(BASE);

        if (!result.ok) {
            throw new Error('configuration unexpectedly failed');
        }

        expect(result.value).not.toHaveProperty('maxOutputTokens');
        expect(result.value).not.toHaveProperty('workspaceId');
    });

    test('reports exact choice and integer diagnostics', () => {
        expect(loadConfig({ ...BASE, FILE_TOOLS: undefined })).toEqual({
            ok: false,
            error: ['FILE_TOOLS is required; choose write-edit, apply-patch.'],
        });
        expect(loadConfig({ ...BASE, MAX_STEPS: '0' })).toEqual({
            ok: false,
            error: ['MAX_STEPS must be a positive whole number in decimal digits; got "0".'],
        });
        expect(
            loadConfig({
                ...BASE,
                MODEL_PROVIDER: 'anthropic',
                MODEL_REASONING_EFFORT: 'low',
                MODEL_MAX_OUTPUT_TOKENS: '0',
            }),
        ).toEqual({
            ok: false,
            error: [
                'MODEL_MAX_OUTPUT_TOKENS must be a positive safe whole number in decimal digits; got "0".',
            ],
        });
    });

    test.each([
        'MODEL_PROVIDER',
        'MODEL_BASE_URL',
        'MODEL_API_KEY',
        'MODEL',
        'MODEL_REASONING_EFFORT',
        'MAX_STEPS',
        'FILE_TOOLS',
        'LOG_FORMAT',
        'WORK_DIR',
        'DATA_DIR',
    ] as const)('requires %s and treats blanks as unset', (name) => {
        for (const value of [undefined, '', '   ']) {
            const result = loadConfig({ ...BASE, [name]: value });

            expect(result.ok).toBe(false);

            if (result.ok) {
                throw new Error('configuration unexpectedly succeeded');
            }

            expect(result.error.some((problem) => problem.includes(name))).toBe(true);
        }
    });

    test('trims settings and removes trailing slashes', () => {
        expect(
            loadConfig({
                ...BASE,
                MODEL_BASE_URL: ' http://localhost:1234/v1// ',
                MODEL_API_KEY: ' key ',
                MODEL: ' model ',
                MODEL_REASONING_EFFORT: ' low ',
                SKILLS_PATH: ' /skills:relative ',
            }),
        ).toMatchObject({
            ok: true,
            value: {
                baseUrl: 'http://localhost:1234/v1',
                apiKey: 'key',
                model: 'model',
                reasoningEffort: 'low',
                skillsPath: '/skills:relative',
            },
        });
        expect(loadConfig({ ...BASE, SKILLS_PATH: '  ' })).toMatchObject({
            ok: true,
            value: { skillsPath: undefined },
        });
    });

    test.each([
        'not a url',
        'ftp://localhost/v1',
        'http://localhost/v1?x=1',
        'http://localhost/v1#part',
        'http://localhost/v1?',
        'http://localhost/v1#',
    ])('rejects MODEL_BASE_URL=%j', (url) => {
        expect(loadConfig({ ...BASE, MODEL_BASE_URL: url })).toMatchObject({
            ok: false,
            error: [expect.stringContaining('MODEL_BASE_URL')],
        });
    });

    test('the base-URL errors give the value they reject', () => {
        expect(loadConfig({ ...BASE, MODEL_BASE_URL: 'localhost:1234/v1' })).toEqual({
            ok: false,
            error: [
                'MODEL_BASE_URL must be an HTTP(S) URL without a query or fragment; got "localhost:1234/v1".',
            ],
        });
        expect(loadConfig({ ...BASE, MODEL_BASE_URL: 'http://localhost:1234/' })).toEqual({
            ok: false,
            error: [
                'MODEL_BASE_URL is LM Studio\'s OpenAI-compatible URL and must have a path such as /v1; got "http://localhost:1234".',
            ],
        });
    });

    test("takes no path on the Claude API's own origin, but takes a proxy's prefix", () => {
        const anthropic = {
            ...BASE,
            MODEL_PROVIDER: 'anthropic',
            MODEL_REASONING_EFFORT: 'medium',
            MODEL_MAX_OUTPUT_TOKENS: '4096',
        };

        expect(
            loadConfig({ ...anthropic, MODEL_BASE_URL: 'https://api.anthropic.com/v1/' }),
        ).toEqual({
            ok: false,
            error: [
                'MODEL_BASE_URL for the Claude API is https://api.anthropic.com, without a path: the SDK adds /v1/messages itself; got "https://api.anthropic.com/v1".',
            ],
        });
        expect(
            loadConfig({ ...anthropic, MODEL_BASE_URL: 'https://gateway.example/v1' }),
        ).toMatchObject({ ok: true, value: { baseUrl: 'https://gateway.example/v1' } });
    });

    test('requires a path for LM Studio but accepts an Anthropic origin', () => {
        expect(loadConfig({ ...BASE, MODEL_BASE_URL: 'http://localhost:1234' })).toMatchObject({
            ok: false,
            error: [expect.stringContaining('/v1')],
        });
        expect(
            loadConfig({
                ...BASE,
                MODEL_PROVIDER: 'anthropic',
                MODEL_BASE_URL: 'https://api.anthropic.com',
                MODEL_REASONING_EFFORT: 'medium',
                MODEL_MAX_OUTPUT_TOKENS: '4096',
            }),
        ).toMatchObject({ ok: true, value: { baseUrl: 'https://api.anthropic.com' } });
    });

    test.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
        'accepts Responses effort %s',
        (effort) => {
            expect(
                loadConfig({ ...BASE, MODEL_PROVIDER: 'openai', MODEL_REASONING_EFFORT: effort }),
            ).toMatchObject({ ok: true, value: { reasoningEffort: effort } });
        },
    );

    test.each(['low', 'medium', 'high', 'xhigh', 'max'])(
        'accepts Anthropic effort %s',
        (effort) => {
            expect(
                loadConfig({
                    ...BASE,
                    MODEL_PROVIDER: 'anthropic',
                    MODEL_REASONING_EFFORT: effort,
                    MODEL_MAX_OUTPUT_TOKENS: '4096',
                }),
            ).toMatchObject({ ok: true, value: { reasoningEffort: effort } });
        },
    );

    test.each(['extreme', 'NONE'])('rejects unsupported effort %j', (effort) => {
        expect(loadConfig({ ...BASE, MODEL_REASONING_EFFORT: effort })).toMatchObject({
            ok: false,
            error: [expect.stringContaining('MODEL_REASONING_EFFORT')],
        });
    });

    test.each([
        ['1', 1],
        ['007', 7],
        [' 5 ', 5],
    ])('accepts MAX_STEPS=%j', (raw, steps) => {
        expect(loadConfig({ ...BASE, MAX_STEPS: raw })).toMatchObject({
            ok: true,
            value: { maxSteps: steps },
        });
    });

    test.each(['0', '-1', '2.5', 'lots', '+12', '1e3', '0x10', '2.0'])(
        'rejects MAX_STEPS=%j',
        (raw) => {
            expect(loadConfig({ ...BASE, MAX_STEPS: raw })).toMatchObject({
                ok: false,
                error: [expect.stringContaining('MAX_STEPS')],
            });
        },
    );

    test.each(['write-edit', 'apply-patch'])('accepts file tools %s', (value) => {
        expect(loadConfig({ ...BASE, FILE_TOOLS: value })).toMatchObject({
            ok: true,
            value: { fileTools: value },
        });
    });

    test.each(['both', 'edit', 'apply_patch', 'APPLY-PATCH'])('rejects file tools %j', (value) => {
        expect(loadConfig({ ...BASE, FILE_TOOLS: value })).toMatchObject({
            ok: false,
            error: [expect.stringContaining('FILE_TOOLS')],
        });
    });

    test('reports unrelated errors with an unknown provider and a former setting', () => {
        const result = loadConfig({
            ...BASE,
            MODEL_PROVIDER: 'unknown',
            MAX_STEPS: '0',
            FILE_TOOLS: 'both',
            MAX_TURNS: '',
            DATA_DIR: '.',
        });

        expect(result.ok).toBe(false);

        if (result.ok) {
            throw new Error('configuration unexpectedly succeeded');
        }

        for (const name of [
            'MODEL_PROVIDER',
            'MAX_STEPS',
            'FILE_TOOLS',
            'MAX_TURNS',
            'must not be or contain WORK_DIR',
        ]) {
            expect(result.error.some((problem) => problem.includes(name))).toBe(true);
        }
    });

    test('uses the real path of WORK_DIR and rejects files', () => {
        const root = mkdtempSync(join(tmpdir(), 'gremlin-config-'));

        try {
            symlinkSync(root, `${root}-link`);
            writeFileSync(join(root, 'file'), 'x');

            expect(loadConfig({ ...BASE, WORK_DIR: `${root}-link` })).toMatchObject({
                ok: true,
                value: { workDir: realpathSync(root) },
            });
            expect(loadConfig({ ...BASE, WORK_DIR: join(root, 'file') })).toMatchObject({
                ok: false,
                error: [expect.stringContaining('WORK_DIR')],
            });
        } finally {
            rmSync(`${root}-link`);
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('uses the real path of DATA_DIR and rejects files and missing paths', () => {
        const root = mkdtempSync(join(tmpdir(), 'gremlin-config-'));

        try {
            symlinkSync(root, `${root}-link`);
            writeFileSync(join(root, 'file'), 'x');

            expect(loadConfig({ ...BASE, DATA_DIR: `${root}-link` })).toMatchObject({
                ok: true,
                value: { dataDir: realpathSync(root) },
            });
            expect(loadConfig({ ...BASE, DATA_DIR: join(root, 'file') })).toEqual({
                ok: false,
                error: [
                    `DATA_DIR must name an existing directory; ${join(root, 'file')} isn't one.`,
                ],
            });
            expect(loadConfig({ ...BASE, DATA_DIR: join(root, 'missing') })).toEqual({
                ok: false,
                error: [
                    `DATA_DIR must name an existing directory; ${join(root, 'missing')} isn't one.`,
                ],
            });
        } finally {
            rmSync(`${root}-link`);
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('a relative DATA_DIR resolves against the current directory', () => {
        const root = mkdtempSync(join(tmpdir(), 'gremlin-config-'));
        mkdirSync(join(root, 'data'));
        vi.spyOn(process, 'cwd').mockReturnValue(root);

        try {
            expect(loadConfig({ ...BASE, DATA_DIR: 'data' })).toMatchObject({
                ok: true,
                value: { workDir: realpathSync(root), dataDir: join(realpathSync(root), 'data') },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('DATA_DIR must not be the working directory, nor contain it', () => {
        const root = realpathSync(mkdtempSync(join(tmpdir(), 'gremlin-config-')));
        mkdirSync(join(root, 'work'));
        mkdirSync(join(root, 'work', 'data'));
        mkdirSync(join(root, 'data'));
        mkdirSync(join(root, 'work-data'));
        const work = join(root, 'work');

        try {
            expect(loadConfig({ ...BASE, WORK_DIR: work, DATA_DIR: work })).toEqual(
                overlapping(work, work),
            );
            expect(loadConfig({ ...BASE, WORK_DIR: work, DATA_DIR: root })).toEqual(
                overlapping(root, work),
            );
            // The tools refuse a data folder inside the working directory themselves.
            expect(
                loadConfig({ ...BASE, WORK_DIR: work, DATA_DIR: join(work, 'data') }),
            ).toMatchObject({ ok: true, value: { workDir: work, dataDir: join(work, 'data') } });
            expect(
                loadConfig({ ...BASE, WORK_DIR: work, DATA_DIR: join(root, 'data') }),
            ).toMatchObject({
                ok: true,
            });
            expect(
                loadConfig({ ...BASE, WORK_DIR: work, DATA_DIR: join(root, 'work-data') }),
            ).toMatchObject({ ok: true });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test('an invalid working directory or data folder is reported alone', () => {
        expect(loadConfig({ ...BASE, WORK_DIR: 'missing' })).toEqual({
            ok: false,
            error: [
                `WORK_DIR must name an existing directory; ${join(process.cwd(), 'missing')} isn't one.`,
            ],
        });
        expect(loadConfig({ ...BASE, DATA_DIR: undefined })).toEqual({
            ok: false,
            error: ['DATA_DIR is required.'],
        });
    });

    // Node's own realpathSync keeps the case a path was typed in; pwd prints the directory's.
    test.runIf(ignoresCase)('spells WORK_DIR as its directory is named on disk', () => {
        const root = mkdtempSync(join(tmpdir(), 'gremlin-config-'));

        try {
            mkdirSync(join(root, 'Notes'));

            expect(loadConfig({ ...BASE, WORK_DIR: join(root, 'notes') })).toMatchObject({
                ok: true,
                value: { workDir: join(realpathSync.native(root), 'Notes') },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('loadLogFormat', () => {
    test.each([
        ['pretty', 'pretty'],
        ['json', 'json'],
        [' json ', 'json'],
    ] as const)('%j selects %s', (raw, format) => {
        expect(loadLogFormat({ LOG_FORMAT: raw })).toBe(format);
    });

    test.each([undefined, '', '  ', 'JSON', 'xml'])('has no format for %j', (raw) => {
        expect(loadLogFormat({ LOG_FORMAT: raw })).toBeUndefined();
    });
});

describe('loadMcpConfig', () => {
    test('DATA_DIR alone, trimmed, without any other setting', () => {
        expect(loadMcpConfig({ DATA_DIR: ` ${DATA_DIR} ` })).toStrictEqual({
            ok: true,
            value: { dataDir: realpathSync.native(DATA_DIR) },
        });
    });

    test('LOG_FORMAT is not read', () => {
        expect(loadMcpConfig({ LOG_FORMAT: 'xml', DATA_DIR })).toStrictEqual({
            ok: true,
            value: { dataDir: realpathSync.native(DATA_DIR) },
        });
    });

    test("checks DATA_DIR as the agent's DATA_DIR is checked", () => {
        expect(loadMcpConfig({ DATA_DIR: join(DATA_DIR, 'missing') })).toEqual({
            ok: false,
            error: [
                `DATA_DIR must name an existing directory; ${join(DATA_DIR, 'missing')} isn't one.`,
            ],
        });
        expect(loadMcpConfig({})).toEqual({ ok: false, error: ['DATA_DIR is required.'] });
        expect(loadMcpConfig({ DATA_DIR: '  ' })).toEqual({
            ok: false,
            error: ['DATA_DIR is required.'],
        });
    });
});
