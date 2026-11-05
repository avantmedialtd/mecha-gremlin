// A run's MCP servers: those the task's mcp list names, or every enabled one without a list (D44),
// connect in parallel before the session. A required server that fails, fails the run (D33), and
// an optional one is left out (D49). Their tools follow the built-in ones, sorted, and stay fixed
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
    type Problem,
    type Row,
    type ServerConfig,
    type StdioConnection,
    resolveServer,
    runWithout,
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

/** A server as the store lists it. */
export type ServerRow = Row & {
    readonly disabled: boolean;
};

/** An optional server the run goes without, and why. */
export type LeftOut = {
    readonly name: string;
    readonly reason: string;
};

export type Started = {
    /** Sorted by name. */
    readonly tools: readonly ToolHandler[];
    /** In name order. */
    readonly leftOut: readonly LeftOut[];
};

export type McpServers = {
    /**
     * The servers the task's list names, each with a ? optional, or every enabled one without a
     * list: their tools and the optional ones left out, or every problem, each a whole message.
     */
    readonly connect: (
        rows: readonly ServerRow[],
        list?: readonly string[],
    ) => Promise<Result<Started, string[]>>;
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
    /** Closes its client and its stdio transport, once however often it's called. */
    readonly close: () => Promise<void>;
};

type Choice = {
    readonly row: ServerRow;
    readonly optional: boolean;
};

// A server whose references resolved, with the bearer of its saved login, if it has one.
type Prepared = {
    readonly server: ServerConfig;
    readonly bearer: Bearer | undefined;
    readonly optional: boolean;
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

// After a listed name, it marks a server the task can go without (D49).
const OPTIONAL = '?';

// Code-unit order, which no locale changes, as toSorted() gives strings. Names are unique, so no
// two compare equal, and `<=` sorts as `<` does.
// Stryker disable next-line EqualityOperator
const inNameOrder = (first: string, second: string): number => (first < second ? -1 : 1);

type Chosen = {
    readonly choices: readonly Choice[];
    /** The optional servers that are disabled. */
    readonly disabled: readonly LeftOut[];
    readonly problems: readonly string[];
};

// Without a list, every enabled server is required, as before a task could choose. A listed name
// the store doesn't hold fails the run, ? or not, and so does a disabled server the list
// requires, since the task says it needs it (D46).
const choose = (rows: readonly ServerRow[], list: readonly string[] | undefined): Chosen => {
    if (list === undefined) {
        return {
            choices: rows.filter((row) => !row.disabled).map((row) => ({ row, optional: false })),
            disabled: [],
            problems: [],
        };
    }

    const choices: Choice[] = [];
    const disabled: LeftOut[] = [];
    const problems: string[] = [];

    for (const item of list) {
        const optional = item.endsWith(OPTIONAL);
        const name = optional ? item.slice(0, -1) : item;
        const row = rows.find((each) => each.name === name);

        if (row === undefined) {
            problems.push(
                `The task's mcp list names ${name}, but there is no MCP server named ${name}: bun run mcp list shows them.`,
            );
        } else if (!row.disabled) {
            choices.push({ row, optional });
        } else if (optional) {
            disabled.push({ name, reason: "it's disabled" });
        } else {
            problems.push(
                `The task's mcp list names ${name}, which is disabled: runs won't start it until bun run mcp enable ${name}.`,
            );
        }
    }

    return { choices, disabled, problems };
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
        runWithout(server.name),
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
            await Promise.all(connections.map((connection) => connection.close()));
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
        let closed: Promise<void> | undefined;
        const connection: Connection = {
            server,
            client,
            stdio,
            bearer,
            redact,
            close: () => {
                closed ??= (async () => {
                    await client.close().catch(() => undefined);
                    await stdio?.close();
                })();

                return closed;
            },
        };

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

    const logConnected = (
        { connection, listing }: Connected,
        named: readonly (Offered & { readonly modelName: string })[],
    ): void => {
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
    };

    // Server by server in name order, once all have listed their tools or been left out, so that
    // parallel connects give the same log every time.
    const logServers = (
        connected: readonly Connected[],
        named: readonly (Offered & { readonly modelName: string })[],
        leftOut: readonly LeftOut[],
    ): void => {
        const records = [
            ...connected.map((each) => ({
                name: each.connection.server.name,
                write: () => logConnected(each, named),
            })),
            ...leftOut.map(({ name, reason }) => ({
                name,
                write: () => log.warn('mcp server left out', { name, reason }),
            })),
        ];
        const ordered = records.toSorted((first, second) => inNameOrder(first.name, second.name));

        for (const { write } of ordered) {
            write();
        }
    };

    // A login that has to be given again fails the run, or leaves an optional server out, as a
    // reference that can't be resolved does, before any network request (D33, D49).
    const prepare = async ({ row, optional }: Choice): Promise<Result<Prepared, Problem[]>> => {
        const resolved = resolveServer(row, parentEnv, runId);

        if (!resolved.ok) {
            return resolved;
        }

        const server = resolved.value;
        const { connection } = server;

        if (connection.transport === 'stdio') {
            return ok({ server, bearer: undefined, optional });
        }

        const found = await findLogin({
            store,
            name: server.name,
            url: connection.writtenUrl,
            owner: runId,
        });

        return found.ok ? ok({ server, bearer: found.value, optional }) : err([found.error]);
    };

    const connect = async (
        rows: readonly ServerRow[],
        list?: readonly string[],
    ): Promise<Result<Started, string[]>> => {
        const chosen = choose(rows, list);
        const prepared = await Promise.all(
            chosen.choices.map(async (choice) => ({ choice, result: await prepare(choice) })),
        );
        const problems = [...chosen.problems];
        const leftOut = [...chosen.disabled];
        let servers: Prepared[] = [];

        for (const { choice, result } of prepared) {
            if (result.ok) {
                servers.push(result.value);
            } else if (choice.optional) {
                const reason = result.error.map((problem) => problem.reason).join(' ');
                leftOut.push({ name: choice.row.name, reason });
            } else {
                problems.push(...result.error.map((problem) => problem.message));
            }
        }

        // Before any network request, and before any server starts.
        if (problems.length > 0) {
            return err(problems);
        }

        const needing = servers.filter(({ server: { connection } }) => {
            return connection.transport === 'stdio' && connection.cwd === undefined;
        });

        if (needing.length > 0) {
            const made = await makeRunDirectory(workDir, dataDir);

            if (made.ok) {
                directory = made.value;
            } else if (needing.some(({ optional }) => !optional)) {
                return err([made.error]);
            } else {
                leftOut.push(
                    ...needing.map(({ server }) => ({ name: server.name, reason: made.error })),
                );
                servers = servers.filter((each) => !needing.includes(each));
            }
        }

        // Closing may have begun meanwhile: no server starts after it.
        if (controller.signal.aborted) {
            return err([]);
        }

        const results = await Promise.all(
            servers.map(async (each) => ({
                optional: each.optional,
                result: await connectOne(each),
            })),
        );
        const connected: Connected[] = [];
        const requiredFailures: Failure[] = [];
        const optionalFailures: Failure[] = [];

        for (const { optional, result } of results) {
            if (result.ok) {
                connected.push(result.value);
            } else if (optional) {
                optionalFailures.push(result.error);
            } else {
                requiredFailures.push(result.error);
            }
        }

        if (requiredFailures.length > 0) {
            await close();

            return err(requiredFailures.map(failureMessage));
        }

        // Each closed alone, so that a stdio server's exit, read once it has closed, is the
        // reason. The shared close then finds it closed.
        const notStarted = await Promise.all(
            optionalFailures.map(async (failure) => {
                await failure.connection.close();

                return { name: failure.connection.server.name, reason: startFailure(failure) };
            }),
        );
        const ordered = [...leftOut, ...notStarted].toSorted((first, second) =>
            inNameOrder(first.name, second.name),
        );

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

        logServers(connected, named, ordered);

        const tools = named
            .toSorted((first, second) => inNameOrder(first.modelName, second.modelName))
            .map(({ modelName, tool, connection, listed }) => {
                // Not strict: Responses would otherwise try to make the server's schema strict,
                // and the model would send nulls that servers refuse (Brief R18.2).
                return defineTool(
                    {
                        name: modelName,
                        description: listed.description,
                        schema: listed.schema,
                        strict: false,
                    },
                    (args) => call(connection, tool, args),
                );
            });

        return ok({ tools, leftOut: ordered });
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
