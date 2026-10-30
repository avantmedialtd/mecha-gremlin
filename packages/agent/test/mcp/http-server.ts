// An in-process MCP server over Streamable HTTP, on 127.0.0.1, for the client's tests: the SDK's
// McpServer behind node:http, which both runtimes have.
import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    type CallToolResult,
    McpServer,
    WebStandardStreamableHTTPServerTransport,
    fromJsonSchema,
} from '@modelcontextprotocol/server';

export type FakeTool = {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: Readonly<Record<string, unknown>>;
    readonly call: (args: unknown) => Promise<CallToolResult> | CallToolResult;
};

export type RecordedHttp = {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
};

export type HttpOptions = {
    readonly tools?: readonly FakeTool[];
    /** Answers a request before the MCP server does, when it gives a response. */
    readonly answer?: (
        request: RecordedHttp,
    ) => Promise<Response | undefined> | Response | undefined;
};

export type FakeHttp = {
    /** The MCP endpoint, on 127.0.0.1. */
    readonly url: string;
    readonly requests: readonly RecordedHttp[];
    readonly close: () => Promise<void>;
};

const OPEN = { type: 'object', properties: {} };

// Reading a request consumes it, so it can't be taken as readonly.
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types
const recordOf = async (request: IncomingMessage): Promise<RecordedHttp> => {
    let body = '';
    request.setEncoding('utf8');

    for await (const chunk of request) {
        body += String(chunk);
    }

    return {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: Object.fromEntries(
            Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
        ),
        body,
    };
};

export const startHttpServer = async ({
    tools = [],
    answer,
}: HttpOptions = {}): Promise<FakeHttp> => {
    const servers: McpServer[] = [];
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const requests: RecordedHttp[] = [];

    // A server and a transport for each session: a transport takes one initialize.
    const session = async (id: string | undefined) => {
        const known = id === undefined ? undefined : sessions.get(id);

        if (known !== undefined) {
            return known;
        }

        const mcp = new McpServer({ name: 'fake-http', version: '1.0.0' });

        for (const { name, description, inputSchema = OPEN, call } of tools) {
            mcp.registerTool(
                name,
                { description, inputSchema: fromJsonSchema(inputSchema) },
                (args) => call(args),
            );
        }

        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (started) => {
                sessions.set(started, transport);
            },
        });
        await mcp.connect(transport);
        servers.push(mcp);

        return transport;
    };

    const server: Server = createServer((incoming, outgoing) => {
        void (async () => {
            const recorded = await recordOf(incoming);
            requests.push(recorded);
            const transport = await session(recorded.headers['mcp-session-id']);
            // No stream of the server's own messages: the client takes 405 for that.
            const response =
                (await answer?.(recorded)) ??
                (recorded.method === 'GET'
                    ? new Response(null, { status: 405 })
                    : await transport.handleRequest(
                          new Request(`http://127.0.0.1${recorded.url}`, {
                              method: recorded.method,
                              headers: recorded.headers,
                              body: recorded.body === '' ? undefined : recorded.body,
                          }),
                      ));
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
        })();
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = server.address() as AddressInfo;
    let closing: Promise<void> | undefined;

    return {
        url: `http://127.0.0.1:${port}/mcp`,
        requests,
        close: () => {
            closing ??= (async () => {
                server.closeAllConnections();
                await new Promise((resolve) => {
                    server.close(resolve);
                });
                await Promise.all(servers.map((each) => each.close()));
            })();

            return closing;
        },
    };
};
