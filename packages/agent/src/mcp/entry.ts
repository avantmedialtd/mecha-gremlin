// An MCP server's entry: one server's object from inside a `mcpServers` map, in Claude Code's
// format (Brief R18.1). `add` checks it before storing it, and each run checks it again, since a
// row may predate a check or have been written by hand. Every problem is reported, and none
// quotes a value: an entry may hold a secret.
import { isAbsolute } from 'node:path';
import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { headerNameProblems, headerValueProblems } from './headers.ts';
import { unpinned } from './pinning.ts';
import { type Template, hasReference, parseTemplate, render } from './references.ts';
import { ADVICE, holdsLiteralSecret, isCredentialName, secretShape } from './secrets.ts';
import { authorityEnd, urlProblems } from './urls.ts';

export type Transport = 'stdio' | 'http';

/** An env variable or a header: its name, and its value with its references. */
export type Named = readonly [name: string, value: Template];

type Common = {
    readonly includeTools: readonly string[] | undefined;
    readonly excludeTools: readonly string[];
    readonly startupTimeoutMs: number;
    readonly toolTimeoutMs: number;
};

export type StdioEntry = Common & {
    readonly transport: 'stdio';
    readonly command: Template;
    readonly args: readonly Template[];
    readonly env: readonly Named[];
    readonly cwd: Template | undefined;
};

export type HttpEntry = Common & {
    readonly transport: 'http';
    readonly url: Template;
    /** The url as the entry writes it, which keys the server's saved logins. */
    readonly writtenUrl: string;
    readonly headers: readonly Named[];
};

export type Entry = StdioEntry | HttpEntry;

export type Warning = {
    readonly message: 'mcp server unpinned' | 'mcp server secret in arguments';
    readonly reason: string;
};

export type CheckedEntry = {
    readonly entry: Entry;
    /** The entry as given, without `disabled`: the store keeps the flag apart. */
    readonly stored: object;
    readonly disabled: boolean;
    readonly warnings: readonly Warning[];
};

type Read<T> = {
    readonly value: T;
    readonly problems: readonly string[];
};

type Fields = ReadonlyMap<string, unknown>;

export const NAME = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/;

const NAME_LENGTH = 24;

const STDIO_FIELDS = ['command', 'args', 'env', 'cwd'];

const HTTP_FIELDS = ['url', 'headers'];

const COMMON_FIELDS = [
    'type',
    'includeTools',
    'excludeTools',
    'startupTimeoutMs',
    'toolTimeoutMs',
    'disabled',
    'title',
    'description',
];

// The fields other clients spell differently (Brief R18.1).
const TIMEOUTS = 'give startupTimeoutMs and toolTimeoutMs, in milliseconds';

const HINTS = new Map([
    ['timeout', TIMEOUTS],
    ['startup_timeout_sec', TIMEOUTS],
    ['tool_timeout_sec', TIMEOUTS],
    ['enabled', 'give disabled instead, as true or false'],
    ['required', "leave it out: every server that isn't disabled is required"],
    ['environment', 'give env instead'],
    ['serverUrl', 'give url instead'],
    ['httpUrl', 'give url instead'],
    ['enabled_tools', 'give includeTools instead'],
    ['disabled_tools', 'give excludeTools instead'],
    ['transport', 'give type instead'],
]);

// The maps that hold servers in the formats vendors publish.
const WRAPPERS = ['mcpServers', 'servers', 'mcp', 'context_servers'];

const TIMEOUT_EXAMPLE = '"startupTimeoutMs": 30000 and "toolTimeoutMs": 120000';

// setTimeout fires at once beyond its 32-bit limit; the floor catches a value given in seconds
// (Brief R18.1).
export const LONGEST_TIMEOUT_MS = 2_147_483_647;

export const SHORTEST_TIMEOUT_MS = 1000;

const CONTROL = /\p{Cc}/u;

// What a field that fails its checks stands for: an entry with a problem is never used.
const NONE: readonly never[] = [];

// What a reference stands for in the checks of a URL, until a run resolves it.
const SAMPLE = 'x';

const isObject = (value: unknown): value is object => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

// Own properties only, read once: an entry's object may come from JSON.parse, whose objects
// inherit `constructor` and the like.
const fieldsOf = (value: object): Fields => {
    return new Map<string, unknown>(Object.entries(value));
};

const stringsOf = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const strings = value.filter((item): item is string => typeof item === 'string');

    return strings.length === value.length ? strings : undefined;
};

const stringMapOf = (value: unknown): (readonly [string, string])[] | undefined => {
    if (!isObject(value)) {
        return undefined;
    }

    const entries = Object.entries(value);
    const strings = entries.filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string';
    });

    return strings.length === entries.length ? strings : undefined;
};

const shapeProblems = (where: string, text: string): string[] => {
    const shape = secretShape(text);

    return shape === undefined ? [] : [`${where} holds ${shape}. ${ADVICE}`];
};

const controlProblems = (where: string, text: string): string[] => {
    return CONTROL.test(text) ? [`${where} holds a control character.`] : [];
};

// A text that may hold references. In a slot named so that it holds a credential, a literal
// value is refused as a secret, whatever its shape.
const templated = (where: string, text: string, slot: boolean): Read<Template> => {
    const parsed = parseTemplate(text);

    return {
        value: parsed.template,
        problems: [
            ...parsed.problems.map((problem) => `${where} holds ${problem}.`),
            ...(slot && parsed.problems.length === 0 && holdsLiteralSecret(parsed.template, text)
                ? [`${where} holds a literal secret. ${ADVICE}`]
                : shapeProblems(where, text)),
        ],
    };
};

// A text that may not: a name, a title or a tool's name.
const plain = (where: string, text: string): string[] => {
    return [
        ...(text.includes('${') ? [`${where} holds a reference, which it can't.`] : []),
        ...shapeProblems(where, text),
    ];
};

// Named without quoting a name that is itself shaped like a secret or holds a control character.
const labelOf = (kind: string, name: string, position: number): string => {
    return secretShape(name) === undefined && !CONTROL.test(name)
        ? `The ${kind} ${name}`
        : `The ${kind} at position ${position}`;
};

export const checkName = (name: string): string[] => {
    return NAME.test(name) && name.length <= NAME_LENGTH
        ? []
        : [
              `The name ${JSON.stringify(name)} isn't allowed: a server's name is 1 to ${NAME_LENGTH} letters and digits, in words joined by single - or _ characters.`,
          ];
};

/** The prefix that a server's tools' names take. */
export const prefixOf = (name: string): string => {
    return name.toLowerCase().replaceAll('-', '_');
};

const wrapperOf = (fields: Fields): string | undefined => {
    const wrapper = WRAPPERS.find((field) => fields.has(field));
    const [only] = fields.values();
    const holdsServer =
        fields.size === 1 &&
        isObject(only) &&
        (Object.hasOwn(only, 'command') || Object.hasOwn(only, 'url'));

    if (wrapper === undefined && !holdsServer) {
        return undefined;
    }

    const field = wrapper ?? String([...fields.keys()]);

    return `The entry holds a server inside its field ${JSON.stringify(field)}: give the object inside it as the entry, and the server's name as the first argument.`;
};

const unknownFields = (fields: Fields): string[] => {
    const known = [...STDIO_FIELDS, ...HTTP_FIELDS, ...COMMON_FIELDS];

    return [...fields].flatMap(([field, value], position) => {
        if (known.includes(field)) {
            return [];
        }

        const hint = HINTS.get(field);
        const where = labelOf('field', field, position + 1);
        const shape = secretShape(JSON.stringify(value));

        return [
            hint === undefined ? `${where} isn't known.` : `${where} isn't known: ${hint}.`,
            ...(shape === undefined ? [] : [`${where} holds ${shape}. ${ADVICE}`]),
        ];
    });
};

const transportOf = (fields: Fields): Result<Transport, string> => {
    const type = fields.get('type');

    if (type === undefined) {
        const command = fields.has('command');

        if (command === fields.has('url')) {
            return err(
                `An entry has command, for a stdio server, or url, for a Streamable HTTP one; this one has ${command ? 'both' : 'neither'}.`,
            );
        }

        return ok(command ? 'stdio' : 'http');
    }

    if (type === 'stdio') {
        return ok('stdio');
    }

    if (type === 'http' || type === 'streamable-http') {
        return ok('http');
    }

    return err(
        type === 'sse'
            ? 'The SSE transport is deprecated, and not supported: use Streamable HTTP, with "type": "http".'
            : 'The type must be stdio, http or streamable-http.',
    );
};

/** The transport an entry names or implies, if it does. */
export const transportOfEntry = (value: unknown): Transport | undefined => {
    if (!isObject(value)) {
        return undefined;
    }

    const transport = transportOf(fieldsOf(value));

    return transport.ok ? transport.value : undefined;
};

/** The url an entry writes, if it writes one, as its saved logins are kept under. */
export const urlOfEntry = (value: unknown): string | undefined => {
    const url = isObject(value) ? fieldsOf(value).get('url') : undefined;

    return typeof url === 'string' ? url : undefined;
};

const otherTransportFields = (transport: Transport, fields: Fields): string[] => {
    const [others, name] =
        transport === 'stdio' ? [HTTP_FIELDS, 'A stdio'] : [STDIO_FIELDS, 'A Streamable HTTP'];

    return others
        .filter((field) => fields.has(field))
        .map((field) => `${name} entry can't have ${field}.`);
};

const toolsOf = (fields: Fields, field: string): Read<readonly string[] | undefined> => {
    const value = fields.get(field);

    if (value === undefined) {
        return { value: undefined, problems: [] };
    }

    const names = stringsOf(value);

    if (names === undefined || names.length === 0 || names.includes('')) {
        return { value: undefined, problems: [`${field} must be a list of tool names.`] };
    }

    const repeated = names.filter((name, index) => names.indexOf(name) !== index);

    return {
        value: names,
        problems: [
            ...[...new Set(repeated)].map(
                (name) => `${field} names ${JSON.stringify(name)} twice.`,
            ),
            ...names.flatMap((name) => plain(field, name)),
        ],
    };
};

const timeoutOf = (fields: Fields, field: string): Read<number> => {
    const value = fields.get(field);

    if (value === undefined) {
        return {
            value: 0,
            problems: [
                `${field} is missing. Give both timeouts, in milliseconds, as in ${TIMEOUT_EXAMPLE}.`,
            ],
        };
    }

    return Number.isInteger(value) &&
        Number(value) >= SHORTEST_TIMEOUT_MS &&
        Number(value) <= LONGEST_TIMEOUT_MS
        ? { value: Number(value), problems: [] }
        : {
              value: 0,
              problems: [
                  `${field} must be a whole number of milliseconds from ${SHORTEST_TIMEOUT_MS} to ${LONGEST_TIMEOUT_MS}.`,
              ],
          };
};

const textProblems = (fields: Fields, field: string): string[] => {
    const value = fields.get(field);

    if (value === undefined) {
        return [];
    }

    return typeof value === 'string'
        ? plain(`The ${field}`, value)
        : [`The ${field} must be a string.`];
};

const commonOf = (fields: Fields): Read<Common & { readonly disabled: boolean }> => {
    const includeTools = toolsOf(fields, 'includeTools');
    const excludeTools = toolsOf(fields, 'excludeTools');
    const startup = timeoutOf(fields, 'startupTimeoutMs');
    const tool = timeoutOf(fields, 'toolTimeoutMs');
    const disabled = fields.has('disabled') ? fields.get('disabled') : false;
    const both = includeTools.value?.filter((name) => excludeTools.value?.includes(name)) ?? NONE;

    return {
        value: {
            includeTools: includeTools.value,
            excludeTools: excludeTools.value ?? [],
            startupTimeoutMs: startup.value,
            toolTimeoutMs: tool.value,
            disabled: disabled === true,
        },
        problems: [
            ...includeTools.problems,
            ...excludeTools.problems,
            ...both.map(
                (name) => `includeTools and excludeTools both name ${JSON.stringify(name)}.`,
            ),
            ...startup.problems,
            ...tool.problems,
            ...(typeof disabled === 'boolean' ? [] : ['disabled must be true or false.']),
            ...textProblems(fields, 'title'),
            ...textProblems(fields, 'description'),
        ],
    };
};

// A spawned value: control characters are refused, since a NUL makes both runtimes' spawn
// errors print the whole value, a resolved secret beside it included (Brief R18.1).
const spawnedValue = (where: string, text: string, slot = false): Read<Template> => {
    const read = templated(where, text, slot);

    return { value: read.value, problems: [...read.problems, ...controlProblems(where, text)] };
};

// A path without references is checked here, and one with them once a run resolves them: a
// relative path would resolve against wherever `bun run mcp` or a scheduled run happens to start.
const literalPath = (text: string): string | undefined => {
    const parsed = parseTemplate(text);

    return parsed.problems.length === 0 && !hasReference(parsed.template)
        ? render(parsed.template, SAMPLE)
        : undefined;
};

const commandOf = (fields: Fields): Read<Template> => {
    const value = fields.get('command');

    if (typeof value !== 'string') {
        return {
            value: NONE,
            problems: [
                value === undefined ? 'A stdio entry needs command.' : 'command must be a string.',
            ],
        };
    }

    const read = spawnedValue('The command', value);
    const path = literalPath(value);
    const named = path === undefined || (path !== '' && (isAbsolute(path) || !path.includes('/')));

    return {
        value: read.value,
        problems: [
            ...read.problems,
            ...(named
                ? []
                : [
                      "The command must be an absolute path, or a name without a slash that the server's PATH finds.",
                  ]),
        ],
    };
};

const cwdOf = (fields: Fields): Read<Template | undefined> => {
    const value = fields.get('cwd');

    if (value === undefined) {
        return { value: undefined, problems: [] };
    }

    if (typeof value !== 'string') {
        return { value: undefined, problems: ['cwd must be a string.'] };
    }

    const read = spawnedValue('cwd', value);
    const path = literalPath(value);
    const absolute = path === undefined || isAbsolute(path);

    return {
        value: read.value,
        problems: [...read.problems, ...(absolute ? [] : ['cwd must be an absolute path.'])],
    };
};

type Arguments = {
    readonly args: readonly Template[];
    /** The arguments as written, for the pinning warning. */
    readonly texts: readonly string[];
    readonly problems: readonly string[];
    readonly warnings: readonly Warning[];
};

// `--option value` and `--option=value`, for an option whose name says it takes a credential.
const argumentSlot = (
    arg: string,
    next: string | undefined,
    index: number,
): { readonly where: string; readonly text: string } | undefined => {
    const equals = arg.indexOf('=');

    if (!arg.startsWith('--')) {
        return undefined;
    }

    if (equals !== -1) {
        const option = arg.slice(0, equals);

        return isCredentialName(option)
            ? {
                  where: `The ${option} option in argument ${index + 1}`,
                  text: arg.slice(equals + 1),
              }
            : undefined;
    }

    return isCredentialName(arg) && next !== undefined && !next.startsWith('-')
        ? { where: `Argument ${index + 2}, after ${arg},`, text: next }
        : undefined;
};

const argsOf = (fields: Fields): Arguments => {
    const value = fields.has('args') ? fields.get('args') : [];
    const strings = stringsOf(value);

    if (strings === undefined) {
        return {
            args: NONE,
            texts: NONE,
            problems: ['args must be a list of strings.'],
            warnings: NONE,
        };
    }

    const reads = strings.map((arg, index) => spawnedValue(`Argument ${index + 1}`, arg));
    const slots = strings.flatMap((arg, index) => {
        const slot = argumentSlot(arg, strings[index + 1], index);

        return slot === undefined
            ? []
            : [{ ...slot, value: templated(slot.where, slot.text, true) }];
    });

    return {
        args: reads.map((read) => read.value),
        texts: strings,
        problems: [
            ...reads.flatMap((read) => read.problems),
            ...slots.flatMap(({ value: slot }) => slot.problems),
        ],
        warnings: slots
            .filter(({ value: slot }) => hasReference(slot.value))
            .map(({ where }) => ({
                message: 'mcp server secret in arguments',
                reason: `${where} holds a reference: a run puts its value in the process list, which every local user can read. Give it in env instead, if the server reads one.`,
            })),
    };
};

const envOf = (fields: Fields): Read<readonly Named[]> => {
    const value = fields.has('env') ? fields.get('env') : {};
    const entries = stringMapOf(value);

    if (entries === undefined) {
        return { value: NONE, problems: ['env must be an object of strings.'] };
    }

    const reads = entries.map(([name, text], index) => {
        const where = labelOf('env variable', name, index + 1);
        const read = spawnedValue(where, text, isCredentialName(name));

        return {
            value: [name, read.value] as const,
            problems: [
                ...controlProblems(`The name of env variable ${index + 1}`, name),
                ...plain(`The name of env variable ${index + 1}`, name),
                ...read.problems,
            ],
        };
    });

    return {
        value: reads.map((read) => read.value),
        problems: reads.flatMap((read) => read.problems),
    };
};

const pinningWarnings = (fields: Fields, args: readonly string[]): Warning[] => {
    const command = fields.get('command');
    const spec = typeof command === 'string' ? unpinned(command, args) : undefined;

    return spec === undefined
        ? []
        : [
              {
                  message: 'mcp server unpinned',
                  reason: `${spec} isn't pinned to an exact version, so a run may start a version published later. Pin it, as in package@1.2.3.`,
              },
          ];
};

type Specific<T> = {
    readonly entry: T;
    readonly problems: readonly string[];
    readonly warnings: readonly Warning[];
};

const stdioOf = (fields: Fields): Specific<Omit<StdioEntry, keyof Common>> => {
    const command = commandOf(fields);
    const args = argsOf(fields);
    const env = envOf(fields);
    const cwd = cwdOf(fields);

    return {
        entry: {
            transport: 'stdio',
            command: command.value,
            args: args.args,
            env: env.value,
            cwd: cwd.value,
        },
        problems: [...command.problems, ...args.problems, ...env.problems, ...cwd.problems],
        warnings: [...pinningWarnings(fields, args.texts), ...args.warnings],
    };
};

/** The query's parameters as written, their names decoded where they can be. */
export const queryOf = (text: string): (readonly [string, string])[] => {
    const fragment = text.indexOf('#');
    const beforeFragment = fragment === -1 ? text : text.slice(0, fragment);
    const start = beforeFragment.indexOf('?');

    if (start === -1) {
        return [];
    }

    return beforeFragment
        .slice(start + 1)
        .split('&')
        .map((pair) => {
            const equals = pair.indexOf('=');
            const name = equals === -1 ? pair : pair.slice(0, equals);
            let decoded = name;

            try {
                decoded = decodeURIComponent(name);
            } catch {
                // A malformed escape: the name is checked as written.
            }

            return [decoded, equals === -1 ? '' : pair.slice(equals + 1)] as const;
        });
};

const urlOf = (fields: Fields): Read<Template> => {
    const value = fields.get('url');

    if (typeof value !== 'string') {
        return {
            value: NONE,
            problems: [
                value === undefined
                    ? 'A Streamable HTTP entry needs url.'
                    : 'url must be a string.',
            ],
        };
    }

    const parsed = parseTemplate(value);
    const authority = parseTemplate(value.slice(0, authorityEnd(value))).template;
    const secrets = queryOf(value).filter(([name, text]) => {
        return isCredentialName(name) && holdsLiteralSecret(parseTemplate(text).template, text);
    });
    const shape = secretShape(value);

    return {
        value: parsed.template,
        problems: [
            ...parsed.problems.map((problem) => `The url holds ${problem}.`),
            ...(hasReference(authority)
                ? [
                      "The url holds a reference outside its path and query: a reference may appear only in a URL's path and query.",
                  ]
                : []),
            // The references stand in for values that a run checks again.
            ...urlProblems('The url', render(parsed.template, SAMPLE)),
            ...secrets.map(
                ([name]) => `The url's query parameter ${name} holds a literal secret. ${ADVICE}`,
            ),
            // The URL's rules already refuse a password in it.
            ...(shape === undefined || shape === 'a password in a URL' || secrets.length > 0
                ? []
                : [`The url holds ${shape}. ${ADVICE}`]),
        ],
    };
};

const headersOf = (fields: Fields): Read<readonly Named[]> => {
    const value = fields.has('headers') ? fields.get('headers') : {};
    const entries = stringMapOf(value);

    if (entries === undefined) {
        return { value: NONE, problems: ['headers must be an object of strings.'] };
    }

    const reads = entries.map(([name, text], index) => {
        const where = labelOf('header', name, index + 1);
        const read = templated(where, text, isCredentialName(name));

        return {
            value: [name, read.value] as const,
            problems: [
                ...plain(`The name of header ${index + 1}`, name),
                ...read.problems,
                ...headerValueProblems(where, text),
            ],
        };
    });

    return {
        value: reads.map((read) => read.value),
        problems: [
            ...headerNameProblems(entries.map(([name]) => name)),
            ...reads.flatMap((read) => read.problems),
        ],
    };
};

// Bun's fetch sends even a request to 127.0.0.1 or localhost through HTTP_PROXY, headers
// included, unless NO_PROXY names the host (Brief R18.1). The scheme is the one fetch will use:
// the URL parser drops spaces and control characters around a URL, and tabs and newlines in it,
// so its text can hide a plain http.
const plainHttpProblems = (url: Template, headers: readonly Named[]): string[] => {
    const referenced = hasReference(url) || headers.some(([, value]) => hasReference(value));

    return referenced && URL.parse(render(url, SAMPLE))?.protocol === 'http:'
        ? [
              'The url is plain http, but it or a header holds a reference: use https, since even a request to 127.0.0.1 may go through a proxy.',
          ]
        : [];
};

const httpOf = (fields: Fields): Specific<Omit<HttpEntry, keyof Common>> => {
    const url = urlOf(fields);
    const headers = headersOf(fields);

    return {
        // An entry whose url isn't a string has a problem, so its writtenUrl is never read.
        entry: {
            transport: 'http',
            url: url.value,
            writtenUrl: String(fields.get('url')),
            headers: headers.value,
        },
        problems: [
            ...url.problems,
            ...headers.problems,
            ...plainHttpProblems(url.value, headers.value),
        ],
        warnings: NONE,
    };
};

export const checkEntry = (value: unknown): Result<CheckedEntry, string[]> => {
    if (!isObject(value)) {
        return err([
            "The entry must be a JSON object: one server's entry, from inside mcpServers.",
        ]);
    }

    const fields = fieldsOf(value);
    const wrapped = wrapperOf(fields);

    if (wrapped !== undefined) {
        return err([wrapped]);
    }

    const transport = transportOf(fields);
    const common = commonOf(fields);

    if (!transport.ok) {
        return err([...unknownFields(fields), transport.error, ...common.problems]);
    }

    const specific = transport.value === 'stdio' ? stdioOf(fields) : httpOf(fields);
    const problems = [
        ...unknownFields(fields),
        ...otherTransportFields(transport.value, fields),
        ...common.problems,
        ...specific.problems,
    ];

    if (problems.length > 0) {
        return err(problems);
    }

    const { disabled, ...shared } = common.value;

    return ok({
        entry: { ...shared, ...specific.entry },
        stored: Object.fromEntries([...fields].filter(([field]) => field !== 'disabled')),
        disabled,
        warnings: specific.warnings,
    });
};
