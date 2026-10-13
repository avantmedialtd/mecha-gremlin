import { readFile } from 'node:fs/promises';
import type {
    ResponseFunctionToolCall,
    ResponseOutputItem,
    ResponseOutputMessage,
} from 'openai/resources/responses/responses';
import { describe, expect, test } from 'vitest';
import {
    type Err,
    type Result,
    type StandardSchemaV1,
    type Tool,
    classify,
    toFunctionTool,
    validateArgs,
} from '../src/index.ts';

type Args = Record<string, unknown>;
type Validate = (
    value: unknown,
) => StandardSchemaV1.Result<Args> | Promise<StandardSchemaV1.Result<Args>>;

const PARAMETERS = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
};

/** Hand-written, so these tests rely on the Standard Schema interface alone. */
const fakeTool = (validate: Validate = (value) => ({ value: value as Args })) => {
    const validated: unknown[] = [];
    const targets: string[] = [];
    const tool: Tool<Args> = {
        name: 'read_file',
        description: 'Read a file',
        schema: {
            '~standard': {
                version: 1,
                vendor: 'fake',
                validate: (value) => {
                    validated.push(value);

                    return validate(value);
                },
                jsonSchema: {
                    input: (options) => {
                        targets.push(options.target);

                        return {
                            $schema: 'http://json-schema.org/draft-07/schema#',
                            ...PARAMETERS,
                        };
                    },
                    output: () => ({}),
                },
            },
        },
    };

    return { tool, validated, targets };
};

const errorOf = (result: Result<Args, string>): string => {
    expect(result.ok).toBe(false);

    return (result as Err<string>).error;
};

const message = (...texts: string[]): ResponseOutputMessage => {
    return {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: texts.map((text) => ({ type: 'output_text', text, annotations: [] })),
    };
};

const refusal = (text: string): ResponseOutputMessage => {
    return { ...message(), content: [{ type: 'refusal', refusal: text }] };
};

const call = (callId: string): ResponseFunctionToolCall => {
    return {
        type: 'function_call',
        id: `fc_${callId}`,
        call_id: callId,
        name: 'read_file',
        arguments: '{"path":"package.json"}',
        status: 'completed',
    };
};

const reasoning: ResponseOutputItem = {
    type: 'reasoning',
    id: 'rs_1',
    summary: [],
    content: [{ type: 'reasoning_text', text: 'I should read the file.' }],
};

describe('Tools are defined by a name, a description and a Standard Schema', () => {
    test('no schema library in core', async () => {
        const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
        const runtime = [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.peerDependencies ?? {}),
        ];

        expect(runtime).toEqual(['openai']);
    });
});

describe('toFunctionTool', () => {
    test("builds a strict function tool from the schema's JSON Schema, without $schema", () => {
        expect(toFunctionTool(fakeTool().tool)).toEqual({
            type: 'function',
            name: 'read_file',
            description: 'Read a file',
            strict: true,
            parameters: PARAMETERS,
        });
    });

    test('requests the JSON Schema as draft-07', () => {
        const { tool, targets } = fakeTool();
        toFunctionTool(tool);

        expect(targets).toEqual(['draft-07']);
    });
});

describe('classify', () => {
    test('calls win over text', () => {
        const only = call('call_1');

        expect(classify([reasoning, message('\n\n'), only])).toEqual({
            kind: 'calls',
            calls: [only],
        });
    });

    test('several calls keep their order', () => {
        const a = call('call_a');
        const b = call('call_b');

        expect(classify([a, message('Reading both.'), b])).toEqual({
            kind: 'calls',
            calls: [a, b],
        });
    });

    test('the answer is trimmed', () => {
        expect(classify([reasoning, message('\n\nThe check script runs the linter.  ')])).toEqual({
            kind: 'final',
            text: 'The check script runs the linter.',
        });
    });

    test('text from several messages, and several parts, is joined in order', () => {
        expect(classify([message('Hello, '), message('world')])).toEqual({
            kind: 'final',
            text: 'Hello, world',
        });
        expect(classify([message('Hello, ', 'world')])).toEqual({
            kind: 'final',
            text: 'Hello, world',
        });
    });

    test('a refusal is the answer', () => {
        expect(classify([refusal("I can't help with that.")])).toEqual({
            kind: 'final',
            text: "I can't help with that.",
        });
    });

    test('nothing to act on', () => {
        expect(classify([reasoning, message(' \n\t')])).toEqual({ kind: 'empty' });
        expect(classify([])).toEqual({ kind: 'empty' });
    });
});

describe('validateArgs', () => {
    const expectedSchema = JSON.stringify(PARAMETERS);

    test('valid arguments', async () => {
        const { tool, validated } = fakeTool();

        expect(await validateArgs(tool, '{"path":"package.json"}')).toEqual({
            ok: true,
            value: { path: 'package.json' },
        });
        expect(validated).toEqual([{ path: 'package.json' }]);
    });

    test.each(['', '  \n'])('empty arguments %j mean an empty object', async (raw) => {
        const { tool, validated } = fakeTool();

        expect(await validateArgs(tool, raw)).toEqual({ ok: true, value: {} });
        expect(validated).toEqual([{}]);
    });

    test('invalid JSON', async () => {
        const { tool, validated } = fakeTool();
        const error = errorOf(await validateArgs(tool, '{"path":'));
        let parserMessage = '';

        try {
            JSON.parse('{"path":');
        } catch (thrown) {
            parserMessage = (thrown as SyntaxError).message;
        }

        expect(error).toContain(
            `The arguments for read_file are not valid JSON (${parserMessage}).`,
        );
        expect(error.endsWith(`JSON Schema: ${expectedSchema}`)).toBe(true);
        expect(validated).toEqual([]);
    });

    test.each(['"package.json"', '[]', 'null', '42', 'true'])(
        'arguments %s are not an object',
        async (raw) => {
            const { tool, validated } = fakeTool();
            const error = errorOf(await validateArgs(tool, raw));

            expect(error).toContain('The arguments for read_file must be a JSON object.');
            expect(error.endsWith(`JSON Schema: ${expectedSchema}`)).toBe(true);
            expect(validated).toEqual([]);
        },
    );

    test('schema mismatch lists each issue with its path', async () => {
        const { tool } = fakeTool(() => ({
            issues: [
                { message: 'Required', path: ['path'] },
                { message: 'Expected string', path: [{ key: 'items' }, 0, 'name'] },
            ],
        }));
        const error = errorOf(await validateArgs(tool, '{"file":"x"}'));

        expect(error).toContain("The arguments for read_file don't match its schema:");
        expect(error).toContain('- path: Required\n');
        expect(error).toContain('- items.0.name: Expected string\n');
        expect(error.endsWith(`JSON Schema: ${expectedSchema}`)).toBe(true);
    });

    test('an issue at the root', async () => {
        const { tool } = fakeTool(() => ({
            issues: [
                { message: 'Unrecognized key: limit' },
                { message: 'Too many keys', path: [] },
            ],
        }));
        const error = errorOf(await validateArgs(tool, '{"path":"a","limit":5}'));

        expect(error).toContain('- (root): Unrecognized key: limit\n');
        expect(error).toContain('- (root): Too many keys\n');
    });

    test('an asynchronous validator', async () => {
        const accepting = fakeTool(async (value) => ({ value: value as Args }));

        expect(await validateArgs(accepting.tool, '{"path":"a"}')).toEqual({
            ok: true,
            value: { path: 'a' },
        });

        const rejecting = fakeTool(async () => ({ issues: [{ message: 'Nope', path: ['path'] }] }));

        expect(errorOf(await validateArgs(rejecting.tool, '{"path":"a"}'))).toContain(
            '- path: Nope',
        );
    });
});
