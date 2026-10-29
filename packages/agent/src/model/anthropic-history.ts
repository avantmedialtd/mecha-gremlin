import type { HistoryItem } from '@mecha-gremlin/core/history';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type {
    ContentBlockParam,
    MessageParam,
    ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

type ClaudeInput = {
    readonly system: string | undefined;
    readonly messages: MessageParam[];
    /** The latest reply's ID, which cache diagnostics compare against; null before any reply. */
    readonly previousMessageId: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Convert provider-owned blocks only here, rejecting anything that cannot be safely replayed. */
export const toClaudeInput = (history: readonly HistoryItem[]): Result<ClaudeInput, string> => {
    const instructions: string[] = [];
    const messages: MessageParam[] = [];
    let previousMessageId: string | null = null;
    let sawMessage = false;

    for (let index = 0; index < history.length; index++) {
        const entry = history[index];

        if (entry === undefined) {
            return err('Anthropic history contains a missing item.');
        }

        if (entry.kind === 'instruction') {
            if (sawMessage) {
                return err('Anthropic system instructions must precede the conversation.');
            }

            instructions.push(entry.text);
            continue;
        }

        sawMessage = true;

        if (entry.kind === 'user') {
            messages.push({ role: 'user', content: entry.text });
            continue;
        }

        if (entry.kind === 'tool_result') {
            return err(`Anthropic tool result ${entry.callId} has no preceding tool call.`);
        }

        if (entry.provider !== 'anthropic') {
            return err(`History belongs to ${entry.provider}, not anthropic.`);
        }

        if (!isRecord(entry.data) || !Array.isArray(entry.data.content)) {
            return err('Anthropic history contains malformed native content.');
        }

        // Diagnostics are best-effort, so a reply without an ID only goes without them.
        previousMessageId = typeof entry.data.id === 'string' ? entry.data.id : null;
        const expected: string[] = [];

        for (const block of entry.data.content) {
            if (!isRecord(block) || typeof block.type !== 'string') {
                return err('Anthropic history contains a malformed content block.');
            }

            if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)) {
                return err(`Unsupported Anthropic content block: ${block.type}.`);
            }

            if (
                (block.type === 'text' && typeof block.text !== 'string') ||
                (block.type === 'thinking' &&
                    (typeof block.thinking !== 'string' || typeof block.signature !== 'string')) ||
                (block.type === 'redacted_thinking' && typeof block.data !== 'string')
            ) {
                return err(`Anthropic history contains a malformed ${block.type} block.`);
            }

            if (block.type === 'tool_use') {
                if (
                    typeof block.id !== 'string' ||
                    typeof block.name !== 'string' ||
                    !('input' in block)
                ) {
                    return err('Anthropic history contains a malformed tool-use block.');
                }

                expected.push(block.id);
            }
        }

        // Supported output blocks are valid replay input blocks. The SDK owns their full shapes;
        // the adapter has checked their discriminants and retains the objects unmodified.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        messages.push({ role: 'assistant', content: entry.data.content as ContentBlockParam[] });

        if (expected.length > 0) {
            const results: ToolResultBlockParam[] = [];

            for (const id of expected) {
                const result = history[++index];

                if (result?.kind !== 'tool_result' || result.callId !== id) {
                    return err(`Anthropic tool call ${id} needs one corresponding ordered result.`);
                }

                results.push({
                    type: 'tool_result',
                    tool_use_id: id,
                    content: result.outcome.ok ? result.outcome.value : result.outcome.error,
                    ...(result.outcome.ok ? {} : { is_error: true }),
                });
            }

            messages.push({ role: 'user', content: results });
        }
    }

    return ok({
        system: instructions.length ? instructions.join('\n\n') : undefined,
        messages,
        previousMessageId,
    });
};
