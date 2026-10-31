import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { withDataSource } from '@mecha-gremlin/store/connection';
import { type Credential, findCredentials } from '@mecha-gremlin/store/credential';
import { type NewMcpServer, addMcpServer, listMcpServers } from '@mecha-gremlin/store/mcp-server';
import { type Store, closeStore, openStore } from '@mecha-gremlin/store/store';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { HELP } from '../../src/main/mcp-help.ts';
import { createMcpServers } from '../../src/mcp/servers.ts';
import { type AuthOptions, type FakeAuth, startAuthServer } from '../mcp/auth-server.ts';
import { type FakeHttp, startHttpServer } from '../mcp/http-server.ts';

const COMMAND = fileURLToPath(new URL('../../src/main/mcp.ts', import.meta.url));

// Each test sets or clears all of these, so settings in your shell or the repository's .env can't
// leak in. The command needs only DATA_DIR.
const SETTINGS = [
    'LOG_FORMAT',
    'DATA_DIR',
    'MODEL_PROVIDER',
    'MODEL_BASE_URL',
    'MODEL_API_KEY',
    'MODEL',
    'MODEL_REASONING_EFFORT',
    'MAX_STEPS',
    'FILE_TOOLS',
    'WORK_DIR',
] as const;

type Settings = Readonly<Partial<Record<(typeof SETTINGS)[number], string>>>;

const DOCS = 'https://docs.example.com/mcp';

const SEE_HELP = 'bun run mcp help explains the command.';

const NO_SERVERS =
    'There are no MCP servers. Add one with bun run mcp add <name> <url>, or bun run mcp add <name> -- <command> [args…].\n';

let dataDir: string;

beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'mcp-data-'));
});

afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
});

// A data folder of its own for each test, inside the one the file made.
let folder: string;

afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
    process.exitCode = undefined;
});

const freshFolder = async (): Promise<string> => {
    folder = await mkdtemp(join(dataDir, 'test-'));

    return folder;
};

/** Runs the command in this process, as main.test.ts runs the agent, and reads what it prints. */
const mcp = async (args: readonly string[], env: Settings = {}) => {
    const settings: Settings = { DATA_DIR: folder, ...env };

    for (const name of SETTINGS) {
        vi.stubEnv(name, settings[name]);
    }

    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const argv = process.argv;
    process.argv = [...argv.slice(0, 1), 'mcp.ts', ...args];
    let stdout = '';
    let stderr = '';
    // Both streams, in the order they were written to.
    const written: string[] = [];
    const out = vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
        stdout += `${String(text)}\n`;
        written.push(`stdout: ${String(text)}`);
    });
    const error = vi.spyOn(console, 'error').mockImplementation((text: unknown) => {
        stderr += `${String(text)}\n`;
        written.push(`stderr: ${String(text)}`);
    });

    try {
        // A module runs only once until the registry is reset.
        vi.resetModules();
        await import('../../src/main/mcp.ts');
    } finally {
        process.argv = argv;
        out.mockRestore();
        error.mockRestore();
    }

    const code = process.exitCode;
    process.exitCode = undefined;

    return { code, stdout, stderr, written, fetch };
};

// A store of its own, opened and closed around the work, as another process would.
const withStore = async <T>(work: (store: Store) => Promise<T>): Promise<T> => {
    const opened = await openStore(folder);

    if (!opened.ok) {
        throw new Error(opened.error);
    }

    try {
        return await work(opened.value.store);
    } finally {
        await closeStore(opened.value.store);
    }
};

const outside = (...statements: readonly string[]): Promise<void> => {
    return withStore(async (store) => {
        for (const statement of statements) {
            await withDataSource(store, 'change the database', (dataSource) => {
                return dataSource.query(statement);
            });
        }
    });
};

const stored = (): Promise<{ name: string; entry: object; disabled: boolean }[]> => {
    return withStore(async (store) => {
        const listed = await listMcpServers(store);

        if (!listed.ok) {
            throw new Error(listed.error);
        }

        return listed.value.map(({ name, entry, disabled }) => ({ name, entry, disabled }));
    });
};

const storedBefore = (servers: readonly NewMcpServer[]): Promise<void> => {
    return withStore(async (store) => {
        for (const server of servers) {
            const added = await addMcpServer(store, server);

            if (!added.ok) {
                throw new Error(added.error);
            }
        }
    });
};

describe('Manage MCP servers from the command line', () => {
    test('adding and listing', async () => {
        await freshFolder();

        const added = await mcp(['add', 'docs', DOCS]);
        const listed = await mcp(['list']);

        expect(added).toMatchObject({ code: 0, stdout: 'Added docs (http).\n', stderr: '' });
        expect(listed).toMatchObject({ code: 0, stderr: '' });
        expect(listed.stdout).toBe(
            [
                'NAME  TRANSPORT  TARGET                        ENABLED',
                'docs  http       https://docs.example.com/mcp  yes',
                '',
            ].join('\n'),
        );
    });

    test('two servers, in name order, and the store closed after each command', async () => {
        await freshFolder();
        await mcp([
            'add',
            'files',
            '--',
            'npx',
            '-y',
            '@modelcontextprotocol/server-filesystem@2.1.0',
        ]);
        await mcp(['add', 'docs', DOCS]);

        const listed = await mcp(['list']);

        expect(listed.stdout).toBe(
            [
                'NAME   TRANSPORT  TARGET                                                ENABLED',
                'docs   http       https://docs.example.com/mcp                          yes',
                'files  stdio      npx -y @modelcontextprotocol/server-filesystem@2.1.0  yes',
                '',
            ].join('\n'),
        );
        // An open store keeps its -wal and -shm files.
        expect(await readdir(folder)).toEqual(['db.sqlite']);
    });

    test('showing one server', async () => {
        await freshFolder();
        await mcp([
            'add',
            'docs',
            DOCS,
            '--header',
            'Authorization: Bearer ${DOCS_TOKEN}',
            '--tool-timeout',
            '5m',
        ]);

        const shown = await mcp(['get', 'docs']);

        expect(shown).toMatchObject({ code: 0, stderr: '' });
        expect(shown.stdout).toBe(
            [
                'docs',
                '  Transport        http',
                '  URL              https://docs.example.com/mcp',
                '  Header           Authorization: Bearer ${DOCS_TOKEN}',
                '  Startup timeout  30s',
                '  Tool timeout     5m',
                '  Login            no',
                '  Enabled          yes',
                'To change it, remove it with bun run mcp remove docs, then add it again.',
                '',
            ].join('\n'),
        );
    });

    test('a local server in the table', async () => {
        await freshFolder();
        await mcp([
            'add',
            'files',
            '--',
            'npx',
            '-y',
            '@modelcontextprotocol/server-filesystem@2.1.0',
            '/srv/my data',
        ]);

        const { stdout } = await mcp(['list']);

        expect(stdout.split('\n')[1]).toBe(
            "files  stdio      npx -y @modelcontextprotocol/server-filesystem@2.1.0 '/srv/my data'  yes",
        );
    });

    test('removing', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);

        const removed = await mcp(['remove', 'docs']);
        const listed = await mcp(['list']);

        expect(removed).toMatchObject({ code: 0, stdout: 'Removed docs.\n', stderr: '' });
        expect(listed.stdout).toBe(NO_SERVERS);
    });

    test('disabling and enabling', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);

        const disabled = await mcp(['disable', 'docs']);
        const whileDisabled = await mcp(['list']);
        const enabled = await mcp(['enable', 'docs']);
        const afterwards = await mcp(['list']);

        expect(disabled).toMatchObject({
            code: 0,
            stdout: "Disabled docs. Runs won't start it until bun run mcp enable docs.\n",
            stderr: '',
        });
        expect(enabled).toMatchObject({ code: 0, stdout: 'Enabled docs.\n', stderr: '' });
        expect(whileDisabled.stdout.split('\n')[1]).toMatch(/^docs .* no$/);
        expect(afterwards.stdout.split('\n')[1]).toMatch(/^docs .* yes$/);
    });

    test.each(['get', 'remove', 'disable', 'enable', 'login', 'logout'])(
        '%s an unknown name',
        async (subcommand) => {
            await freshFolder();
            await mcp(['add', 'docs', DOCS]);

            const result = await mcp([subcommand, 'nope']);

            expect(result).toMatchObject({
                code: 1,
                stdout: '',
                stderr: 'error: There is no MCP server named nope: bun run mcp list shows them.\n',
            });
            expect(await stored()).toMatchObject([{ name: 'docs', disabled: false }]);
        },
    );

    test('a name in use', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);

        const again = await mcp(['add', 'docs', '--', 'server']);

        expect(again).toMatchObject({
            code: 1,
            stdout: '',
            stderr: 'error: The MCP server docs exists. To change it, remove it with bun run mcp remove docs, then add it again.\n',
        });
        expect(await stored()).toEqual([
            {
                name: 'docs',
                entry: { url: DOCS, startupTimeoutMs: 30000, toolTimeoutMs: 120000 },
                disabled: false,
            },
        ]);
    });

    test('a prefix in use', async () => {
        await freshFolder();
        await mcp(['add', 'github-api', DOCS]);

        const again = await mcp(['add', 'github_api', DOCS]);

        expect(again).toMatchObject({
            code: 1,
            stderr: 'error: The tools of github_api would share the prefix github_api with those of the MCP server github-api: give it another name.\n',
        });
        expect((await stored()).map((server) => server.name)).toEqual(['github-api']);
    });

    test.each([
        [
            ['start'],
            `Give one of the subcommands: add <name> <url>, add <name> -- <command>, list, get <name>, remove <name>, disable <name>, enable <name>, login <name> or logout <name>. ${SEE_HELP}`,
        ],
        [['list', 'extra'], `list takes no arguments. ${SEE_HELP}`],
        [['get'], `get takes a server's name: bun run mcp get <name>. ${SEE_HELP}`],
        [
            ['add', 'docs'],
            `add takes a server's name, and then a URL or, after --, a command: bun run mcp add <name> <url> [options], or bun run mcp add <name> [options] -- <command> [args…]. ${SEE_HELP}`,
        ],
        [
            ['add', 'playwright', 'npx', '-y', '@playwright/mcp@0.0.83'],
            `The option -y isn't known. A local server's command, with its own options, comes after --: bun run mcp add <name> [options] -- <command> [args…]. ${SEE_HELP}`,
        ],
    ])('the usage error for %j', async (args, problem) => {
        await freshFolder();

        const result = await mcp(args);

        expect(result).toMatchObject({ code: 1, stdout: '', stderr: `error: ${problem}\n` });
        expect(await readdir(folder)).toEqual([]);
    });

    test('the setting it needs', async () => {
        await freshFolder();

        const first = await mcp(['list'], { LOG_FORMAT: undefined });
        const withAnyFormat = await mcp(['list'], { LOG_FORMAT: 'xml' });
        const second = await mcp(['list'], { DATA_DIR: undefined });

        expect(first).toMatchObject({ code: 0, stdout: NO_SERVERS, stderr: '' });
        expect(withAnyFormat).toMatchObject({ code: 0, stdout: NO_SERVERS, stderr: '' });
        expect(second).toMatchObject({
            code: 1,
            stdout: '',
            stderr: 'error: DATA_DIR is required.\n',
        });
    });

    test('the setting and the arguments, reported together', async () => {
        await freshFolder();

        const { code, stderr } = await mcp(['start'], { DATA_DIR: join(folder, 'no') });

        expect(code).toBe(1);
        expect(stderr.split('\n')).toEqual([
            `error: DATA_DIR must name an existing directory; ${join(folder, 'no')} isn't one.`,
            expect.stringMatching(/^error: Give one of the subcommands: /),
            '',
        ]);
    });

    test('a new data folder', async () => {
        await freshFolder();

        const result = await mcp(['list']);

        expect(result).toMatchObject({ code: 0, stdout: NO_SERVERS, stderr: '' });
        expect(await readdir(folder)).toEqual(['db.sqlite']);
    });

    test("a data folder whose store can't open", async () => {
        await freshFolder();
        await mkdir(join(folder, 'db.sqlite'));

        const { code, stdout, stderr } = await mcp(['list']);

        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toMatch(
            /^error: Can't open the database at .*db\.sqlite: unable to open database file\n$/,
        );
    });

    test('offline: a reference to a variable that is not set is stored as written', async () => {
        await freshFolder();

        const added = await mcp([
            'add',
            'docs',
            DOCS,
            '--header',
            'Authorization: Bearer ${DOCS_TOKEN_UNSET}',
        ]);
        const shown = await mcp(['get', 'docs']);

        expect(added.code).toBe(0);
        expect(added.fetch).not.toHaveBeenCalled();
        expect(shown.fetch).not.toHaveBeenCalled();
        expect(shown.stdout).toContain(
            '  Header           Authorization: Bearer ${DOCS_TOKEN_UNSET}\n',
        );
        expect(await stored()).toMatchObject([
            { entry: { headers: { Authorization: 'Bearer ${DOCS_TOKEN_UNSET}' } } },
        ]);
    });

    test('disabled at the start, then enabled', async () => {
        await freshFolder();

        const added = await mcp(['add', 'docs', DOCS, '--disabled']);
        const listed = await mcp(['list']);
        const whileDisabled = await stored();
        await mcp(['enable', 'docs']);

        expect(added).toMatchObject({
            code: 0,
            stdout: "Added docs (http). Runs won't start it until bun run mcp enable docs.\n",
        });
        expect(listed.stdout.split('\n')[1]).toBe(
            'docs  http       https://docs.example.com/mcp  no',
        );
        expect(whileDisabled).toEqual([
            {
                name: 'docs',
                entry: { url: DOCS, startupTimeoutMs: 30000, toolTimeoutMs: 120000 },
                disabled: true,
            },
        ]);
        expect(await stored()).toMatchObject([{ disabled: false }]);
    });

    test('warnings on stderr, before the result', async () => {
        await freshFolder();

        const { code, written } = await mcp([
            'add',
            'Playwright',
            '--',
            'npx',
            '-y',
            '@playwright/mcp@latest',
            '--api-key',
            '${KEY}',
        ]);

        expect(code).toBe(0);
        expect(written).toEqual([
            "stderr: warning: @playwright/mcp@latest isn't pinned to an exact version, so a run may start a version published later. Pin it, as in package@1.2.3.",
            'stderr: warning: Argument 4, after --api-key, holds a reference: a run puts its value in the process list, which every local user can read. Give it in env instead, if the server reads one.',
            'stdout: Added Playwright (stdio).',
        ]);
    });

    test('a variable named __proto__ is stored like any other', async () => {
        await freshFolder();
        await mcp(['add', 'files', '--env', '__proto__=x', '--', 'server']);

        const shown = await mcp(['get', 'files']);
        const [server] = await stored();

        expect(shown.stdout).toContain('  Variable         __proto__=x\n');
        expect(JSON.stringify(server?.entry)).toBe(
            '{"command":"server","env":{"__proto__":"x"},"startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        );
    });

    test('rows stored before the flags keep working', async () => {
        await freshFolder();
        await storedBefore([
            {
                name: 'docs',
                prefix: 'docs',
                entry: {
                    type: 'http',
                    url: DOCS,
                    title: 'Docs',
                    startupTimeoutMs: 60000,
                    toolTimeoutMs: 120000,
                },
                disabled: false,
            },
        ]);

        const listed = await mcp(['list']);
        const shown = await mcp(['get', 'docs']);

        expect(listed.stdout.split('\n')[1]).toBe(
            'docs  http       https://docs.example.com/mcp  yes',
        );
        expect(shown.stdout.split('\n').slice(1, 5)).toEqual([
            '  Transport        http',
            '  URL              https://docs.example.com/mcp',
            '  Startup timeout  1m',
            '  Tool timeout     2m',
        ]);
    });

    test('a row whose entry names no transport is listed without one', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);
        await outside(`UPDATE mcp_server SET entry = '{"note":[1,true,null]}'`);

        const { code, stdout } = await mcp(['list']);

        expect(code).toBe(0);
        expect(stdout).toBe('NAME  TRANSPORT  TARGET  ENABLED\ndocs  -          -       yes\n');
    });
});

describe('Describe a server with flags, and store nothing for one with a problem', () => {
    test('every problem at once', async () => {
        await freshFolder();

        const { code, stdout, stderr } = await mcp([
            'add',
            'my docs',
            DOCS,
            '--tool-timeout',
            '30',
            '--header',
            'Authorization',
        ]);

        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toBe(
            [
                `error: The name "my docs" isn't allowed: a server's name is 1 to 24 letters and digits, in words joined by single - or _ characters.`,
                "error: A --header has no colon: give each as --header 'Name: value'.",
                'error: --tool-timeout needs a unit, as in 30s: ms, s, m or h.',
                '',
            ].join('\n'),
        );
        expect(await readdir(folder)).toEqual([]);
    });

    test('a literal token appears in no output', async () => {
        await freshFolder();

        const { code, stdout, stderr } = await mcp([
            'add',
            'docs',
            DOCS,
            '--header',
            'Authorization: Bearer abc123def',
        ]);

        expect(code).toBe(1);
        expect(stderr).toContain('error: The header Authorization holds a literal secret.');
        expect(stderr).toContain('in single quotes, so that your shell leaves it alone.');
        expect(`${stdout}${stderr}`).not.toContain('abc123def');
    });
});

describe("Report the store's failures", () => {
    test('a table that has gone', async () => {
        await freshFolder();
        await mcp(['list']);
        await outside('DROP TABLE mcp_server');

        const results = [
            await mcp(['list']),
            await mcp(['get', 'docs']),
            await mcp(['add', 'docs', DOCS]),
            await mcp(['remove', 'docs']),
            await mcp(['disable', 'docs']),
            await mcp(['login', 'docs']),
            await mcp(['logout', 'docs']),
        ];

        expect(results.map((result) => result.code)).toEqual([1, 1, 1, 1, 1, 1, 1]);
        expect(results.map((result) => result.stdout)).toEqual(['', '', '', '', '', '', '']);
        expect(results.map((result) => result.stderr)).toEqual([
            expect.stringMatching(
                /^error: Can't list the MCP servers in the database at .*: SqliteError: no such table: mcp_server\n$/,
            ),
            expect.stringMatching(/^error: Can't list the MCP servers in the database at /),
            expect.stringMatching(/^error: Can't list the MCP servers in the database at /),
            expect.stringMatching(/^error: Can't list the MCP servers in the database at /),
            expect.stringMatching(/^error: Can't set the MCP server flag in the database at /),
            expect.stringMatching(/^error: Can't list the MCP servers in the database at /),
            expect.stringMatching(/^error: Can't list the MCP servers in the database at /),
        ]);
    });

    test('an insert that fails', async () => {
        await freshFolder();
        await mcp(['list']);
        await outside(
            "CREATE TRIGGER refuse BEFORE INSERT ON mcp_server BEGIN SELECT RAISE(ABORT, 'refused'); END",
        );

        const { code, stdout, stderr } = await mcp(['add', 'docs', '--', 'npx', 'pkg@1.0.0']);

        expect(code).toBe(1);
        expect(stdout).toBe('');
        expect(stderr).toMatch(
            /^error: Can't add the MCP server in the database at .*: SqliteError: refused\n$/,
        );
    });
});

describe('Help', () => {
    test('help, with no setting at all', async () => {
        await freshFolder();

        const { code, stdout, stderr } = await mcp(['help'], { DATA_DIR: undefined });

        expect(code).toBe(0);
        expect(stdout).toBe(`${HELP}\n`);
        expect(stderr).toBe('');

        for (const term of [
            'bun run mcp add <name> <url>',
            'bun run mcp add <name> [options] -- <command>',
            'bun run mcp list',
            'bun run mcp get <name>',
            'bun run mcp remove <name>',
            'bun run mcp disable <name>',
            'bun run mcp enable <name>',
            '--header',
            '--env',
            '--cwd',
            '--include-tool',
            '--exclude-tool',
            '--startup-timeout',
            '--tool-timeout',
            '--disabled',
            'bun run mcp login <name>',
            'bun run mcp logout <name>',
            '--client-id',
            '--client-secret',
            '--redirect-uri',
            '--scope',
            '30s',
            '2m',
            "'Authorization: Bearer ${GITHUB_PAT}'",
            'DATA_DIR',
            'mcp:node',
            '1 to 24',
            'README',
        ]) {
            expect(stdout).toContain(term);
        }
    });

    test('within 80 columns', () => {
        for (const line of HELP.split('\n')) {
            expect(line.length).toBeLessThanOrEqual(80);
        }
    });

    test("help, however it's asked for, and no store opened", async () => {
        await freshFolder();

        const byFlag = await mcp(['--help']);
        const byLetter = await mcp(['-h']);
        const withMore = await mcp(['help', 'add']);

        expect([byFlag.code, byLetter.code, withMore.code]).toEqual([0, 0, 0]);
        expect([byFlag.stdout, byLetter.stdout, withMore.stdout]).toEqual([
            `${HELP}\n`,
            `${HELP}\n`,
            `${HELP}\n`,
        ]);
        expect(await readdir(folder)).toEqual([]);
    });

    test('no arguments: the same text, and exit code 1', async () => {
        await freshFolder();

        const { code, stdout } = await mcp([]);

        expect(code).toBe(1);
        expect(stdout).toBe(`${HELP}\n`);
        expect(await readdir(folder)).toEqual([]);
    });
});

// The command run as `bun run mcp` and `bun run mcp:node` run it, as a process of its own.
const runAs = (program: string, args: readonly string[], env: Readonly<Record<string, string>>) => {
    const child = spawn(program, [COMMAND, ...args], {
        cwd: folder,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });

    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        child.once('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
};

describe('On Bun and on Node', { timeout: 15_000 }, () => {
    test('the same output', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);
        const env = { DATA_DIR: folder };

        const onNode = await runAs('node', ['list'], env);
        const onBun = await runAs('bun', ['list'], env);
        const errorOnNode = await runAs('node', ['remove', 'nope'], env);
        const errorOnBun = await runAs('bun', ['remove', 'nope'], env);

        expect(onNode).toEqual(onBun);
        expect(onNode).toEqual({
            code: 0,
            stdout: 'NAME  TRANSPORT  TARGET                        ENABLED\ndocs  http       https://docs.example.com/mcp  yes\n',
            stderr: '',
        });
        expect(errorOnNode).toEqual(errorOnBun);
        expect(errorOnNode).toEqual({
            code: 1,
            stdout: '',
            stderr: 'error: There is no MCP server named nope: bun run mcp list shows them.\n',
        });
    });
});

// Captured before any test stubs it.
const realFetch = globalThis.fetch;

const PROXIES = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
];

type Started = {
    readonly done: Promise<{ code: unknown; stdout: string; stderr: string }>;
    readonly stdout: () => string;
    readonly stdin: PassThrough;
    /** The authorization URL, once the command has printed it. */
    readonly url: () => Promise<string>;
};

/**
 * Runs the command in this process, as mcp() does, without waiting for it: a login waits for its
 * redirect. Requests reach the network, which is 127.0.0.1 here, and stdin is the test's.
 */
const startMcp = (
    args: readonly string[],
    env: Settings & Readonly<Record<string, string>> = {},
) => {
    const settings: Readonly<Record<string, string | undefined>> = { DATA_DIR: folder, ...env };

    for (const name of [...SETTINGS, ...Object.keys(env)]) {
        vi.stubEnv(name, settings[name]);
    }

    // A request to 127.0.0.1 mustn't go through the developer's proxy (Brief R18.1).
    for (const name of PROXIES) {
        vi.stubEnv(name, undefined);
    }

    vi.stubEnv('NO_PROXY', '127.0.0.1,localhost');
    // mcp() leaves its fake in place until the test ends.
    vi.stubGlobal('fetch', realFetch);
    const stdin = new PassThrough();
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    const argv = process.argv;
    process.argv = [...argv.slice(0, 1), 'mcp.ts', ...args];
    let stdout = '';
    let stderr = '';
    const out = vi.spyOn(console, 'log').mockImplementation((text: unknown) => {
        stdout += `${String(text)}\n`;
    });
    const error = vi.spyOn(console, 'error').mockImplementation((text: unknown) => {
        stderr += `${String(text)}\n`;
    });

    vi.resetModules();
    const done = import('../../src/main/mcp.ts').then(() => {
        const code = process.exitCode;
        process.exitCode = undefined;

        return { code, stdout, stderr };
    });
    const restored = done.finally(() => {
        process.argv = argv;
        out.mockRestore();
        error.mockRestore();

        if (original !== undefined) {
            Object.defineProperty(process, 'stdin', original);
        }
    });

    return {
        done: restored,
        stdout: () => stdout,
        stdin,
        url: async () => {
            await vi.waitFor(
                () => {
                    expect(stdout).toMatch(/^http:\/\/\S+$/m);
                },
                { timeout: 10_000, interval: 10 },
            );

            return String(/^http:\/\/\S+$/m.exec(stdout)?.[0]);
        },
    } satisfies Started;
};

const loginCleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    await Promise.all(loginCleanups.splice(0).map((cleanup) => cleanup()));
});

type Guarded = {
    readonly auth: FakeAuth;
    readonly server: FakeHttp;
};

/** A Streamable HTTP server with two tools, which the fake authorization server guards. */
const guarded = async (options: AuthOptions = {}): Promise<Guarded> => {
    const auth = await startAuthServer(options);
    let url = '';
    const server = await startHttpServer({
        tools: ['search', 'fetch'].map((name) => ({
            name,
            call: () => ({ content: [{ type: 'text', text: name }] }),
        })),
        answer: (request) => auth.guard(request, url),
    });
    url = server.url;
    loginCleanups.push(server.close, auth.close);

    return { auth, server };
};

const credentials = (url: string): Promise<Credential[]> => {
    return withStore(async (store) => {
        const found = await findCredentials(store, { server: 'docs', url });

        if (!found.ok) {
            throw new Error(found.error);
        }

        return found.value;
    });
};

/** `login docs`, the browser following the URL it prints and coming back. */
const loginThroughBrowser = async (
    { auth }: Guarded,
    args: readonly string[] = [],
    env: Readonly<Record<string, string>> = {},
) => {
    const started = startMcp(['login', 'docs', ...args], env);
    const url = await started.url();
    const redirect = await auth.authorize(url);
    await realFetch(redirect);
    const result = await started.done;

    return { ...result, url, redirect };
};

// A run, as a later one would reach the server: its own store on the data folder.
const laterRun = async (url: string) => {
    vi.stubGlobal('fetch', realFetch);

    return withStore(async (store) => {
        const run = createMcpServers({
            parentEnv: {},
            runId: 'later00',
            workDir: folder,
            dataDir: folder,
            store,
            log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        });

        try {
            return await run.connect([
                {
                    name: 'docs',
                    prefix: 'docs',
                    entry: { url, startupTimeoutMs: 10_000, toolTimeoutMs: 10_000 },
                },
            ]);
        } finally {
            await run.close();
        }
    });
};

describe('Log in to a Streamable HTTP server with OAuth', { timeout: 20_000 }, () => {
    test('a login through the browser, and a later run with the saved token', async () => {
        await freshFolder();
        const guard = await guarded();
        await mcp(['add', 'docs', guard.server.url]);

        const { code, stdout, stderr, url } = await loginThroughBrowser(guard);
        const [row] = await credentials(guard.server.url);
        const later = await laterRun(guard.server.url);

        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(stdout).toBe(
            [
                'Open this address in a browser, and sign in to docs:',
                '',
                url,
                '',
                "If the browser can't reach this machine, as over SSH, paste here the address it ends on, and press Enter. The login waits 5 minutes.",
                'Logged in to docs: 2 tools.',
                '',
            ].join('\n'),
        );
        expect(later.ok).toBe(true);
        expect(guard.server.requests.at(-1)?.headers.authorization).toBe(
            `Bearer ${String(Object(row?.tokens).access_token)}`,
        );
    });

    test('a pasted redirect', async () => {
        await freshFolder();
        const guard = await guarded();
        await mcp(['add', 'docs', guard.server.url]);
        const started = startMcp(['login', 'docs']);
        const redirect = await guard.auth.authorize(await started.url());

        started.stdin.write(`${redirect}\n`);
        const { code, stdout } = await started.done;

        expect(code).toBe(0);
        expect(stdout).toMatch(/\nLogged in to docs: 2 tools\.\n$/);
    });

    test('a warning about a pasted line, before the result', async () => {
        await freshFolder();
        const guard = await guarded();
        await mcp(['add', 'docs', guard.server.url]);
        const started = startMcp(['login', 'docs']);
        const url = await started.url();

        started.stdin.write('the wrong thing\n');
        await realFetch(await guard.auth.authorize(url));
        const { code, stderr } = await started.done;

        expect(code).toBe(0);
        expect(stderr).toBe(
            "warning: That line isn't the address the browser ended on: paste all of it, which holds code= or error=.\n",
        );
    });

    test('a server that offers no OAuth', async () => {
        await freshFolder();
        const server = await startHttpServer();
        loginCleanups.push(server.close);
        await mcp(['add', 'docs', server.url]);

        const result = await startMcp(['login', 'docs']).done;

        expect(result).toEqual({
            code: 1,
            stdout: '',
            stderr: 'error: The MCP server docs offers no OAuth login: it publishes no OAuth metadata.\n',
        });
    });

    test('a local server', async () => {
        await freshFolder();
        await mcp(['add', 'playwright', '--', 'npx', '-y', '@playwright/mcp@0.0.83']);
        await mcp(['add', 'unresolved', '--env', 'TOKEN=${UNSET_TOKEN}', '--', 'server']);

        const results = [
            await startMcp(['login', 'playwright']).done,
            await startMcp(['login', 'unresolved']).done,
        ];

        expect(results).toEqual([
            {
                code: 1,
                stdout: '',
                stderr: 'error: The MCP server playwright is a local one, and a local server has no OAuth login: what it needs comes from its env and its arguments.\n',
            },
            {
                code: 1,
                stdout: '',
                stderr: 'error: The MCP server unresolved is a local one, and a local server has no OAuth login: what it needs comes from its env and its arguments.\n',
            },
        ]);
    });

    test("a remote server whose references don't resolve fails as a run would", async () => {
        await freshFolder();
        await mcp(['add', 'docs', 'https://docs.example.test/mcp?key=${DOCS_KEY_UNSET}']);

        const result = await startMcp(['login', 'docs']).done;

        expect(result).toEqual({
            code: 1,
            stdout: '',
            stderr: "error: The MCP server docs can't start. It refers to DOCS_KEY_UNSET, which is unset or blank: set it in .env. To run without it: bun run mcp disable docs.\n",
        });
    });

    test('nothing secret printed: the code, the tokens, the verifier and the client secret', async () => {
        await freshFolder();
        const guard = await guarded({ clients: { abc: 'open-sesame' } });
        await mcp(['add', 'docs', guard.server.url]);

        const { code, stdout, stderr, redirect } = await loginThroughBrowser(
            guard,
            ['--client-id', 'abc', '--client-secret', '${DOCS_SECRET}'],
            { DOCS_SECRET: 'open-sesame' },
        );
        const [row] = await credentials(guard.server.url);
        const tokens = Object(row?.tokens);
        const [exchange] = guard.auth.tokenRequests;
        const output = `${stdout}${stderr}`;

        expect(code).toBe(0);
        expect(exchange?.authorization).toBe(
            `Basic ${Buffer.from('abc:open-sesame').toString('base64')}`,
        );

        for (const secret of [
            String(new URL(redirect).searchParams.get('code')),
            String(tokens.access_token),
            String(tokens.refresh_token),
            String(exchange?.code_verifier),
            'open-sesame',
        ]) {
            expect(output).not.toContain(secret);
        }
    });

    test("a client secret whose variable isn't set", async () => {
        await freshFolder();
        await mcp(['add', 'docs', 'https://docs.example.test/mcp']);

        const result = await startMcp([
            'login',
            'docs',
            '--client-id',
            'abc',
            '--client-secret',
            '${DOCS_SECRET_UNSET}',
        ]).done;

        expect(result).toEqual({
            code: 1,
            stdout: '',
            stderr: 'error: --client-secret refers to DOCS_SECRET_UNSET, which is unset or blank: set it in .env.\n',
        });
    });

    test('a literal client secret: refused, and shown nowhere', async () => {
        await freshFolder();
        await mcp(['add', 'docs', 'https://docs.example.test/mcp']);

        const { code, stdout, stderr } = await startMcp([
            'login',
            'docs',
            '--client-id',
            'abc',
            '--client-secret',
            'hunter2-literal',
        ]).done;

        expect(code).toBe(1);
        expect(stderr).toContain('error: --client-secret holds a literal secret.');
        expect(stderr).toContain('in single quotes, so that your shell leaves it alone.');
        expect(`${stdout}${stderr}`).not.toContain('hunter2-literal');
    });

    test('the scope given', async () => {
        await freshFolder();
        const guard = await guarded();
        await mcp(['add', 'docs', guard.server.url]);

        const { code, url } = await loginThroughBrowser(guard, ['--scope', 'read write']);

        expect(code).toBe(0);
        expect(new URL(url).searchParams.get('scope')).toBe('read write');
    });

    test('a refusal', async () => {
        await freshFolder();
        const guard = await guarded();
        await mcp(['add', 'docs', guard.server.url]);
        const started = startMcp(['login', 'docs']);
        const redirect = await guard.auth.authorize(await started.url(), { deny: true });

        await realFetch(redirect);
        const { code, stderr } = await started.done;

        expect(code).toBe(1);
        expect(stderr).toBe(
            'error: The authorization server refused the login to docs: access_denied.\n',
        );
    });
});

const loginLine = (stdout: string): string | undefined => {
    return stdout.split('\n').find((line) => line.startsWith('  Login'));
};

describe('Log out, and show a login', { timeout: 20_000 }, () => {
    test('logging out: the rows gone, and a later run needs a login', async () => {
        await freshFolder();
        const guard = await guarded();
        await mcp(['add', 'docs', guard.server.url]);
        await loginThroughBrowser(guard);

        const out = await mcp(['logout', 'docs']);
        const again = await mcp(['logout', 'docs']);
        const later = await laterRun(guard.server.url);

        expect(out).toMatchObject({ code: 0, stdout: 'Logged out of docs.\n', stderr: '' });
        expect(again).toMatchObject({ code: 0, stdout: 'docs has no login.\n', stderr: '' });
        expect(await credentials(guard.server.url)).toEqual([]);
        expect(later).toEqual({
            ok: false,
            error: [
                "The MCP server docs couldn't start: it needs a login: bun run mcp login docs.\nTo run without it: bun run mcp disable docs.",
            ],
        });
    });

    test('a local server has no login to log out of, and needs no table of them', async () => {
        await freshFolder();
        await mcp(['add', 'files', '--', 'server']);
        await outside('DROP TABLE credential');

        const out = await mcp(['logout', 'files']);
        const removed = await mcp(['remove', 'files']);

        expect(out).toMatchObject({ code: 0, stdout: 'files has no login.\n', stderr: '' });
        expect(removed).toMatchObject({ code: 0, stdout: 'Removed files.\n', stderr: '' });
    });

    test('removing a server that is logged in: its rows gone', async () => {
        await freshFolder();
        const guard = await guarded();
        await mcp(['add', 'docs', guard.server.url]);
        await loginThroughBrowser(guard);

        const removed = await mcp(['remove', 'docs']);

        expect(removed).toMatchObject({ code: 0, stdout: 'Removed docs.\n', stderr: '' });
        expect(await credentials(guard.server.url)).toEqual([]);
        expect(await stored()).toEqual([]);
    });

    test('showing a login: no, yes, and needs a new login', async () => {
        await freshFolder();
        const guard = await guarded();
        await mcp(['add', 'docs', guard.server.url]);
        const before = loginLine((await mcp(['get', 'docs'])).stdout);
        await loginThroughBrowser(guard);
        const after = loginLine((await mcp(['get', 'docs'])).stdout);
        await outside('UPDATE credential SET needs_login = 1');
        const refused = loginLine((await mcp(['get', 'docs'])).stdout);

        expect([before, after, refused]).toEqual([
            '  Login            no',
            '  Login            yes',
            '  Login            needs a new login',
        ]);
    });

    test("logins that can't be read", async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);
        await outside('DROP TABLE credential');

        const results = [
            await mcp(['get', 'docs']),
            await mcp(['logout', 'docs']),
            await mcp(['remove', 'docs']),
        ];

        expect(results.map((result) => result.code)).toEqual([1, 1, 1]);
        expect(results.map((result) => result.stderr)).toEqual([
            expect.stringMatching(/^error: Can't find the credentials in the database at /),
            expect.stringMatching(/^error: Can't delete the credentials in the database at /),
            expect.stringMatching(/^error: Can't delete the credentials in the database at /),
        ]);
        expect(await stored()).toMatchObject([{ name: 'docs' }]);
    });

    test("a server that can't be removed after its logins are", async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);
        await outside(
            "CREATE TRIGGER refuse BEFORE DELETE ON mcp_server BEGIN SELECT RAISE(ABORT, 'refused'); END",
        );

        const { code, stderr } = await mcp(['remove', 'docs']);

        expect(code).toBe(1);
        expect(stderr).toMatch(
            /^error: Can't remove the MCP server in the database at .*: SqliteError: refused\n$/,
        );
    });
});

// The command as `bun run mcp login` runs it: a process of its own, whose stdin stays open.
const loginAs = (program: string, guard: Guarded) => {
    const child = spawn(program, [COMMAND, 'login', 'docs'], {
        cwd: folder,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', DATA_DIR: folder, NO_PROXY: '127.0.0.1' },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
    });
    const authorized = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
            const url = /^http:\/\/\S+$/m.exec(stdout)?.[0];

            if (url !== undefined && !stdout.includes('Logged in')) {
                guard.auth
                    .authorize(url)
                    .then(realFetch)
                    .then(() => resolve(), reject);
            }
        });
    });

    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        child.once('close', (code) => {
            child.stdin.destroy();
            resolve({ code, stdout, stderr });
        });
        void authorized.catch(() => child.kill());
    });
};

describe('Log in on Bun and on Node', { timeout: 30_000 }, () => {
    test.each(['bun', 'node'])(
        'on %s, the process ends though stdin stays open',
        async (program) => {
            await freshFolder();
            const guard = await guarded();
            await mcp(['add', 'docs', guard.server.url]);

            const result = await loginAs(program, guard);

            expect(result.code).toBe(0);
            expect(result.stderr).toBe('');
            expect(result.stdout).toMatch(/\nLogged in to docs: 2 tools\.\n$/);
        },
    );
});
