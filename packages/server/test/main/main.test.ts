import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResponseOutputItem, ResponseUsage } from 'openai/resources/responses/responses';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { MAX_TURNS } from '../../src/session/session.ts';
import {
    type FakeServer,
    call,
    completed,
    fakeFetch,
    httpError,
    message,
    reasoning,
    script,
} from '../fake-model.ts';

// main.ts runs as soon as it's imported, so it's never imported here at the top: `hello` fakes
// the globals it reads, then imports it afresh. Its question texts are spelled out for the same
// reason.
const DEFAULT_QUESTION = 'What exact command does the check script run? Quote it.';
const FILE_QUESTION = 'What is this file for? Answer in two or three sentences.';

/** Each test sets or clears all of these, so settings in your shell can't leak in. */
const SETTINGS = [
    'LOG_FORMAT',
    'MODEL_PROVIDER',
    'MODEL_BASE_URL',
    'MODEL_API_KEY',
    'MODEL',
    'MODEL_REASONING_EFFORT',
] as const;
type Settings = Readonly<Partial<Record<(typeof SETTINGS)[number], string>>>;

type LogRecord = {
    readonly time: string;
    readonly level: string;
    readonly message: string;
    readonly [field: string]: unknown;
};

const PACKAGE_JSON = `${JSON.stringify({ scripts: { check: 'bun run lint && bun run test' } }, null, 4)}\n`;
const MENU = 'Café crème: 3 €\n';

let cwd: string;

beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'hello-'));
    await writeFile(join(cwd, 'package.json'), PACKAGE_JSON);
    await writeFile(join(cwd, 'menu.txt'), MENU);
});

afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
});

afterEach(() => {
    process.exitCode = undefined;
});

/**
 * The log is read as JSON records, which pins every field, unless a test asks for another format.
 * The formatted output has its own tests.
 */
const hello = async (env: Settings = {}, server: FakeServer = {}, args: readonly string[] = []) => {
    const settings: Settings = { LOG_FORMAT: 'json', ...env };

    for (const name of SETTINGS) {
        vi.stubEnv(name, settings[name]);
    }

    const { fetch, requests } = fakeFetch(server);
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    // Every reading of the clock is 1.5 s after the last, so each turn takes 1.5 s.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 1500));

    const argv = process.argv;
    process.argv = [...argv.slice(0, 1), 'main.ts', ...args];
    let output = '';
    // Vitest replaces `console` in its workers, so spying on stdout itself wouldn't see the log.
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        output += `${String(line)}\n`;
    });

    try {
        // A module runs only once until the registry is reset.
        vi.resetModules();
        await import('../../src/main/main.ts');
    } finally {
        process.argv = argv;
        log.mockRestore();
    }

    const records =
        settings.LOG_FORMAT === 'json'
            ? output
                  .trim()
                  .split('\n')
                  .map((line) => JSON.parse(line) as LogRecord)
            : [];
    const turns = requests.filter((request) => request.url.endsWith('/v1/responses'));

    return { code: process.exitCode, output, records, requests, turns, turn: turns[0] };
};

const find = (records: readonly LogRecord[], wanted: string): LogRecord | undefined => {
    return records.find((record) => record.message === wanted);
};

const errors = (records: readonly LogRecord[]): string[] => {
    return records.filter((record) => record.level === 'error').map((record) => record.message);
};

const readThenAnswer: FakeServer = {
    responses: script(
        () => completed([reasoning(), call('read_file', { path: 'package.json' })]),
        () => completed([message('\n\nIt runs the checks.')]),
    ),
};

describe('Ask the model a question about a file and log the answer', () => {
    test('the default question', async () => {
        const { turn } = await hello();

        expect(turn?.body?.input).toEqual([
            { role: 'developer', content: expect.stringContaining('read_file') },
            { role: 'user', content: `File: package.json\nQuestion: ${DEFAULT_QUESTION}` },
        ]);
    });

    test('the file and question come from the arguments', async () => {
        const { turn } = await hello({}, {}, ['README.md', 'Which', 'runtime?']);

        expect(turn?.body?.input).toContainEqual({
            role: 'user',
            content: 'File: README.md\nQuestion: Which runtime?',
        });
    });

    test('a file alone gets a question about its purpose', async () => {
        const { turn } = await hello({}, {}, ['README.md']);

        expect(turn?.body?.input).toContainEqual({
            role: 'user',
            content: `File: README.md\nQuestion: ${FILE_QUESTION}`,
        });
    });

    test('the model can read files with read_file', async () => {
        const { turn } = await hello();

        expect(turn?.body?.tools).toEqual([
            expect.objectContaining({ type: 'function', name: 'read_file', strict: true }),
        ]);
    });

    test('the answer after reading the file', async () => {
        const { code, records, turns } = await hello({}, readThenAnswer);

        expect(code).toBe(0);
        expect(find(records, 'answer')).toMatchObject({
            level: 'info',
            text: 'It runs the checks.',
        });
        expect(turns).toHaveLength(2);
        expect(turns[1]?.body?.input).toContainEqual({
            type: 'function_call_output',
            call_id: 'call_1',
            output: PACKAGE_JSON,
        });
    });
});

describe('Log each tool call and turn', () => {
    test('the records of a tool round trip', async () => {
        const { records } = await hello({}, readThenAnswer);

        expect(records).toMatchObject([
            {
                level: 'info',
                message: 'asking',
                model: 'prism-ml/bonsai-27b',
                baseUrl: 'http://127.0.0.1:1234/v1',
                file: 'package.json',
                question: DEFAULT_QUESTION,
            },
            {
                level: 'info',
                message: 'turn',
                number: 1,
                inputTokens: 349,
                cachedTokens: 256,
                outputTokens: 26,
                reasoningTokens: 12,
                seconds: 1.5,
            },
            {
                level: 'info',
                message: 'tool call',
                tool: 'read_file',
                arguments: { path: 'package.json' },
            },
            {
                level: 'info',
                message: 'tool result',
                tool: 'read_file',
                bytes: Buffer.byteLength(PACKAGE_JSON),
            },
            { level: 'info', message: 'turn', number: 2 },
            { level: 'info', message: 'answer', text: 'It runs the checks.' },
        ]);
        expect(records.every((record) => !Number.isNaN(Date.parse(record.time)))).toBe(true);
    });

    test('sizes are in bytes, not characters', async () => {
        const { records } = await hello(
            {},
            {
                responses: script(
                    () => completed([call('read_file', { path: 'menu.txt' })]),
                    () => completed([message('A café crème costs 3 €.')]),
                ),
            },
        );

        expect(Buffer.byteLength(MENU)).toBeGreaterThan(MENU.length);
        expect(find(records, 'tool result')).toMatchObject({ bytes: Buffer.byteLength(MENU) });
    });

    test('a failed call is a warning carrying its error', async () => {
        const { records } = await hello(
            {},
            {
                responses: script(
                    () => completed([call('read_file', { path: '.env' })]),
                    () => completed([message("I can't read that.")]),
                ),
            },
        );

        expect(find(records, 'tool failed')).toMatchObject({
            level: 'warn',
            tool: 'read_file',
            error: '".env" is an environment file. read_file doesn\'t read those: they hold secrets.',
        });
    });

    test("arguments that don't parse are logged as the model sent them", async () => {
        const { records } = await hello(
            {},
            {
                responses: script(
                    () => completed([call('read_file', '{"path": "package.json"')]),
                    () => completed([message('Sorry.')]),
                ),
            },
        );

        expect(find(records, 'tool call')).toMatchObject({ arguments: '{"path": "package.json"' });
    });

    test('a turn without usage still reports its time', async () => {
        const noUsage = new Response(
            `event: response.completed\ndata: ${JSON.stringify({
                type: 'response.completed',
                response: {
                    id: 'r',
                    object: 'response',
                    status: 'completed',
                    output: [message('Hi.')],
                },
            })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
        );
        const { records } = await hello({}, { responses: () => noUsage });

        expect(find(records, 'turn')).toEqual({
            time: expect.any(String),
            level: 'info',
            message: 'turn',
            number: 1,
            seconds: 1.5,
        });
    });

    test('usage without token details leaves those out', async () => {
        // Some OpenAI-compatible servers report only the totals.
        const totals = { input_tokens: 10, output_tokens: 5, total_tokens: 15 } as ResponseUsage;
        const { records } = await hello(
            {},
            { responses: () => completed([message('Hi.')], totals) },
        );

        expect(find(records, 'turn')).toEqual({
            time: expect.any(String),
            level: 'info',
            message: 'turn',
            number: 1,
            inputTokens: 10,
            outputTokens: 5,
            seconds: 1.5,
        });
    });
});

describe('Formatted output by default', () => {
    test('without LOG_FORMAT, each record is a line to read', async () => {
        const { output } = await hello({ LOG_FORMAT: undefined }, readThenAnswer);
        const lines = output.trim().split('\n');

        expect(lines.every((line) => /^\d\d:\d\d:\d\d (INFO |WARN |ERROR) /.test(line))).toBe(true);
        expect(lines.map((line) => line.slice(9))).toEqual([
            `INFO  asking model=prism-ml/bonsai-27b baseUrl=http://127.0.0.1:1234/v1 file=package.json question="${DEFAULT_QUESTION}"`,
            'INFO  turn number=1 inputTokens=349 cachedTokens=256 outputTokens=26 reasoningTokens=12 seconds=1.5',
            'INFO  tool call tool=read_file arguments={"path":"package.json"}',
            `INFO  tool result tool=read_file bytes=${Buffer.byteLength(PACKAGE_JSON)}`,
            'INFO  turn number=2 inputTokens=349 cachedTokens=256 outputTokens=26 reasoningTokens=12 seconds=1.5',
            'INFO  answer text="It runs the checks."',
        ]);
    });

    test('an unknown LOG_FORMAT fails before anything else', async () => {
        const { code, output, requests } = await hello({ LOG_FORMAT: 'xml' });

        expect(code).toBe(1);
        expect(output).toMatch(
            /^\d\d:\d\d:\d\d ERROR LOG_FORMAT must be pretty or json; got "xml"\.\n$/,
        );
        expect(requests).toHaveLength(0);
    });

    test('LOG_FORMAT is trimmed, as every setting is', async () => {
        const { output } = await hello({ LOG_FORMAT: ' json ' }, readThenAnswer);
        const messages = output
            .trim()
            .split('\n')
            .map((line) => (JSON.parse(line) as LogRecord).message);

        expect(messages).toEqual(['asking', 'turn', 'tool call', 'tool result', 'turn', 'answer']);
    });
});

describe('Actionable failures', () => {
    test('the turn limit', async () => {
        const { code, records, turns } = await hello(
            {},
            {
                responses: (n) =>
                    completed([call('read_file', { path: 'package.json' }, `call_${n}`)]),
            },
        );

        expect(code).toBe(1);
        expect(find(records, 'answer')).toBeUndefined();
        expect(turns).toHaveLength(MAX_TURNS);
        expect(errors(records)).toEqual([
            `The model didn't answer within ${MAX_TURNS} turns: it was still calling tools. Try a narrower question.`,
        ]);
    });

    test('no answer', async () => {
        const { code, records } = await hello(
            {},
            { responses: script(() => completed([reasoning()])) },
        );

        expect(code).toBe(1);
        expect(find(records, 'answer')).toBeUndefined();
        expect(errors(records)).toEqual([expect.stringContaining('The model gave no answer')]);
    });

    test("an item the SDK can't replay", async () => {
        const strange = { type: 'made_up' } as unknown as ResponseOutputItem;
        const { code, records } = await hello(
            {},
            {
                responses: script(() =>
                    completed([strange, call('read_file', { path: 'package.json' })]),
                ),
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringMatching(/^The conversation can't be continued \(.*made_up/),
        ]);
    });

    test('a failed turn', async () => {
        const { code, records } = await hello(
            {},
            { responses: () => httpError(500, 'model crashed') },
        );

        expect(code).toBe(1);
        expect(find(records, 'answer')).toBeUndefined();
        expect(errors(records)).toEqual([
            'The model server at http://127.0.0.1:1234/v1 failed the turn (500 model crashed). Try again; if it keeps failing, check its logs or status page.',
        ]);
    });

    test('a rate-limited turn', async () => {
        const { code, records } = await hello({}, { responses: () => httpError(429, 'slow down') });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            "The model server at http://127.0.0.1:1234/v1 is limiting requests (429 slow down). Wait a minute and try again; if it keeps happening, check the account's quota.",
        ]);
    });

    test('a failed turn without a status', async () => {
        const { code, records } = await hello(
            {},
            {
                responses: () =>
                    new Response(
                        `event: response.failed\ndata: ${JSON.stringify({
                            type: 'response.failed',
                            response: {
                                id: 'r',
                                object: 'response',
                                status: 'failed',
                                output: [],
                                error: { code: 'server_error', message: 'it broke' },
                            },
                        })}\n\n`,
                        { headers: { 'content-type': 'text/event-stream' } },
                    ),
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            'The model server at http://127.0.0.1:1234/v1 failed the turn (server_error: it broke). Try again; if it keeps failing, check its logs or status page.',
        ]);
    });

    test('LM Studio stops during the session', async () => {
        const { code, records } = await hello(
            {},
            {
                responses: () => {
                    throw new TypeError('Unable to connect');
                },
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            "Can't reach LM Studio at http://127.0.0.1:1234/v1 (Connection error. (Unable to connect)). Is its server running? Start it with `lms server start`, or set MODEL_BASE_URL.",
        ]);
    });

    test("another provider that can't be reached", async () => {
        const { code, records } = await hello(
            { MODEL_PROVIDER: 'openai', MODEL_API_KEY: 'sk-test', MODEL: 'gpt-test' },
            {
                responses: () => {
                    throw new TypeError('Unable to connect');
                },
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            "Can't reach https://api.openai.com/v1 (Connection error. (Unable to connect)). Check MODEL_BASE_URL.",
        ]);
    });
});

describe('run with LM Studio (the default provider)', () => {
    test('asks the loaded model and logs its answer', async () => {
        const { code, records, turn } = await hello();

        expect(code).toBe(0);
        expect(find(records, 'answer')).toMatchObject({ text: 'Hi there!' });
        // With one model loaded there's no note about the choice: the first record is the question.
        expect(records[0]).toMatchObject({ message: 'asking', model: 'prism-ml/bonsai-27b' });
        expect(turn?.url).toBe('http://127.0.0.1:1234/v1/responses');
        expect(turn?.body).toMatchObject({
            model: 'prism-ml/bonsai-27b',
            reasoning: { effort: 'none' },
            stream: true,
            store: false,
        });
    });

    test('passes the configured reasoning effort through', async () => {
        const { code, turn } = await hello({ MODEL_REASONING_EFFORT: 'low' });

        expect(code).toBe(0);
        expect(turn?.body).toMatchObject({ reasoning: { effort: 'low' } });
    });

    test('invalid config fails before any network call', async () => {
        const { code, records, requests } = await hello({ MODEL_BASE_URL: 'lmstudio' });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('MODEL_BASE_URL')]);
        expect(requests).toHaveLength(0);
    });

    test('an unreachable LM Studio fails with a hint', async () => {
        const { code, records } = await hello(
            {},
            {
                models: () => {
                    throw new TypeError('Unable to connect');
                },
            },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('lms server start')]);
    });

    test("a rejected key fails with LM Studio's hint", async () => {
        const { code, records } = await hello(
            {},
            { models: () => new Response('denied', { status: 401 }) },
        );

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringMatching(
                /Require Authentication.*MODEL_API_KEY|MODEL_API_KEY.*Require Authentication/,
            ),
        ]);
    });

    test("a configured model that isn't loaded sends no turn", async () => {
        const { code, records, turn } = await hello({ MODEL: 'qwen2.5-0.5b-instruct-mlx' });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('lms load qwen2.5-0.5b-instruct-mlx'),
        ]);
        expect(turn).toBeUndefined();
    });

    test('with several models loaded, says which it chose and how to choose another', async () => {
        const twoLoaded = {
            models: [
                {
                    type: 'llm',
                    key: 'prism-ml/bonsai-27b',
                    loaded_instances: [{ id: 'prism-ml/bonsai-27b' }],
                },
                {
                    type: 'llm',
                    key: 'qwen2.5-0.5b-instruct-mlx',
                    loaded_instances: [{ id: 'qwen2.5-0.5b-instruct-mlx' }],
                },
            ],
        };
        const { code, records, turn } = await hello({}, { models: () => Response.json(twoLoaded) });

        expect(code).toBe(0);
        expect(records[0]).toMatchObject({
            level: 'info',
            message:
                'Using prism-ml/bonsai-27b, the first of 2 loaded models (prism-ml/bonsai-27b, qwen2.5-0.5b-instruct-mlx). Set MODEL to choose another.',
        });
        expect(turn?.body).toMatchObject({ model: 'prism-ml/bonsai-27b' });
    });
});

describe('run with another OpenAI-compatible provider', () => {
    const openai = { MODEL_PROVIDER: 'openai', MODEL_API_KEY: 'sk-test', MODEL: 'gpt-test' };

    test("uses the named model without asking LM Studio, and the model's own reasoning default", async () => {
        const { code, records, requests, turn } = await hello(openai);

        expect(code).toBe(0);
        expect(find(records, 'answer')).toMatchObject({ text: 'Hi there!' });
        expect(requests.some((request) => request.url.endsWith('/api/v1/models'))).toBe(false);
        expect(turn).toMatchObject({
            url: 'https://api.openai.com/v1/responses',
            authorization: 'Bearer sk-test',
            body: { model: 'gpt-test' },
        });
        expect(turn?.body).not.toHaveProperty('reasoning');
    });

    test('needs MODEL and MODEL_API_KEY, and fails before any network call', async () => {
        const { code, records, requests } = await hello({ MODEL_PROVIDER: 'openai' });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('MODEL_API_KEY is required'),
            expect.stringContaining('MODEL is required'),
        ]);
        expect(requests).toHaveLength(0);
    });

    test('a rejected key points at MODEL_API_KEY, not at LM Studio', async () => {
        const { code, records } = await hello(openai, {
            responses: () => httpError(401, 'bad key'),
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([expect.stringContaining('MODEL_API_KEY')]);
        expect(errors(records)[0]).not.toContain('LM Studio');
    });

    test('a forbidden key reports its own status', async () => {
        const { code, records } = await hello(openai, {
            responses: () => httpError(403, 'forbidden'),
        });

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringContaining('rejected the API key (HTTP 403)'),
        ]);
    });
});
