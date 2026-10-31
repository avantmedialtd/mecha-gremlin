// `bun run mcp`: adds, lists, shows, removes, disables and enables the MCP servers a run connects
// to. It opens the store and nothing else: it never resolves a reference, nor contacts a server.
import { type Result, ok } from '@mecha-gremlin/core/result';
import {
    addMcpServer,
    listMcpServers,
    removeMcpServer,
    setMcpServerDisabled,
} from '@mecha-gremlin/store/mcp-server';
import { type Store, closeStore, openStore } from '@mecha-gremlin/store/store';
import { loadMcpConfig } from '../config/config.ts';
import { type CheckedEntry, prefixOf } from '../mcp/entry.ts';
import { type Change, type Command, readCommand } from './mcp-args.ts';
import { HELP } from './mcp-help.ts';
import {
    addedLine,
    changedLine,
    errorLine,
    listLines,
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

const get = async (store: Store, name: string): Promise<number> => {
    const listed = await listMcpServers(store);

    if (!listed.ok) {
        return fail([listed.error]);
    }

    const server = listed.value.find((candidate) => candidate.name === name);

    if (server === undefined) {
        return fail([unknown(name)]);
    }

    print(serverLines(server));

    return 0;
};

const change = async (
    store: Store,
    kind: Change,
    name: string,
): Promise<Result<boolean, string>> => {
    if (kind !== 'remove') {
        return setMcpServerDisabled(store, { name, disabled: kind === 'disable' });
    }

    const removed = await removeMcpServer(store, name);

    return removed.ok ? ok(removed.value > 0) : removed;
};

const perform = async (store: Store, command: Command): Promise<number> => {
    if (command.kind === 'add') {
        return add(store, command.name, command.checked);
    }

    if (command.kind === 'list') {
        return list(store);
    }

    if (command.kind === 'get') {
        return get(store, command.name);
    }

    const changed = await change(store, command.kind, command.name);

    if (!changed.ok) {
        return fail([changed.error]);
    }

    if (!changed.value) {
        return fail([unknown(command.name)]);
    }

    console.log(changedLine(command.kind, command.name));

    return 0;
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
