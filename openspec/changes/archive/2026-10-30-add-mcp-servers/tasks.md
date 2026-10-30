## 1. Dependencies and scripts

- [x] 1.1 Add `@modelcontextprotocol/client@latest` to `packages/agent`, and `@modelcontextprotocol/server@latest` as a development dependency there; check with `bun install` that the client's `zod` dependency resolves to the repo's.
- [x] 1.2 Add the root scripts `mcp` (`bun packages/agent/src/main/mcp.ts`) and `mcp:node` (`node --env-file-if-exists=.env packages/agent/src/main/mcp.ts`), as `agent` and `agent:node` are.

## 2. A stdin pipe for the process package

- [x] 2.1 Make `stdin: 'ignore' | 'pipe'` a required option of `spawnProcess`, with the subprocess's `stdin` typed by mode (a `WritableStream<Uint8Array>` for `'pipe'`, `undefined` for `'ignore'`) through mode-keyed objects, with no casts.
- [x] 2.2 Write the Node writer over `child.stdin`: a write resolves in its callback, any error becomes an `EPIPE`-coded one, a permanent `'error'` listener stays on the stream, close resolves at once on a destroyed stream, and abort destroys it.
- [x] 2.3 Write the Bun writer over the `FileSink`: a write awaits `write()` and then `flush()`, and fails with `EPIPE` before writing once `exitCode` or `signalCode` is set. Close and abort end the sink.
- [x] 2.4 Pass `stdin: 'ignore'` from `exec/run.ts`, `exec/sweep.ts` and the tests, and test every scenario of the `process-spawning` delta, skipping only "A process that closed its stdin" for `spawnWithNode` on Bun.

## 3. Tools that aren't strict

- [x] 3.1 Give `core`'s `Tool` an optional `strict`, and have the Responses adapter send `strict: false` for a tool that says so and `strict: true` otherwise; test both.

## 4. The store's mcp_server table

- [x] 4.1 Define the `mcp_server` EntitySchema in `packages/store/src/mcp-server.ts`, with an explicit type on every column: `id`, `name` and `prefix` (each unique), `entry` (`simple-json`, without `disabled`), `disabled`, `created_at` and `updated_at`.
- [x] 4.2 Write the migration `src/migrations/1793318400000-create-mcp-server.ts`, named with its 13-digit timestamp, with `import type`, one statement per `query()` and an exact `down`; import it by name in `openStore`, after the credential migration.
- [x] 4.3 Write the functions, each one statement on the store's queue:
  - `addMcpServer`, given the name, prefix, entry and starting flag, telling a name in use from a prefix in use;
  - `listMcpServers`, in name order;
  - `removeMcpServer`, giving the count;
  - `setMcpServerDisabled`, saying whether it found the server.
- [x] 4.4 Test every scenario of the `store` delta: the round trip with both flags, both unique keys, the order, removing, disabling, and the migrations, including an upgraded database and an empty schema diff.

## 5. The entry and the mcp command

- [x] 5.1 Write the strict JSON tokenizer in `agent/src/mcp/`.
  - It builds objects without a prototype.
  - It reports a syntax error, a repeated key or a byte-order mark with its line and column, and never quotes the text.
- [x] 5.2 Write the entry's checks, reading fields, `env` names and header names as own properties:
  - the fields of each transport, the transport inference, and `sse` refused;
  - unknown fields refused, with the hints, the pasted wrapper's included; and the missing timeout's example;
  - `disabled` taken out of the entry as the starting flag;
  - the filters, a name in both refused, and both timeouts;
  - a `command` or `cwd` without references checked as a path, and control characters refused in the stdio fields;
  - the name and its prefix;
  - the references' syntax, where they may appear (in a URL, only its path and query), and `MODEL_API_KEY`;
  - credential slots, `--option=value` included, with their exemptions (numbers, booleans, `none`, and names ending in `PATH`, `FILE` or `DIR`);
  - text shaped like a secret, at a boundary and with at least 16 characters after its prefix;
  - the refusal's advice: a reference set in `.env`, and changing a token typed on a command line;
  - headers and URLs, with plain `http` refused when a header or any part of the URL holds a reference;
  - the `mcp server unpinned` warning, by the `command`'s file name (`npx`, `bunx`, `uvx`, `docker`), with dist-tags and ranges counted as unpinned;
  - the `mcp server secret in arguments` warning.

  Collect every problem, and never quote a refused value.
- [x] 5.3 Give `config.ts` a loader for the command's two settings, `DATA_DIR` and `LOG_FORMAT`, sharing the agent's checks of them.
- [x] 5.4 Write the entry point `agent/src/main/mcp.ts`:
  - the five subcommands, an entry of `-` read from stdin, and the usage errors;
  - `migrated` when the open applied migrations;
  - the records each subcommand logs, and the exit codes;
  - a name or prefix in use, named in the error;
  - no network request, and no reference resolved.
- [x] 5.5 Test every scenario of the `mcp-servers` spec, on both runtimes.

## 6. The MCP client

- [x] 6.1 Write the run-time checks:
  - re-check each enabled entry, logging only its errors;
  - resolve its references from the environment, as own properties, trimmed;
  - check the resolved header values, and the resolved `url` by every URL rule, without quoting either;
  - check that a resolved `command` is a name without a slash or an absolute path, and find a name in the absolute entries of the server's `PATH`;
  - check that a resolved `cwd` is an absolute path to an existing directory.

  Report every problem from every server before any network request.
- [x] 6.2 Add `serverEnv` to `exec/env.ts`: the shell's copied and non-interactive variables, without the playwright-cli ones, then the server's own, then `GREMLIN_RUN_ID`. Have `commandEnv` share its core.
- [x] 6.3 Write the redaction: each non-empty value the server's references resolved to, longest first, replaced by `[redacted]`. Apply it before any cut, to the stderr tail, the failure's reason, a dropped tool's name, a JSON-RPC error's message, and every result.
- [x] 6.4 Write the stdio transport over `spawnProcess` with `stdin: 'pipe'`:
  - framing with the SDK's `ReadBuffer`, each chunk wrapped as a `Buffer`, and `serializeMessage`;
  - an 8 KiB stderr tail, always drained, without its first line when the tail begins inside it;
  - the close in the design's order:
    - the descendant listing, shared with `exec/sweep.ts`, within 10 seconds;
    - stdin ended without awaiting the close, then up to 2 seconds for the exit;
    - SIGTERM only to a group that isn't empty, then up to 2 seconds, with EPERM counted as empty;
    - SIGKILL only to groups still alive, then up to 2 seconds;
    - the readers cancelled and awaited.

    The limits are constants that tests can shorten, and the close is idempotent, one shared promise.
- [x] 6.5 Make the run's directory for stdio servers with no `cwd`:
  - with `mkdtemp` in the OS's temporary directory, mode 0700, holding an empty `node_modules`;
  - failing the run when that directory is inside `WORK_DIR` or `DATA_DIR`;
  - removed when the agent finishes.
- [x] 6.6 Connect over Streamable HTTP with the resolved headers in `requestInit`. Detect a 401 by `SdkHttpError`'s `data.status`, and turn it into an error saying the server needs a login, which isn't supported yet.
- [x] 6.7 Connect every enabled server in parallel:
  - with `enforceStrictCapabilities: true`, the legacy handshake and no capabilities;
  - each within its `startupTimeoutMs`, which covers the connection and the whole tool list, with `timeout` set to what is left of it on `connect()` and on each `tools/list` page;
  - under the run's `AbortController`, aborted when closing begins;
  - on any failure, close every server, then report the error with the redacted tail of the failing server's stderr, read after its close, ending with `bun run mcp disable <name>`.
- [x] 6.8 List the tools leniently:
  - a raw `tools/list` with a loose schema, up to 64 pages, stopping at a repeated cursor;
  - each tool checked with `isSpecType.Tool`, and empty names dropped;
  - then the filters, and the schema preflight on a deep copy: `$schema` removed, `properties: {}` and `items: {}` added, a root union dropped;
  - then compiling the copy with `fromJsonSchema` and a validator that can't print: `AjvJsonSchemaValidator` from `@modelcontextprotocol/client/validators/ajv`, over `new Ajv({ logger: false, strict: false, allErrors: true, validateSchema: false })` with `addFormats`. What it throws is caught: the tool is dropped with a `warn` record, or the run fails when `includeTools` names it;
  - then the model-facing names, with the hash suffix and the collision groups, the map back to each server's own names, and the sorted order.
- [x] 6.9 Give each MCP tool `core`'s `ToolSchema` without a cast. Use an object whose `~standard.validate` calls the compiled validator, and whose `jsonSchema.input` and `output` return the copy, with a type guard narrowing the copy for `fromJsonSchema`. R17.3 needed two casts, TS2345 and TS2322, which the lint refuses in source files.
- [x] 6.10 Call tools leniently:
  - a raw `tools/call` with a loose schema, each block checked with `isSpecType.ContentBlock`;
  - `timeout` set to `toolTimeoutMs`, which progress doesn't reset, and the run's abort signal;
  - the redaction, then the flattening, the 32 KiB cap on a UTF-8 boundary, and the failed outcomes.
- [x] 6.11 Log `mcp tools changed` on `notifications/tools/list_changed`, with the SDK's `autoRefresh` off, and keep the tools offered unchanged.
- [x] 6.12 Once every server has listed its tools, log server by server in name order: its `warn` records for dropped tools and unmatched exclusions, then its `mcp server` record (`name`, `transport`, `tools`, `bytes`, `catalog`). No record holds a resolved value.

## 7. The agent and its logger

- [x] 7.1 In `main.ts`:
  - create the run ID and the shell, then install the signal handlers and `finish()`, then connect the MCP servers, then start the session;
  - exit with 1 when connecting fails; a connect cut short by a signal logs no connect error, and the agent exits with the signal's code;
  - offer the servers' tools after the built-in ones;
  - in `finish()`, abort the run's controller and close every server, then `dispose()`, then close the store and remove the run's directory, on every path, signals included;
  - remove the signal handlers once the store is closed.
- [x] 7.2 In `log/log.ts`:
  - write every control character but tab and the line breaks as a `\u` escape in pretty output;
  - write a string holding one as JSON rather than bare;
  - escape U+007F to U+009F in JSON output too;
  - test every scenario of the `structured-log` delta.

## 8. Tests of the client

- [x] 8.1 Write the fake servers the tests need:
  - an in-process `McpServer` over Streamable HTTP on 127.0.0.1, which the slow start and the slow call use under fake timers;
  - small stdio scripts:
    - one that exits at start with a message on stderr, and one that writes a long line first;
    - one that never answers, and one that ignores end-of-file and SIGTERM;
    - a `sh -c` wrapper whose server starts a child in a group of its own;
    - a stderr flood, and a secret in stderr;
    - malformed tools and blocks, and schemas that won't compile;
    - three pages, a repeated cursor, and `list_changed`;
    - one that runs `npm config get registry`.

  The signal guard must vouch for every stdio server, through the run ID it carries. `fakeFetch` passes requests for the fake MCP server's origin to the real `fetch`, captured before it is stubbed.
- [x] 8.2 Test every scenario of the `mcp-client` spec and of the `agent` delta, on both runtimes.
- [x] 8.3 Spy on `console.debug`, `info`, `warn` and `error` across the MCP tests, and expect no call. Where the agent's logger runs, expect every `console.log` line to be one of its records.

## 9. Documentation and checks

- [x] 9.1 Update the README:
  - Layout: the agent's `mcp` folder and the store's `mcp-server` module;
  - Run: the tools offered and the new records;
  - Configuration: the `mcp` command's two settings;
  - The data folder: it also holds the MCP server definitions, references only, which the shell can change for later runs.

  Add a new section on MCP servers. It covers:
  - adding them with the entry on stdin, with an HTTP example whose header holds a reference and a pinned stdio example;
  - a worked example from GitHub's remote snippet: unwrap it, add the two timeouts, turn the PAT's placeholder into `${GITHUB_PAT}`, and set that in `.env`;
  - quoting, and never typing a real token into the command;
  - secrets in `env` rather than `args`;
  - that Bun's `.env` expands `$`, even in single quotes, while Node's doesn't;
  - `list`, `remove`, `disable` and `enable`;
  - the entry's fields, references, the timeouts, the filters and the tool names;
  - `PATH` under a scheduler, or an absolute `command` or `env.PATH`;
  - checking a new server with a short run and its `mcp server` record;
  - that a server that fails fails every run until it's disabled;
  - that the run's directory keeps out an `.npmrc` the file tools write, but not one a shell command writes to `~/.npmrc`.

  It also says what isn't supported yet (OAuth, images, resources), that tool descriptions and results reach the model as untrusted text, and that tool definitions cost context.
- [x] 9.2 Update `Brief.md`: the header's log, and the statuses of D30 (the `bun run mcp` form), D33, D34, D36 and D37, which this change carries out.
- [x] 9.3 Add new words to `cspell.json`, then run `bun run check`, `bun run mutation` (100%, with every timeout looked at) and `openspec validate add-mcp-servers --strict`, and fix what fails.
