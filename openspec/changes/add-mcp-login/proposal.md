## Why

The first request for MCP servers, on 2026-10-29, asked for "a command that can initiate the OAuth dance and save the token that future runs will require", logging the URL the user must open. Persistence and the client are done. A Streamable HTTP server that needs a login still fails every run, with "needs a login, which isn't supported yet". On 2026-10-31 the user asked how to log in, and decided D31 (a configured client ID, else DCR), D32 (plain tokens in the 0600 database) and D38 (the redirect on any free port).

## What Changes

- **`bun run mcp login <name>`** logs in to a Streamable HTTP server with OAuth:
  - it discovers the server's authorization server, and registers a client: a configured `--client-id`, else the one saved earlier, else DCR;
  - it prints the URL to open, and takes the browser's redirect on 127.0.0.1 or the address pasted on stdin;
  - it checks `state`, exchanges the code with PKCE, saves the client, the discovery state and the tokens, and lists the server's tools with the new token to prove it works.

  Options: `--client-id`, `--client-secret` (a reference), `--redirect-uri` and `--scope`.
- **`bun run mcp logout <name>`** deletes a server's saved logins, as `remove` now does too. **`get`** shows a remote server's login.
- **Runs use the login.** A run sends the saved access token, refreshes it when it expires within 5 minutes or after a 401, and holds the credential's lease while it does, so concurrent runs can't spend a rotating refresh token twice.
  - A refused refresh marks the login spent, and the error names `bun run mcp login <name>`; so does a 401 from a server with no login.
  - A failed refresh keeps the tokens.
- **Never in output:** codes, tokens, verifiers and client secrets. Runs redact a server's tokens like its resolved references.
- **The help text and the README** cover logging in.
- **The Brief** records D31, D32 and D38 as decided, and D35 as settled by the order the work took.

## Capabilities

### New Capabilities

- `mcp-login`: logging in to a Streamable HTTP server with OAuth and logging out: registration, the redirect and the paste, the checks, and what is saved.

### Modified Capabilities

- `mcp-servers`: "Manage MCP servers from the command line" gains `login` and `logout`, `remove` deletes a server's logins, `get` shows them, and `login` is the subcommand that makes network requests.
- `mcp-client`: "Reach Streamable HTTP servers with their headers" sends a saved login, and names `bun run mcp login` for a 401. A new requirement covers using a login in a run: the token, refreshing it under the lease, and redacting it.

## Impact

- **`packages/agent`:**
  - a login module in `mcp/`: the provider over the credential rows, the listener and the paste, and the flow;
  - the run's `AuthProvider` and refresh, in the HTTP connection;
  - `main/mcp.ts`, its arguments, output and help;
  - tests with a fake authorization server that rotates refresh tokens.
- **`packages/store`:** none expected. Its credential functions are used as they are.
- **The repository root:** the README, the Brief and `cspell.json`.
- **Not in scope:** CIMD; encrypted tokens; logging in from inside a container; OAuth for stdio servers.
