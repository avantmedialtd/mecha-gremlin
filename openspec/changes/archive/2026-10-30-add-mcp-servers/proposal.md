## Why

The agent can't use MCP servers: it offers only its own tools. D29 (2026-10-30) put the servers' definitions in the database, as rows a command writes, in place of a configuration file. Brief 4.12 drafts the rest of the client, from the research in R17.3, R17.5 and R18. This change adds the command, the table and the client, for servers that need no OAuth: OAuth comes in a later change (C16, C17, D35).

## What Changes

- **A new table, `mcp_server`,** in the store, holding each server's name, the prefix its tools take, its entry and whether it's disabled, with functions to add, list and remove servers and to disable or enable one.
- **A new command, `bun run mcp`** (and `bun run mcp:node`), with five subcommands: `add <name> <entry>`, `list`, `remove <name>`, `disable <name>` and `enable <name>`. An entry of `-` is read from stdin, which keeps it out of the shell's history, the process list and the line `bun run` echoes.
  - An entry is one server's JSON object in the `mcpServers` format that vendors publish: `command`, `args`, `env` and `cwd` for stdio; `type`, `url` and `headers` for Streamable HTTP. Both kinds also take `includeTools`, `excludeTools`, `startupTimeoutMs`, `toolTimeoutMs` and `disabled`.
  - Secrets are given only as `${NAME}` references to the agent's environment, and are resolved when a run starts. A literal secret is refused, and a reference in an argument, which a run puts in the process list, gets a warning.
  - A pasted `mcpServers` wrapper, and fields that other clients spell differently, are refused with a hint.
  - The command needs only `DATA_DIR` and `LOG_FORMAT`. It never resolves a reference and never contacts a server.
- **Each run connects to every enabled server** once the store is open, the run ID chosen and the signal handlers installed, and before the session, and a server that can't start, answer or list a tool its entry requires fails the run before the first model call.
  - Stdio servers run through `@mecha-gremlin/process`, which gains a stdin pipe. Each runs in a process group of its own, in a directory made for the run outside `WORK_DIR` and `DATA_DIR` unless its entry names one. Every wait in closing one is bounded.
  - Streamable HTTP servers get their headers.
- **Their tools follow the built-in ones,** named `mcp__<server>__<tool>`.
  - They are sorted, and fixed for the session.
  - Their schemas are checked and patched on a copy.
  - They go to the Responses API without strict mode.
- **Calls are lenient,** and each request carries its own timeout from the entry, never the SDK's 60-second default. Results are flattened to text and capped at 32 KiB, and failures come back to the model as tool errors.
- **The logs gain an `mcp server` record for each server,** listing its tools, their definitions' size and a hash of its catalog. No record holds a resolved reference: a server's text is redacted before it reaches a record or the model, and the logger escapes control characters.
- **Dependencies:** `@modelcontextprotocol/client` becomes a dependency of the agent, and `@modelcontextprotocol/server` a development dependency for its tests.
- **The README** documents adding MCP servers.
- **Settled by this design:** it takes the Brief's recommendations for D33 (a server that fails, fails the run), D34 (`includeTools` and `excludeTools`), D36 (stdio servers in an empty directory per run) and D37 (stdio through `@mecha-gremlin/process`). It gives D30's command the form `bun run mcp`, under which the OAuth login can later become `bun run mcp login`.

## Capabilities

### New Capabilities

- `mcp-servers`: the `mcp` command and the entries it keeps: adding, listing, removing, disabling and enabling servers, and the checks an entry must pass.
- `mcp-client`: how a run connects to the enabled servers, their transports, the tools they offer, how calls and results reach the model, failures, shutdown and logging.

### Modified Capabilities

- `store`: the `mcp_server` table and its functions, and a second migration, which the first open now applies too.
- `process-spawning`: a `stdin` option, `'ignore'` or `'pipe'`, and a writable pipe for `'pipe'`.
- `tool-calls`: a tool can be sent to the Responses API without strict mode.
- `agent`: the run connects the MCP servers after installing its signal handlers and before starting the session, and offers their tools after its own; it logs the `mcp server` records, closes the servers before stopping the session's processes, and handles a signal that arrives while they connect.
- `structured-log`: control characters are escaped in pretty output, and U+007F to U+009F in JSON output too, since a server's text now reaches records.

## Impact

- **`packages/agent`:**
  - a new `mcp` folder: the entry's checks, the transports, the client, the tools and the results;
  - a second entry point, `main/mcp.ts`, and the changes to `main.ts`;
  - a configuration loader for the command's two settings;
  - the logger's escaping of control characters.
- **`packages/store`:** a new module and migration. **`packages/process`:** the stdin pipe. **`packages/core`:** a tool can say it isn't strict.
- **The repository root:** the `mcp` and `mcp:node` scripts, the README, the Brief and `cspell.json`.
- **Not in scope:**
  - OAuth (C17), and restarting a server that exits mid-session (Q23);
  - deferring tool definitions behind a search (Q21);
  - MCP resources, prompts, sampling, elicitation and roots;
  - the 2026-07-28 protocol era, and showing images to the model.
