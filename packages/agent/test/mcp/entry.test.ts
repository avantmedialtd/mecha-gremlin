import { describe, expect, test } from 'vitest';
import {
    type CheckedEntry,
    checkEntry,
    checkName,
    prefixOf,
    queryOf,
    transportOfEntry,
} from '../../src/mcp/entry.ts';

const ADVICE =
    "Give it as a reference, such as ${NAME}, to a variable set in .env, in single quotes, so that your shell leaves it alone. A secret typed on a command line is in the shell's history: change it.";

const TIMEOUTS = { startupTimeoutMs: 30000, toolTimeoutMs: 120000 };

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

const stdio = (fields: Readonly<Record<string, unknown>> = {}) => ({
    command: 'server',
    ...TIMEOUTS,
    ...fields,
});

const http = (fields: Readonly<Record<string, unknown>> = {}) => ({
    url: 'https://docs.example.com/mcp',
    ...TIMEOUTS,
    ...fields,
});

const wrapped = (field: string): string => {
    return `The entry holds a server inside its field "${field}": give the object inside it as the entry, and the server's name as the first argument.`;
};

const problems = (value: unknown): string[] => {
    const checked = checkEntry(value);

    return checked.ok ? [] : checked.error;
};

const checked = (value: unknown): CheckedEntry => {
    const result = checkEntry(value);

    expect(result).toMatchObject({ ok: true });

    return (result as { value: CheckedEntry }).value;
};

describe('The transports and their fields', () => {
    test('a stdio entry', () => {
        const entry = {
            command: 'npx',
            args: ['-y', '@playwright/mcp@0.0.83'],
            startupTimeoutMs: 30000,
            toolTimeoutMs: 120000,
        };

        expect(checkEntry(entry)).toEqual({
            ok: true,
            value: {
                entry: {
                    transport: 'stdio',
                    command: ['npx'],
                    args: [['-y'], ['@playwright/mcp@0.0.83']],
                    env: [],
                    cwd: undefined,
                    includeTools: undefined,
                    excludeTools: [],
                    startupTimeoutMs: 30000,
                    toolTimeoutMs: 120000,
                },
                stored: entry,
                disabled: false,
                warnings: [],
            },
        });
    });

    test('every stdio field, with references', () => {
        const entry = stdio({
            command: '${NODE}',
            args: ['server.js', '--root=${ROOT}'],
            env: { DEPTH: '2', API_KEY: '${API_KEY}' },
            cwd: '/srv/${SITE}',
            includeTools: ['a', 'b'],
            excludeTools: ['c'],
        });

        expect(checked(entry).entry).toEqual({
            transport: 'stdio',
            command: [{ variable: 'NODE' }],
            args: [['server.js'], ['--root=', { variable: 'ROOT' }]],
            env: [
                ['DEPTH', ['2']],
                ['API_KEY', [{ variable: 'API_KEY' }]],
            ],
            cwd: ['/srv/', { variable: 'SITE' }],
            includeTools: ['a', 'b'],
            excludeTools: ['c'],
            ...TIMEOUTS,
        });
    });

    test('a URL without a type is Streamable HTTP', () => {
        expect(checked(http({ headers: { 'X-Team': 'docs' } })).entry).toEqual({
            transport: 'http',
            url: ['https://docs.example.com/mcp'],
            headers: [['X-Team', ['docs']]],
            includeTools: undefined,
            excludeTools: [],
            ...TIMEOUTS,
        });
    });

    test.each([
        ['stdio', stdio({ type: 'stdio' }), 'stdio'],
        ['http', http({ type: 'http' }), 'http'],
        ['streamable-http', http({ type: 'streamable-http' }), 'http'],
    ])('the type %s', (_type, entry, transport) => {
        expect(checked(entry).entry.transport).toBe(transport);
        expect(transportOfEntry(entry)).toBe(transport);
    });

    test('SSE is refused as deprecated', () => {
        expect(problems(http({ type: 'sse' }))).toEqual([
            'The SSE transport is deprecated, and not supported: use Streamable HTTP, with "type": "http".',
        ]);
    });

    test.each(['local', 'streamableHttp', null, 1])('an unknown type: %j', (type) => {
        expect(problems(http({ type }))).toEqual([
            'The type must be stdio, http or streamable-http.',
        ]);
        expect(transportOfEntry(http({ type }))).toBeUndefined();
    });

    test('both kinds, or neither', () => {
        expect(problems({ ...stdio(), url: 'https://docs.example.com/mcp' })).toEqual([
            'An entry has command, for a stdio server, or url, for a Streamable HTTP one; this one has both.',
        ]);
        expect(problems(TIMEOUTS)).toEqual([
            'An entry has command, for a stdio server, or url, for a Streamable HTTP one; this one has neither.',
        ]);
        expect(transportOfEntry(TIMEOUTS)).toBeUndefined();
        expect(transportOfEntry('docs')).toBeUndefined();
    });

    test("a field of the other transport, and a transport's required field", () => {
        expect(problems(stdio({ type: 'stdio', url: 'https://x.example', headers: {} }))).toEqual([
            "A stdio entry can't have url.",
            "A stdio entry can't have headers.",
        ]);
        expect(problems(http({ type: 'http', command: 'x', args: [], env: {}, cwd: '/' }))).toEqual(
            [
                "A Streamable HTTP entry can't have command.",
                "A Streamable HTTP entry can't have args.",
                "A Streamable HTTP entry can't have env.",
                "A Streamable HTTP entry can't have cwd.",
            ],
        );
        expect(problems({ type: 'stdio', ...TIMEOUTS })).toEqual(['A stdio entry needs command.']);
        expect(problems({ type: 'http', ...TIMEOUTS })).toEqual([
            'A Streamable HTTP entry needs url.',
        ]);
    });

    test.each([
        [stdio({ command: 1 }), 'command must be a string.'],
        [stdio({ args: 'x' }), 'args must be a list of strings.'],
        [stdio({ args: ['x', 1] }), 'args must be a list of strings.'],
        [stdio({ args: null }), 'args must be a list of strings.'],
        [stdio({ env: [] }), 'env must be an object of strings.'],
        [stdio({ env: { A: 1 } }), 'env must be an object of strings.'],
        [stdio({ env: null }), 'env must be an object of strings.'],
        [stdio({ cwd: 1 }), 'cwd must be a string.'],
        [http({ url: 1 }), 'url must be a string.'],
        [http({ headers: 'x' }), 'headers must be an object of strings.'],
        [http({ headers: { A: true } }), 'headers must be an object of strings.'],
        [http({ headers: null }), 'headers must be an object of strings.'],
        [http({ title: 1 }), 'The title must be a string.'],
        [http({ description: [] }), 'The description must be a string.'],
        [http({ disabled: 'yes' }), 'disabled must be true or false.'],
        [http({ disabled: null }), 'disabled must be true or false.'],
    ])('a field of the wrong type: %j', (entry, problem) => {
        expect(problems(entry)).toEqual([problem]);
    });

    test.each([[[]], ['docs'], [null], [1]])('an entry that is not an object: %j', (entry) => {
        expect(problems(entry)).toEqual([
            "The entry must be a JSON object: one server's entry, from inside mcpServers.",
        ]);
    });

    test('a title and a description are kept', () => {
        const entry = http({ title: 'Docs', description: 'Searches the docs.' });

        expect(checked(entry).stored).toEqual(entry);
    });
});

describe('The starting flag', () => {
    test("disabled is taken out of the entry as the server's starting flag", () => {
        const { stored, disabled } = checked(http({ disabled: true }));

        expect(disabled).toBe(true);
        expect(stored).toEqual(http());
    });

    test('disabled false, and no disabled at all', () => {
        expect(checked(http({ disabled: false }))).toMatchObject({
            stored: http(),
            disabled: false,
        });
        expect(checked(http()).disabled).toBe(false);
    });
});

describe('Unknown fields', () => {
    test.each([
        ['timeout', 'give startupTimeoutMs and toolTimeoutMs, in milliseconds'],
        ['startup_timeout_sec', 'give startupTimeoutMs and toolTimeoutMs, in milliseconds'],
        ['tool_timeout_sec', 'give startupTimeoutMs and toolTimeoutMs, in milliseconds'],
        ['enabled', 'give disabled instead, as true or false'],
        ['required', "leave it out: every server that isn't disabled is required"],
        ['environment', 'give env instead'],
        ['serverUrl', 'give url instead'],
        ['httpUrl', 'give url instead'],
        ['enabled_tools', 'give includeTools instead'],
        ['disabled_tools', 'give excludeTools instead'],
        ['transport', 'give type instead'],
    ])("another client's spelling: %s", (field, hint) => {
        expect(problems(http({ [field]: 30 }))).toEqual([
            `The field ${field} isn't known: ${hint}.`,
        ]);
    });

    test('a field of no client', () => {
        expect(problems(http({ colour: 'blue' }))).toEqual(["The field colour isn't known."]);
    });

    test('keys that name Object members: constructor is unknown, and __proto__ is an env name', () => {
        const constructor = http({ constructor: 1 });
        // In an object literal, __proto__ sets the prototype; JSON.parse makes it a key.
        const proto = JSON.parse(
            '{"command": "server", "env": {"__proto__": "x"}, "startupTimeoutMs": 30000, "toolTimeoutMs": 120000}',
        );

        expect(problems(constructor)).toEqual(["The field constructor isn't known."]);
        expect(checked(proto).entry).toMatchObject({ env: [['__proto__', ['x']]] });
        expect(JSON.stringify(checked(proto).stored)).toBe(
            '{"command":"server","env":{"__proto__":"x"},"startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        );
    });

    test('an entry read by JSON.parse is read by its own properties too', () => {
        const entry = JSON.parse(
            '{"url": "https://docs.example.com/mcp", "startupTimeoutMs": 30000, "toolTimeoutMs": 120000}',
        );

        expect(checkEntry(entry)).toMatchObject({ ok: true });
    });

    test('a field named like a secret, or holding one, is named by its position', () => {
        expect(problems(http({ [TOKEN]: 1, other: { deep: [TOKEN] } }))).toEqual([
            "The field at position 4 isn't known.",
            "The field other isn't known.",
            `The field other holds text shaped like a token. ${ADVICE}`,
        ]);
    });

    test.each(['mcpServers', 'servers', 'mcp', 'context_servers'])(
        'a pasted %s wrapper',
        (wrapper) => {
            expect(
                problems({ [wrapper]: { docs: { url: 'https://docs.example.com/mcp' } } }),
            ).toEqual([
                `The entry holds a server inside its field "${wrapper}": give the object inside it as the entry, and the server's name as the first argument.`,
            ]);
        },
    );

    test('a field that holds a server', () => {
        expect(problems({ docs: { url: 'https://docs.example.com/mcp' } })).toEqual([
            wrapped('docs'),
        ]);
        expect(problems({ playwright: { command: 'npx' } })).toEqual([wrapped('playwright')]);
        expect(problems({ docs: { title: 'x' } })).toEqual([
            "The field docs isn't known.",
            'An entry has command, for a stdio server, or url, for a Streamable HTTP one; this one has neither.',
            `startupTimeoutMs is missing. Give both timeouts, in milliseconds, as in "startupTimeoutMs": 30000 and "toolTimeoutMs": 120000.`,
            `toolTimeoutMs is missing. Give both timeouts, in milliseconds, as in "startupTimeoutMs": 30000 and "toolTimeoutMs": 120000.`,
        ]);
        expect(problems({ docs: 'https://docs.example.com/mcp' })).toHaveLength(4);
    });
});

describe('The filters and the timeouts', () => {
    test('a list of tool names, and a name in both', () => {
        expect(problems(http({ includeTools: ['a', 'b'], excludeTools: ['b', 'c'] }))).toEqual([
            'includeTools and excludeTools both name "b".',
        ]);
    });

    test.each([[[]], [['a', '']], ['a'], [[1]], [null]])('a list that is not one: %j', (tools) => {
        expect(problems(http({ includeTools: tools }))).toEqual([
            'includeTools must be a list of tool names.',
        ]);
        expect(problems(http({ excludeTools: tools }))).toEqual([
            'excludeTools must be a list of tool names.',
        ]);
    });

    test('a name given twice', () => {
        expect(problems(http({ excludeTools: ['a', 'b', 'a', 'a'] }))).toEqual([
            'excludeTools names "a" twice.',
        ]);
    });

    test('a reference in a tool name', () => {
        expect(problems(http({ includeTools: ['${T}'] }))).toEqual([
            "includeTools holds a reference, which it can't.",
        ]);
    });

    test.each(['startupTimeoutMs', 'toolTimeoutMs'])('a missing %s', (field) => {
        expect(problems(http({ [field]: undefined }))).toEqual([
            `${field} is missing. Give both timeouts, in milliseconds, as in "startupTimeoutMs": 30000 and "toolTimeoutMs": 120000.`,
        ]);
    });

    test.each([30, 999, 2147483648, 1000.5, '30000', -1, null])('a timeout of %j', (timeout) => {
        expect(problems(http({ toolTimeoutMs: timeout }))).toEqual([
            'toolTimeoutMs must be a whole number of milliseconds from 1000 to 2147483647.',
        ]);
        expect(problems(http({ startupTimeoutMs: timeout }))).toEqual([
            'startupTimeoutMs must be a whole number of milliseconds from 1000 to 2147483647.',
        ]);
    });

    test.each([1000, 2147483647])('a timeout of %j', (timeout) => {
        expect(
            checked(http({ toolTimeoutMs: timeout, startupTimeoutMs: timeout })).entry,
        ).toMatchObject({
            toolTimeoutMs: timeout,
            startupTimeoutMs: timeout,
        });
    });
});

describe('Paths and control characters', () => {
    test.each(['server', '/usr/local/bin/server', '${NPX}', 'C:x'])('the command %s', (command) => {
        expect(problems(stdio({ command }))).toEqual([]);
    });

    test.each(['./server', 'bin/server', ''])('the command %j', (command) => {
        expect(problems(stdio({ command }))).toEqual([
            "The command must be an absolute path, or a name without a slash that the server's PATH finds.",
        ]);
    });

    test('cwd', () => {
        expect(problems(stdio({ cwd: '/srv/docs' }))).toEqual([]);
        expect(problems(stdio({ cwd: '${HOME}/docs' }))).toEqual([]);
        expect(problems(stdio({ cwd: 'servers/docs' }))).toEqual(['cwd must be an absolute path.']);
        expect(problems(stdio({ cwd: '' }))).toEqual(['cwd must be an absolute path.']);
    });

    test('control characters in the stdio fields, named and not quoted', () => {
        expect(
            problems(
                stdio({
                    command: 'ser\u0000ver',
                    args: ['ok', 'sec\u0000ret', 'tab\there'],
                    env: { 'A\nB': 'x', C: 'va\u001blue' },
                    cwd: '/srv\u0085',
                }),
            ),
        ).toEqual([
            'The command holds a control character.',
            'Argument 2 holds a control character.',
            'Argument 3 holds a control character.',
            'The name of env variable 1 holds a control character.',
            'The env variable C holds a control character.',
            'cwd holds a control character.',
        ]);
    });
});

describe('References', () => {
    test('where they may appear', () => {
        expect(
            problems(
                stdio({
                    command: '${CMD}',
                    args: ['${A}', '$$5'],
                    env: { B: 'x${B}y' },
                    cwd: '/${C}',
                }),
            ),
        ).toEqual([]);
        expect(
            problems(
                http({
                    url: 'https://docs.example.com/${PATH_PART}?q=${Q}',
                    headers: { 'X-Team': '${TEAM}' },
                }),
            ),
        ).toEqual([]);
    });

    test('a default, and a bare variable', () => {
        const found = problems(stdio({ env: { A: '${TOKEN:-abc123}', B: '$HOME/x' } }));

        expect(found).toEqual([
            "The env variable A holds a reference with a default, ${TOKEN…}, and defaults aren't supported: set TOKEN itself.",
            "The env variable B holds $HOME, which isn't a reference: write ${HOME}.",
        ]);
        expect(found.join()).not.toContain('abc123');
    });

    test("the model's key", () => {
        expect(problems(http({ headers: { Authorization: 'Bearer ${MODEL_API_KEY}' } }))).toEqual([
            "The header Authorization holds a reference to MODEL_API_KEY, the model's key, which no server is given.",
        ]);
    });

    test('in each field, named', () => {
        expect(
            problems(
                stdio({
                    command: '$X',
                    args: ['a', '${'],
                    cwd: '/$',
                }),
            ),
        ).toEqual([
            "The command holds $X, which isn't a reference: write ${X}.",
            'Argument 2 holds a reference without its closing }.',
            'cwd holds a $ that starts no reference: write ${NAME} for a variable, or $$ for a $.',
        ]);
        expect(
            problems(http({ url: 'https://docs.example.com/$x', headers: { A: '${' } })),
        ).toEqual([
            "The url holds $x, which isn't a reference: write ${x}.",
            'The header A holds a reference without its closing }.',
        ]);
    });

    test('where they may not appear', () => {
        expect(
            problems(
                http({
                    headers: { 'X-${A}': 'x' },
                    title: '${B}',
                    description: 'Costs $5, or ${C}',
                }),
            ),
        ).toEqual([
            "The title holds a reference, which it can't.",
            "The description holds a reference, which it can't.",
            'The header name "X-${A}" isn\'t an RFC 9110 token.',
            "The name of header 1 holds a reference, which it can't.",
        ]);
        expect(problems(stdio({ env: { '${A}': 'x' } }))).toEqual([
            "The name of env variable 1 holds a reference, which it can't.",
        ]);
    });

    test.each([
        'https://${DOCS_HOST}/mcp',
        'https://docs.example.com:${PORT}/mcp',
        'https://${USER}@docs.example.com/mcp',
        '${SCHEME}://docs.example.com/mcp',
    ])("outside a URL's path and query: %s", (url) => {
        expect(problems(http({ url }))).toContain(
            "The url holds a reference outside its path and query: a reference may appear only in a URL's path and query.",
        );
    });
});

describe('Literal secrets', () => {
    test('a header from the environment, and a literal token', () => {
        expect(problems(http({ headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } }))).toEqual([]);

        const found = problems(http({ headers: { Authorization: 'Bearer abc123def' } }));

        expect(found).toEqual([`The header Authorization holds a literal secret. ${ADVICE}`]);
        expect(found.join()).not.toContain('abc123def');
    });

    test('a credential variable', () => {
        expect(problems(stdio({ env: { API_KEY: 'abc' } }))).toEqual([
            `The env variable API_KEY holds a literal secret. ${ADVICE}`,
        ]);
        expect(problems(stdio({ env: { API_KEY: '${API_KEY}' } }))).toEqual([]);
    });

    test('settings that are not secrets', () => {
        expect(
            problems(
                stdio({
                    env: {
                        MAX_TOKENS: '4096',
                        AUTH_TYPE: 'none',
                        PRIVATE_KEY_PATH: '/home/me/key.pem',
                    },
                }),
            ),
        ).toEqual([]);
    });

    test('a key in an option, and after one', () => {
        const inOption = problems(stdio({ args: ['--api-key=abc123def'] }));
        const afterOption = problems(stdio({ args: ['--token', 'abc123def'] }));

        expect(inOption).toEqual([
            `The --api-key option in argument 1 holds a literal secret. ${ADVICE}`,
        ]);
        expect(afterOption).toEqual([
            `Argument 2, after --token, holds a literal secret. ${ADVICE}`,
        ]);
        expect([...inOption, ...afterOption].join()).not.toContain('abc123def');
    });

    test('options that are not slots', () => {
        expect(
            problems(
                stdio({
                    args: [
                        '--token',
                        '--verbose',
                        '--port=3000',
                        '--max-tokens',
                        '4096',
                        '-k',
                        'x',
                        '--token',
                    ],
                }),
            ),
        ).toEqual([]);
        expect(
            problems(stdio({ args: ['token', 'abc', '--auth=none', '--cache-dir=/x'] })),
        ).toEqual([]);
    });

    test('prefixes inside ordinary words', () => {
        expect(
            checkEntry(
                stdio({ command: 'npx', args: ['-y', 'task-master-ai@0.30.0', '--disk-cache'] }),
            ),
        ).toMatchObject({ ok: true, value: { warnings: [] } });
    });

    test("a token's shape, anywhere", () => {
        const found = problems(stdio({ args: ['run', TOKEN], title: `Uses ${TOKEN}` }));

        expect(found).toEqual([
            `The title holds text shaped like a token. ${ADVICE}`,
            `Argument 2 holds text shaped like a token. ${ADVICE}`,
        ]);
        expect(found.join()).not.toContain(TOKEN);
    });

    test('a value shaped like a secret in a slot is refused once, as a literal secret', () => {
        expect(problems(stdio({ env: { GITHUB_TOKEN: TOKEN } }))).toEqual([
            `The env variable GITHUB_TOKEN holds a literal secret. ${ADVICE}`,
        ]);
    });

    test('secrets in other fields', () => {
        expect(
            problems(
                stdio({
                    command: '/usr/bin/${TOOL}',
                    env: { NOTION_HEADERS: '{"Authorization": "Bearer ntn_abc1"}', [TOKEN]: '1' },
                    cwd: '/x/-----BEGIN PRIVATE KEY-----',
                    excludeTools: ['eyJa.eyJb.c'],
                }),
            ),
        ).toEqual([
            `excludeTools holds a JSON Web Token. ${ADVICE}`,
            `The env variable NOTION_HEADERS holds a credential written out. ${ADVICE}`,
            `The name of env variable 2 holds text shaped like a token. ${ADVICE}`,
            `cwd holds a private key. ${ADVICE}`,
        ]);
    });

    test('a reference in the arguments is stored, with a warning', () => {
        const { warnings } = checked(stdio({ args: ['--api-key', '${KEY}', '--token=${T}'] }));

        expect(warnings).toEqual([
            {
                message: 'mcp server secret in arguments',
                reason: 'Argument 2, after --api-key, holds a reference: a run puts its value in the process list, which every local user can read. Give it in env instead, if the server reads one.',
            },
            {
                message: 'mcp server secret in arguments',
                reason: 'The --token option in argument 3 holds a reference: a run puts its value in the process list, which every local user can read. Give it in env instead, if the server reads one.',
            },
        ]);
    });

    test('a literal dollar is stored as written', () => {
        expect(checked(stdio({ args: ['$$5'] }))).toMatchObject({
            entry: { args: [['$5']] },
            stored: { args: ['$$5'] },
        });
    });

    test('a query parameter that holds a credential', () => {
        expect(problems(http({ url: 'https://docs.example.com/mcp?key=abc&x=1' }))).toEqual([
            `The url's query parameter key holds a literal secret. ${ADVICE}`,
        ]);
        expect(problems(http({ url: 'https://docs.example.com/mcp?api%5Fkey=abc#' }))).toEqual([
            'The url has a fragment.',
            `The url's query parameter api_key holds a literal secret. ${ADVICE}`,
        ]);
        expect(
            problems(http({ url: 'https://docs.example.com/mcp?key=${KEY}&token&%E0=1' })),
        ).toEqual([`The url's query parameter token holds a literal secret. ${ADVICE}`]);
        expect(problems(http({ url: `https://docs.example.com/mcp?token=${TOKEN}` }))).toEqual([
            `The url's query parameter token holds a literal secret. ${ADVICE}`,
        ]);
        expect(problems(http({ url: 'https://docs.example.com/mcp?limit=10' }))).toEqual([]);
    });

    test('userinfo', () => {
        const found = problems(http({ url: 'https://user:pw@docs.example.com/mcp' }));

        expect(found).toEqual([`The url holds a user name or a password. ${ADVICE}`]);
        expect(found.join()).not.toContain('pw');
    });

    test('a URL shaped like a secret', () => {
        expect(problems(http({ url: `https://docs.example.com/${TOKEN}/mcp` }))).toEqual([
            `The url holds text shaped like a token. ${ADVICE}`,
        ]);
    });

    test('a header named like a secret is named by its position', () => {
        expect(problems(http({ headers: { [TOKEN]: 'x' } }))).toEqual([
            `The name of header 1 holds text shaped like a token. ${ADVICE}`,
        ]);
    });
});

describe("A URL's query parameters", () => {
    test('none without a query, and none from past the fragment', () => {
        expect(queryOf('https://docs.example.com/mcp')).toEqual([]);
        expect(queryOf('https://docs.example.com/mcp#?token=abc')).toEqual([]);
    });

    test('each pair as written, its name decoded where it can be', () => {
        expect(queryOf('https://x.example/mcp?a=1&b&%74oken=a=b&%E0=2#c=3')).toEqual([
            ['a', '1'],
            ['b', ''],
            ['token', 'a=b'],
            ['%E0', '2'],
        ]);
    });
});

describe('Headers and URLs', () => {
    test.each(['Mcp-Session-Id', 'content-type'])('a reserved header: %s', (name) => {
        expect(problems(http({ headers: { [name]: 'x' } }))).toEqual([
            `The header ${name} is the transport's own, and can't be set.`,
        ]);
    });

    test('header values', () => {
        expect(problems(http({ headers: { A: 'a\nb', B: '5 €', C: '' } }))).toEqual([
            'The header A holds a control character, or a character beyond U+00FF.',
            'The header B holds a control character, or a character beyond U+00FF.',
            'The header C is empty.',
        ]);
    });

    test('a bad port', () => {
        expect(problems(http({ url: 'https://docs.example.com:6000/mcp' }))).toEqual([
            'The url has the port 6000, which fetch refuses.',
        ]);
    });

    test('plain HTTP with a reference', () => {
        const plainHttp =
            'The url is plain http, but it or a header holds a reference: use https, since even a request to 127.0.0.1 may go through a proxy.';

        expect(
            problems(
                http({
                    url: 'http://127.0.0.1:8080/mcp',
                    headers: { Authorization: 'Bearer ${T}' },
                }),
            ),
        ).toEqual([plainHttp]);
        expect(problems(http({ url: 'http://docs.example.com/s/${DOCS_SECRET}/mcp' }))).toEqual([
            plainHttp,
        ]);
        expect(problems(http({ url: 'HTTP://docs.example.com/${X}' }))).toEqual([plainHttp]);
        expect(problems(http({ url: 'http://127.0.0.1:8080/mcp', headers: { A: 'b' } }))).toEqual(
            [],
        );
        expect(problems(http({ url: 'https://docs.example.com/${X}' }))).toEqual([]);
    });

    test('plain HTTP hidden in the text, as the URL parser reads it', () => {
        const plainHttp =
            'The url is plain http, but it or a header holds a reference: use https, since even a request to 127.0.0.1 may go through a proxy.';
        const headers = { Authorization: 'Bearer ${T}' };

        expect(problems(http({ url: ' http://127.0.0.1:8080/mcp', headers }))).toEqual([plainHttp]);
        expect(problems(http({ url: '\u0001http://127.0.0.1:8080/mcp', headers }))).toEqual([
            plainHttp,
        ]);
        expect(problems(http({ url: 'ht\ttp://127.0.0.1:8080/mcp', headers }))).toEqual([
            plainHttp,
        ]);
        expect(problems(http({ url: 'h\nttp://127.0.0.1:8080/mcp', headers }))).toEqual([
            plainHttp,
        ]);
        expect(problems(http({ url: ' https://127.0.0.1:8080/mcp', headers }))).toEqual([]);
    });

    test("a URL that doesn't parse, with a reference", () => {
        expect(
            problems(
                http({
                    url: 'http://127.0.0.1:8080:9/mcp',
                    headers: { Authorization: 'Bearer ${T}' },
                }),
            ),
        ).toEqual(["The url isn't a URL."]);
    });

    test('every problem at once', () => {
        expect(
            problems(
                http({ colour: 'blue', toolTimeoutMs: -5, url: 'https://docs.example.com/mcp#x' }),
            ),
        ).toEqual([
            "The field colour isn't known.",
            'toolTimeoutMs must be a whole number of milliseconds from 1000 to 2147483647.',
            'The url has a fragment.',
        ]);
    });
});

describe('Unpinned packages', () => {
    test.each([
        [['-y', '@playwright/mcp'], '@playwright/mcp'],
        [['-y', '@playwright/mcp@latest'], '@playwright/mcp@latest'],
    ])('npx %j', (args, spec) => {
        expect(checked(stdio({ command: 'npx', args })).warnings).toEqual([
            {
                message: 'mcp server unpinned',
                reason: `${spec} isn't pinned to an exact version, so a run may start a version published later. Pin it, as in package@1.2.3.`,
            },
        ]);
    });

    test('a pinned package, and a command with a reference', () => {
        expect(
            checked(stdio({ command: 'npx', args: ['@playwright/mcp@0.0.83'] })).warnings,
        ).toEqual([]);
        expect(checked(stdio({ command: '${NPX}', args: ['@playwright/mcp'] })).warnings).toEqual(
            [],
        );
    });

    test('both warnings, unpinned first', () => {
        expect(
            checked(
                stdio({ command: 'uvx', args: ['mcp-server-fetch', '--api-key', '${K}'] }),
            ).warnings.map((warning) => warning.message),
        ).toEqual(['mcp server unpinned', 'mcp server secret in arguments']);
    });
});

describe('Names and their prefixes', () => {
    test.each([
        ['Context7-docs', 'context7_docs'],
        ['docs', 'docs'],
        ['a', 'a'],
        ['A-b_C', 'a_b_c'],
        ['x'.repeat(24), 'x'.repeat(24)],
    ])('%s takes the prefix %s', (name, prefix) => {
        expect(checkName(name)).toEqual([]);
        expect(prefixOf(name)).toBe(prefix);
    });

    test.each(['aws.docs', '-x', 'a__b', 'a_', 'a--b', '', 'x'.repeat(25), 'a b'])(
        '%j is refused, naming the rule',
        (name) => {
            expect(checkName(name)).toEqual([
                `The name ${JSON.stringify(name)} isn't allowed: a server's name is 1 to 24 letters and digits, in words joined by single - or _ characters.`,
            ]);
        },
    );
});

describe('What each check leaves alone', () => {
    test('an entry whose first field holds a url is no wrapper', () => {
        expect(problems({ env: { url: 'x' }, command: 'server', ...TIMEOUTS })).toEqual([]);
    });

    test('the transport an entry implies, or none', () => {
        expect(transportOfEntry(http())).toBe('http');
        expect(transportOfEntry(stdio())).toBe('stdio');
        expect(transportOfEntry(null)).toBeUndefined();
        expect(transportOfEntry([])).toBeUndefined();
    });

    test('defaults: no args, no env, no headers, and no warnings', () => {
        expect(checked(stdio()).entry).toMatchObject({ args: [], env: [], cwd: undefined });
        expect(checked(stdio()).warnings).toEqual([]);
        expect(checked(stdio({ command: 'npx' })).warnings).toEqual([]);
        expect(checked(http())).toMatchObject({ entry: { headers: [] }, warnings: [] });
    });

    test('an option followed by a setting is no secret, and warns of nothing', () => {
        expect(checked(stdio({ args: ['--max-tokens', '4096', '--auth=none'] })).warnings).toEqual(
            [],
        );
    });

    test("a name shaped like a secret is not quoted in its value's problems either", () => {
        expect(problems(stdio({ env: { A: 'x', [TOKEN]: 'a\u0000b' } }))).toEqual([
            `The name of env variable 2 holds text shaped like a token. ${ADVICE}`,
            'The env variable at position 2 holds a control character.',
        ]);
        expect(problems(http({ headers: { A: 'x', [TOKEN]: '' } }))).toEqual([
            `The name of header 2 holds text shaped like a token. ${ADVICE}`,
            'The header at position 2 is empty.',
        ]);
    });

    test('a path that only looks like a credential slot, and a query after a fragment', () => {
        expect(problems(http({ url: 'https://api.example.com/v1-token' }))).toEqual([]);
        expect(problems(http({ url: 'https://docs.example.com/mcp?x=1#&token=abc' }))).toEqual([
            'The url has a fragment.',
        ]);
    });

    test('plain http with one header of two holding a reference', () => {
        expect(
            problems(
                http({
                    url: 'http://127.0.0.1:8080/mcp',
                    headers: { 'X-Team': 'docs', Authorization: 'Bearer ${T}' },
                }),
            ),
        ).toEqual([
            'The url is plain http, but it or a header holds a reference: use https, since even a request to 127.0.0.1 may go through a proxy.',
        ]);
    });

    test('a URL whose path holds http:', () => {
        expect(problems(http({ url: 'https://docs.example.com/http:/${X}' }))).toEqual([]);
    });

    test('a reference in the scheme: the URL is checked with the reference standing in for it', () => {
        expect(problems(http({ url: '${SCHEME}://docs.example.com/mcp' }))).toEqual([
            "The url holds a reference outside its path and query: a reference may appear only in a URL's path and query.",
            'The url must start with https:// or http://.',
        ]);
    });
});
