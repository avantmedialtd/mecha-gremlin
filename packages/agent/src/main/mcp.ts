// `bun run mcp`: adds, lists, shows, removes, disables and enables the MCP servers a run connects
// to, and logs in to them and out. Only `login` resolves references and contacts a server; every
// other subcommand opens the store and nothing else.
import { type Result, ok } from '@mecha-gremlin/core/result';
import { deleteCredentials, findCredentials } from '@mecha-gremlin/store/credential';
import {
    type McpServer,
    addMcpServer,
    listMcpServers,
    removeMcpServer,
    setMcpServerDisabled,
} from '@mecha-gremlin/store/mcp-server';
import { type Store, closeStore, openStore } from '@mecha-gremlin/store/store';
import { loadMcpConfig } from '../config/config.ts';
import { type CheckedEntry, prefixOf, transportOfEntry, urlOfEntry } from '../mcp/entry.ts';
import { logIn } from '../mcp/login.ts';
import { resolve } from '../mcp/references.ts';
import { resolveServer } from '../mcp/resolve.ts';
import { type Command, type Login, readCommand } from './mcp-args.ts';
import { HELP } from './mcp-help.ts';
import {
    type LoginState,
    addedLine,
    authorizeLines,
    changedLine,
    errorLine,
    listLines,
    loggedInLine,
    loggedOutLine,
    serverLines,
    warningLine,
} from './mcp-output.ts';

const HELP_WORDS = new Set(['help', '--help', '-h']);

// The exit code of a request for help: 0 when it was asked for, and 1 when the command was run
// bare, since nothing was done. Anything else isn't one.
const helpExitCode = (args: readonly string[]): number | undefined => {
    const [first] = args;

    if (first === undefined) {
        return 1;
    }

    return HELP_WORDS.has(first) ? 0 : undefined;
};

const print = (lines: readonly string[]): void => {
    console.log(lines.join('\n'));
};

const fail = (problems: readonly string[]): number => {
    for (const problem of problems) {
        console.error(errorLine(problem));
    }

    return 1;
};

const unknown = (name: string): string => {
    return `There is no MCP server named ${name}: bun run mcp list shows them.`;
};

const local = (name: string): string => {
    return `The MCP server ${name} is a local one, and a local server has no OAuth login: what it needs comes from its env and its arguments.`;
};

const find = async (store: Store, name: string): Promise<Result<McpServer | undefined, string>> => {
    const listed = await listMcpServers(store);

    return listed.ok ? ok(listed.value.find((candidate) => candidate.name === name)) : listed;
};

const add = async (
    store: Store,
    name: string,
    { entry, stored, disabled, warnings }: CheckedEntry,
): Promise<number> => {
    const prefix = prefixOf(name);
    const listed = await listMcpServers(store);

    if (!listed.ok) {
        return fail([listed.error]);
    }

    // The store refuses both too, but only these errors can name the other server.
    const sharing = listed.value.find((server) => server.prefix === prefix);

    if (sharing?.name === name) {
        return fail([
            `The MCP server ${name} exists. To change it, remove it with bun run mcp remove ${name}, then add it again.`,
        ]);
    }

    if (sharing !== undefined) {
        return fail([
            `The tools of ${name} would share the prefix ${prefix} with those of the MCP server ${sharing.name}: give it another name.`,
        ]);
    }

    const added = await addMcpServer(store, { name, prefix, entry: stored, disabled });

    if (!added.ok) {
        return fail([added.error]);
    }

    // Before the result, so that they aren't missed.
    for (const { reason } of warnings) {
        console.error(warningLine(reason));
    }

    console.log(addedLine(name, entry.transport, disabled));

    return 0;
};

const list = async (store: Store): Promise<number> => {
    const listed = await listMcpServers(store);

    if (!listed.ok) {
        return fail([listed.error]);
    }

    print(listLines(listed.value));

    return 0;
};

// The most recently saved row is the one a run uses.
const loginState = async (
    store: Store,
    name: string,
    url: string,
): Promise<Result<LoginState, string>> => {
    const found = await findCredentials(store, { server: name, url });

    if (!found.ok) {
        return found;
    }

    const [row] = found.value;

    if (row === undefined) {
        return ok('no');
    }

    return ok(row.needsLogin ? 'needs a new login' : 'yes');
};

const get = async (store: Store, name: string): Promise<number> => {
    const found = await find(store, name);

    if (!found.ok) {
        return fail([found.error]);
    }

    const server = found.value;

    if (server === undefined) {
        return fail([unknown(name)]);
    }

    const url = urlOfEntry(server.entry);
    const login = url === undefined ? ok(undefined) : await loginState(store, name, url);

    if (!login.ok) {
        return fail([login.error]);
    }

    print(serverLines(server, login.value));

    return 0;
};

// A remote server's saved logins, which outlive neither a logout nor the server.
const forget = async (store: Store, server: McpServer): Promise<Result<number, string>> => {
    const url = urlOfEntry(server.entry);

    return url === undefined ? ok(0) : deleteCredentials(store, { server: server.name, url });
};

const logout = async (store: Store, name: string): Promise<number> => {
    const found = await find(store, name);

    if (!found.ok) {
        return fail([found.error]);
    }

    const server = found.value;

    if (server === undefined) {
        return fail([unknown(name)]);
    }

    const forgotten = await forget(store, server);

    if (!forgotten.ok) {
        return fail([forgotten.error]);
    }

    console.log(loggedOutLine(name, forgotten.value));

    return 0;
};

const remove = async (store: Store, name: string): Promise<number> => {
    const found = await find(store, name);

    if (!found.ok) {
        return fail([found.error]);
    }

    const server = found.value;

    if (server === undefined) {
        return fail([unknown(name)]);
    }

    // The logins first: a server added again under its name and URL mustn't find them.
    const forgotten = await forget(store, server);
    const removed = forgotten.ok ? await removeMcpServer(store, name) : forgotten;

    if (!removed.ok) {
        return fail([removed.error]);
    }

    console.log(changedLine('remove', name));

    return 0;
};

const login = async (store: Store, name: string, given: Login): Promise<number> => {
    const found = await find(store, name);

    if (!found.ok) {
        return fail([found.error]);
    }

    const server = found.value;

    if (server === undefined) {
        return fail([unknown(name)]);
    }

    // A login has no run, but the server's references resolve as a run's do; a run ID of its own
    // keeps a local server's environment as a run's would be.
    const resolved = resolveServer(server, process.env, crypto.randomUUID());

    if (!resolved.ok) {
        return fail(transportOfEntry(server.entry) === 'stdio' ? [local(name)] : resolved.error);
    }

    const { connection } = resolved.value;

    if (connection.transport === 'stdio') {
        return fail([local(name)]);
    }

    const secret =
        given.clientSecret === undefined ? undefined : resolve(given.clientSecret, process.env);
    const missing = secret?.missing ?? [];

    if (missing.length > 0) {
        return fail(
            missing.map((variable) => {
                return `--client-secret refers to ${variable}, which is unset or blank: set it in .env.`;
            }),
        );
    }

    const logged = await logIn({
        store,
        server: resolved.value,
        connection,
        clientId: given.clientId,
        clientSecret: secret?.text,
        redirectUri: given.redirectUri,
        scope: given.scope,
        input: process.stdin,
        show: (url) => {
            print(authorizeLines(name, url));
        },
        warn: (text) => {
            console.error(warningLine(text));
        },
    });

    if (!logged.ok) {
        return fail([logged.error]);
    }

    console.log(loggedInLine(name, logged.value));

    return 0;
};

const toggle = async (store: Store, kind: 'disable' | 'enable', name: string): Promise<number> => {
    const changed = await setMcpServerDisabled(store, { name, disabled: kind === 'disable' });

    if (!changed.ok) {
        return fail([changed.error]);
    }

    if (!changed.value) {
        return fail([unknown(name)]);
    }

    console.log(changedLine(kind, name));

    return 0;
};

const perform = (store: Store, command: Command): Promise<number> => {
    switch (command.kind) {
        case 'add':
            return add(store, command.name, command.checked);
        case 'list':
            return list(store);
        case 'get':
            return get(store, command.name);
        case 'remove':
            return remove(store, command.name);
        case 'login':
            return login(store, command.name, command.login);
        case 'logout':
            return logout(store, command.name);
        case 'disable':
        case 'enable':
            return toggle(store, command.kind, command.name);
    }
};

const run = async (args: readonly string[]): Promise<number> => {
    const help = helpExitCode(args);

    // Before any setting is read: help may be the first thing anyone runs, and a question
    // shouldn't create a database.
    if (help !== undefined) {
        console.log(HELP);

        return help;
    }

    const loaded = loadMcpConfig(process.env);
    const command = readCommand(args);

    if (!loaded.ok || !command.ok) {
        return fail([...(loaded.ok ? [] : loaded.error), ...(command.ok ? [] : command.error)]);
    }

    const opened = await openStore(loaded.value.dataDir);

    if (!opened.ok) {
        return fail([opened.error]);
    }

    const { store } = opened.value;

    try {
        return await perform(store, command.value);
    } finally {
        await closeStore(store);
    }
};

process.exitCode = await run(process.argv.slice(2));
