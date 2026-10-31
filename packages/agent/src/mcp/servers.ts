// A run's MCP servers: every enabled one connects, in parallel, before the session, and a server
// that fails, fails the run (D33). Their tools follow the built-in ones, sorted, and stay fixed
// for the session, for the prompt cache (Brief R3.4).
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import type { ToolOutcome } from '@mecha-gremlin/core/tools';
import type { Store } from '@mecha-gremlin/store/store';
import {
    Client,
    ProtocolError,
    SdkError,
    SdkErrorCode,
    SdkHttpError,
    type ServerCapabilities,
    StreamableHTTPClientTransport,
    type Transport,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { Env } from '../config/config.ts';
import type { Logger } from '../log/log.ts';
import { type ToolHandler, defineTool } from '../tools/tool-handler.ts';
import { type Bearer, findLogin } from './bearer.ts';
import { withModelNames } from './names.ts';
import { type Redact, redactor } from './redact.ts';
import {
    type HttpConnection,
    type Row,
    type ServerConfig,
    type StdioConnection,
    resolveServer,
} from './resolve.ts';
import { capped, flatten } from './results.ts';
import { makeRunDirectory } from './run-directory.ts';
import {
    CLOSE_LIMITS,
    type CloseLimits,
    type StdioTransport,
    createStdioTransport,
} from './stdio.ts';
import { type ListedTool, type Listing, listTools, silentValidator } from './tools.ts';

export type McpOptions = {
    /** The agent process's environment, which the servers' references resolve from. */
    readonly parentEnv: Env;
    readonly runId: string;
    readonly workDir: string;
    readonly dataDir: string;
    /** The store that holds the servers' saved logins. */
    readonly store: Store;
    readonly log: Logger;
    readonly limits?: CloseLimits;
};

export type McpServers = {
    /** The enabled servers' tools, sorted by name, or every problem, each a whole message. */
    readonly connect: (rows: readonly Row[]) => Promise<Result<ToolHandler[], string[]>>;
    /** Ends every connect and call, and closes every server, in parallel: one close, shared. */
    readonly close: () => Promise<void>;
    /** Removes the directory made for stdio servers, if one was. */
    readonly removeDirectory: () => Promise<void>;
};

// What a stdio transport tells beyond the SDK's Transport, whose callbacks the SDK sets.
type StdioView = Pick<StdioTransport, 'stderrTail' | 'exit' | 'ended' | 'close'>;

type Connection = {
    readonly server: ServerConfig;
    readonly client: Client;
    readonly stdio: StdioView | undefined;
    readonly bearer: Bearer | undefined;
    readonly redact: Redact;
};

// A server whose references resolved, with the bearer of its saved login, if it has one.
type Prepared = {
    readonly server: ServerConfig;
    readonly bearer: Bearer | undefined;
};

type Connected = {
    readonly connection: Connection;
    readonly listing: Listing;
};

type Failure = {
    readonly connection: Connection;
    /** A reason the server can't be used, or what was thrown while it started. */
    readonly error: unknown;
    /**
     * The stdio server, when it had gone as it failed, so that its exit, read once it has closed,
     * is the reason. A server that answered wrongly exits only when the failure closes it.
     */
    readonly gone: StdioView | undefined;
};

/** What each server is told the client is. */
export const CLIENT = { name: 'mecha-gremlin', version: '0.0.0' };

// Its blocks are checked one at a time, so that one malformed block doesn't lose the rest.
const CallResult = z.looseObject({});

const STDERR_LINES = 10;

// Code-unit order, which no locale changes, as toSorted() gives strings. Names are unique, so no
// two compare equal, and `<=` sorts as `<` does.
// Stryker disable next-line EqualityOperator
const inNameOrder = (first: string, second: string): number => (first < second ? -1 : 1);

// Every value, or every error, in order.
const collect = <T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> => {
    const values: T[] = [];
    const errors: E[] = [];

    for (const result of results) {
        if (result.ok) {
            values.push(result.value);
        } else {
            errors.push(result.error);
        }
    }

    return errors.length > 0 ? err(errors) : ok(values);
};

/**
 * A client as each server gets it. Strict capabilities keep the SDK's console.debug off stdout
 * (Brief R18.3), and the legacy handshake, its default, announces no capabilities.
 */
export const createClient = (): Client => {
    return new Client(CLIENT, {
        enforceStrictCapabilities: true,
        jsonSchemaValidator: silentValidator(),
    });
};

const catalogOf = (tools: readonly unknown[]): string => {
    return createHash('sha256').update(JSON.stringify(tools)).digest('hex');
};

const codeOf = (error: unknown): unknown => {
    return Object(error).code;
};

const reasonOf = (error: unknown): string => {
    return error instanceof Error ? error.message : String(error);
};

/** Why a server failed to start, without any value its references resolved to. */
const startFailure = ({ connection, error, gone }: Failure): string => {
    const { server, bearer, redact } = connection;

    // Without an authProvider, 2.4.0 reports a 401 this way, not as UnauthorizedError; with one,
    // so it reports the second 401, after a refresh.
    if (error instanceof SdkHttpError && error.data.status === 401) {
        return bearer === undefined
            ? `it needs a login: bun run mcp login ${server.name}`
            : `it refused its login's token even after a refresh: log in again with bun run mcp login ${server.name}`;
    }

    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        return `it didn't finish starting within its startupTimeoutMs of ${server.startupTimeoutMs} ms`;
    }

    const exit = gone?.exit();

    if (exit !== undefined) {
        return exit.signal === null
            ? `it exited with code ${exit.exitCode} before it was ready`
            : `it was ended by ${exit.signal} before it was ready`;
    }

    return redact(reasonOf(error));
};

// The stderr tail is complete only once the server has closed, since it lags stdout (Brief
// R18.3), and it is redacted before its last lines are taken.
const failureMessage = (failure: Failure): string => {
    const { server, stdio, redact } = failure.connection;
    const lines = redact(stdio?.stderrTail() ?? '')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(-STDERR_LINES);

    return [
        `The MCP server ${server.name} couldn't start: ${startFailure(failure)}.`,
        ...(lines.length > 0 ? ['Its stderr ended with:', ...lines] : []),
        `To run without it: bun run mcp disable ${server.name}.`,
    ].join('\n');
};

const callFailure = (
    { server, redact }: Connection,
    tool: string,
    error: unknown,
    closing: boolean,
): string => {
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout && !closing) {
        return `The call to ${tool} on the MCP server ${server.name} took longer than its toolTimeoutMs of ${server.toolTimeoutMs} ms, so it was cancelled.`;
    }

    if (error instanceof ProtocolError) {
        return `The MCP server ${server.name} refused the call to ${tool}: ${redact(error.message)}`;
    }

    return `The call to ${tool} on the MCP server ${server.name} failed: ${redact(reasonOf(error))}`;
};

type Offered = {
    readonly server: string;
    readonly prefix: string;
    readonly tool: string;
    readonly connection: Connection;
    readonly listed: ListedTool;
};

export const createMcpServers = ({
    parentEnv,
    runId,
    workDir,
    dataDir,
    store,
    log,
    limits = CLOSE_LIMITS,
}: McpOptions): McpServers => {
    // Aborted when closing begins, which ends every connect and call still in flight.
    const controller = new AbortController();
    const connections: Connection[] = [];
    let directory: string | undefined;
    let closing: Promise<void> | undefined;

    const close = (): Promise<void> => {
        closing ??= (async () => {
            controller.abort();
            await Promise.all(
                connections.map(async ({ client, stdio }) => {
                    await client.close().catch(() => undefined);
                    await stdio?.close();
                }),
            );
        })();

        return closing;
    };

    const call = async (
        connection: Connection,
        tool: string,
        args: unknown,
    ): Promise<ToolOutcome> => {
        const { server, client, redact } = connection;

        try {
            // A wall-clock limit: progress doesn't reset it, and without it the SDK would end
            // the call at 60 seconds, whatever the entry says (Brief R17.3).
            const result = await client.request(
                { method: 'tools/call', params: { name: tool, arguments: args } },
                CallResult,
                { timeout: server.toolTimeoutMs, signal: controller.signal },
            );
            const text = capped(redact(flatten(result.content, result.structuredContent)));

            return result.isError === true ? err(text) : ok(text);
        } catch (error) {
            return err(callFailure(connection, tool, error, controller.signal.aborted));
        }
    };

    // The SDK's default redirectPolicy, same-origin, keeps the headers on their origin. A login's
    // token takes the place of the entry's own Authorization header.
    const transportFor = (
        target: StdioConnection | HttpConnection,
        bearer: Bearer | undefined,
    ): { readonly transport: Transport; readonly stdio: StdioTransport | undefined } => {
        if (target.transport === 'http') {
            return {
                transport: new StreamableHTTPClientTransport(new URL(target.url), {
                    requestInit: { headers: { ...target.headers } },
                    authProvider: bearer?.provider,
                }),
                stdio: undefined,
            };
        }

        const stdio = createStdioTransport({
            program: target.program,
            args: target.args,
            // connect makes the run's directory before a stdio server without a cwd starts, so the
            // empty text, there for the type, is never used.
            // Stryker disable next-line StringLiteral
            cwd: target.cwd ?? directory ?? '',
            env: target.env,
            parentEnv,
            limits,
        });

        return { transport: stdio, stdio };
    };

    const connectOne = async ({
        server,
        bearer,
    }: Prepared): Promise<Result<Connected, Failure>> => {
        const deadline = Date.now() + server.startupTimeoutMs;
        // Every request names its own timeout: the SDK otherwise ends each one at 60 seconds.
        const remaining = (): number => deadline - Date.now();
        const { transport, stdio } = transportFor(server.connection, bearer);
        // A refresh brings new tokens, so the values are gathered for each text.
        const redact: Redact = (text) => {
            return redactor(
                bearer === undefined ? server.secrets : [...server.secrets, ...bearer.secrets()],
            )(text);
        };
        const client = createClient();
        const connection = { server, client, stdio, bearer, redact };

        connections.push(connection);
        // The tools offered stay as they are for the session; the next run sees the change.
        client.setNotificationHandler('notifications/tools/list_changed', () => {
            log.info('mcp tools changed', { name: server.name });
        });

        try {
            if (bearer !== undefined) {
                const ready = await bearer.prepare();

                if (!ready.ok) {
                    return err({ connection, error: ready.error, gone: undefined });
                }
            }

            await client.connect(transport, { timeout: remaining(), signal: controller.signal });
            const capabilities: ServerCapabilities = client.getServerCapabilities() ?? {};

            // tools/list goes only to a server that announces tools.
            const listing =
                capabilities.tools === undefined
                    ? ok({ tools: [], warnings: [], catalog: catalogOf([]) })
                    : await listTools(client, {
                          includeTools: server.includeTools,
                          excludeTools: server.excludeTools,
                          remaining,
                          signal: controller.signal,
                          redact,
                      });

            return listing.ok
                ? ok({ connection, listing: listing.value })
                : err({ connection, error: listing.error, gone: undefined });
        } catch (error) {
            // Its stdout ended, or it had stopped reading what it was sent.
            const gone =
                stdio !== undefined && (stdio.ended() || codeOf(error) === 'EPIPE')
                    ? stdio
                    : undefined;

            return err({ connection, error, gone });
        }
    };

    // Server by server in name order, once all have listed their tools, so that parallel
    // connects give the same log every time.
    const logServers = (
        connected: readonly Connected[],
        named: readonly (Offered & { readonly modelName: string })[],
    ): void => {
        const ordered = connected.toSorted((first, second) =>
            inNameOrder(first.connection.server.name, second.connection.server.name),
        );

        for (const { connection, listing } of ordered) {
            const { name, connection: target } = connection.server;
            const own = named.filter((each) => each.connection === connection);
            const definitions = own.map(({ modelName, listed }) => ({
                name: modelName,
                description: listed.description,
                parameters: listed.inputSchema,
            }));

            for (const { message, tool, reason } of listing.warnings) {
                log.warn(message, { server: name, tool, reason });
            }

            log.info('mcp server', {
                name,
                transport: target.transport,
                tools: own.map(({ modelName }) => modelName).toSorted(),
                bytes: new TextEncoder().encode(JSON.stringify(definitions)).byteLength,
                catalog: listing.catalog,
            });
        }
    };

    // A login that has to be given again fails the run as a reference that can't be resolved
    // does, before any network request (D33).
    const prepare = async (row: Row): Promise<Result<Prepared, string[]>> => {
        const resolved = resolveServer(row, parentEnv, runId);

        if (!resolved.ok) {
            return resolved;
        }

        const server = resolved.value;
        const { connection } = server;

        if (connection.transport === 'stdio') {
            return ok({ server, bearer: undefined });
        }

        const found = await findLogin({
            store,
            name: server.name,
            url: connection.writtenUrl,
            owner: runId,
        });

        return found.ok ? ok({ server, bearer: found.value }) : err([found.error]);
    };

    const connect = async (rows: readonly Row[]): Promise<Result<ToolHandler[], string[]>> => {
        const prepared = collect(await Promise.all(rows.map(prepare)));

        // Before any network request, and before any server starts.
        if (!prepared.ok) {
            return err(prepared.error.flat());
        }

        const servers = prepared.value;

        const needsDirectory = servers.some(({ server: { connection } }) => {
            return connection.transport === 'stdio' && connection.cwd === undefined;
        });

        if (needsDirectory) {
            const made = await makeRunDirectory(workDir, dataDir);

            if (!made.ok) {
                return err([made.error]);
            }

            directory = made.value;
        }

        // Closing may have begun meanwhile: no server starts after it.
        if (controller.signal.aborted) {
            return err([]);
        }

        const results = collect(await Promise.all(servers.map(connectOne)));

        if (!results.ok) {
            await close();

            return err(results.error.map(failureMessage));
        }

        const connected = results.value;

        const named = withModelNames(
            connected.flatMap(({ connection, listing }) => {
                return listing.tools.map((listed) => ({
                    server: connection.server.name,
                    prefix: connection.server.prefix,
                    tool: listed.name,
                    connection,
                    listed,
                }));
            }),
        );

        logServers(connected, named);

        return ok(
            named
                .toSorted((first, second) => inNameOrder(first.modelName, second.modelName))
                .map(({ modelName, tool, connection, listed }) => {
                    // Not strict: Responses would otherwise try to make the server's schema
                    // strict, and the model would send nulls that servers refuse (Brief R18.2).
                    return defineTool(
                        {
                            name: modelName,
                            description: listed.description,
                            schema: listed.schema,
                            strict: false,
                        },
                        (args) => call(connection, tool, args),
                    );
                }),
        );
    };

    return {
        connect,
        close,
        removeDirectory: async () => {
            if (directory !== undefined) {
                await rm(directory, { recursive: true, force: true });
            }
        },
    };
};
