// The `mcp` command's arguments: a subcommand and its operands, for `add` a server described with
// flags, as `claude mcp add` takes them, and for `login` the client to log in with. `add` turns
// the flags into the `mcpServers` entry that it stored before there were flags, and checks that
// entry as before.
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { type CheckedEntry, checkEntry, checkName } from '../mcp/entry.ts';
import { loopbackUri } from '../mcp/redirect.ts';
import { type Template, hasReference, parseTemplate } from '../mcp/references.ts';
import { ADVICE } from '../mcp/secrets.ts';
import { readTime } from './mcp-time.ts';
import { parse } from './options.ts';

export type Change = 'remove' | 'disable' | 'enable';

/** The client `login` is given, if any, and the scope it asks for. */
export type Login = {
    readonly clientId: string | undefined;
    /** `--client-secret`'s reference, which the login resolves. */
    readonly clientSecret: Template | undefined;
    readonly redirectUri: URL | undefined;
    readonly scope: string | undefined;
};

export type Command =
    | { readonly kind: 'add'; readonly name: string; readonly checked: CheckedEntry }
    | { readonly kind: 'list' }
    | { readonly kind: 'get' | 'logout' | Change; readonly name: string }
    | { readonly kind: 'login'; readonly name: string; readonly login: Login };

type Read<T> = {
    readonly value: T;
    readonly problems: readonly string[];
};

/** A header or a variable: its name, and its value as written. */
type Pair = readonly [name: string, value: string];

type Target =
    | { readonly kind: 'remote'; readonly name: string; readonly url: string }
    | {
          readonly kind: 'local';
          readonly name: string;
          readonly command: string;
          readonly args: readonly string[];
      };

type Flags = {
    readonly headers: readonly Pair[];
    readonly env: readonly Pair[];
    readonly cwd: string | undefined;
    readonly includeTools: readonly string[] | undefined;
    readonly excludeTools: readonly string[] | undefined;
    readonly startupTimeoutMs: number;
    readonly toolTimeoutMs: number;
    readonly disabled: boolean | undefined;
};

const SEE_HELP = 'bun run mcp help explains the command.';

const SUBCOMMANDS =
    'add <name> <url>, add <name> -- <command>, list, get <name>, remove <name>, disable <name>, enable <name>, login <name> or logout <name>';

const FORMS =
    'bun run mcp add <name> <url> [options], or bun run mcp add <name> [options] -- <command> [args…]';

const SHAPE = `add takes a server's name, and then a URL or, after --, a command: ${FORMS}. ${SEE_HELP}`;

const NOT_URL = `The second argument isn't a URL. A remote server's URL begins with https:// or http://, and a local server's command comes after --: ${FORMS}. ${SEE_HELP}`;

const FOR_LOCAL = 'is for a local server only, whose command comes after --.';

const FOR_REMOTE = 'is for a remote server only, whose URL follows its name.';

const UNKNOWN_IN_ADD = `A local server's command, with its own options, comes after --: bun run mcp add <name> [options] -- <command> [args…]. ${SEE_HELP}`;

const ADD_OPTIONS = {
    header: { type: 'string', multiple: true },
    env: { type: 'string', multiple: true },
    cwd: { type: 'string' },
    'include-tool': { type: 'string', multiple: true },
    'exclude-tool': { type: 'string', multiple: true },
    'startup-timeout': { type: 'string' },
    'tool-timeout': { type: 'string' },
    disabled: { type: 'boolean' },
} as const;

const LOGIN_OPTIONS = {
    'client-id': { type: 'string' },
    'client-secret': { type: 'string' },
    'redirect-uri': { type: 'string' },
    scope: { type: 'string' },
} as const;

const LOGIN_SHAPE = `login takes a server's name, and its options: bun run mcp login <name> [options]. ${SEE_HELP}`;

const REDIRECT_URI =
    '--redirect-uri must be an http address on 127.0.0.1 or localhost, with its port, as in http://127.0.0.1:8765/callback.';

const STARTUP_TIMEOUT_MS = 30_000;

const TOOL_TIMEOUT_MS = 120_000;

const URL_START = /^https?:\/\//;

// The command is undefined when there's no --, and empty when nothing follows it.
const targetOf = (
    operands: readonly string[],
    command: readonly string[] | undefined,
): Result<Target, string> => {
    const [name, url, ...extra] = operands;

    if (name === undefined || extra.length > 0) {
        return err(SHAPE);
    }

    if (command !== undefined) {
        const [program, ...args] = command;

        return url === undefined && program !== undefined
            ? ok({ kind: 'local', name, command: program, args })
            : err(SHAPE);
    }

    if (url === undefined) {
        return err(SHAPE);
    }

    return URL_START.test(url) ? ok({ kind: 'remote', name, url }) : err(NOT_URL);
};

// Names given twice, which an entry's object would keep only once.
const twice = (option: string, pairs: readonly Pair[]): string[] => {
    const names = pairs.map(([name]) => name);
    const repeated = names.filter((name, index) => names.indexOf(name) !== index);

    return [...new Set(repeated)].map((name) => `${option} names ${JSON.stringify(name)} twice.`);
};

// `Name: value`, split at the first colon, the value without the spaces around it.
const headersOf = (texts: readonly string[]): Read<readonly Pair[]> => {
    const headers = texts.flatMap((text): Pair[] => {
        const colon = text.indexOf(':');

        return colon === -1 ? [] : [[text.slice(0, colon), text.slice(colon + 1).trim()]];
    });

    return {
        value: headers,
        problems: [
            ...(headers.length === texts.length
                ? []
                : ["A --header has no colon: give each as --header 'Name: value'."]),
            ...twice('--header', headers),
        ],
    };
};

// `NAME=value`, split at the first =. `NAME` alone passes the agent's own variable through, as
// Docker's `-e NAME` does.
const envOf = (texts: readonly string[]): Read<readonly Pair[]> => {
    const env = texts.map((text): Pair => {
        const equals = text.indexOf('=');

        return equals === -1
            ? [text, `\${${text}}`]
            : [text.slice(0, equals), text.slice(equals + 1)];
    });
    const named = env.filter(([name]) => name !== '');

    return {
        value: named,
        problems: [
            ...(named.length === env.length
                ? []
                : [
                      "An --env has no variable's name: give each as --env NAME=value, or --env NAME.",
                  ]),
            ...twice('--env', named),
        ],
    };
};

// A time that can't be read is reported, and the default stands in for it in the entry, which is
// then checked for its other problems.
const timeoutOf = (option: string, text: string | undefined, fallback: number): Read<number> => {
    if (text === undefined) {
        return { value: fallback, problems: [] };
    }

    const time = readTime(option, text);

    return time.ok
        ? { value: time.value, problems: [] }
        : { value: fallback, problems: [time.error] };
};

const misplaced = (
    target: Target,
    given: {
        readonly header?: readonly string[];
        readonly env?: readonly string[];
        readonly cwd?: string;
    },
): string[] => {
    if (target.kind === 'local') {
        return given.header === undefined ? [] : [`--header ${FOR_REMOTE}`];
    }

    return [
        ...(given.env === undefined ? [] : [`--env ${FOR_LOCAL}`]),
        ...(given.cwd === undefined ? [] : [`--cwd ${FOR_LOCAL}`]),
    ];
};

const objectOf = (pairs: readonly Pair[]): object | undefined => {
    return pairs.length > 0 ? Object.fromEntries(pairs) : undefined;
};

// Each field only when it was given, and both timeouts always, so that a run needs no defaults
// of its own. Object.fromEntries defines each name as an own property, so that a variable named
// __proto__ is a variable like any other.
const entryOf = (target: Target, flags: Flags): object => {
    const fields: (readonly [string, unknown])[] =
        target.kind === 'remote'
            ? [
                  ['url', target.url],
                  ['headers', objectOf(flags.headers)],
              ]
            : [
                  ['command', target.command],
                  ['args', target.args.length > 0 ? target.args : undefined],
                  ['env', objectOf(flags.env)],
                  ['cwd', flags.cwd],
              ];

    return Object.fromEntries(
        [
            ...fields,
            ['includeTools', flags.includeTools],
            ['excludeTools', flags.excludeTools],
            ['startupTimeoutMs', flags.startupTimeoutMs],
            ['toolTimeoutMs', flags.toolTimeoutMs],
            // checkEntry takes it out of the entry it stores, as the server's flag.
            ['disabled', flags.disabled],
        ].filter(([, value]) => value !== undefined),
    );
};

const readAdd = (args: readonly string[]): Result<Command, string[]> => {
    const parsed = parse(args, ADD_OPTIONS, { unknown: UNKNOWN_IN_ADD, value: SEE_HELP });

    if (!parsed.ok) {
        return err([parsed.error]);
    }

    const { values, positionals, tokens } = parsed.value;
    // Everything after -- is the command's, its own options included.
    const end = tokens.find((token) => token.kind === 'option-terminator')?.index;
    const command = end === undefined ? undefined : args.slice(end + 1);
    const operands = positionals.slice(0, positionals.length - (command?.length ?? 0));
    const target = targetOf(operands, command);
    const headers = headersOf(values.header ?? []);
    const env = envOf(values.env ?? []);
    const startup = timeoutOf('--startup-timeout', values['startup-timeout'], STARTUP_TIMEOUT_MS);
    const tool = timeoutOf('--tool-timeout', values['tool-timeout'], TOOL_TIMEOUT_MS);
    const problems = [
        ...operands.slice(0, 1).flatMap((name) => checkName(name)),
        ...(target.ok ? [] : [target.error]),
        ...headers.problems,
        ...env.problems,
        ...startup.problems,
        ...tool.problems,
        ...(target.ok ? misplaced(target.value, values) : []),
    ];

    if (!target.ok) {
        return err(problems);
    }

    const checked = checkEntry(
        entryOf(target.value, {
            headers: headers.value,
            env: env.value,
            cwd: values.cwd,
            includeTools: values['include-tool'],
            excludeTools: values['exclude-tool'],
            startupTimeoutMs: startup.value,
            toolTimeoutMs: tool.value,
            disabled: values.disabled,
        }),
    );

    if (!checked.ok) {
        return err([...problems, ...checked.error]);
    }

    return problems.length === 0
        ? ok({ kind: 'add', name: target.value.name, checked: checked.value })
        : err(problems);
};

// A secret on the command line is a reference alone, as everywhere else: a literal one would be in
// the shell's history.
const clientSecretOf = (text: string | undefined): Read<Template | undefined> => {
    if (text === undefined) {
        return { value: undefined, problems: [] };
    }

    const { template, problems } = parseTemplate(text);
    const literal = template.some((part) => typeof part === 'string') || !hasReference(template);

    return {
        value: template,
        problems:
            problems.length > 0
                ? problems.map((problem) => `--client-secret holds ${problem}.`)
                : literal
                  ? [`--client-secret holds a literal secret. ${ADVICE}`]
                  : [],
    };
};

const readLogin = (args: readonly string[]): Result<Command, string[]> => {
    const parsed = parse(args, LOGIN_OPTIONS, { unknown: SEE_HELP, value: SEE_HELP });

    if (!parsed.ok) {
        return err([parsed.error]);
    }

    const { values, positionals } = parsed.value;
    const [name, ...extra] = positionals;
    const clientSecret = clientSecretOf(values['client-secret']);
    const redirect = values['redirect-uri'];
    // Without --redirect-uri, String() gives undefined's name, which is no URI.
    const redirectUri = loopbackUri(String(redirect));
    const problems = [
        ...(name === undefined || extra.length > 0 ? [LOGIN_SHAPE] : []),
        ...(values['client-id'] === undefined && values['client-secret'] !== undefined
            ? [
                  '--client-secret needs --client-id: it is the secret of the client that --client-id names.',
              ]
            : []),
        ...clientSecret.problems,
        ...(redirect !== undefined && redirectUri === undefined ? [REDIRECT_URI] : []),
    ];

    // Without a name, the shape is a problem.
    return problems.length > 0
        ? err(problems)
        : ok({
              kind: 'login',
              name: String(name),
              login: {
                  clientId: values['client-id'],
                  clientSecret: clientSecret.value,
                  redirectUri,
                  scope: values.scope,
              },
          });
};

/** The subcommand and what it needs, or every problem with them. */
export const readCommand = (args: readonly string[]): Result<Command, string[]> => {
    const [subcommand, first, ...rest] = args;

    switch (subcommand) {
        case 'add':
            return readAdd(args.slice(1));
        case 'login':
            return readLogin(args.slice(1));
        case 'list':
            return first === undefined
                ? ok({ kind: 'list' })
                : err([`list takes no arguments. ${SEE_HELP}`]);
        case 'get':
        case 'remove':
        case 'disable':
        case 'enable':
        case 'logout':
            return first === undefined || rest.length > 0
                ? err([
                      `${subcommand} takes a server's name: bun run mcp ${subcommand} <name>. ${SEE_HELP}`,
                  ])
                : ok({ kind: subcommand, name: first });
        default:
            return err([`Give one of the subcommands: ${SUBCOMMANDS}. ${SEE_HELP}`]);
    }
};
