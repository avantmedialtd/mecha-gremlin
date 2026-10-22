import { describe, expect, test } from 'vitest';
import { type HistoryItem, toInput, toOutputItem } from '../src/history.ts';
import { err, ok } from '../src/result.ts';

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
    const developer: HistoryItem = { role: 'developer', content: 'Read files before answering.' };
    const user: HistoryItem = { role: 'user', content: 'What does the check script run?' };

    const reasoning: HistoryItem = {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'I should read package.json.' }],
    };

    const message: HistoryItem = {
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

    const output: HistoryItem = { type: 'function_call_output', call_id: 'call_1', output: '{}' };

    test('replays every item in order, without SDK-only fields', () => {
        const call = { ...callFields, parsed_arguments: { path: 'package.json' } } as HistoryItem;

        expect(toInput([developer, user, reasoning, message, call, output])).toEqual({
            ok: true,
            value: [developer, user, reasoning, message, callFields, output],
        });
    });

    test("an item the SDK can't replay comes back as a value", () => {
        const unknown = { type: 'made_up' } as unknown as HistoryItem;

        expect(toInput([user, unknown])).toEqual({
            ok: false,
            error: 'Unsupported response item type: made_up',
        });
    });
});
