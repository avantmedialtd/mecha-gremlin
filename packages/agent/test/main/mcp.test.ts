import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { withDataSource } from '@mecha-gremlin/store/connection';
import { closeStore, openStore } from '@mecha-gremlin/store/store';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { HELP } from '../../src/main/mcp-help.ts';

const COMMAND = fileURLToPath(new URL('../../src/main/mcp.ts', import.meta.url));

// Each test sets or clears all of these, so settings in your shell can't leak in. The command
// needs only the first two.
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

type LogRecord = {
    readonly time: string;
    readonly level: string;
    readonly message: string;
    readonly [field: string]: unknown;
};

const DOCS =
    '{"url":"https://docs.example.com/mcp","startupTimeoutMs":30000,"toolTimeoutMs":120000}';

const SEE_HELP = 'bun run mcp help explains the command.';

const MIGRATIONS = ['CreateCredential1793232000000', 'CreateMcpServer1793318400000'];

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

const parseRecords = (output: string): LogRecord[] => {
    return output
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as LogRecord);
};

const withoutTime = (records: readonly LogRecord[]) => {
    return records.map(({ time: _time, ...rest }) => rest);
};

/** Runs the command in this process, as main.test.ts runs the agent, and reads its log as JSON. */
const mcp = async (args: readonly string[], env: Settings = {}, stdin?: string) => {
    const settings: Settings = { LOG_FORMAT: 'json', DATA_DIR: folder, ...env };

    for (const name of SETTINGS) {
        vi.stubEnv(name, settings[name]);
    }

    if (stdin !== undefined) {
        vi.spyOn(process, 'stdin', 'get').mockReturnValue(
            Readable.from([stdin]) as typeof process.stdin,
        );
    }

    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const argv = process.argv;
    process.argv = [...argv.slice(0, 1), 'mcp.ts', ...args];
    let output = '';
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        output += `${String(line)}\n`;
    });

    try {
        // A module runs only once until the registry is reset.
        vi.resetModules();
        await import('../../src/main/mcp.ts');
    } finally {
        process.argv = argv;
        log.mockRestore();
    }

    const code = process.exitCode;
    process.exitCode = undefined;

    return {
        code,
        output,
        // Parsed when a test reads them: help prints plain text, whatever the format.
        get records() {
            return settings.LOG_FORMAT === 'json' ? parseRecords(output) : [];
        },
        fetch,
    };
};

const messages = (records: readonly LogRecord[]): string[] => {
    return records.map((record) => record.message);
};

const errors = (records: readonly LogRecord[]): string[] => {
    return records.filter((record) => record.level === 'error').map((record) => record.message);
};

const listed = async () => {
    const { records } = await mcp(['list']);

    return withoutTime(records.filter((record) => record.message !== 'migrated'));
};

// A store of its own, opened and closed around the statements, as another process would.
const outside = async (...statements: readonly string[]): Promise<void> => {
    const opened = await openStore(folder);

    if (!opened.ok) {
        throw new Error(opened.error);
    }

    try {
        for (const statement of statements) {
            await withDataSource(opened.value.store, 'change the database', (dataSource) => {
                return dataSource.query(statement);
            });
        }
    } finally {
        await closeStore(opened.value.store);
    }
};

describe('Manage MCP servers with the mcp command', () => {
    test('adding and listing', async () => {
        await freshFolder();

        const added = await mcp(['add', 'docs', DOCS]);

        expect(added.code).toBe(0);
        expect(withoutTime(added.records)).toEqual([
            { level: 'info', message: 'migrated', names: MIGRATIONS },
            { level: 'info', message: 'mcp server added', name: 'docs', transport: 'http' },
        ]);
        expect(await listed()).toEqual([
            {
                level: 'info',
                message: 'mcp server',
                name: 'docs',
                transport: 'http',
                disabled: false,
                entry: JSON.parse(DOCS),
            },
        ]);
    });

    test('a second server, and the store closed after each command', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);

        const second = await mcp([
            'add',
            'files',
            '{"url":"https://files.example.com/mcp","startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        ]);

        expect(second.code).toBe(0);
        expect((await listed()).map((record) => record.name)).toEqual(['docs', 'files']);
        // An open store keeps its -wal and -shm files.
        expect(await readdir(folder)).toEqual(['db.sqlite']);
    });

    test('an entry on stdin', async () => {
        await freshFolder();

        const added = await mcp(['add', 'docs', '-'], {}, `${DOCS}\n`);

        expect(added.code).toBe(0);
        expect(await listed()).toMatchObject([{ name: 'docs', entry: JSON.parse(DOCS) }]);
    });

    test('removing', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);

        const removed = await mcp(['remove', 'docs']);

        expect(removed.code).toBe(0);
        expect(withoutTime(removed.records)).toEqual([
            { level: 'info', message: 'mcp server removed', name: 'docs' },
        ]);
        expect(await listed()).toEqual([{ level: 'info', message: 'no mcp servers' }]);
    });

    test('disabling and enabling', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);

        const disabled = await mcp(['disable', 'docs']);
        const whileDisabled = await listed();
        const enabled = await mcp(['enable', 'docs']);
        const afterwards = await listed();

        expect([disabled.code, enabled.code]).toEqual([0, 0]);
        expect(withoutTime([...disabled.records, ...enabled.records])).toEqual([
            { level: 'info', message: 'mcp server disabled', name: 'docs' },
            { level: 'info', message: 'mcp server enabled', name: 'docs' },
        ]);
        expect(whileDisabled).toMatchObject([{ name: 'docs', disabled: true }]);
        expect(afterwards).toMatchObject([{ name: 'docs', disabled: false }]);
    });

    test.each(['remove', 'disable', 'enable'])('%s an unknown name', async (subcommand) => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);

        const { code, records } = await mcp([subcommand, 'nope']);

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            'There is no MCP server named nope: bun run mcp list shows them.',
        ]);
        expect(await listed()).toMatchObject([{ name: 'docs', disabled: false }]);
    });

    test('a name in use', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);

        const again = await mcp([
            'add',
            'docs',
            '{"command":"server","startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        ]);

        expect(again.code).toBe(1);
        expect(errors(again.records)).toEqual([
            'The MCP server docs exists. To change it, remove it with bun run mcp remove docs, then add it again.',
        ]);
        expect(await listed()).toMatchObject([{ name: 'docs', entry: JSON.parse(DOCS) }]);
    });

    test('a prefix in use', async () => {
        await freshFolder();
        await mcp(['add', 'github-api', DOCS]);

        const again = await mcp(['add', 'github_api', DOCS]);

        expect(again.code).toBe(1);
        expect(errors(again.records)).toEqual([
            'The tools of github_api would share the prefix github_api with those of the MCP server github-api: give it another name.',
        ]);
        expect((await listed()).map((record) => record.name)).toEqual(['github-api']);
    });

    test.each([
        [
            ['start'],
            `Give one of the subcommands: add <name> <entry>, list, remove <name>, disable <name> or enable <name>. ${SEE_HELP}`,
        ],
        [
            ['add', 'docs'],
            `add takes a name and an entry: bun run mcp add <name> <entry>, with - as the entry to read it from stdin. ${SEE_HELP}`,
        ],
        [
            ['add'],
            `add takes a name and an entry: bun run mcp add <name> <entry>, with - as the entry to read it from stdin. ${SEE_HELP}`,
        ],
        [
            ['add', 'docs', DOCS, 'more'],
            `add takes a name and an entry: bun run mcp add <name> <entry>, with - as the entry to read it from stdin. ${SEE_HELP}`,
        ],
        [['list', 'extra'], `list takes no arguments. ${SEE_HELP}`],
        [['remove'], `remove takes a server's name: bun run mcp remove <name>. ${SEE_HELP}`],
        [
            ['disable', 'a', 'b'],
            `disable takes a server's name: bun run mcp disable <name>. ${SEE_HELP}`,
        ],
        [['enable'], `enable takes a server's name: bun run mcp enable <name>. ${SEE_HELP}`],
    ])('the usage error for %j', async (args, problem) => {
        await freshFolder();

        const { code, records } = await mcp(args);

        expect(code).toBe(1);
        expect(withoutTime(records)).toEqual([{ level: 'error', message: problem }]);
    });

    test('help, with no setting at all', async () => {
        await freshFolder();

        const { code, output } = await mcp(['help'], {
            LOG_FORMAT: undefined,
            DATA_DIR: undefined,
        });

        expect(code).toBe(0);
        expect(output).toBe(`${HELP}\n`);

        for (const term of [
            'add <name> <entry>',
            'list',
            'remove <name>',
            'disable <name>',
            'enable <name>',
            'read from stdin',
            'mcp:node',
            '1 to 24',
            '"mcpServers"',
            'startupTimeoutMs',
            'toolTimeoutMs',
            '${GITHUB_PAT}',
            'DATA_DIR',
            'LOG_FORMAT',
            'README',
        ]) {
            expect(output).toContain(term);
        }
    });

    test("help, however it's asked for, as plain text, and no store opened", async () => {
        await freshFolder();

        const byFlag = await mcp(['--help']);
        const byLetter = await mcp(['-h']);
        const withMore = await mcp(['help', 'add']);

        expect([byFlag.code, byLetter.code, withMore.code]).toEqual([0, 0, 0]);
        expect([byFlag.output, byLetter.output, withMore.output]).toEqual([
            `${HELP}\n`,
            `${HELP}\n`,
            `${HELP}\n`,
        ]);
        expect(await readdir(folder)).toEqual([]);
    });

    test('no arguments: the same text, and exit code 1', async () => {
        await freshFolder();

        const { code, output } = await mcp([]);

        expect(code).toBe(1);
        expect(output).toBe(`${HELP}\n`);
        expect(await readdir(folder)).toEqual([]);
    });

    test('the settings it needs', async () => {
        await freshFolder();

        const first = await mcp(['list']);
        const second = await mcp(['list'], { DATA_DIR: undefined });

        expect(first.code).toBe(0);
        expect(second.code).toBe(1);
        expect(errors(second.records)).toEqual(['DATA_DIR is required.']);
    });

    test('settings and usage, reported together, in pretty output', async () => {
        await freshFolder();

        const { code, output } = await mcp(['start'], {
            LOG_FORMAT: 'xml',
            DATA_DIR: join(folder, 'no'),
        });
        const lines = output.trim().split('\n');

        expect(code).toBe(1);
        expect(lines).toEqual([
            expect.stringMatching(
                /^\d\d:\d\d:\d\d ERROR LOG_FORMAT must be one of pretty, json; got "xml"\.$/,
            ),
            expect.stringMatching(
                /ERROR DATA_DIR must name an existing directory; .* isn't one\.$/,
            ),
            expect.stringMatching(/ERROR Give one of the subcommands: /),
        ]);
    });

    test('a new data folder', async () => {
        await freshFolder();

        const { code, records } = await mcp(['list']);

        expect(code).toBe(0);
        expect(withoutTime(records)).toEqual([
            { level: 'info', message: 'migrated', names: MIGRATIONS },
            { level: 'info', message: 'no mcp servers' },
        ]);
    });

    test("a data folder whose store can't open", async () => {
        await freshFolder();
        await mkdir(join(folder, 'db.sqlite'));

        const { code, records } = await mcp(['list']);

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            expect.stringMatching(
                /^Can't open the database at .*db\.sqlite: unable to open database file$/,
            ),
        ]);
    });

    test('offline: a reference to a variable that is not set is stored as written', async () => {
        await freshFolder();
        const entry =
            '{"url":"https://docs.example.com/mcp","headers":{"Authorization":"Bearer ${DOCS_TOKEN_UNSET}"},"startupTimeoutMs":30000,"toolTimeoutMs":120000}';

        const added = await mcp(['add', 'docs', entry]);
        const list = await mcp(['list']);

        expect(added.code).toBe(0);
        expect(added.fetch).not.toHaveBeenCalled();
        expect(list.fetch).not.toHaveBeenCalled();
        expect(list.records).toMatchObject([
            { entry: { headers: { Authorization: 'Bearer ${DOCS_TOKEN_UNSET}' } } },
        ]);
    });

    test('disabled at the start, then enabled', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS.replace('{', '{"disabled":true,')]);
        const whileDisabled = await listed();

        await mcp(['enable', 'docs']);

        expect(whileDisabled).toMatchObject([{ disabled: true, entry: JSON.parse(DOCS) }]);
        expect(await listed()).toEqual([
            {
                level: 'info',
                message: 'mcp server',
                name: 'docs',
                transport: 'http',
                disabled: false,
                entry: JSON.parse(DOCS),
            },
        ]);
    });

    test('a stdio entry, with its warnings, which a list shows as stored', async () => {
        await freshFolder();
        const entry =
            '{"command":"npx","args":["-y","@playwright/mcp@latest","--api-key","${KEY}"],"env":{"__proto__":"x"},"startupTimeoutMs":30000,"toolTimeoutMs":120000}';

        const added = await mcp(['add', 'Playwright', entry]);

        expect(added.code).toBe(0);
        expect(withoutTime(added.records).slice(1)).toEqual([
            {
                level: 'warn',
                message: 'mcp server unpinned',
                name: 'Playwright',
                reason: "@playwright/mcp@latest isn't pinned to an exact version, so a run may start a version published later. Pin it, as in package@1.2.3.",
            },
            {
                level: 'warn',
                message: 'mcp server secret in arguments',
                name: 'Playwright',
                reason: 'Argument 4, after --api-key, holds a reference: a run puts its value in the process list, which every local user can read. Give it in env instead, if the server reads one.',
            },
            { level: 'info', message: 'mcp server added', name: 'Playwright', transport: 'stdio' },
        ]);
        expect(await listed()).toEqual([
            {
                level: 'info',
                message: 'mcp server',
                name: 'Playwright',
                transport: 'stdio',
                disabled: false,
                entry: JSON.parse(entry),
            },
        ]);
    });

    test('a row whose entry names no transport is listed without one', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);
        await outside(`UPDATE mcp_server SET entry = '{"note":[1,true,null]}'`);

        expect(await listed()).toEqual([
            {
                level: 'info',
                message: 'mcp server',
                name: 'docs',
                disabled: false,
                entry: { note: [1, true, null] },
            },
        ]);
    });
});

describe('Report every problem with an entry, and store nothing', () => {
    test("a name that isn't allowed, with an entry that is", async () => {
        await freshFolder();

        const { code, records } = await mcp(['add', 'docs site', DOCS]);

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            `The name "docs site" isn't allowed: a server's name is 1 to 24 letters and digits, in words joined by single - or _ characters.`,
        ]);
        expect(await listed()).toEqual([{ level: 'info', message: 'no mcp servers' }]);
    });

    test('every problem at once', async () => {
        await freshFolder();

        const { code, records } = await mcp([
            'add',
            'aws.docs',
            '{"colour":"blue","url":"https://docs.example.com/mcp#x","startupTimeoutMs":30000,"toolTimeoutMs":-5}',
        ]);

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            `The name "aws.docs" isn't allowed: a server's name is 1 to 24 letters and digits, in words joined by single - or _ characters.`,
            "The field colour isn't known.",
            'toolTimeoutMs must be a whole number of milliseconds from 1000 to 2147483647.',
            'The url has a fragment.',
        ]);
        expect(messages(records)).not.toContain('migrated');
        expect(await listed()).toEqual([{ level: 'info', message: 'no mcp servers' }]);
    });

    test('a repeated key, beside the problems of the entry it was read as', async () => {
        await freshFolder();

        const { code, records } = await mcp([
            'add',
            'docs',
            '{\n  "url": "https://a.example/mcp",\n  "url": "https://b.example/mcp",\n  "toolTimeoutMs": 120000\n}',
        ]);

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            'The key "url" is repeated, at line 3, column 3: give each key once.',
            'startupTimeoutMs is missing. Give both timeouts, in milliseconds, as in "startupTimeoutMs": 30000 and "toolTimeoutMs": 120000.',
        ]);
    });

    test('text that is not quoted', async () => {
        await freshFolder();

        const { code, output } = await mcp(
            ['add', 'docs', '-'],
            {},
            '{"command": "server", "env": {"API_KEY": sk-secret123}}',
        );

        expect(code).toBe(1);
        expect(parseRecords(output).map((record) => record.message)).toEqual([
            "The entry isn't valid JSON: expected a value at line 1, column 42.",
        ]);
        expect(output).not.toContain('sk-secret123');
    });

    test('a pasted wrapper', async () => {
        await freshFolder();

        const { code, records } = await mcp([
            'add',
            'docs',
            '{"mcpServers":{"docs":{"url":"https://docs.example.com/mcp"}}}',
        ]);

        expect(code).toBe(1);
        expect(errors(records)).toEqual([
            `The entry holds a server inside its field "mcpServers": give the object inside it as the entry, and the server's name as the first argument.`,
        ]);
    });

    test('a literal token appears in no record', async () => {
        await freshFolder();

        const { code, output } = await mcp([
            'add',
            'docs',
            '{"url":"https://docs.example.com/mcp","headers":{"Authorization":"Bearer abc123def"},"startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        ]);

        expect(code).toBe(1);
        expect(output).toContain('Authorization');
        expect(output).not.toContain('abc123def');
    });
});

describe("Report the store's failures", () => {
    test('a table that has gone', async () => {
        await freshFolder();
        await mcp(['list']);
        await outside('DROP TABLE mcp_server');

        const results = [
            await mcp(['list']),
            await mcp(['add', 'docs', DOCS]),
            await mcp(['remove', 'docs']),
            await mcp(['disable', 'docs']),
        ];

        expect(results.map((result) => result.code)).toEqual([1, 1, 1, 1]);
        expect(results.map((result) => errors(result.records))).toEqual([
            [
                expect.stringMatching(
                    /^Can't list the MCP servers in the database at .*: SqliteError: no such table: mcp_server$/,
                ),
            ],
            [expect.stringMatching(/^Can't list the MCP servers in the database at /)],
            [expect.stringMatching(/^Can't remove the MCP server in the database at /)],
            [expect.stringMatching(/^Can't set the MCP server flag in the database at /)],
        ]);
    });

    test('an insert that fails', async () => {
        await freshFolder();
        await mcp(['list']);
        await outside(
            "CREATE TRIGGER refuse BEFORE INSERT ON mcp_server BEGIN SELECT RAISE(ABORT, 'refused'); END",
        );

        const { code, records } = await mcp([
            'add',
            'docs',
            '{"command":"npx","args":["pkg"],"startupTimeoutMs":30000,"toolTimeoutMs":120000}',
        ]);

        expect(code).toBe(1);
        expect(withoutTime(records)).toEqual([
            {
                level: 'error',
                message: expect.stringMatching(
                    /^Can't add the MCP server in the database at .*: SqliteError: refused$/,
                ),
            },
        ]);
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
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
    });

    return new Promise<{ code: number | null; stdout: string }>((resolve) => {
        child.once('close', (code) => {
            resolve({ code, stdout });
        });
    });
};

describe('On Bun and on Node', { timeout: 15_000 }, () => {
    test('the same records', async () => {
        await freshFolder();
        await mcp(['add', 'docs', DOCS]);
        const env = { LOG_FORMAT: 'json', DATA_DIR: folder };

        const onNode = await runAs('node', ['list'], env);
        const onBun = await runAs('bun', ['list'], env);

        expect(onNode.code).toBe(0);
        expect(onBun.code).toBe(0);
        expect(withoutTime(parseRecords(onNode.stdout))).toEqual(
            withoutTime(parseRecords(onBun.stdout)),
        );
        expect(parseRecords(onNode.stdout)).toMatchObject([
            { message: 'mcp server', name: 'docs' },
        ]);
    });
});
