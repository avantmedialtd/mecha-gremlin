// `bun run mcp`: adds, lists, removes, disables and enables the MCP servers a run connects to.
// It opens the store and nothing else: it never resolves a reference, nor contacts a server.
import { text } from 'node:stream/consumers';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import {
    type McpServer,
    addMcpServer,
    listMcpServers,
    removeMcpServer,
    setMcpServerDisabled,
} from '@mecha-gremlin/store/mcp-server';
import { type Store, closeStore, openStore } from '@mecha-gremlin/store/store';
import { loadLogFormat, loadMcpConfig } from '../config/config.ts';
import { type Logger, createLogger } from '../log/log.ts';
import {
    type CheckedEntry,
    checkEntry,
    checkName,
    prefixOf,
    transportOfEntry,
} from '../mcp/entry.ts';
import { jsonOf, parseJson } from '../mcp/json.ts';
import { HELP } from './mcp-help.ts';

type Change = 'remove' | 'disable' | 'enable';

type Command =
    | { readonly kind: 'add'; readonly name: string; readonly entry: string }
    | { readonly kind: 'list' }
    | { readonly kind: Change; readonly name: string };

// What a command does, once its entry, if it has one, has been read and checked.
type Task =
    | { readonly kind: 'add'; readonly name: string; readonly checked: CheckedEntry }
    | Exclude<Command, { readonly kind: 'add' }>;

const SUBCOMMANDS = 'add <name> <entry>, list, remove <name>, disable <name> or enable <name>';

const SEE_HELP = 'bun run mcp help explains the command.';

const HELP_WORDS = new Set(['help', '--help', '-h']);

const DONE = {
    remove: 'mcp server removed',
    disable: 'mcp server disabled',
    enable: 'mcp server enabled',
} as const;

// Two strings, which TypeScript can't tell from the length alone.
const isPair = (values: readonly string[]): values is readonly [string, string] => {
    return values.length === 2;
};

// The exit code of a request for help: 0 when it was asked for, and 1 when the command was run
// bare, since nothing was done. Anything else isn't one.
const helpExitCode = (args: readonly string[]): number | undefined => {
    const [first] = args;

    if (first === undefined) {
        return 1;
    }

    return HELP_WORDS.has(first) ? 0 : undefined;
};

const parseCommand = (args: readonly string[]): Result<Command, string> => {
    const [subcommand, first, ...rest] = args;

    switch (subcommand) {
        case 'add': {
            const operands = args.slice(1);

            return isPair(operands)
                ? ok({ kind: 'add', name: operands[0], entry: operands[1] })
                : err(
                      `add takes a name and an entry: bun run mcp add <name> <entry>, with - as the entry to read it from stdin. ${SEE_HELP}`,
                  );
        }
        case 'list':
            return first === undefined
                ? ok({ kind: 'list' })
                : err(`list takes no arguments. ${SEE_HELP}`);
        case 'remove':
        case 'disable':
        case 'enable':
            return first === undefined || rest.length > 0
                ? err(
                      `${subcommand} takes a server's name: bun run mcp ${subcommand} <name>. ${SEE_HELP}`,
                  )
                : ok({ kind: subcommand, name: first });
        default:
            return err(`Give one of the subcommands: ${SUBCOMMANDS}. ${SEE_HELP}`);
    }
};

// An entry of `-` comes from stdin, which keeps it out of the shell's history, the process list
// and the command line that `bun run` echoes.
const prepare = async (command: Command): Promise<Result<Task, string[]>> => {
    if (command.kind !== 'add') {
        return ok(command);
    }

    const { name, entry } = command;
    const parsed = parseJson(entry === '-' ? await text(process.stdin) : entry);
    const checked = parsed.value === undefined ? err([]) : checkEntry(parsed.value);
    const problems = [...checkName(name), ...parsed.problems, ...(checked.ok ? [] : checked.error)];

    return checked.ok && problems.length === 0
        ? ok({ kind: 'add', name, checked: checked.value })
        : err(problems);
};

const add = async (
    store: Store,
    name: string,
    { entry, stored, disabled, warnings }: CheckedEntry,
    log: Logger,
): Promise<number> => {
    const prefix = prefixOf(name);
    const listed = await listMcpServers(store);

    if (!listed.ok) {
        log.error(listed.error);

        return 1;
    }

    // The store refuses both too, but only these errors can name the other server.
    const sharing = listed.value.find((server) => server.prefix === prefix);

    if (sharing?.name === name) {
        log.error(
            `The MCP server ${name} exists. To change it, remove it with bun run mcp remove ${name}, then add it again.`,
        );

        return 1;
    }

    if (sharing !== undefined) {
        log.error(
            `The tools of ${name} would share the prefix ${prefix} with those of the MCP server ${sharing.name}: give it another name.`,
        );

        return 1;
    }

    const added = await addMcpServer(store, { name, prefix, entry: stored, disabled });

    if (!added.ok) {
        log.error(added.error);

        return 1;
    }

    for (const { message, reason } of warnings) {
        log.warn(message, { name, reason });
    }

    log.info('mcp server added', { name, transport: entry.transport });

    return 0;
};

const list = (servers: readonly McpServer[], log: Logger): void => {
    if (servers.length === 0) {
        log.info('no mcp servers');
    }

    for (const { name, entry, disabled } of servers) {
        log.info('mcp server', {
            name,
            transport: transportOfEntry(entry),
            disabled,
            entry: jsonOf(entry),
        });
    }
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

const perform = async (store: Store, task: Task, log: Logger): Promise<number> => {
    if (task.kind === 'add') {
        return add(store, task.name, task.checked, log);
    }

    if (task.kind === 'list') {
        const listed = await listMcpServers(store);

        if (listed.ok) {
            list(listed.value, log);
        } else {
            log.error(listed.error);
        }

        return listed.ok ? 0 : 1;
    }

    const changed = await change(store, task.kind, task.name);

    if (!changed.ok) {
        log.error(changed.error);
    } else if (changed.value) {
        log.info(DONE[task.kind], { name: task.name });
    } else {
        log.error(`There is no MCP server named ${task.name}: bun run mcp list shows them.`);
    }

    return changed.ok && changed.value ? 0 : 1;
};

const run = async (args: readonly string[]): Promise<number> => {
    const help = helpExitCode(args);

    // Plain text, whatever LOG_FORMAT is, before any setting is read: help may be the first thing
    // anyone runs, and a question shouldn't create a database.
    if (help !== undefined) {
        console.log(HELP);

        return help;
    }

    // An invalid LOG_FORMAT is one of the errors loadMcpConfig reports, which still need a format.
    const log = createLogger(loadLogFormat(process.env) ?? 'pretty');
    const loaded = loadMcpConfig(process.env);
    const parsed = parseCommand(args);

    if (!loaded.ok || !parsed.ok) {
        for (const problem of [
            ...(loaded.ok ? [] : loaded.error),
            ...(parsed.ok ? [] : [parsed.error]),
        ]) {
            log.error(problem);
        }

        return 1;
    }

    // Before the store opens: every problem with an entry is reported together.
    const prepared = await prepare(parsed.value);

    if (!prepared.ok) {
        for (const problem of prepared.error) {
            log.error(problem);
        }

        return 1;
    }

    const opened = await openStore(loaded.value.dataDir);

    if (!opened.ok) {
        log.error(opened.error);

        return 1;
    }

    const { store, migrated } = opened.value;

    if (migrated.length > 0) {
        log.info('migrated', { names: migrated });
    }

    try {
        return await perform(store, prepared.value, log);
    } finally {
        await closeStore(store);
    }
};

process.exitCode = await run(process.argv.slice(2));
