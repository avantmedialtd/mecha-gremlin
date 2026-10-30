import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { classify, toFunctionTool } from '../../src/model/responses-tools.ts';
import { call, message, reasoning } from '../fake-model.ts';

describe('Responses tools and reply classification', () => {
    test('offers the draft-07 schema as a strict function tool', () => {
        expect(
            toFunctionTool({
                name: 'read',
                description: 'Read a file',
                schema: z.object({ path: z.string() }).strict(),
            }),
        ).toMatchObject({
            type: 'function',
            name: 'read',
            description: 'Read a file',
            strict: true,
            parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
            },
        });
    });

    test("a tool that isn't strict, beside one that is and one that doesn't say", () => {
        const schema = z.object({ query: z.string() });

        expect(
            [
                toFunctionTool({ name: 'search', description: 'Search', schema, strict: false }),
                toFunctionTool({ name: 'search', description: 'Search', schema, strict: true }),
                toFunctionTool({ name: 'search', description: 'Search', schema }),
            ].map((tool) => tool.strict),
        ).toEqual([false, true, true]);
    });

    test('calls win over text and keep their order', () => {
        expect(
            classify([
                reasoning(),
                message('Reading.'),
                call('read', { path: 'a' }, 'a'),
                call('read', { path: 'b' }, 'b'),
            ]),
        ).toEqual({
            kind: 'calls',
            calls: [
                { call_id: 'a', name: 'read', arguments: '{"path":"a"}' },
                { call_id: 'b', name: 'read', arguments: '{"path":"b"}' },
            ],
        });
    });

    test('joins and trims message text, including refusals', () => {
        expect(classify([reasoning(), message('  Hello, '), message('world  ')])).toEqual({
            kind: 'final',
            text: 'Hello, world',
        });
        expect(
            classify([
                { ...message(''), content: [{ type: 'refusal', refusal: "I can't help." }] },
            ]),
        ).toEqual({ kind: 'final', text: "I can't help." });
    });

    test('reasoning and whitespace are empty', () => {
        expect(classify([reasoning(), message(' \n\t')])).toEqual({ kind: 'empty' });
        expect(classify([])).toEqual({ kind: 'empty' });
    });
});
