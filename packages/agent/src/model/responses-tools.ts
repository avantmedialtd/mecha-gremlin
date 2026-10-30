import { type Reply, type Tool, toolJsonSchema } from '@mecha-gremlin/core/tools';
import type { FunctionTool, ResponseOutputItem } from 'openai/resources/responses/responses';

/**
 * Responses uses strict function tools, unless a tool says it isn't strict: left unset, Responses
 * would try to make its schema strict (Brief R18.2). LM Studio ignores the strict flag.
 */
export const toFunctionTool = (tool: Tool): FunctionTool => {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: toolJsonSchema(tool),
        strict: tool.strict !== false,
    };
};

/** Calls win over text. A refusal is an answer rather than an empty reply. */
export const classify = (output: readonly ResponseOutputItem[]): Reply => {
    const calls = output.filter(
        (item): item is Extract<ResponseOutputItem, { type: 'function_call' }> =>
            item.type === 'function_call',
    );

    if (calls.length > 0) {
        return {
            kind: 'calls',
            calls: calls.map(({ call_id, name, arguments: args }) => ({
                call_id,
                name,
                arguments: args,
            })),
        };
    }

    let text = '';

    for (const item of output) {
        if (item.type !== 'message') {
            continue;
        }

        for (const part of item.content) {
            text += part.type === 'refusal' ? part.refusal : part.text;
        }
    }

    text = text.trim();

    return text === '' ? { kind: 'empty' } : { kind: 'final', text };
};
