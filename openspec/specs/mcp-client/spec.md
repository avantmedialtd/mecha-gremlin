# mcp-client Specification

## Purpose
How a run uses its MCP servers: connecting every enabled server before the session, over stdio through `@mecha-gremlin/process` or over Streamable HTTP; offering their tools under names every provider accepts; returning their results to the model as redacted, capped text; closing them; and logging each server without its secrets.
## Requirements
### Requirement: Connect every enabled server before the session
Once the store is open, the run ID chosen and the signal handlers installed, and before the session, the agent SHALL read the enabled servers from the store (`mcp-servers`). It SHALL go by each server's `disabled` flag alone, and SHALL NOT start a disabled server.
- **Checks before any network request.** For every enabled server, the agent SHALL:
  - check the entry again, as `add` does, logging only its errors;
  - resolve the entry's references from the environment, reading own properties, and trim each value;
  - check the resolved header values, and the resolved `url` by every URL rule of `mcp-servers`, without quoting either;
  - check that a resolved stdio `command` is either an absolute path or a name without a slash, and find a name in the absolute entries of the server's `PATH`;
  - check that a resolved `cwd` is an absolute path to an existing directory.

  An unset or blank variable, or any other problem with any server, SHALL fail the run. The agent SHALL log an `error` record for each problem of every server, before any network request and before any server starts.
- **Connecting.** It SHALL connect to every enabled server in parallel, each within its own `startupTimeoutMs`, which SHALL cover the start, the handshake and the whole tool list.
  - A client SHALL use the 2025-11-25 handshake, announce no capabilities, and request a server's tools only when the server announces them.
  - The handshake and each `tools/list` request SHALL be sent with a `timeout` of what is left of `startupTimeoutMs`, so that the SDK's own 60-second default never applies.
- **Failing.** When a server can't start, answer, or list a tool its `includeTools` names, the agent SHALL close every server and fail the run before the first model call. The error SHALL:
  - name the server and the reason;
  - give the last lines of the server's stderr, read once it has closed;
  - end by saying that `bun run mcp disable <name>` lets the agent run without it.
- **Redacting.** A text SHALL be redacted before it's cut: each non-empty value that one of the server's references resolved to SHALL be replaced by `[redacted]`, longest first. This SHALL apply to every text that comes from a server, or from an error in reaching it, and goes into a record or a tool's outcome. That covers:
  - the failure's reason and the stderr lines;
  - a dropped tool's name;
  - a JSON-RPC error's message;
  - a tool's result, whether `isError` or not.

#### Scenario: Two servers' tools
- **WHEN** two enabled servers each offer one tool
- **THEN** the first model request offers the built-in tools and then both servers' tools, the MCP tools sorted by name

#### Scenario: A disabled server
- **WHEN** a server is disabled
- **THEN** it isn't started, and none of its tools is offered

#### Scenario: No servers
- **WHEN** the store holds no server
- **THEN** the run offers the built-in tools only, and logs no `mcp server` record

#### Scenario: An unset reference
- **WHEN** an enabled entry references `DOCS_TOKEN`, which is unset
- **THEN** the run fails with an error naming the server and `DOCS_TOKEN`, before any network request and before any server starts

#### Scenario: A server that exits at start
- **WHEN** a stdio server writes "bad config" to stderr and exits with code 3 before answering
- **THEN** the run fails before the first model call, with an error that names the server, its exit and "bad config", and ends with `bun run mcp disable` and the server's name

#### Scenario: A server that never answers
- **WHEN** a server never answers the handshake
- **THEN** the run fails once that server's `startupTimeoutMs` has passed, with an error naming it, and every server is closed

#### Scenario: A slow start
- **WHEN** a server's `startupTimeoutMs` is 90000, and it answers the handshake after 61 seconds
- **THEN** it connects, and its tools are offered

#### Scenario: A required tool that's missing
- **WHEN** an entry's `includeTools` names `search`, and the server doesn't list it
- **THEN** the run fails before the first model call, with an error naming the server and `search`

#### Scenario: A secret in stderr
- **WHEN** a failing server writes to stderr the value that its `env`'s reference `${DOCS_TOKEN}` resolved to
- **THEN** that value appears in no record, and `[redacted]` appears where it was

#### Scenario: A secret in an error
- **WHEN** an HTTP server whose header resolves to `t0k` answers its first request with 500 and a body holding `t0k`, and in another run a tool's `isError` text holds `t0k`
- **THEN** `t0k` appears in no record and in no outcome, and `[redacted]` appears where it was

#### Scenario: The handshake
- **WHEN** a server is started
- **THEN** its `initialize` request names protocol version 2025-11-25, and holds empty `capabilities`

### Requirement: Run stdio servers in a group of their own
A stdio server SHALL be started through `@mecha-gremlin/process` with `stdin: 'pipe'`, detached, so that it leads a process group of its own.
- **Its program** SHALL be the absolute path its `command` resolved to.
- **Its working directory** SHALL be its `cwd`, or else the run's directory.
  - The run's directory SHALL be made once, when a server needs it, with `mkdtemp` in the OS's temporary directory, with mode 0700. It SHALL hold only an empty `node_modules`, so that npm takes it as a project's root and reads no `.npmrc` above it.
  - When the OS's temporary directory is inside `WORK_DIR` or `DATA_DIR`, the run SHALL fail before any server starts, with an error naming it.
  - The run's directory SHALL be removed when the agent ends.
- **Its environment** SHALL be the shell's copied and non-interactive variables, without the playwright-cli ones, then the entry's `env`, then `GREMLIN_RUN_ID`.
- **Its stderr** SHALL always be read, and its last 8 KiB kept, without their first line when the 8 KiB begin inside it.
- **Closing a server** SHALL:
  1. list the process groups its descendants lead, once, before any signal, waiting at most 10 seconds for the list;
  2. end its stdin without waiting for that to finish, and wait up to 2 seconds for the server to exit;
  3. if its group isn't empty, send SIGTERM to the group, and wait up to 2 seconds for the group to be empty, taking EPERM as empty on macOS;
  4. send SIGKILL to each of its group and the listed groups that isn't empty, and wait up to 2 seconds for them to be empty;
  5. cancel its stdout and stderr readers, and wait for them.

  A close SHALL give the same promise to every caller.

#### Scenario: The environment
- **WHEN** a stdio server prints the names in its environment
- **THEN** apart from those the system adds itself (bash's `PWD`, `SHLVL` and `_`, and macOS's `__CF_USER_TEXT_ENCODING`), they are:
  - the shell's copied and non-interactive ones, without the playwright-cli ones;
  - the entry's `env` names;
  - `GREMLIN_RUN_ID`.

#### Scenario: The working directory
- **WHEN** an entry names no `cwd`, and then names a directory
- **THEN** the server first runs in a directory made for the run, which holds only an empty `node_modules` and is gone once the agent has ended, and then in the named one

#### Scenario: An npm configuration above the run's directory
- **WHEN** the OS's temporary directory is inside a directory that holds a `package.json` and an `.npmrc` setting `registry`, and a stdio server with no `cwd` runs `npm config get registry`
- **THEN** it gets npm's default registry

#### Scenario: A temporary directory inside the work directory
- **WHEN** `TMPDIR` names a directory inside `WORK_DIR`, and an enabled stdio server names no `cwd`
- **THEN** the run fails before any server starts, with an error naming the directory

#### Scenario: Relative entries in PATH
- **WHEN** the server's `PATH` is `.::/usr/bin`, and both its `cwd` and the agent's current directory hold an executable named like its `command`
- **THEN** the program in `/usr/bin` runs

#### Scenario: End-of-file is enough
- **WHEN** a server exits when its stdin ends
- **THEN** closing it sends no signal

#### Scenario: A wrapper and a child of its own
- **WHEN** the command is `sh -c '<server>; true'`, and the server starts a child that leads its own process group
- **THEN** after closing, none of the shell, the server and the child is running

#### Scenario: A server that ignores SIGTERM
- **WHEN** a server ignores end-of-file and SIGTERM
- **THEN** closing sends SIGTERM 2 seconds after ending its stdin, and SIGKILL 2 seconds after that, and the server is gone

#### Scenario: A flood of stderr
- **WHEN** a server writes 1 MiB to stderr before answering
- **THEN** it connects, and once it has been closed, its stderr's last line is in the kept tail

#### Scenario: A tail that begins inside a line
- **WHEN** a failing server writes a line of 10 KiB to stderr, and then "bad config"
- **THEN** the error's stderr lines hold "bad config", and nothing of the long line

### Requirement: Reach Streamable HTTP servers with their headers
A Streamable HTTP server SHALL be reached at its resolved `url`, with its resolved headers on every request, and with no OAuth. A server that answers with 401 SHALL be reported as needing a login, which isn't supported yet.

#### Scenario: A header from the environment
- **WHEN** an entry's header is `Authorization: Bearer ${DOCS_TOKEN}` and `DOCS_TOKEN` is `t0k`
- **THEN** every request to the server carries `Authorization: Bearer t0k`

#### Scenario: A resolved URL that breaks a rule
- **WHEN** the `url` is `https://docs.example.com/mcp?key=${DOCS_KEY}`, and `DOCS_KEY` is `a#b`
- **THEN** the run fails before any network request, with an error naming the server and saying its URL has a fragment, and `a#b` appears in no record

#### Scenario: A server that wants a login
- **WHEN** a server answers its first request with 401
- **THEN** the run fails before the first model call, with an error naming the server and saying it needs a login, which isn't supported yet

### Requirement: Offer each server's tools under names every provider accepts
- **Listing.** The agent SHALL list each server's tools page by page, up to 64 pages, stopping at a cursor it has seen. It SHALL drop a tool that isn't a valid MCP tool, or has an empty name, with a `warn` record naming the server and, where it has one, the tool, and keep the rest.
- **Filters** SHALL apply to the server's own tool names. With `includeTools`, only the tools it names SHALL be offered. A tool `excludeTools` names SHALL NOT be offered. A name in `excludeTools` that the server doesn't list SHALL get a `warn` record.
- **The schema** SHALL be patched on a copy, leaving the server's own unchanged:
  - `$schema` SHALL be removed;
  - an object schema without `properties` SHALL get `properties: {}`, and an array schema without `items` SHALL get `items: {}`;
  - a tool whose input schema has `oneOf`, `allOf` or `anyOf` at its root SHALL be dropped with a `warn` record, or fail the run when `includeTools` names it.
- **Compiling.** The patched copy SHALL be compiled by a validator that writes nothing and ignores formats it doesn't know. A tool whose copy can't be compiled SHALL be dropped with a `warn` record naming it, or fail the run when `includeTools` names it. The copy SHALL be what the model is sent, and what the call's arguments are checked against before the server is called.
- **Names.** A tool SHALL be offered as `mcp__<prefix>__<tool>`.
  - In the tool's part, an `_` SHALL be inserted where an uppercase letter follows a lowercase letter or a digit; the part SHALL be lowercased; and every character outside `[a-z0-9_]` SHALL become `_`.
  - A name over 64 characters SHALL keep its first 55, followed by `_` and the first 8 hexadecimal digits of the SHA-256 of the server's name, a NUL and the tool's own name.
  - Tools that would share a name SHALL all take that hashed form, and a tool a server lists twice SHALL keep its first entry.
  - A call SHALL reach the server, and the tool by its own name.
- **What's sent.** The model SHALL be sent each tool's name, its description as the server gives it, and the patched schema. On Responses, MCP tools SHALL be sent with `strict: false` (`tool-calls`). Titles, annotations, output schemas, icons and `_meta` SHALL NOT be sent.
- **Order.** The MCP tools SHALL follow the built-in tools, sorted by name, and SHALL stay the same for the whole session. A `notifications/tools/list_changed` SHALL be logged as an `info` record `mcp tools changed`, with the server's name, and SHALL NOT change the tools offered.

#### Scenario: A hyphenated name
- **WHEN** the server `context7` lists `resolve-library-id`
- **THEN** the tool is offered as `mcp__context7__resolve_library_id`, and a call to it reaches `resolve-library-id`

#### Scenario: A camelCase name
- **WHEN** a server lists `getUser`
- **THEN** its model-facing name ends in `get_user`

#### Scenario: A long name
- **WHEN** a mapped name would be 70 characters
- **THEN** it is offered as its first 55 characters, `_` and 8 hexadecimal digits, and the same in every run

#### Scenario: Two tools that would share a name
- **WHEN** one server lists `get_user` and `getUser`
- **THEN** both are offered under hashed names, and each call reaches the right tool

#### Scenario: A malformed tool
- **WHEN** a server lists a tool with no input schema beside a valid one
- **THEN** the valid tool is offered, and a `warn` record names the dropped one

#### Scenario: Filters
- **WHEN** a server lists `a`, `b` and `c`, and its `excludeTools` is `["b","z"]`, and then instead its `includeTools` is `["a","b"]`
- **THEN** first `a` and `c` are offered, with a `warn` record naming `z`, and then only `a` and `b` are offered

#### Scenario: A schema with a union at its root
- **WHEN** a tool's input schema has `anyOf` at its root, and then `includeTools` names that tool
- **THEN** the tool is first dropped with a `warn` record, and then the run fails before the first model call

#### Scenario: Schemas the validator can't take
- **WHEN** a server lists a valid tool, a tool whose schema declares draft-04, a tool with a property of `format` `made-up`, and a tool with the `pattern` `(`
- **THEN** the first three are offered, the fourth is dropped with a `warn` record naming it, and nothing but log records is written to stdout or stderr

#### Scenario: A patched schema
- **WHEN** a tool's input schema is an object with no `properties`
- **THEN** the model is sent it with `properties: {}`, and the server's own schema object is unchanged

#### Scenario: Arguments checked before the call
- **WHEN** the model calls an MCP tool with arguments its schema refuses
- **THEN** the server isn't called, and the model gets the validation error as the tool's outcome

#### Scenario: Pages
- **WHEN** a server's list comes in 3 pages, and then another server repeats a cursor
- **THEN** the first server's tools from every page are offered, and listing the second stops at the repeated cursor, keeping what it had

#### Scenario: A changed list
- **WHEN** a server sends `notifications/tools/list_changed` during the session
- **THEN** an `mcp tools changed` record is logged, and every later model request offers the same tools as the first

### Requirement: Return a tool's result to the model as capped text
- **Calls.** A call SHALL be sent as a `tools/call` request whose result is checked block by block, so that one malformed block doesn't lose the rest.
- **Timeouts.** A call SHALL be sent with a `timeout` of the entry's `toolTimeoutMs`, which progress notifications SHALL NOT reset, so that the SDK's own 60-second default never applies. A call SHALL also be cancelled when the servers start closing.
- **The outcome** SHALL be one text, the blocks joined with line feeds:
  - text blocks as they are;
  - a resource link as `[resource link: <name> <uri> (<mimeType>)]`, without ` (<mimeType>)` when it has none;
  - a text resource as `[resource <uri>]`, a line feed and its text;
  - a blob resource, an image or audio as `[<type> <mimeType>, <n> base64 characters, not shown]`;
  - a block of another type, or a malformed one, as `[<type> block, not shown]`;
  - structured content as its JSON, only when no text block came;
  - `(no output)` when nothing else came.
- **The cap.** An outcome over 32 KiB, once redacted, SHALL be cut at a character boundary below it, with a note giving its full size.
- **Errors.** A result with `isError: true` SHALL be a failed outcome with its text. A JSON-RPC error, a timeout or a closed connection SHALL be a failed outcome naming the server and the tool.

#### Scenario: Text blocks
- **WHEN** a result holds the text blocks "a" and "b"
- **THEN** the outcome is "a\nb"

#### Scenario: A resource link and an image
- **WHEN** a result holds a resource link named `doc` to `file:///doc.md` with type `text/markdown`, and an image of type `image/png` whose data is 1,000 base64 characters
- **THEN** the outcome is `[resource link: doc file:///doc.md (text/markdown)]`, a line feed, and `[image image/png, 1000 base64 characters, not shown]`

#### Scenario: Structured content
- **WHEN** a result holds structured content and a text block, and then structured content alone
- **THEN** the first outcome is the text block's text, and the second is the structured content's JSON

#### Scenario: Nothing
- **WHEN** a result holds no content
- **THEN** the outcome is "(no output)"

#### Scenario: A block of an unknown type
- **WHEN** a result holds a text block and a block of type `video`
- **THEN** the outcome holds the text, and `[video block, not shown]`

#### Scenario: A large result
- **WHEN** a result's text is 100 KiB
- **THEN** the outcome holds at most 32 KiB of it, cut on a character boundary, with a note giving 102400 bytes as its full size

#### Scenario: A tool error
- **WHEN** a result has `isError: true` and the text "not found"
- **THEN** the outcome is a failure whose error is "not found"

#### Scenario: A slow call
- **WHEN** the entry's `toolTimeoutMs` is 90000, and a call answers after 61 seconds
- **THEN** the outcome is its result

#### Scenario: A call that takes too long
- **WHEN** a call is still running when its server's `toolTimeoutMs` has passed
- **THEN** the call is cancelled, and its outcome is a failure naming the server, the tool and the timeout

#### Scenario: A server that died
- **WHEN** a stdio server exits during the session, and the model then calls one of its tools
- **THEN** the outcome is a failure naming the server and the tool

### Requirement: Log each server, and never its secrets
Once every server has listed its tools, and before `asking`, the agent SHALL log each server's records, server by server in name order: its `warn` records, and then an `info` record `mcp server` with:
- `name`;
- `transport`;
- `tools`, the model-facing names offered;
- `bytes`, the size in UTF-8 bytes of their definitions as sent;
- `catalog`, the SHA-256 of the server's tool list as it came, in hexadecimal.

No record SHALL hold a resolved reference, a header value or a token. Nothing other than the agent's logger SHALL write to stdout or stderr.

#### Scenario: The record
- **WHEN** a server offers two tools
- **THEN** its `mcp server` record comes before `asking`, with the server's name and transport, both model-facing names, a positive `bytes`, and a `catalog` of 64 hexadecimal digits

#### Scenario: Name order
- **WHEN** the servers `b` and `a` are enabled, and `b` lists its tools first
- **THEN** the `mcp server` record for `a` comes before the one for `b`

#### Scenario: The same catalog
- **WHEN** two runs list the same tools from a server
- **THEN** both records have the same `catalog`

#### Scenario: No secret in the logs
- **WHEN** a header and the URL's query each reference a variable set to `t0k`, and the run answers, and in another run nothing listens at the URL
- **THEN** `t0k` appears in no record, in pretty or in JSON output

#### Scenario: Nothing else on stdout
- **WHEN** a run connects to a server that announces no tools
- **THEN** stdout and stderr hold only the agent's log records

