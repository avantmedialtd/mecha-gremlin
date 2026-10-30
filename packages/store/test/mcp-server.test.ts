import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { withDataSource } from '../src/connection.ts';
import {
    type McpServer,
    type NewMcpServer,
    addMcpServer,
    listMcpServers,
    mcpServerSchema,
    removeMcpServer,
    setMcpServerDisabled,
} from '../src/mcp-server.ts';
import { type Store, closeStore } from '../src/store.ts';
import { dataFolder, open } from './stores.ts';

// An entry as the agent stores it: nested objects and arrays, its references unresolved.
const ENTRY = {
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.83', '--image-responses', 'omit'],
    env: { API_KEY: '${API_KEY}', DEPTH: '2' },
    includeTools: ['browser_navigate', 'browser_snapshot'],
    startupTimeoutMs: 30000,
    toolTimeoutMs: 120000,
};

const server = (changes: Partial<NewMcpServer> = {}): NewMcpServer => {
    return { name: 'playwright', prefix: 'playwright', entry: ENTRY, disabled: false, ...changes };
};

const at = (time: number): void => {
    vi.spyOn(Date, 'now').mockReturnValue(time);
};

const listed = async (store: Store): Promise<McpServer[]> => {
    const found = await listMcpServers(store);

    if (!found.ok) {
        throw new Error(found.error);
    }

    return found.value;
};

// The store's tests compare the entity with the database, but TypeORM would give the id, generated
// by increment, the type integer by itself, so only this shows a type left out.
test('every column of the entity has an explicit type', () => {
    const columns = Object.entries(mcpServerSchema.options.columns);

    expect(columns.filter(([, column]) => !column?.type).map(([name]) => name)).toEqual([]);
    expect(columns).toHaveLength(7);
});

describe('Keep MCP server definitions', () => {
    test('a round trip, with both flags', async () => {
        const { store } = await open();
        at(1000);

        const added = [
            await addMcpServer(store, server()),
            await addMcpServer(store, server({ name: 'Docs-2', prefix: 'docs_2', disabled: true })),
        ];

        expect(added).toEqual([
            { ok: true, value: undefined },
            { ok: true, value: undefined },
        ]);
        expect(await listed(store)).toEqual([
            {
                id: 2,
                name: 'Docs-2',
                prefix: 'docs_2',
                entry: ENTRY,
                disabled: true,
                createdAt: 1000,
                updatedAt: 1000,
            },
            {
                id: 1,
                name: 'playwright',
                prefix: 'playwright',
                entry: ENTRY,
                disabled: false,
                createdAt: 1000,
                updatedAt: 1000,
            },
        ]);
    });

    test('a name in use: the first server is unchanged', async () => {
        const { store } = await open();
        await addMcpServer(store, server());

        const again = await addMcpServer(
            store,
            server({ prefix: 'other', entry: { url: 'https://x.example/mcp' } }),
        );

        expect(again).toEqual({
            ok: false,
            error: "Can't add the MCP server playwright: a server with that name exists.",
        });
        expect(await listed(store)).toMatchObject([{ name: 'playwright', entry: ENTRY }]);
    });

    test('a name and its prefix both in use: the name is named', async () => {
        const { store } = await open();
        await addMcpServer(store, server());

        expect(await addMcpServer(store, server())).toEqual({
            ok: false,
            error: "Can't add the MCP server playwright: a server with that name exists.",
        });
    });

    test('a prefix in use', async () => {
        const { store } = await open();
        await addMcpServer(store, server({ name: 'github-api', prefix: 'github_api' }));

        const added = await addMcpServer(
            store,
            server({ name: 'github_api', prefix: 'github_api' }),
        );

        expect(added).toEqual({
            ok: false,
            error: "Can't add the MCP server github_api: another server has its prefix, github_api.",
        });
        expect((await listed(store)).map((row) => row.name)).toEqual(['github-api']);
    });

    test('name order', async () => {
        const { store } = await open();
        await addMcpServer(store, server({ name: 'b', prefix: 'b' }));
        await addMcpServer(store, server({ name: 'a', prefix: 'a' }));

        expect((await listed(store)).map((row) => row.name)).toEqual(['a', 'b']);
    });

    test('removing says how many, and leaves the others', async () => {
        const { store } = await open();
        await addMcpServer(store, server());
        await addMcpServer(store, server({ name: 'docs', prefix: 'docs' }));

        const first = await removeMcpServer(store, 'playwright');
        const again = await removeMcpServer(store, 'playwright');

        expect(first).toEqual({ ok: true, value: 1 });
        expect(again).toEqual({ ok: true, value: 0 });
        expect((await listed(store)).map((row) => row.name)).toEqual(['docs']);
    });

    test('disabling and enabling say whether they found the server', async () => {
        const { store } = await open();
        at(1000);
        await addMcpServer(store, server());
        await addMcpServer(store, server({ name: 'docs', prefix: 'docs' }));
        at(2000);

        const disabled = await setMcpServerDisabled(store, { name: 'playwright', disabled: true });
        const whileDisabled = await listed(store);
        at(3000);
        const enabled = await setMcpServerDisabled(store, { name: 'playwright', disabled: false });
        const missing = await setMcpServerDisabled(store, { name: 'nope', disabled: true });

        expect(disabled).toEqual({ ok: true, value: true });
        expect(whileDisabled).toMatchObject([
            { name: 'docs', disabled: false, updatedAt: 1000 },
            { name: 'playwright', disabled: true, createdAt: 1000, updatedAt: 2000 },
        ]);
        expect(enabled).toEqual({ ok: true, value: true });
        expect(missing).toEqual({ ok: true, value: false });
        expect(await listed(store)).toMatchObject([
            { name: 'docs', disabled: false },
            { name: 'playwright', disabled: false, updatedAt: 3000 },
        ]);
    });

    test('a closed store refuses every function, without throwing', async () => {
        const folder = await dataFolder();
        const { store } = await open(folder);
        await closeStore(store);
        const closed = `the store at ${join(folder, 'db.sqlite')} is closed.`;

        expect(
            await Promise.all([
                addMcpServer(store, server()),
                listMcpServers(store),
                removeMcpServer(store, 'playwright'),
                setMcpServerDisabled(store, { name: 'playwright', disabled: true }),
            ]),
        ).toEqual([
            { ok: false, error: `Can't add the MCP server: ${closed}` },
            { ok: false, error: `Can't list the MCP servers: ${closed}` },
            { ok: false, error: `Can't remove the MCP server: ${closed}` },
            { ok: false, error: `Can't set the MCP server flag: ${closed}` },
        ]);
    });

    test('a query that fails gives an error naming the database and the reason', async () => {
        const { store } = await open();
        await withDataSource(store, 'drop the table', (dataSource) => {
            return dataSource.query('DROP TABLE mcp_server');
        });
        const reason = `in the database at ${store.path}: SqliteError: no such table: mcp_server`;

        expect(
            await Promise.all([
                addMcpServer(store, server()),
                listMcpServers(store),
                removeMcpServer(store, 'playwright'),
                setMcpServerDisabled(store, { name: 'playwright', disabled: true }),
            ]),
        ).toEqual([
            { ok: false, error: `Can't add the MCP server ${reason}` },
            { ok: false, error: `Can't list the MCP servers ${reason}` },
            { ok: false, error: `Can't remove the MCP server ${reason}` },
            { ok: false, error: `Can't set the MCP server flag ${reason}` },
        ]);
    });
});
