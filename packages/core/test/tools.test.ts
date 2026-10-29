import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import type { Err, Result } from '../src/result.ts';
import type { StandardSchemaV1 } from '../src/standard-schema.ts';
import { type Tool, toolJsonSchema, validateArgs } from '../src/tools.ts';

type Args = Readonly<Record<string, unknown>>;
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
        name: 'read',
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

describe('Tools are defined by a name, a description and a Standard Schema', () => {
    test('no schema library in core', async () => {
        const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
        const runtime = [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.peerDependencies ?? {}),
        ];

        expect(runtime).toEqual([]);
        expect(pkg.devDependencies ?? {}).not.toHaveProperty('openai');
        expect(pkg.devDependencies ?? {}).not.toHaveProperty('@anthropic-ai/sdk');
    });
});

describe('toolJsonSchema', () => {
    test("returns the tool's JSON Schema without $schema", () => {
        expect(toolJsonSchema(fakeTool().tool)).toEqual(PARAMETERS);
    });

    test('requests the JSON Schema as draft-07', () => {
        const { tool, targets } = fakeTool();
        toolJsonSchema(tool);

        expect(targets).toEqual(['draft-07']);
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

        expect(error).toContain(`The arguments for read are not valid JSON (${parserMessage}).`);
        expect(error.endsWith(`JSON Schema: ${expectedSchema}`)).toBe(true);
        expect(validated).toEqual([]);
    });

    test.each(['"package.json"', '[]', 'null', '42', 'true'])(
        'arguments %s are not an object',
        async (raw) => {
            const { tool, validated } = fakeTool();
            const error = errorOf(await validateArgs(tool, raw));

            expect(error).toContain('The arguments for read must be a JSON object.');
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

        expect(error).toContain("The arguments for read don't match its schema:");
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

    test.each([
        ['an error', new Error('boom')],
        ['something else', 'boom'],
    ])('a validator that throws or rejects with %s', async (_what, thrown) => {
        const throwing = fakeTool(() => {
            throw thrown;
        });
        const rejecting = fakeTool(async () => {
            throw thrown;
        });
        const expected = `Validating the arguments for read failed (boom).\nThe arguments must match this JSON Schema: ${expectedSchema}`;

        expect(errorOf(await validateArgs(throwing.tool, '{"path":"a"}'))).toBe(expected);
        expect(errorOf(await validateArgs(rejecting.tool, '{"path":"a"}'))).toBe(expected);
    });

    test("a JSON Schema that can't be produced is left out", async () => {
        const { tool } = fakeTool();
        const unsupported: Tool<Args> = {
            ...tool,
            schema: {
                '~standard': {
                    ...tool.schema['~standard'],
                    jsonSchema: {
                        input: () => {
                            throw new Error('unsupported target');
                        },
                        output: () => ({}),
                    },
                },
            },
        };

        expect(errorOf(await validateArgs(unsupported, '[]'))).toBe(
            'The arguments for read must be a JSON object.',
        );
    });
});
