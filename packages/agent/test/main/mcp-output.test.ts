import type { McpServer } from '@mecha-gremlin/store/mcp-server';
import { describe, expect, test } from 'vitest';
import {
    addedLine,
    authorizeLines,
    changedLine,
    errorLine,
    listLines,
    loggedInLine,
    loggedOutLine,
    serverLines,
    warningLine,
} from '../../src/main/mcp-output.ts';

const TIMEOUTS = { startupTimeoutMs: 30000, toolTimeoutMs: 120000 };

const server = (name: string, entry: unknown, disabled = false): McpServer => {
    return {
        id: 1,
        name,
        prefix: name,
        entry: entry as object,
        disabled,
        createdAt: 0,
        updatedAt: 0,
    };
};

describe('The lines that report', () => {
    test('a problem and a warning', () => {
        expect(errorLine('There is no MCP server named nope.')).toBe(
            'error: There is no MCP server named nope.',
        );
        expect(warningLine('It is unpinned.')).toBe('warning: It is unpinned.');
    });

    test('a server added, and added disabled', () => {
        expect(addedLine('docs', 'http', false)).toBe('Added docs (http).');
        expect(addedLine('files', 'stdio', true)).toBe(
            "Added files (stdio). Runs won't start it until bun run mcp enable files.",
        );
    });

    test('a server removed, disabled and enabled', () => {
        expect(changedLine('remove', 'docs')).toBe('Removed docs.');
        expect(changedLine('disable', 'docs')).toBe(
            "Disabled docs. Runs won't start it until bun run mcp enable docs.",
        );
        expect(changedLine('enable', 'docs')).toBe('Enabled docs.');
    });
});

describe('The table of servers', () => {
    test('no servers', () => {
        expect(listLines([])).toEqual([
            'There are no MCP servers. Add one with bun run mcp add <name> <url>, or bun run mcp add <name> -- <command> [args…].',
        ]);
    });

    test('padded to the widest value, two spaces apart, and nothing after the last column', () => {
        expect(
            listLines([
                server('docs', { url: 'https://docs.example.com/mcp', ...TIMEOUTS }),
                server(
                    'filesystem',
                    {
                        command: 'npx',
                        args: ['-y', '@modelcontextprotocol/server-filesystem@2.1.0'],
                        ...TIMEOUTS,
                    },
                    true,
                ),
                server('x', { type: 'http', url: 'https://x.example/mcp', ...TIMEOUTS }),
            ]),
        ).toEqual([
            'NAME        TRANSPORT  TARGET                                                ENABLED',
            'docs        http       https://docs.example.com/mcp                          yes',
            'filesystem  stdio      npx -y @modelcontextprotocol/server-filesystem@2.1.0  no',
            'x           http       https://x.example/mcp                                 yes',
        ]);
    });

    test('an argument that holds a space, a quote or nothing, in single quotes', () => {
        const [, row] = listLines([
            server('files', {
                command: '/opt/my tools/server',
                args: ['/srv/my data', "it's", 'say "hi"', '', '${HOME}', '$$5'],
                ...TIMEOUTS,
            }),
        ]);

        expect(row).toBe(
            `files  stdio      '/opt/my tools/server' '/srv/my data' 'it'\\''s' 'say "hi"' '' \${HOME} $$5  yes`,
        );
    });

    test('a quote alone, of either kind', () => {
        const [, row] = listLines([
            server('a', { command: 'server', args: ["'", '"', 'a b'], ...TIMEOUTS }),
        ]);

        expect(row).toBe(`a     stdio      server ''\\''' '"' 'a b'  yes`);
    });

    test('rows written by hand, which name no transport or target', () => {
        expect(
            listLines([
                server('a', { note: [1, true, null] }),
                server('b', null),
                server('c', { command: 1, url: 2 }),
                server('d', { command: 'server', args: 'x' }),
            ]),
        ).toEqual([
            'NAME  TRANSPORT  TARGET  ENABLED',
            'a     -          -       yes',
            'b     -          -       yes',
            'c     -          -       yes',
            'd     stdio      server  yes',
        ]);
    });
});

describe("One server's settings", () => {
    test('a remote server, with references as written, and its login', () => {
        expect(
            serverLines(
                server('docs', {
                    url: 'https://docs.example.com/mcp',
                    headers: { Authorization: 'Bearer ${DOCS_TOKEN}', 'X-Team': 'docs' },
                    startupTimeoutMs: 30000,
                    toolTimeoutMs: 300000,
                }),
                'no',
            ),
        ).toEqual([
            'docs',
            '  Transport        http',
            '  URL              https://docs.example.com/mcp',
            '  Header           Authorization: Bearer ${DOCS_TOKEN}',
            '  Header           X-Team: docs',
            '  Startup timeout  30s',
            '  Tool timeout     5m',
            '  Login            no',
            '  Enabled          yes',
            'To change it, remove it with bun run mcp remove docs, then add it again.',
        ]);
    });

    test.each(['yes', 'needs a new login'] as const)('a login that reads %s', (login) => {
        expect(serverLines(server('docs', { url: 'https://docs.example.com/mcp' }), login)).toEqual(
            [
                'docs',
                '  Transport  http',
                '  URL        https://docs.example.com/mcp',
                `  Login      ${login}`,
                '  Enabled    yes',
                'To change it, remove it with bun run mcp remove docs, then add it again.',
            ],
        );
    });

    test('a local server, with every setting, disabled', () => {
        expect(
            serverLines(
                server(
                    'files',
                    {
                        command: 'npx',
                        args: [
                            '-y',
                            '@modelcontextprotocol/server-filesystem@2.1.0',
                            '/srv/my data',
                        ],
                        env: { LOG_LEVEL: 'info', GITHUB_TOKEN: '${GITHUB_TOKEN}' },
                        cwd: '/srv',
                        includeTools: ['read_file', 'list_directory'],
                        excludeTools: ['write_file'],
                        startupTimeoutMs: 90000,
                        toolTimeoutMs: 3600000,
                    },
                    true,
                ),
                undefined,
            ),
        ).toEqual([
            'files',
            '  Transport          stdio',
            "  Command            npx -y @modelcontextprotocol/server-filesystem@2.1.0 '/srv/my data'",
            '  Variable           LOG_LEVEL=info',
            '  Variable           GITHUB_TOKEN=${GITHUB_TOKEN}',
            '  Working directory  /srv',
            '  Include tools      read_file, list_directory',
            '  Exclude tools      write_file',
            '  Startup timeout    90s',
            '  Tool timeout       1h',
            '  Enabled            no',
            'To change it, remove it with bun run mcp remove files, then add it again.',
        ]);
    });

    test('a row written by hand, which holds none of the settings', () => {
        const expected = [
            '  Transport  -',
            '  Enabled    yes',
            'To change it, remove it with bun run mcp remove a, then add it again.',
        ];

        expect(serverLines(server('a', { note: [1, true, null] }), undefined)).toEqual([
            'a',
            ...expected,
        ]);
        expect(serverLines(server('a', null), undefined)).toEqual(['a', ...expected]);
        expect(
            serverLines(
                server('a', {
                    url: 1,
                    headers: null,
                    command: null,
                    env: 5,
                    cwd: ['/srv'],
                    includeTools: 'a',
                    excludeTools: { b: true },
                    startupTimeoutMs: '30000',
                    toolTimeoutMs: null,
                }),
                undefined,
            ),
        ).toEqual(['a', ...expected]);
    });

    test('values of other types, as a row written by hand may hold them', () => {
        expect(
            serverLines(
                server('a', {
                    command: 'server',
                    args: [1, true],
                    env: { A: 2 },
                    startupTimeoutMs: 1500.5,
                }),
                undefined,
            ),
        ).toEqual([
            'a',
            '  Transport        stdio',
            '  Command          server 1 true',
            '  Variable         A=2',
            '  Startup timeout  1500.5ms',
            '  Enabled          yes',
            'To change it, remove it with bun run mcp remove a, then add it again.',
        ]);
    });
});

describe('What a login and a logout print', () => {
    test('the authorization URL, with what to do with it', () => {
        expect(authorizeLines('docs', 'https://auth.example.com/authorize?state=s')).toEqual([
            'Open this address in a browser, and sign in to docs:',
            '',
            'https://auth.example.com/authorize?state=s',
            '',
            "If the browser can't reach this machine, as over SSH, paste here the address it ends on, and press Enter. The login waits 5 minutes.",
        ]);
    });

    test.each([
        [0, 'Logged in to docs: 0 tools.'],
        [1, 'Logged in to docs: 1 tool.'],
        [2, 'Logged in to docs: 2 tools.'],
    ])('logged in, with %i tools', (tools, line) => {
        expect(loggedInLine('docs', tools)).toBe(line);
    });

    test('logged out, or without a login', () => {
        expect(loggedOutLine('docs', 2)).toBe('Logged out of docs.');
        expect(loggedOutLine('docs', 1)).toBe('Logged out of docs.');
        expect(loggedOutLine('docs', 0)).toBe('docs has no login.');
    });
});
