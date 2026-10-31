## MODIFIED Requirements

### Requirement: Manage MCP servers from the command line
`bun run mcp` on Bun, and `bun run mcp:node` on Node, SHALL take one of these subcommands:
- `add <name> <url> [options]` and `add <name> [options] -- <command> [args…]` ("Describe a server with flags");
- `list`;
- `get <name>`;
- `remove <name>`, `disable <name>` and `enable <name>`;
- `login <name> [options]` and `logout <name>` (`mcp-login`);
- `help`, `--help` or `-h`.

The servers SHALL be kept in the store (`store`) in `DATA_DIR`, which SHALL be the only setting the command reads, checked as the agent checks it. The command SHALL make no network request and resolve no reference, except `login`, which reaches the server and its authorization server, and resolves the server's references as a run does (`mcp-login`).

**Output.** The command SHALL write plain text for people, not log records:
- its results to stdout;
- each problem to stderr, as a line beginning `error: `, and each warning as a line beginning `warning: `, before any result.

It SHALL exit with 0 on success. Otherwise, having reported every problem it found, it SHALL exit with 1. The problems are:
- an unknown subcommand or option, or a wrong number of arguments;
- an unknown name, or a name or prefix already in use;
- settings for a server that fail their checks;
- a `DATA_DIR` that fails its check.

The errors for an unknown subcommand, an unknown option and a wrong number of arguments SHALL end by naming `bun run mcp help`.

**The subcommands** SHALL do this:
- `add` SHALL check the name and the server's settings, store the server, and print `Added <name> (<transport>).`; with `--disabled`, it SHALL also say that runs won't start the server until `bun run mcp enable <name>`.
- `list` SHALL print a table with a header row, `NAME`, `TRANSPORT`, `TARGET` and `ENABLED`, and one row per server, in name order: its transport, `http` or `stdio`; its URL, or its command and arguments; and `yes` or `no`. With no servers, it SHALL print one line saying there are none and how to add one.
- `get` SHALL print the server's name, and then one labelled line per setting, with references as written: its transport; its URL and each header, or its command and arguments, each variable and its working directory; its filters; both timeouts, in the largest of `h`, `m`, `s` and `ms` that divides them exactly; for a Streamable HTTP server, its login: `yes`, `no` or `needs a new login`; and whether it's enabled. It SHALL end with how to change it: `remove`, then `add`.
- `remove` SHALL delete the server and its saved logins, and print `Removed <name>.`
- `disable` and `enable` SHALL set the server's flag, and print `Disabled <name>.` or `Enabled <name>.`, the first saying that runs won't start it.

**Help.** `help`, `--help` and `-h`, whatever follows them, and no arguments at all, SHALL print one usage text to stdout, needing no setting and opening no store. The text SHALL give:
- the subcommands, with both forms of `add`, and `login` and `logout`;
- each option of `add`, with the default timeouts and how a time is written, and each option of `login`;
- the rule for a name;
- references in place of secrets, in single quotes, with an example;
- `DATA_DIR`;
- `bun run mcp:node`;
- the README section that explains the rest.

A request for help SHALL exit with 0, and no arguments SHALL exit with 1.

#### Scenario: Adding and listing
- **WHEN** `bun run mcp add docs https://docs.example.com/mcp` runs, and then `bun run mcp list`
- **THEN** the first exits with 0 after printing `Added docs (http).`, and the second prints a header row of `NAME`, `TRANSPORT`, `TARGET` and `ENABLED`, then a row of `docs`, `http`, `https://docs.example.com/mcp` and `yes`

#### Scenario: Showing one server
- **WHEN** `add docs https://docs.example.com/mcp --header 'Authorization: Bearer ${DOCS_TOKEN}' --tool-timeout 5m` runs, and then `get docs`
- **THEN** `get` prints the URL, the header with its reference as written, a startup timeout of `30s`, a tool timeout of `5m`, that the server is enabled, and how to change it

#### Scenario: A local server in the table
- **WHEN** `add files -- npx -y @modelcontextprotocol/server-filesystem@2.1.0 '/srv/my data'` runs, and then `list`
- **THEN** the row's target is `npx -y @modelcontextprotocol/server-filesystem@2.1.0 '/srv/my data'`

#### Scenario: Removing
- **WHEN** `bun run mcp remove docs` runs after `docs` was added
- **THEN** it exits with 0 after printing `Removed docs.`, and a later `list` prints that there are no MCP servers

#### Scenario: Disabling and enabling
- **WHEN** `disable docs` runs, then `list`, then `enable docs`, then `list`
- **THEN** the first table's row for `docs` ends with `no`, and the second's with `yes`

#### Scenario: An unknown name
- **WHEN** `bun run mcp remove nope` runs, and no server is named `nope`
- **THEN** it exits with 1, prints nothing to stdout, and prints to stderr one line beginning `error: ` and naming `nope`

#### Scenario: A name in use
- **WHEN** `add docs …` runs while a server named `docs` exists
- **THEN** it exits with 1, with an error saying `docs` exists and that changing it is `remove`, then `add`, and the stored server is unchanged

#### Scenario: An unknown subcommand
- **WHEN** `bun run mcp start` runs
- **THEN** it exits with 1, with an error naming the subcommands and `bun run mcp help`

#### Scenario: A wrong number of arguments
- **WHEN** `bun run mcp list extra` runs, and then `bun run mcp get`
- **THEN** each exits with 1, with an error saying what the subcommand takes and naming `bun run mcp help`

#### Scenario: The setting it needs
- **WHEN** `DATA_DIR` is valid and no other setting is set, `LOG_FORMAT` included, and then `DATA_DIR` is unset
- **THEN** `list` works the first time, and the second time exits with 1, printing `error: DATA_DIR is required.`

#### Scenario: A new data folder
- **WHEN** `list` runs with a `DATA_DIR` that holds no database yet
- **THEN** it creates `db.sqlite` there, and prints only that there are no MCP servers and how to add one

#### Scenario: Offline
- **WHEN** `add` stores a server whose header references a variable that isn't set
- **THEN** it exits with 0, makes no network request, and the stored header holds the reference as written

#### Scenario: On Node
- **WHEN** `bun run mcp:node list` runs with the same settings
- **THEN** it prints the same as `bun run mcp list`

#### Scenario: Help
- **WHEN** `bun run mcp help` runs with no `DATA_DIR` set
- **THEN** it exits with 0, and its output names both forms of `add`, `list`, `get`, `remove`, `disable`, `enable`, `--header`, `--env`, `--cwd`, `--include-tool`, `--exclude-tool`, `--startup-timeout`, `--tool-timeout`, `--disabled`, `login`, `logout`, `--client-id`, `30s`, `2m`, `'Authorization: Bearer ${GITHUB_PAT}'`, `DATA_DIR`, `mcp:node` and the README

#### Scenario: Help, however it's asked for
- **WHEN** `--help` runs, then `-h`, then `help add`
- **THEN** each prints the same text as `help`, exits with 0, and creates no database

#### Scenario: No arguments
- **WHEN** `bun run mcp` runs with no arguments
- **THEN** it prints the same text as `help`, and exits with 1

#### Scenario: Showing a login
- **WHEN** `get docs` runs before `docs` is logged in, after it's logged in, and after its refresh was refused
- **THEN** its `Login` line reads `no`, then `yes`, then `needs a new login`
