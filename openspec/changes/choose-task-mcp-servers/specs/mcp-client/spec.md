## RENAMED Requirements

- FROM: `### Requirement: Connect every enabled server before the session`
- TO: `### Requirement: Connect the servers a task chooses before the session`

## MODIFIED Requirements

### Requirement: Connect the servers a task chooses before the session
Once the store is open, the run ID chosen and the signal handlers installed, and before the session, the agent SHALL read the servers from the store (`mcp-servers`) and choose those to start:
- **Without a list.** When the task's frontmatter has no `mcp` list (`agent`), every enabled server, going by each server's `disabled` flag alone. Every one SHALL be required.
- **With a list.** When it has one, the servers the list names and no others, so that an empty list chooses none. A name followed by `?` SHALL be optional, and any other required.
  - A name the store doesn't hold SHALL fail the run, with an error naming it and `bun run mcp list`.
  - A required server that is disabled SHALL fail the run, with an error naming it and `bun run mcp enable <name>`. An optional one SHALL be left out.

The agent SHALL NOT start a server it didn't choose, or a disabled one.
- **Checks before any network request.** For every chosen server, the agent SHALL:
  - check the entry again, as `add` does, logging only its errors;
  - resolve the entry's references from the environment, reading own properties, and trim each value;
  - check the resolved header values, and the resolved `url` by every URL rule of `mcp-servers`, without quoting either;
  - check that a resolved stdio `command` is either an absolute path or a name without a slash, and find a name in the absolute entries of the server's `PATH`;
  - check that a resolved `cwd` is an absolute path to an existing directory.

  An unset or blank variable, or any other problem with a required server, SHALL fail the run. The agent SHALL log an `error` record for each problem of every required server, before any network request and before any server starts. A problem with an optional server SHALL leave it out instead.
- **Connecting.** It SHALL connect to every chosen server in parallel, each within its own `startupTimeoutMs`, which SHALL cover the start, the handshake and the whole tool list.
  - A client SHALL use the 2025-11-25 handshake, announce no capabilities, and request a server's tools only when the server announces them.
  - The handshake and each `tools/list` request SHALL be sent with a `timeout` of what is left of `startupTimeoutMs`, so that the SDK's own 60-second default never applies.
- **Failing.** When a required server can't start, answer, or list a tool its `includeTools` names, the agent SHALL close every server and fail the run before the first model call. The error SHALL:
  - name the server and the reason;
  - give the last lines of the server's stderr, read once it has closed;
  - end by naming two ways to run without it: `bun run mcp disable <name>`, for every run, and a task `mcp` list that leaves it out, for one task.
- **Leaving out.** When an optional server is disabled, or can't be used for a reason that would fail the run for a required one, the agent SHALL close that server alone, if it started, and go on with the others. It SHALL keep the server's name and a reason: the problem, or the failure's reason without the stderr lines, or that it's disabled. The run SHALL log a `warn` record for it ("Log each server, and never its secrets"), and its starting instructions SHALL name it with that reason (`agent`).
- **Redacting.** A text SHALL be redacted before it's cut: each non-empty value that one of the server's references resolved to SHALL be replaced by `[redacted]`, longest first. This SHALL apply to every text that comes from a server, or from an error in reaching it, and goes into a record, a tool's outcome or the starting instructions. That covers:
  - the failure's reason and the stderr lines;
  - a left-out server's reason;
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
- **THEN** the run fails before the first model call, with an error that names the server, its exit and "bad config", and ends with `bun run mcp disable` and the server's name, and with a task `mcp` list that leaves it out

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

#### Scenario: A task's list
- **WHEN** the servers `docs`, `github` and `pw` are enabled, and the task's list is `[docs]`
- **THEN** only `docs` is started, and only its tools are offered

#### Scenario: An empty list
- **WHEN** servers are enabled, and the task's list is `[]`
- **THEN** no server is started, and the run offers the built-in tools only

#### Scenario: A name the store doesn't hold
- **WHEN** the task's list names `notes`, and no server has that name
- **THEN** the run fails before any network request, with an error naming `notes` and `bun run mcp list`

#### Scenario: A listed server that's disabled
- **WHEN** the task's list names `docs`, which is disabled
- **THEN** the run fails before any network request, with an error naming `docs` and `bun run mcp enable docs`

#### Scenario: An optional server that can't start
- **WHEN** the task's list is `[docs, github?]`, and the stdio server `github` exits with code 3 before answering
- **THEN** `github` is closed, `docs`'s tools are offered, and the run goes on to its answer and exits with code 0

#### Scenario: An optional server that's disabled
- **WHEN** the task's list is `[github?]`, and `github` is disabled
- **THEN** `github` isn't started, and it's left out with the reason that it's disabled

#### Scenario: An optional server with an unset reference
- **WHEN** the task's list is `[docs?]`, and `docs`'s entry references `DOCS_TOKEN`, which is unset
- **THEN** `docs` is left out, before any network request, with a reason naming `DOCS_TOKEN`, and the run goes on

#### Scenario: A secret in a left-out server's reason
- **WHEN** the optional server `docs`, whose header resolves to `t0k`, answers its first request with 500 and a body holding `t0k`
- **THEN** `t0k` appears in no record and not in the starting instructions, and `[redacted]` appears where it was

### Requirement: Log each server, and never its secrets
Once every chosen server has listed its tools or been left out, and before `asking`, the agent SHALL log each chosen server's records, server by server in name order. For a server that connected, these are its `warn` records, and then an `info` record `mcp server` with:
- `name`;
- `transport`;
- `tools`, the model-facing names offered;
- `bytes`, the size in UTF-8 bytes of their definitions as sent;
- `catalog`, the SHA-256 of the server's tool list as it came, in hexadecimal.

For an optional server left out, it is a `warn` record `mcp server left out` with `name` and `reason`.

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

#### Scenario: A server left out
- **WHEN** the task's list is `[a, b?, c]`, `a` and `c` connect, and `b` exits before answering
- **THEN** the records are an `mcp server` record for `a`, an `mcp server left out` record for `b` with its reason, and an `mcp server` record for `c`, in that order, before `asking`

### Requirement: Use a server's login in a run
For a Streamable HTTP server with a saved login (`mcp-login`), a run SHALL use the server's most recently saved row for its name and its URL as written.
- **The token.** Every request SHALL carry the row's access token as a bearer token, in place of any `Authorization` header in the entry.
- **A spent login.** A row marked `needs_login` SHALL fail the run before any network request, with an error naming the server and `bun run mcp login <name>`. For an optional server, it SHALL leave the server out instead, with that reason ("Connect the servers a task chooses before the session").
- **Refreshing.** The run SHALL refresh the token before the server's first request when it expires within 5 minutes, and once after a 401, after which it SHALL send the request once more. A refresh SHALL:
  - take the row's lease for 30 seconds, and send the refresh request outside any transaction, cancelling it after 25 seconds;
  - save the new tokens only while it still holds the lease, which saving them releases;
  - when another run holds the lease, check every 250 ms, for up to 35 seconds: use the tokens that run saved once they appear, and try for the lease again whenever it's free. After 35 seconds, the server's use SHALL fail, as a failed refresh does.
- **A refused refresh.** `invalid_grant` SHALL mark the row `needs_login`, and fail the server's use with an error naming `bun run mcp login <name>`. At the start, that fails the run, or leaves an optional server out; during the session, the call.
- **A failed refresh.** A timeout, a server error or a network failure SHALL keep the tokens, and fail only this run's use of the server.
- **No flow of its own.** In a run, the SDK SHALL NOT register a client, start an authorization or refresh a token itself.
- **Redaction.** The server's access token, refresh token and client secret SHALL be redacted wherever its resolved references are ("Connect the servers a task chooses before the session").

#### Scenario: The token sent
- **WHEN** `docs` has a login whose access token is `at1`
- **THEN** every request to `docs` carries `Authorization: Bearer at1`

#### Scenario: A token about to expire
- **WHEN** the access token expires in 2 minutes
- **THEN** the run refreshes it before its first request to `docs`, and sends the new one

#### Scenario: A 401 during the session
- **WHEN** `docs` answers a tool call with 401 once
- **THEN** the run refreshes the token and sends the call again with the new one, and the outcome is the call's result

#### Scenario: Two runs at once
- **WHEN** two runs start together, each finding the token about to expire, against an authorization server that revokes the grant when a refresh token is used twice
- **THEN** exactly one refresh request reaches it, both runs use the new token, and the grant isn't revoked

#### Scenario: A revoked grant
- **WHEN** the refresh is refused with `invalid_grant`
- **THEN** the row is marked `needs_login`, the run fails with an error naming `bun run mcp login docs`, and a later run fails before any network request

#### Scenario: An authorization server that doesn't answer
- **WHEN** the refresh request gets no answer
- **THEN** the run fails, naming `docs`, and the row keeps its tokens and isn't marked `needs_login`

#### Scenario: A token in an error
- **WHEN** `docs` answers with an error whose body holds its access token
- **THEN** the token appears in no record

#### Scenario: An optional server's spent login
- **WHEN** `docs`'s row is marked `needs_login`, and the task's list is `[docs?]`
- **THEN** `docs` is left out before any network request, with a reason naming `bun run mcp login docs`, and the run goes on
