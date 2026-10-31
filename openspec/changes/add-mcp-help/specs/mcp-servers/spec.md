## MODIFIED Requirements

### Requirement: Manage MCP servers with the mcp command
`bun run mcp` on Bun, and `bun run mcp:node` on Node, SHALL take one of five subcommands: `add <name> <entry>`, `list`, `remove <name>`, `disable <name>` or `enable <name>`, or a request for help: `help`, `--help` or `-h`. An `<entry>` of `-` SHALL be read from stdin, which keeps it out of the process list, the shell's history and the command line that `bun run` echoes.

The servers SHALL be kept in the store (`store`) in `DATA_DIR`. The command SHALL need only `DATA_DIR` and `LOG_FORMAT`, checked as the agent checks them, and SHALL report through the structured logger, in that format, help being the one exception. When opening the store applied migrations, it SHALL first log the `migrated` record that the agent logs (`agent`). It SHALL make no network request, and SHALL resolve no reference.

On success it SHALL exit with 0. Otherwise it SHALL log an `error` record for each problem and exit with 1: an unknown subcommand, a wrong number of arguments, an unknown name, a name or prefix already in use, an entry that fails its checks, or settings that fail theirs. The error for an unknown subcommand, or for a wrong number of arguments, SHALL end by naming `bun run mcp help`.

The subcommands SHALL do this:
- `add` SHALL check the name and the entry, store the entry as checked, and log an `info` record `mcp server added` with `name` and `transport`;
- `list` SHALL log one `info` record `mcp server` for each server, in name order, with `name`, `transport`, `disabled` and `entry`, or an `info` record `no mcp servers` when there are none;
- `remove` SHALL delete the server, and log an `info` record `mcp server removed` with `name`;
- `disable` and `enable` SHALL set the server's flag, and log an `info` record `mcp server disabled` or `mcp server enabled` with `name`.

**Help.** `help`, `--help` and `-h`, whatever follows them, and no arguments at all, SHALL write one usage text to stdout as plain text, whatever `LOG_FORMAT` is, and SHALL need no setting and open no store. The text SHALL give: the five subcommands with their arguments, and `-` for an entry on stdin; `bun run mcp:node`; the rule for a name; what an entry is, one server's object from inside a `mcpServers` map, with its fields by transport, the two required timeouts and the filters; references in place of secrets, with an example entry given on stdin; the two settings; and the README section that explains the rest. A request for help SHALL exit with 0, and no arguments SHALL exit with 1.

#### Scenario: Adding and listing
- **WHEN** `bun run mcp add docs '{"url":"https://docs.example.com/mcp","startupTimeoutMs":30000,"toolTimeoutMs":120000}'` runs, and then `bun run mcp list`
- **THEN** the first exits with 0 after an `mcp server added` record, and the second logs one `mcp server` record with `name` `docs`, `transport` `http`, `disabled` false, and the entry as it was given

#### Scenario: An entry on stdin
- **WHEN** `bun run mcp add docs -` runs with the same entry on stdin
- **THEN** the server is stored as if the entry had been the argument

#### Scenario: Removing
- **WHEN** `bun run mcp remove docs` runs after `docs` was added
- **THEN** it exits with 0 after an `mcp server removed` record, and a later `list` logs `no mcp servers`

#### Scenario: Disabling and enabling
- **WHEN** `disable docs` runs, then `list`, then `enable docs`, then `list`
- **THEN** the first `mcp server` record has `disabled` true, and the second has `disabled` false

#### Scenario: An unknown name
- **WHEN** `bun run mcp remove nope` runs, and no server is named `nope`
- **THEN** it exits with 1, with an error naming `nope`

#### Scenario: A name in use
- **WHEN** `add docs …` runs while a server named `docs` exists
- **THEN** it exits with 1, with an error saying `docs` exists, and the stored entry is unchanged

#### Scenario: An unknown subcommand
- **WHEN** `bun run mcp start` runs
- **THEN** it exits with 1, with an error naming the five subcommands and `bun run mcp help`

#### Scenario: The settings it needs
- **WHEN** `DATA_DIR` and `LOG_FORMAT` are valid and no `MODEL_*` setting is set, and then `DATA_DIR` is unset
- **THEN** `list` works the first time, and the second time exits with 1, with an error naming `DATA_DIR`

#### Scenario: A new data folder
- **WHEN** `list` runs with a `DATA_DIR` that holds no database yet
- **THEN** it logs `migrated`, naming the migrations it applied, and then `no mcp servers`

#### Scenario: Offline
- **WHEN** `add` stores an entry whose header references a variable that isn't set
- **THEN** it exits with 0, makes no network request, and the stored entry holds the reference as written

#### Scenario: On Node
- **WHEN** `bun run mcp:node list` runs with the same settings
- **THEN** it gives the same records as `bun run mcp list`

#### Scenario: Help
- **WHEN** `bun run mcp help` runs with no `DATA_DIR` and no `LOG_FORMAT` set
- **THEN** it exits with 0, writes no log record, and its output names `add <name> <entry>`, `list`, `remove <name>`, `disable <name>`, `enable <name>`, `-`, `mcp:node`, `startupTimeoutMs`, `toolTimeoutMs`, `${GITHUB_PAT}`, `DATA_DIR`, `LOG_FORMAT` and the README

#### Scenario: Help, however it's asked for
- **WHEN** `--help` runs, then `-h`, then `help add`, each with `LOG_FORMAT` `json`
- **THEN** each writes the same text as `help`, as plain text, and exits with 0

#### Scenario: No arguments
- **WHEN** `bun run mcp` runs with no arguments
- **THEN** it writes the same text as `help`, and exits with 1

#### Scenario: A wrong number of arguments
- **WHEN** `bun run mcp list extra` runs
- **THEN** it exits with 1, with an error saying `list` takes no arguments and naming `bun run mcp help`
