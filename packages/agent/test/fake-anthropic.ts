type Reply =
    | { readonly text: string }
    | { readonly name: string; readonly args: unknown; readonly id?: string };

/**
 * A native streamed Messages reply, with no network or live API credentials. Like the API's, its
 * usage leaves out the fields that don't apply to the reply.
 */
export const claudeReply = (reply: Reply): Response => {
    const isTool = 'name' in reply;
    const events = [
        {
            type: 'message_start',
            message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-test',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                stop_details: null,
                container: null,
                diagnostics: null,
                usage: {
                    input_tokens: 10,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
                    service_tier: 'standard',
                },
            },
        },
        isTool
            ? {
                  type: 'content_block_start',
                  index: 0,
                  content_block: {
                      type: 'tool_use',
                      id: reply.id ?? 'call_1',
                      name: reply.name,
                      input: {},
                      caller: { type: 'direct' },
                  },
              }
            : {
                  type: 'content_block_start',
                  index: 0,
                  content_block: { type: 'text', text: '', citations: null },
              },
        isTool
            ? {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.args) },
              }
            : {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: reply.text },
              },
        { type: 'content_block_stop', index: 0 },
        {
            type: 'message_delta',
            delta: {
                stop_reason: isTool ? 'tool_use' : 'end_turn',
                stop_sequence: null,
                stop_details: null,
                container: null,
            },
            usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
    ];

    return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
    );
};
