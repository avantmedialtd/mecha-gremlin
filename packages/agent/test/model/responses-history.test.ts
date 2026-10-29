import { describe, expect, test } from 'vitest';
import type { HistoryItem } from '@mecha-gremlin/core/history';
import { err, ok } from '@mecha-gremlin/core/result';
import { toInput, toOutputItem } from '../../src/model/responses-history.ts';

describe('toOutputItem', () => {
    test("a successful call's output is its text", () => {
        expect(toOutputItem('call_1', ok('file contents'))).toEqual({
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'file contents',
        });
    });

    test("a failed call's output is its error, marked as one", () => {
        expect(toOutputItem('call_1', err('no such file: x.txt'))).toEqual({
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'Error: no such file: x.txt',
        });
    });
});

describe('toInput', () => {
    const developer: HistoryItem = { kind: 'instruction', text: 'Read files before answering.' };
    const user: HistoryItem = { kind: 'user', text: 'What does the check script run?' };

    const reasoning = {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'I should read package.json.' }],
    };

    const message = {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '\n\n', annotations: [] }],
    };

    const callFields = {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'read',
        arguments: '{"path":"package.json"}',
        status: 'completed',
    } as const;

    const output: HistoryItem = { kind: 'tool_result', callId: 'call_1', outcome: ok('{}') };

    test('replays every item in order, without SDK-only fields', () => {
        const call = { ...callFields, parsed_arguments: { path: 'package.json' } };

        expect(
            toInput(
                [
                    developer,
                    user,
                    { kind: 'native', provider: 'openai', data: [reasoning, message, call] },
                    output,
                ],
                'openai',
            ),
        ).toEqual({
            ok: true,
            value: [
                { role: 'developer', content: 'Read files before answering.' },
                { role: 'user', content: 'What does the check script run?' },
                reasoning,
                message,
                callFields,
                { type: 'function_call_output', call_id: 'call_1', output: '{}' },
            ],
        });
    });

    test("an item the SDK can't replay comes back as a value", () => {
        const unknown: HistoryItem = {
            kind: 'native',
            provider: 'openai',
            data: [{ type: 'made_up' }],
        };

        expect(toInput([user, unknown], 'openai')).toEqual({
            ok: false,
            error: 'Unsupported response item type: made_up',
        });
    });

    test.each([
        [undefined],
        [null],
        [{}],
        ['output'],
        [[null]],
        [[1]],
        [['text']],
        [[{}]],
        [[{ type: 'reasoning', id: 'rs_1', summary: [] }, null]],
    ])('rejects malformed native output %j', (data: unknown) => {
        expect(toInput([{ kind: 'native', provider: 'openai', data }], 'openai')).toEqual({
            ok: false,
            error: 'Responses history contains malformed native output.',
        });
    });

    test('rejects native history from another provider', () => {
        expect(toInput([{ kind: 'native', provider: 'lmstudio', data: [] }], 'openai')).toEqual({
            ok: false,
            error: 'History belongs to lmstudio, not openai.',
        });
    });
});
