import type { HistoryItem } from '@mecha-gremlin/core/history';
import { err, ok } from '@mecha-gremlin/core/result';
import { describe, expect, test } from 'vitest';
import { toClaudeInput } from '../../src/model/anthropic-history.ts';

const native = (content: unknown, fields: object = { id: 'msg_1' }): HistoryItem => ({
    kind: 'native',
    provider: 'anthropic',
    data: { ...fields, content },
});

describe('Anthropic replay validation', () => {
    test('joins instructions before the conversation and does not invent tool results', () => {
        const blocks = [{ type: 'text', text: 'Hello' }];

        expect(
            toClaudeInput([
                { kind: 'instruction', text: 'First' },
                { kind: 'instruction', text: 'Second' },
                { kind: 'user', text: 'Hi' },
                native(blocks),
            ]),
        ).toEqual({
            ok: true,
            value: {
                system: 'First\n\nSecond',
                messages: [
                    { role: 'user', content: 'Hi' },
                    { role: 'assistant', content: blocks },
                ],
                previousMessageId: 'msg_1',
            },
        });
    });

    test('names the latest reply for cache diagnostics', () => {
        const reply = [{ type: 'text', text: 'Hello' }];

        expect(
            toClaudeInput([
                { kind: 'user', text: 'Hi' },
                native(reply, { id: 'msg_1' }),
                { kind: 'user', text: 'Again' },
                native(reply, { id: 'msg_2' }),
            ]),
        ).toMatchObject({ ok: true, value: { previousMessageId: 'msg_2' } });
    });

    test('names no reply before the first one', () => {
        expect(toClaudeInput([{ kind: 'user', text: 'Hi' }])).toEqual({
            ok: true,
            value: {
                system: undefined,
                messages: [{ role: 'user', content: 'Hi' }],
                previousMessageId: null,
            },
        });
    });

    test.each([{}, { id: null }, { id: 7 }])(
        'names no reply when the latest one has no string ID: %j',
        (fields) => {
            const reply = [{ type: 'text', text: 'Hello' }];

            expect(
                toClaudeInput([
                    { kind: 'user', text: 'Hi' },
                    native(reply),
                    { kind: 'user', text: 'Again' },
                    native(reply, fields),
                ]),
            ).toMatchObject({ ok: true, value: { previousMessageId: null } });
        },
    );

    test('rejects an instruction after conversation content', () => {
        expect(
            toClaudeInput([
                { kind: 'user', text: 'Hi' },
                { kind: 'instruction', text: 'Late' },
            ]),
        ).toEqual({
            ok: false,
            error: 'Anthropic system instructions must precede the conversation.',
        });
    });

    test('rejects a missing history item', () => {
        const sparse: HistoryItem[] = [];
        sparse.length = 1;

        expect(toClaudeInput(sparse)).toEqual({
            ok: false,
            error: 'Anthropic history contains a missing item.',
        });
    });

    test('rejects a tool result without a preceding call', () => {
        expect(
            toClaudeInput([{ kind: 'tool_result', callId: 'orphan', outcome: ok('value') }]),
        ).toEqual({
            ok: false,
            error: 'Anthropic tool result orphan has no preceding tool call.',
        });
    });

    test.each([null, undefined, 'content', [], {}, { id: 'msg_1', content: {} }])(
        'rejects malformed native data %j',
        (data) => {
            expect(toClaudeInput([{ kind: 'native', provider: 'anthropic', data }])).toEqual({
                ok: false,
                error: 'Anthropic history contains malformed native content.',
            });
        },
    );

    test.each([[null], [undefined], [12], ['text'], [[]], [{}], [{ type: 7 }]])(
        'rejects malformed block %j',
        (block) => {
            expect(toClaudeInput([native([block])])).toEqual({
                ok: false,
                error: 'Anthropic history contains a malformed content block.',
            });
        },
    );

    test('rejects an unsupported block', () => {
        expect(toClaudeInput([native([{ type: 'server_tool_use' }])])).toEqual({
            ok: false,
            error: 'Unsupported Anthropic content block: server_tool_use.',
        });
    });

    test.each([
        [{ type: 'text' }, 'text'],
        [{ type: 'thinking', signature: 'sig' }, 'thinking'],
        [{ type: 'thinking', thinking: 'thought' }, 'thinking'],
        [{ type: 'redacted_thinking' }, 'redacted_thinking'],
    ])('rejects an incomplete %s block', (block, kind) => {
        expect(toClaudeInput([native([block])])).toEqual({
            ok: false,
            error: `Anthropic history contains a malformed ${kind} block.`,
        });
    });

    test.each([
        { type: 'tool_use', name: 'read', input: {} },
        { type: 'tool_use', id: 'a', input: {} },
        { type: 'tool_use', id: 'a', name: 'read' },
    ])('rejects an incomplete tool-use block %j', (block) => {
        expect(toClaudeInput([native([block])])).toEqual({
            ok: false,
            error: 'Anthropic history contains a malformed tool-use block.',
        });
    });

    test('rejects a result for the wrong tool call', () => {
        expect(
            toClaudeInput([
                native([{ type: 'tool_use', id: 'a', name: 'read', input: {} }]),
                { kind: 'tool_result', callId: 'b', outcome: ok('value') },
            ]),
        ).toEqual({
            ok: false,
            error: 'Anthropic tool call a needs one corresponding ordered result.',
        });
    });

    test('replays valid signed thinking and ordered successful and failed tool results', () => {
        const blocks = [
            { type: 'thinking', thinking: 'thought', signature: 'sig' },
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'tool_use', id: 'a', name: 'read', input: {} },
            { type: 'tool_use', id: 'b', name: 'read', input: {} },
        ];

        expect(
            toClaudeInput([
                native(blocks),
                { kind: 'tool_result', callId: 'a', outcome: ok('done') },
                { kind: 'tool_result', callId: 'b', outcome: err('missing') },
            ]),
        ).toEqual({
            ok: true,
            value: {
                system: undefined,
                messages: [
                    { role: 'assistant', content: blocks },
                    {
                        role: 'user',
                        content: [
                            { type: 'tool_result', tool_use_id: 'a', content: 'done' },
                            {
                                type: 'tool_result',
                                tool_use_id: 'b',
                                content: 'missing',
                                is_error: true,
                            },
                        ],
                    },
                ],
                previousMessageId: 'msg_1',
            },
        });
    });

    test('rejects a call without its result', () => {
        expect(
            toClaudeInput([native([{ type: 'tool_use', id: 'a', name: 'read', input: {} }])]),
        ).toEqual({
            ok: false,
            error: 'Anthropic tool call a needs one corresponding ordered result.',
        });
    });

    test('rejects history from a different provider', () => {
        expect(toClaudeInput([{ kind: 'native', provider: 'openai', data: [] }])).toEqual({
            ok: false,
            error: 'History belongs to openai, not anthropic.',
        });
    });
});
