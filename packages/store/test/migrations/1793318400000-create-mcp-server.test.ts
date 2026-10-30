import { expect, test } from 'vitest';
import { withDataSource } from '../../src/connection.ts';
import { CreateMcpServer1793318400000 } from '../../src/migrations/1793318400000-create-mcp-server.ts';
import { open } from '../stores.ts';

const TABLES = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_server'";

// TypeORM reads the timestamp from the name's last 13 digits, and would fall back to the class's
// name, which a minifier could change.
test('the migration is named with its 13-digit timestamp', () => {
    expect(new CreateMcpServer1793318400000().name).toBe('CreateMcpServer1793318400000');
});

test('down undoes up', async () => {
    const { store } = await open();

    const undone = await withDataSource(store, 'undo the migration', async (dataSource) => {
        await dataSource.undoLastMigration({ transaction: 'all' });

        return dataSource.query(TABLES);
    });
    const redone = await withDataSource(store, 'migrate again', async (dataSource) => {
        const migrations = await dataSource.runMigrations({ transaction: 'all' });

        return [
            migrations.map((migration) => migration.name),
            await dataSource.query(TABLES),
            (await dataSource.driver.createSchemaBuilder().log()).upQueries,
        ];
    });

    expect(undone).toEqual({ ok: true, value: [] });
    expect(redone).toEqual({
        ok: true,
        value: [['CreateMcpServer1793318400000'], [{ name: 'mcp_server' }], []],
    });
});
