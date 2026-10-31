// What `bun run mcp` prints for people: its results, for stdout, and its problems and warnings,
// for stderr.
import type { McpServer } from '@mecha-gremlin/store/mcp-server';
import { type Transport, transportOfEntry } from '../mcp/entry.ts';
import type { Change } from './mcp-args.ts';
import { durationOf } from './mcp-time.ts';

type Fields = ReadonlyMap<string, unknown>;

type Row = readonly [label: string, value: string];

/** A remote server's login, as `get` shows it. */
export type LoginState = 'yes' | 'no' | 'needs a new login';

const NO_SERVERS =
    'There are no MCP servers. Add one with bun run mcp add <name> <url>, or bun run mcp add <name> -- <command> [args…].';

// What a shell would split a word at, or take out of it.
const SPLITS = /[ '"]/;

const notStarted = (name: string): string => {
    return `Runs won't start it until bun run mcp enable ${name}.`;
};

export const errorLine = (problem: string): string => {
    return `error: ${problem}`;
};

export const warningLine = (reason: string): string => {
    return `warning: ${reason}`;
};

export const addedLine = (name: string, transport: Transport, disabled: boolean): string => {
    const added = `Added ${name} (${transport}).`;

    return disabled ? `${added} ${notStarted(name)}` : added;
};

/** What to do with the authorization URL, which the login then waits on. */
export const authorizeLines = (name: string, url: string): string[] => {
    return [
        `Open this address in a browser, and sign in to ${name}:`,
        '',
        url,
        '',
        "If the browser can't reach this machine, as over SSH, paste here the address it ends on, and press Enter. The login waits 5 minutes.",
    ];
};

export const loggedInLine = (name: string, tools: number): string => {
    return `Logged in to ${name}: ${tools} ${tools === 1 ? 'tool' : 'tools'}.`;
};

export const loggedOutLine = (name: string, deleted: number): string => {
    return deleted > 0 ? `Logged out of ${name}.` : `${name} has no login.`;
};

export const changedLine = (change: Change, name: string): string => {
    switch (change) {
        case 'remove':
            return `Removed ${name}.`;
        case 'disable':
            return `Disabled ${name}. ${notStarted(name)}`;
        case 'enable':
            return `Enabled ${name}.`;
    }
};

// Each column but the last padded to its widest cell, two spaces apart.
const tabulate = (rows: readonly (readonly string[])[]): string[] => {
    const widths = rows.reduce<readonly number[]>((widest, row) => {
        return row.map((cell, index) => Math.max(cell.length, widest[index] ?? 0));
    }, []);

    return rows.map((row) => {
        return row
            .map((cell, index) =>
                index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0),
            )
            .join('  ');
    });
};

// A stored entry's own fields. A row written into the database by hand may hold any JSON, even
// null, which mustn't stop the command.
const fieldsOf = (entry: object): Fields => {
    return new Map(Object.entries(entry ?? {}));
};

const textOf = (fields: Fields, field: string): string | undefined => {
    const value = fields.get(field);

    return typeof value === 'string' ? value : undefined;
};

const pairsOf = (fields: Fields, field: string): [string, unknown][] => {
    return Object.entries(fields.get(field) ?? {});
};

const toolsOf = (fields: Fields, field: string): string | undefined => {
    const value: unknown = fields.get(field);

    return Array.isArray(value) ? value.join(', ') : undefined;
};

const timeoutOf = (fields: Fields, field: string): string | undefined => {
    const value = fields.get(field);

    return typeof value === 'number' ? durationOf(value) : undefined;
};

// As a shell would read it back: a word that holds a space or a quote, or nothing at all, in
// single quotes, with each ' in it closing them, escaped, and opening them again.
const wordOf = (word: string): string => {
    return word === '' || SPLITS.test(word) ? `'${word.replaceAll("'", "'\\''")}'` : word;
};

const commandLineOf = (fields: Fields): string | undefined => {
    const command = fields.get('command');
    const args = fields.get('args');
    const words: unknown[] = Array.isArray(args) ? args : [];

    return typeof command === 'string'
        ? [command, ...words].map((word) => wordOf(String(word))).join(' ')
        : undefined;
};

const optional = (label: string, value: string | undefined): Row[] => {
    return value === undefined ? [] : [[label, value]];
};

/** The servers as a table, in the order given, or a line saying there are none. */
export const listLines = (servers: readonly McpServer[]): string[] => {
    if (servers.length === 0) {
        return [NO_SERVERS];
    }

    return tabulate([
        ['NAME', 'TRANSPORT', 'TARGET', 'ENABLED'],
        ...servers.map(({ name, entry, disabled }) => {
            const fields = fieldsOf(entry);

            return [
                name,
                transportOfEntry(entry) ?? '-',
                textOf(fields, 'url') ?? commandLineOf(fields) ?? '-',
                disabled ? 'no' : 'yes',
            ];
        }),
    ]);
};

/**
 * One server's settings, with references as written, its login when it is a remote one, and how
 * to change them.
 */
export const serverLines = (
    { name, entry, disabled }: McpServer,
    login: LoginState | undefined,
): string[] => {
    const fields = fieldsOf(entry);
    const rows: Row[] = [
        ['Transport', transportOfEntry(entry) ?? '-'],
        ...optional('URL', textOf(fields, 'url')),
        ...pairsOf(fields, 'headers').map(([header, value]): Row => {
            return ['Header', `${header}: ${String(value)}`];
        }),
        ...optional('Command', commandLineOf(fields)),
        ...pairsOf(fields, 'env').map(([variable, value]): Row => {
            return ['Variable', `${variable}=${String(value)}`];
        }),
        ...optional('Working directory', textOf(fields, 'cwd')),
        ...optional('Include tools', toolsOf(fields, 'includeTools')),
        ...optional('Exclude tools', toolsOf(fields, 'excludeTools')),
        ...optional('Startup timeout', timeoutOf(fields, 'startupTimeoutMs')),
        ...optional('Tool timeout', timeoutOf(fields, 'toolTimeoutMs')),
        ...optional('Login', login),
        ['Enabled', disabled ? 'no' : 'yes'],
    ];

    return [
        name,
        ...tabulate(rows).map((line) => `  ${line}`),
        `To change it, remove it with bun run mcp remove ${name}, then add it again.`,
    ];
};
