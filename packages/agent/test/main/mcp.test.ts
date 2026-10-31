import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withDataSource } from '@mecha-gremlin/store/connection';
import { type NewMcpServer, addMcpServer, listMcpServers } from '@mecha-gremlin/store/mcp-server';
import { type Store, closeStore, openStore } from '@mecha-gremlin/store/store';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { HELP } from '../../src/main/mcp-help.ts';

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

    test.each(['get', 'remove', 'disable', 'enable'])('%s an unknown name', async (subcommand) => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);

        const result = await mcp([subcommand, 'nope']);

        expect(result).toMatchObject({
            code: 1,
            stdout: '',
            stderr: 'error: There is no MCP server named nope: bun run mcp list shows them.\n',
        });
        expect(await stored()).toMatchObject([{ name: 'docs', disabled: false }]);
    });

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
            `Give one of the subcommands: add <name> <url>, add <name> -- <command>, list, get <name>, remove <name>, disable <name> or enable <name>. ${SEE_HELP}`,
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
        ];

        expect(results.map((result) => result.code)).toEqual([1, 1, 1, 1, 1]);
        expect(results.map((result) => result.stdout)).toEqual(['', '', '', '', '']);
        expect(results.map((result) => result.stderr)).toEqual([
            expect.stringMatching(
                /^error: Can't list the MCP servers in the database at .*: SqliteError: no such table: mcp_server\n$/,
            ),
            expect.stringMatching(/^error: Can't list the MCP servers in the database at /),
            expect.stringMatching(/^error: Can't list the MCP servers in the database at /),
            expect.stringMatching(/^error: Can't remove the MCP server in the database at /),
            expect.stringMatching(/^error: Can't set the MCP server flag in the database at /),
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
