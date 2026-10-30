import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resolveServer } from '../../src/mcp/resolve.ts';

const TIMEOUTS = { startupTimeoutMs: 30_000, toolTimeoutMs: 120_000 };

let folder: string;

beforeEach(async () => {
    folder = await realpath(await mkdtemp(join(tmpdir(), 'mcp-resolve-')));
});

afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
});

const row = (entry: Readonly<Record<string, unknown>>) => {
    return { name: 'docs', prefix: 'docs', entry: { ...TIMEOUTS, ...entry } };
};

const problem = (text: string): string => {
    return `The MCP server docs can't start. ${text} To run without it: bun run mcp disable docs.`;
};

describe('Resolve a server before it starts', () => {
    test('its secrets are exactly the values its references resolved to, in order', () => {
        const stdio = resolveServer(
            row({ command: '/bin/sh', args: ['-c', '${SCRIPT}'], env: { API_TOKEN: '${TOKEN}' } }),
            { SCRIPT: 'exit 0', TOKEN: 't0k' },
            'run00000',
        );
        const http = resolveServer(
            row({
                url: 'https://docs.example.com/${VERSION}/mcp',
                headers: { Authorization: 'Bearer ${TOKEN}' },
            }),
            { VERSION: 'v1', TOKEN: 't0k' },
            'run00000',
        );

        expect(stdio).toMatchObject({ ok: true, value: { secrets: ['exit 0', 't0k'] } });
        expect(http).toMatchObject({ ok: true, value: { secrets: ['v1', 't0k'] } });
    });

    test('an unset reference in a Streamable HTTP entry fails with that alone', () => {
        expect(
            resolveServer(row({ url: 'https://docs.example.com/${MISSING}/mcp' }), {}, 'run00000'),
        ).toEqual({
            ok: false,
            error: [problem('It refers to MISSING, which is unset or blank: set it in .env.')],
        });
    });

    test('without a PATH, no command is found by its name', () => {
        expect(resolveServer(row({ command: 'sh' }), {}, 'run00000')).toEqual({
            ok: false,
            error: [
                problem(
                    "Its command, sh, is in none of the absolute directories of its PATH: give the command's absolute path, or set PATH in its env.",
                ),
            ],
        });
    });

    test('a directory of PATH without the command, or with something else by its name, is passed over', async () => {
        const directories = ['missing', 'plain', 'folder', 'real'].map((name) =>
            join(folder, name),
        );
        const [missing = '', plain = '', inFolder = '', real = ''] = directories;
        await mkdir(missing);
        await mkdir(join(inFolder, 'gremlin-tool'), { recursive: true });
        await mkdir(plain);
        await writeFile(join(plain, 'gremlin-tool'), '#!/bin/sh\n', { mode: 0o644 });
        await mkdir(real);
        await writeFile(join(real, 'gremlin-tool'), '#!/bin/sh\n', { mode: 0o755 });
        await chmod(join(real, 'gremlin-tool'), 0o755);

        const resolved = resolveServer(
            row({ command: 'gremlin-tool', env: { PATH: directories.join(':') } }),
            {},
            'run00000',
        );

        expect(resolved).toMatchObject({
            ok: true,
            value: { connection: { program: join(real, 'gremlin-tool') } },
        });
    });

    test("a cwd that doesn't exist", () => {
        expect(
            resolveServer(
                row({ command: '/bin/sh', cwd: '${DIR}' }),
                { DIR: join(folder, 'gone') },
                'run00000',
            ),
        ).toEqual({
            ok: false,
            error: [
                problem(
                    'Its cwd, with its references resolved, must be an absolute path to a directory that exists.',
                ),
            ],
        });
    });
});
