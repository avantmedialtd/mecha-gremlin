import { type Result, err, ok } from '@mecha-gremlin/core/result';
import { EntitySchema } from 'typeorm';
import { type Store, reasonOf, withDataSource } from './connection.ts';

export type McpServer = {
    readonly id: number;
    readonly name: string;
    /** The prefix its tools' names take. */
    readonly prefix: string;
    /** The entry as the agent checked it, without `disabled`. */
    readonly entry: object;
    readonly disabled: boolean;
    readonly createdAt: number;
    readonly updatedAt: number;
};

// The store doesn't check entries: it keeps what the agent checked, which a run checks again.
// `simple-json` is plain text, where TypeORM's `json` declares NUMERIC affinity, and times are
// epoch milliseconds, as in the credential table (Brief R17.2).
export const mcpServerSchema = new EntitySchema<McpServer>({
    name: 'mcp_server',
    columns: {
        id: { type: 'integer', primary: true, generated: 'increment' },
        name: { type: 'text' },
        prefix: { type: 'text' },
        entry: { type: 'simple-json' },
        disabled: { type: 'boolean' },
        createdAt: { name: 'created_at', type: 'integer' },
        updatedAt: { name: 'updated_at', type: 'integer' },
    },
    // A unique prefix keeps two servers whose tools would share one from both being stored. SQLite
    // checks the last unique constraint first, so a name in use is reported as such, even though
    // its prefix is in use too.
    uniques: [{ columns: ['prefix'] }, { columns: ['name'] }],
});

export type NewMcpServer = Pick<McpServer, 'name' | 'prefix' | 'entry' | 'disabled'>;

export type ServerFlag = Pick<McpServer, 'name' | 'disabled'>;

type Taken = 'name' | 'prefix' | undefined;

// SQLite names the column whose unique constraint failed.
const takenBy = (error: unknown): Taken => {
    const reason = reasonOf(error);

    if (reason.includes('UNIQUE constraint failed: mcp_server.name')) {
        return 'name';
    }

    if (reason.includes('UNIQUE constraint failed: mcp_server.prefix')) {
        return 'prefix';
    }

    throw error;
};

export const addMcpServer = async (
    store: Store,
    { name, prefix, entry, disabled }: NewMcpServer,
): Promise<Result<undefined, string>> => {
    const added = await withDataSource(store, 'add the MCP server', async (dataSource) => {
        const now = Date.now();

        try {
            await dataSource
                .createQueryBuilder()
                .insert()
                .into(mcpServerSchema)
                .values({ name, prefix, entry, disabled, createdAt: now, updatedAt: now })
                .execute();
        } catch (error) {
            return takenBy(error);
        }

        return undefined;
    });

    if (!added.ok) {
        return added;
    }

    if (added.value === 'name') {
        return err(`Can't add the MCP server ${name}: a server with that name exists.`);
    }

    if (added.value === 'prefix') {
        return err(`Can't add the MCP server ${name}: another server has its prefix, ${prefix}.`);
    }

    return ok(undefined);
};

export const listMcpServers = (store: Store): Promise<Result<McpServer[], string>> => {
    return withDataSource(store, 'list the MCP servers', (dataSource) => {
        return dataSource
            .getRepository(mcpServerSchema)
            .createQueryBuilder('server')
            .orderBy('server.name')
            .getMany();
    });
};

export const removeMcpServer = (store: Store, name: string): Promise<Result<number, string>> => {
    return withDataSource(store, 'remove the MCP server', async (dataSource) => {
        const deleted = await dataSource
            .createQueryBuilder()
            .delete()
            .from(mcpServerSchema)
            .where('name = :name', { name })
            .execute();

        return deleted.affected ?? 0;
    });
};

// Whether it found the server, from UpdateResult.affected, which better-sqlite3 reports
// correctly (Brief R17.1).
export const setMcpServerDisabled = (
    store: Store,
    { name, disabled }: ServerFlag,
): Promise<Result<boolean, string>> => {
    return withDataSource(store, 'set the MCP server flag', async (dataSource) => {
        const updated = await dataSource
            .createQueryBuilder()
            .update(mcpServerSchema)
            .set({ disabled, updatedAt: Date.now() })
            .where('name = :name', { name })
            .execute();

        return updated.affected === 1;
    });
};
