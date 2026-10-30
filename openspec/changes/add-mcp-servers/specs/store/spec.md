## ADDED Requirements

### Requirement: Keep MCP server definitions
`@mecha-gremlin/store/mcp-server` SHALL keep MCP servers (`mcp-servers`) in an `mcp_server` table, one row per server, holding:
- its name, and the prefix its tools take;
- its entry as checked, without `disabled`, as JSON;
- whether it's disabled;
- when it was created and last updated, in epoch milliseconds.

Names SHALL be unique, and so SHALL prefixes.
- `addMcpServer` SHALL insert a server with the name, prefix, entry and starting flag it is given, and give an error saying whether its name or its prefix is in use when one is.
- `listMcpServers` SHALL give every server, in name order.
- `removeMcpServer` SHALL delete a server by name, and say how many it deleted.
- `setMcpServerDisabled` SHALL set a server's flag by name, and say whether it found the server.

Each of them SHALL run on the store's queue, report a failure as a result, and SHALL NOT throw.

#### Scenario: A round trip
- **WHEN** a server is added, not disabled, with an entry holding nested objects and arrays, and another is added disabled
- **THEN** `listMcpServers` gives the first with the same name and prefix, an entry deeply equal to the one added, and `disabled` false, and the second with `disabled` true

#### Scenario: A name in use
- **WHEN** a server is added under a name another server has
- **THEN** `addMcpServer` gives an error saying the name is in use, and the first server is unchanged

#### Scenario: A prefix in use
- **WHEN** a server is added with a new name, and the prefix another server has
- **THEN** `addMcpServer` gives an error saying the prefix is in use

#### Scenario: Name order
- **WHEN** the servers `b` and then `a` are added
- **THEN** `listMcpServers` gives `a`, then `b`

#### Scenario: Removing
- **WHEN** a server is removed, and then removed again
- **THEN** `removeMcpServer` first says it deleted 1, and then 0

#### Scenario: Disabling
- **WHEN** a server is disabled, and then a name no server has is disabled
- **THEN** `setMcpServerDisabled` first says it found the server, which is then listed with `disabled` true, and then says it found none

## MODIFIED Requirements

### Requirement: Migrate when it opens
The store SHALL run every pending migration when it opens, in one transaction, with TypeORM's schema synchronisation off. It SHALL give the names of the migrations it applied, in the order they ran. Once they have run, TypeORM SHALL find no difference between the store's entity definitions and the database. A migration that fails SHALL be rolled back, the connection SHALL be closed, and the open SHALL give an error naming the reason; no store SHALL be given.

#### Scenario: The first open
- **WHEN** a store opens in an empty directory
- **THEN** it gives the names of the migrations that create the `credential` table and the `mcp_server` table, in that order, and both tables exist

#### Scenario: A later open
- **WHEN** a store opens again in the same directory
- **THEN** it gives no migration names, and the credentials and servers saved before are still there

#### Scenario: The schema matches the definitions
- **WHEN** a store has opened
- **THEN** TypeORM's schema builder has no queries to run

#### Scenario: A migration that fails
- **WHEN** the database already holds a `credential` table that no migration created
- **THEN** the open gives an error, that table is unchanged, and no store is given

#### Scenario: An upgraded database
- **WHEN** a store opens a database whose only applied migration is the one that creates the `credential` table
- **THEN** it gives the name of the migration that creates the `mcp_server` table alone, and the credentials saved before are still there
