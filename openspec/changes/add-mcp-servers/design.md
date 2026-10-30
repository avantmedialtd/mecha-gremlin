## Context

The agent opens the store in `DATA_DIR` before any network request, offers its own tools (`read`, `write` and `edit` or `apply_patch`, `shell`, `activate_skill`), and runs one session. Brief 4.12 drafts an MCP client from R17.3 (the SDK), R17.5 (twelve harnesses) and R18 (configuration formats, real servers' catalogs, a stdio transport prototype). D29, decided on 2026-10-30, replaced 4.12's `MCP_CONFIG` file with rows in the database, written by a command. This design is 4.12 with that change, and with what a review of the first draft found. For the details behind each rule it cites R17 and R18.

Constraints that shape it:
- **Two runtimes.** The code runs on Bun and on Node 26, with Node's type stripping (D19), and the tests run on both.
- **The repository's bars:** a 100% Stryker score, type-aware lint (with `no-unsafe-type-assertion` on outside tests), and Results rather than throws.
- **The tool list is fixed per session,** for the prompt cache (R3.4).
- **The built-in tools are sent to Responses with `strict: true`,** and LM Studio converts tool names to snake_case (R5.2).
- **The SDK can't be used as it is.** `@modelcontextprotocol/client` 2.4:
  - loses a whole list or result over one malformed item;
  - gives every request a 60-second timeout unless the request names its own, and an `AbortSignal` doesn't lift it;
  - has no logger hook, and its default validator logs through `console`;
  - refreshes nothing before a 401;
  - has a stdio transport that signals only its direct child (R17.3, R18.2, R18.3).

## Goals / Non-Goals

**Goals:**
- Add, list, remove, disable and enable MCP servers with one command, keeping their definitions in the store.
- Connect each run to every enabled server, offer their tools under names every provider accepts, and return their results as text.
- Keep secrets out of the database, the logs and the process list wherever the agent can: entries hold references, and runs resolve them from the environment.
- Fail a run before its first model call when a server it depends on is missing or broken.
- Behave the same on Bun and Node, and clean up every server process, including a browser a server started, within a bounded time.

**Non-Goals:**
- OAuth (C17).
- Restarting a server that exits mid-session (Q23).
- Deferring tool definitions behind a search (Q21).
- MCP resources, prompts, sampling, elicitation and roots; the 2026-07-28 era; images reaching the model.
- Checking a server when it's added.

## Decisions

### 1. Rows in the store, written by a command (D29)

The store gains a table, `mcp_server`, and a migration that creates it:

| Column | Type | Holds |
|---|---|---|
| `id` | integer, primary key | generated |
| `name` | text, unique | the server's name, as given |
| `prefix` | text, unique | its tools' prefix: the name lowercased, with `-` turned to `_` |
| `entry` | text: JSON | the entry as checked, without `disabled`, its references unresolved |
| `disabled` | integer: boolean | the only place a server's flag lives |
| `created_at`, `updated_at` | integer | epoch milliseconds |

`@mecha-gremlin/store/mcp-server` provides:
- `addMcpServer`, given the name, prefix, entry and starting flag;
- `listMcpServers`, in name order;
- `removeMcpServer`, which gives the count;
- `setMcpServerDisabled`, which says whether it found the row.

Each is one statement inside the store's queue. The store doesn't check entries: it keeps what the agent checked.

**The unique `prefix`** lets the database itself refuse two servers whose tools would share a prefix, such as `github-api` and `github_api`. The command checks first, so that its error can name the other server.

**One flag.** An entry's `disabled` field is taken as the starting flag and left out of the stored entry. Otherwise `enable` would leave a `"disabled": true` behind it, and a run would have two answers to read.

**Alternative:** columns for the entry's fields. Rejected: the entry is the user's input, re-checked on every run, and a JSON column keeps the table unchanged as fields are added.

### 2. The `mcp` command (D30's form)

A second entry point, `packages/agent/src/main/mcp.ts`, run as `bun run mcp <subcommand> …` or `bun run mcp:node <subcommand> …`:

| Subcommand | Does |
|---|---|
| `add <name> <entry>` | checks the name and the entry, refuses a name or prefix in use, stores the entry, and logs `mcp server added`; an `<entry>` of `-` is read from stdin |
| `list` | logs one `mcp server` record for each server, in name order: `name`, `transport`, `disabled` and `entry`; or `no mcp servers` |
| `remove <name>` | deletes the server, and logs `mcp server removed` |
| `disable <name>`, `enable <name>` | set the flag, and log `mcp server disabled` or `mcp server enabled` |

- **Settings.** It needs only `DATA_DIR` and `LOG_FORMAT`, checked as the agent checks them. A narrower loader in `config.ts` shares their checks. Like the agent, it logs `migrated` when its open applied migrations; on a fresh install it is usually what applies them.
- **Output.** Its output is structured records, in the format `LOG_FORMAT` chooses. Every problem with an entry is reported together, as `error` records, and the exit code is then 1. So is the code for an unknown subcommand, a wrong number of arguments, or an unknown name.
- **Offline.** It opens the store and makes no network request. It never resolves a reference: a run does.
- **Why a JSON entry.** It is the format vendors publish (R18.1), so a vendor's entry needs only unwrapping, the two timeouts, and references for its placeholders. It is one input model, checked by one schema. And a shell leaves `${NAME}` alone inside the single quotes it is written in.
- **Why stdin.** An entry given as an argument is in the shell's history and the process list. `bun run` also echoes the whole command line to stderr before the script starts, which the tokenizer's care can't prevent (checked on Bun 1.4.4). `add <name> -` keeps the entry out of all three, so the README's examples use it.
- **Changing an entry** means `remove`, then `add`, so a typo can't half-change a server. The OAuth change can add `login` to the same command.

### 3. The entry: 4.12's format, with tighter checks

The entry is Claude Code's `mcpServers` entry, with the rules 4.12 sets out, as the command's input rather than a file's. The review tightened several of them.

- **Fields:**
  - stdio takes `command`, `args`, `env` and `cwd`; Streamable HTTP takes `type` and `url`, and optionally `headers`;
  - both take `includeTools`, `excludeTools`, `startupTimeoutMs`, `toolTimeoutMs`, `disabled`, and `title` and `description`, which are kept but unused;
  - without a `type`, `command` means stdio and `url` Streamable HTTP;
  - `sse` is refused as deprecated;
  - any other field is an error with a hint. That includes a pasted wrapper (`mcpServers`, `servers`, `mcp`, `context_servers`, or one field holding a server), whose hint says to give the object inside it and its name as the first argument.
- **Paths.** Once resolved, `command` is a name without a slash or an absolute path, and `cwd` is an absolute path. A relative one would resolve against wherever `bun run mcp` or a scheduled run happens to start.
- **No control characters** in `command`, the arguments, `env` names and values, or `cwd`. A NUL there makes the spawn fail with an error that prints the whole value, a resolved secret beside it included (R18.1).
- **Strict JSON,** read by a small tokenizer of its own.
  - It reports duplicate keys and a byte-order mark, gives line and column, and never quotes the text, since a pasted snippet may hold a secret (R18.1).
  - It builds objects without a prototype, and the checks read own properties only. A `__proto__` key would otherwise replace an object's prototype, and `constructor` would pass as a known field (R18.1).
  - A missing timeout's error gives an example of both.
- **References:**
  - `${NAME}` and `${env:NAME}`, with `$$` for a literal `$`, in `command`, the arguments, `env` values, `cwd`, header values, and a URL's path and query;
  - never in a URL's scheme, userinfo, host or port, which `add` couldn't check: `https://${HOST}/mcp` parses, with the host `${host}`;
  - any other `$` is an error with a hint;
  - `MODEL_API_KEY` can't be referenced.
- **No literal secrets.**
  - A credential slot must hold a reference. A slot is an `env` name, a header name, a query parameter, an `--option` followed by its value, or an `--option=value`, whose name's words include KEY, TOKEN, SECRET, PASSWORD, AUTH and the like.
  - Numbers, booleans and `none` are exempt, and so is a slot whose name ends in PATH, FILE or DIR, such as `PRIVATE_KEY_PATH`.
  - Text shaped like a token is refused anywhere: a known prefix, at the start of a string or after a character that isn't a letter or a digit, followed by at least 16 token characters. Without the boundary and the length, `sk-` would refuse `task-master-ai` and `--disk-cache`.
  - Userinfo in a URL, a written-out `Bearer` or `Basic` credential, a JSON Web Token and a PEM private key are refused too.
  - The refusal says to use a reference set in `.env`, and to change a token typed on a command line.
- **References in arguments** are stored with a `warn` record `mcp server secret in arguments`. A run puts their values in the server's argv, which every local user can read through `ps`, while `env` is readable only by the same user. The rule above would otherwise steer keys into arguments without a word.
- **Headers:**
  - RFC 9110 names, unique ignoring case;
  - reserved names refused: `Accept`, `Content-Type`, `Content-Length`, `Host`, `Connection`, `Transfer-Encoding`, `Last-Event-ID`, `DPoP` and every `Mcp-*`;
  - values non-empty, with no control character but tab and nothing above U+00FF.
- **URLs:**
  - `http` or `https`, with no userinfo or fragment, and no port on fetch's bad-port list;
  - plain `http` is refused when a header or any part of the URL holds a reference, whatever the host. Bun 1.4.4's fetch sends even a request to `127.0.0.1` or `localhost` through `HTTP_PROXY` unless `NO_PROXY` names it, `Authorization` header included (checked), so 4.12's loopback exception doesn't hold.
- **Timeouts:** whole milliseconds from 1,000 to 2,147,483,647, both required in every entry, as every other operational setting is explicit.
- **Names:** `^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$`, 1–24 characters.
- **Pinning.** An entry is stored with a `warn` record when its `command`'s file name is `npx`, `bunx`, `uvx` or `docker`, and its package or image isn't pinned to an exact version. A dist-tag such as `@latest`, which vendors' snippets use, doesn't pin a package, nor does a range. `uvx` needs `==` or `@` and an exact version, and an image needs a digest or a tag other than `latest`.

`add` runs the static checks. Each run checks every enabled entry again, logging only errors, since a row may predate a newer check or have been written by hand. It then does what only a run can do:
- it resolves the references, as own properties of the environment, trimmed; an unset or blank one is an error;
- it checks the resolved header values, and the resolved URL by every URL rule, without quoting either;
- it resolves a stdio `command` without a slash against the server's `PATH`, skipping relative and empty entries, and spawns the absolute path it found;
- it checks that a resolved `cwd` is an absolute path to an existing directory.

Every problem, from every server, is reported before any network request.

### 4. The run: connect, list, offer

**Order in `main.ts`:**
1. the settings, the skills and the store;
2. the run ID and the shell;
3. the signal handlers and `finish()`;
4. then the MCP servers;
5. then the session.

Stdio servers carry `GREMLIN_RUN_ID`, which the shell's sweep and the tests' signal guard both rely on, so the run ID must come first. The connect can last a whole `startupTimeoutMs`, so a signal during it must already reach `finish()`. Creating the shell earlier costs nothing: it only builds an environment and closures.

- **Connecting.** Every enabled server connects in parallel, each within its own `startupTimeoutMs`. That covers the spawn or the first request, the handshake, and every `tools/list` page.
  - `connect()` and each `tools/list` page are sent with `timeout` set to what is left of `startupTimeoutMs`. Without it, the SDK ends each request at 60 seconds, and some servers take longer to list (R18.2).
  - Clients use the legacy handshake, announce no capabilities, and set `enforceStrictCapabilities: true`. `tools/list` goes only to a server that announces tools, which keeps the SDK's `console.debug` off stdout (R18.3).
  - The MCP layer holds one `AbortController` for the run, which it aborts when closing begins, ending every connect and call still in flight.
- **A failure fails the run (D33).** When any server fails to start, to answer, or to list a tool its `includeTools` names, every server is closed, and the run fails before its first model call.
  - The error names the server and the reason, then the last lines of its stderr tail, read after the close, since it lags stdout (R18.3).
  - It ends with how to run without the server: `bun run mcp disable <name>`.
- **A signal while connecting** aborts the connections. `finish()` then closes every server started, removes the run's directory and closes the store, and the agent exits with the signal's code. It logs `interrupted`, and no error for the aborted connections.
- **Redaction.** Before a text from a server, or from an error in reaching it, goes into a record or a tool's outcome, each non-empty value that one of the server's references resolved to is replaced by `[redacted]`, longest first, and only then is the text cut. Only references can hold a secret, since `add` refuses literal ones, so redacting every configured value would only garble the tail. The texts it covers:
  - the stderr tail;
  - the failure's reason, where 2.4.0's `SdkHttpError` puts the whole response body;
  - a dropped tool's name;
  - a JSON-RPC error's message;
  - every tool result, `isError` or not.
- **Records in name order.** Each server's `warn` records and its `mcp server` record are logged once every server has listed its tools, server by server in name order, so that parallel connects give the same log every time.

### 5. Stdio, through the process package (D36, D37)

- **`@mecha-gremlin/process` gains a required `stdin: 'ignore' | 'pipe'`.** With `'pipe'`, the subprocess has a `WritableStream<Uint8Array>`.
  - A write resolves once the pipe has taken the chunk.
  - `close()` gives end-of-file, and resolves even after the process has exited.
  - Once the process exits or closes its stdin, every write fails with an `EPIPE` error, inside its own promise.
  - Each runtime gets its own small writer, because the raw APIs disagree (R18.3).
  - On Bun, `spawnWithNode` can't detect a process that closed its stdin, so that one scenario is exempt there.
  - The existing callers pass `'ignore'`.
- **The transport,** in `agent/src/mcp/`:
  - it spawns the server detached, as the leader of its own group;
  - its environment comes from `serverEnv`: the shell's copied and non-interactive variables, without the playwright-cli ones, then the server's own, then `GREMLIN_RUN_ID`;
  - it frames messages with the SDK's `ReadBuffer`, wrapping each chunk as a `Buffer`, and with `serializeMessage`;
  - it always drains stderr into an 8 KiB tail, dropping the tail's first line when the tail begins inside it, so that a cut can't leave part of a secret that redaction would miss.
- **Its `close()`** is idempotent and shares one promise. Every wait in it is bounded:
  1. it lists the process groups the server's descendants lead, once, before the first signal, within 10 seconds, as the sweep does;
  2. it ends stdin without awaiting the close, since a write held by a full pipe holds the close too (R18.3), and waits up to 2 seconds for the server to exit;
  3. if the server's group isn't empty, it sends SIGTERM to the group, and waits up to 2 seconds for the group to be empty. That also covers a wrapper leader such as `sh -c`. On macOS, a zombie-only group's EPERM counts as empty;
  4. it sends SIGKILL to each of the group and the listed groups that is still alive, so a server that left on end-of-file gets no signal, and waits up to 2 seconds;
  5. it cancels the stdout and stderr readers, and awaits them.

  This is what stops Playwright's Chrome, which a group kill alone misses (R18.3). The limits are constants, as the shell's `Limits` are, so tests can shorten them. Bounded, a close takes at most about 16 seconds. `main.ts` ignores signals while it finishes, which is safe only because every step of finishing has a limit.
- **The run's directory.** A stdio server runs in its `cwd`, or else in a directory made once for the run (D36).
  - It is made with `mkdtemp` in the OS's temporary directory, with mode 0700, never inside `WORK_DIR` or `DATA_DIR`: when the temporary directory is inside either, the run fails.
  - It holds only an empty `node_modules`. npm walks up from its working directory to the nearest folder holding a `package.json` or a `node_modules`, and reads that folder's `.npmrc`; the empty `node_modules` makes the run's directory that folder (checked with npm 11.20).
  - This keeps out an `.npmrc` that the file tools write, or that a repository brings into `WORK_DIR`. It can't keep out one a shell command writes to `~/.npmrc`. `uvx` reads no project `uv.toml` (checked).

### 6. Streamable HTTP

The SDK's transport sends the resolved headers through `requestInit`, keeps its default `redirectPolicy: 'same-origin'`, and has no `authProvider`. Without one, 2.4.0 reports a 401 as an `SdkHttpError` whose `data.status` is 401, not as `UnauthorizedError`, so that is what the client checks. A server that answers 401 fails the run: OAuth comes later.

### 7. Tools (D34)

- **Listing is lenient.** The agent sends `tools/list` itself, with a loose result schema.
  - It follows `nextCursor` for up to 64 pages, stopping at a repeated cursor.
  - It checks each tool with `isSpecType.Tool`.
  - It drops a tool that fails, or whose name is empty, with a `warn` record.
- **Filters** apply to the server's own tool names.
  - `includeTools`, when given, lists the only tools offered; `excludeTools` removes tools.
  - A name in both lists is refused by `add`.
  - An `includeTools` name the server doesn't list fails the run. An unmatched `excludeTools` name only warns.
- **The preflight** works on a deep copy, since `fromJsonSchema` hands back the server's own object.
  - A tool whose schema has a root `oneOf`, `allOf` or `anyOf` is dropped, since Anthropic refuses a whole request over one; when `includeTools` names it, the run fails instead.
  - `$schema` is removed. `fromJsonSchema` throws for any dialect but 2020-12, 2019-09, draft-07 and draft-06, so a schema that declares draft-04 would otherwise lose its tool, and draft-07 is what the model is sent anyway.
  - `properties: {}` and `items: {}` are added where missing.
- **Compiling.** `fromJsonSchema` compiles the copy at once, and throws for what ajv can't compile, such as an invalid `pattern` or a `$ref` it can't resolve.
  - The agent catches that. It drops the tool with a `warn` record, or fails the run when `includeTools` names it, so one bad schema can't fail its whole server.
  - The validator is built so that it can't print: `new AjvJsonSchemaValidator(ajv)` from `@modelcontextprotocol/client/validators/ajv`, with `ajv = new Ajv({ logger: false, strict: false, allErrors: true, validateSchema: false })` and `addFormats(ajv)`. The default one logs `unknown format … ignored` through `console` (R18.2).
- **The tool's `ToolSchema`, without casts.** R17.3 needed two casts to turn `fromJsonSchema`'s result into `core`'s `ToolSchema`: TS2345 on the schema, and TS2322 on the converter's `Target`, whose last member is `(object & string)` in the SDK but `({} & string)` in `core`. The lint refuses both in source files. So the tool's schema is a small object of its own:
  - its `~standard.validate` calls the compiled validator;
  - its `jsonSchema.input` and `output` return the copy;
  - a type guard narrows the copy for `fromJsonSchema`.

  `validateArgs` then still checks arguments locally.
- **Names** are `mcp__<prefix>__<tool>`.
  - In the tool part, `_` goes where an uppercase letter follows a lowercase letter or a digit; the part is lowercased; and every character outside `[a-z0-9_]` becomes `_`.
  - A name over 64 characters keeps its first 55 and gains `_` and the first 8 hex digits of the SHA-256 of `name\0tool`.
  - Tools that would share a name all take the hashed form, and a tool a server lists twice keeps its first entry.
  - A map built once per session sends each call to its server and raw name.
- **What's sent:** the description as it is, and the patched schema. Titles, annotations, output schemas, icons and `_meta` are never sent.
- **Strict mode.** `core`'s `Tool` gains an optional `strict`, and the Responses adapter sends a tool marked `strict: false` that way. MCP tools are; the built-in ones stay strict. Left unset, Responses would likely make MCP schemas strict, and the model would then send nulls that servers refuse (R18.2).
- **Order:** the built-in tools, then the MCP tools sorted by name, fixed for the session. A `tools/list_changed` is logged, with `autoRefresh` off.

### 8. Calls and results

- **Calls are lenient too.** The agent sends `tools/call` itself, with a loose result schema, and checks each content block with `isSpecType.ContentBlock`. The SDK's output-schema cache stays cold, so a server's bad structured content never throws (R18.2).
- **A timeout per call.** Each call is sent with `timeout` set to the entry's `toolTimeoutMs`, which progress doesn't reset, so it is a wall-clock limit. The SDK's 60-second default never applies, since a signal doesn't lift it. The call also carries the run's abort signal, so closing ends it.
- **Results are flattened** into one text, joined with newlines:
  - text blocks as they are;
  - a resource link as `[resource link: <name> <uri> (<mimeType>)]`, without the parentheses when there's no MIME type;
  - a text resource as `[resource <uri>]` and its text;
  - a blob resource, an image or audio as `[<type> <mimeType>, <n> base64 characters, not shown]`;
  - a block of another type, or a malformed one, as `[<type> block, not shown]`;
  - structured content as JSON, only when no text block came;
  - and nothing at all as `(no output)`.
- **The cap** is 32 KiB, cut on a UTF-8 boundary after redaction, with a note giving the full size.
- **Errors.** `isError: true` becomes a failed outcome with its text. A JSON-RPC error, a timeout or a closed connection becomes a failed outcome naming the server and the tool.

### 9. Shutdown and logs

- **`finish()`:**
  - aborts the run's controller, and closes every MCP client in parallel, those still connecting included;
  - then runs the shell's sweep, which stays the backstop;
  - then closes the store, and removes the run's directory for stdio servers.

  The signal handlers stay until the store is closed. A killed agent's stdio servers see end-of-file and exit on their own (R18.3).
- **An `info` record `mcp server` for each server,** in name order once every server has listed its tools, and before `asking`. It holds `name`, `transport`, `tools` (the model-facing names), `bytes` (the definitions' JSON size) and `catalog` (a SHA-256 of the raw list), so that a change between runs shows. Dropped tools and unmatched exclusions are `warn` records, just before it.
- **Never secrets.** No record holds a resolved reference, a header value or a token.
- **Escaped control characters.** A server's text now reaches records: an HTTP error's body, a dropped tool's name, an `isError` text. In pretty output the logger wrote messages, bare values and block lines raw, so a server could send terminal escape sequences, such as a clipboard write or cursor moves that hide a record.
  - The logger now writes every control character but tab and the line breaks as a `\u` escape (`structured-log`).
  - In JSON output, it escapes U+007F to U+009F as well, which `JSON.stringify` leaves raw.
- **Tests.** The logger writes with `console.log`, and `main.test.ts` reads the log that way. So the MCP tests spy on `console.debug`, `info`, `warn` and `error` and expect no call, and where the logger runs, they expect every `console.log` line to be a record. `fakeFetch` passes requests for the fake MCP server's origin to the real `fetch`, captured before it is stubbed, since the SDK's transport looks the global up at request time.

### 10. Dependencies

`@modelcontextprotocol/client@latest` goes in `packages/agent`, and `@modelcontextprotocol/server@latest` becomes a development dependency, for in-process test servers. No other dependency is new. The newest client on 2026-10-30 is 2.4.0. It bundles `fast-uri` 3.1.8, which has four advisories (R17.3), and since the copy is bundled, an `overrides` entry can't replace it. The fix is merged for 2.4.1, which isn't published yet, so the change takes 2.4.1 as soon as it is.

## Risks / Trade-offs

- [LM Studio's snake_case conversion may change `__` or digits, Q18] → S7 checks it; the lookup could also accept a normalised form.
- [Tool definitions are large: 15 servers cost about 21,900 tokens (R18.2)] → `includeTools` and the servers' own flags; the README says so. Deferring them is Q21.
- [A browser can outlive a server that dies abruptly (R18.3)] → known, and documented. S10 measures it on Linux.
- [The official Docker images have no `ps`, Q24] → the close then finds no descendants; procps goes in the image when Docker comes.
- [A server's descriptions and results are untrusted text in the prompt] → `includeTools` is the gate; the README warns.
- [The shell can change the definitions in `DATA_DIR`, so one run can choose the servers the next one starts] → no new power, since a shell can already change what runs next, such as a crontab or a shell profile; the README says so.
- [Redaction knows only the values of references] → `add` refuses literal secrets; a secret a server reads from elsewhere is the server's to keep.
- [A secret holding `$` reads differently on each runtime: Bun's `.env` loader expands `$`, even in single quotes, and Node's `--env-file` doesn't (R18.1)] → the README says so.
- [A server that ignores end-of-file and SIGTERM holds the agent's exit for about 4 seconds, and a slow `ps` for up to 10] → bounded; the limits are constants.
- [Re-checking each entry on every run costs a little at start-up] → milliseconds, against a server's start.
- [`@modelcontextprotocol/client` 2.4.0 bundles a `fast-uri` with four advisories, which reaches schemas that servers supply (R17.3)] → take 2.4.1 as soon as it's published.

## Migration Plan

Nothing changes until a server is added. The first run or `bun run mcp` after the upgrade applies the `mcp_server` migration and logs it. To roll back, revert the change: the extra table is left in the database, unused.

## Open Questions

- Q18 and S7 (LM Studio's names), Q21 (deferring definitions), Q23 (restarts), Q24 (`ps` in Docker) and S10 (Linux Chromium).
- Should `add` be able to check a server (`bun run mcp check <name>`)? Not in this change; the README shows how to check one with a short run.
- What happens to a server's OAuth credentials when it's removed is for the OAuth change.
