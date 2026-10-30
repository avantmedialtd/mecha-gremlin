import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, test, vi } from 'vitest';
import { type ListOptions, isObjectSchema, listTools, preflight } from '../../src/mcp/tools.ts';

// A client whose answers to tools/list are the pages given; a cursor is the index of its page.
const fakeClient = (pages: readonly unknown[]) => {
    const request = vi.fn<
        (sent: { readonly params: { readonly cursor?: string } }) => Promise<unknown>
    >(async (sent) => {
        return pages[Number(sent.params.cursor ?? 0)];
    });

    return { client: { request } as unknown as Client, request };
};

const OPTIONS: ListOptions = {
    includeTools: undefined,
    excludeTools: [],
    remaining: () => 1234,
    signal: new AbortController().signal,
    // A string's own method, as the real one uses: it fails for anything else.
    redact: (text) => text.replaceAll('t0k', '[redacted]'),
};

describe("Patch a tool's input schema on a copy", () => {
    test("$schema goes, empty properties and items are added, and the server's own is unchanged", () => {
        const own = {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                list: { type: 'array' },
                nested: { type: 'object', default: { type: 'object' } },
                given: { type: 'array', items: { type: 'object' } },
            },
        };
        const before = structuredClone(own);

        const patched = preflight(own);

        expect(patched).toEqual({
            type: 'object',
            properties: {
                list: { type: 'array', items: {} },
                nested: { type: 'object', default: { type: 'object' }, properties: {} },
                given: { type: 'array', items: { type: 'object', properties: {} } },
            },
        });
        expect(own).toEqual(before);
    });

    test('an object at the root without properties', () => {
        expect(preflight({ type: 'object' })).toEqual({ type: 'object', properties: {} });
        expect(preflight({ type: 'object', properties: { a: true } })).toEqual({
            type: 'object',
            properties: { a: true },
        });
    });

    test.each([
        'items',
        'additionalItems',
        'additionalProperties',
        'contains',
        'propertyNames',
        'not',
        'if',
        'then',
        'else',
        'unevaluatedItems',
        'unevaluatedProperties',
    ])('a schema under %s is patched', (keyword) => {
        expect(
            preflight({ type: 'object', properties: {}, [keyword]: { type: 'object' } }),
        ).toEqual({
            type: 'object',
            properties: {},
            [keyword]: { type: 'object', properties: {} },
        });
    });

    test.each(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'])(
        'schemas by name under %s are patched',
        (keyword) => {
            expect(
                preflight({ type: 'object', properties: {}, [keyword]: { a: { type: 'array' } } }),
            ).toEqual({
                type: 'object',
                properties: {},
                [keyword]: { a: { type: 'array', items: {} } },
            });
        },
    );

    test.each(['allOf', 'anyOf', 'oneOf', 'prefixItems'])(
        'schemas in a list under %s are patched',
        (keyword) => {
            expect(
                preflight({ type: 'object', properties: {}, [keyword]: [{ type: 'array' }, true] }),
            ).toEqual({
                type: 'object',
                properties: {},
                [keyword]: [{ type: 'array', items: {} }, true],
            });
        },
    );

    test('values that are not schemas are left as they are', () => {
        const values = {
            type: 'object',
            properties: {},
            enum: [{ type: 'object' }],
            const: { type: 'array' },
            examples: [{ type: 'object' }],
            description: 'type object',
        };

        expect(preflight(values)).toEqual(values);
    });

    test('a schema of null is left as it is', () => {
        expect(preflight({ type: 'object', properties: { a: null } })).toEqual({
            type: 'object',
            properties: { a: null },
        });
    });

    test('a map or a list that holds something else', () => {
        expect(preflight({ type: 'object', properties: 'odd', allOf: 'odd' })).toEqual({
            type: 'object',
            properties: 'odd',
            allOf: 'odd',
        });
    });
});

describe('List the tools', () => {
    test("each page's request has what is left of startupTimeoutMs, and the run's signal; a repeated cursor stops", async () => {
        const { client, request } = fakeClient([
            { tools: [{ name: 'first', inputSchema: { type: 'object' } }], nextCursor: '1' },
            { tools: [{ name: 'second', inputSchema: { type: 'object' } }], nextCursor: '1' },
        ]);

        const listed = await listTools(client, OPTIONS);

        expect(request.mock.calls).toEqual([
            [
                { method: 'tools/list', params: {} },
                expect.anything(),
                { timeout: 1234, signal: OPTIONS.signal },
            ],
            [
                { method: 'tools/list', params: { cursor: '1' } },
                expect.anything(),
                { timeout: 1234, signal: OPTIONS.signal },
            ],
        ]);
        expect(listed).toMatchObject({
            ok: true,
            value: { tools: [{ name: 'first' }, { name: 'second' }], warnings: [] },
        });
    });

    test("a tool's schema: Standard Schema's, over the copy, checking every error and formats", async () => {
        const inputSchema = {
            type: 'object',
            properties: {
                to: { type: 'string', format: 'email' },
                count: { type: 'integer', minimum: 1 },
            },
        };
        const { client } = fakeClient([{ tools: [{ name: 'send', inputSchema }] }]);

        const listed = await listTools(client, OPTIONS);
        const [tool] = listed.ok ? listed.value.tools : [];
        const standard = tool?.schema['~standard'];
        const checked = await standard?.validate({ to: 'not an address', count: 0 });

        expect(tool?.description).toBe('');
        expect(standard?.vendor).toBe('mcp');
        expect(standard?.jsonSchema.input({ target: 'draft-07' })).toEqual(inputSchema);
        expect(standard?.jsonSchema.output({ target: 'draft-07' })).toEqual(inputSchema);
        // The SDK gives every error in one issue.
        expect(checked?.issues).toEqual([
            { message: 'data/to must match format "email", data/count must be >= 1' },
        ]);
    });

    test('a schema that compiles is offered, though the meta-schema refuses it', async () => {
        const { client } = fakeClient([
            {
                tools: [
                    {
                        name: 'short',
                        inputSchema: {
                            type: 'object',
                            properties: { a: { type: 'string', minLength: -1 } },
                        },
                    },
                ],
            },
        ]);

        expect(await listTools(client, OPTIONS)).toMatchObject({
            ok: true,
            value: { tools: [{ name: 'short' }], warnings: [] },
        });
    });

    test('a tool whose name is not a string is dropped without a name', async () => {
        const { client } = fakeClient([
            {
                tools: [
                    { name: 5, inputSchema: { type: 'object' } },
                    { inputSchema: { type: 'object' } },
                ],
            },
        ]);
        const reason = "it isn't a valid MCP tool, or its name is empty";

        expect(await listTools(client, OPTIONS)).toMatchObject({
            ok: true,
            value: {
                tools: [],
                warnings: [
                    { message: 'mcp tool dropped', tool: undefined, reason },
                    { message: 'mcp tool dropped', tool: undefined, reason },
                ],
            },
        });
    });

    test("an included tool that isn't listed, and one that can't be offered, in one error", async () => {
        const { client } = fakeClient([
            { tools: [{ name: 'union', inputSchema: { type: 'object', anyOf: [] } }] },
        ]);

        expect(await listTools(client, { ...OPTIONS, includeTools: ['absent', 'union'] })).toEqual({
            ok: false,
            error: "it doesn't list absent, which its includeTools names; it can't offer union, which its includeTools names: its input schema has anyOf at its root, which providers refuse",
        });
    });

    test('only an object schema narrows', () => {
        expect(isObjectSchema({ type: 'object' })).toBe(true);
        expect(isObjectSchema({ type: 'array' })).toBe(false);
    });
});
