## Context

MCP servers are rows in the store (`add-mcp-servers`), added with `bun run mcp` and its flags (`simplify-mcp-command`). A Streamable HTTP server that answers 401 fails the run, "needs a login, which isn't supported yet". Persistence (`add-persistence`) already holds the `credential` table built for this: one row per server, URL and issuer, holding the SDK's client information, tokens and discovery state, `expires_at`, `needs_login`, and a refresh lease, with `findCredentials`, `saveCredential`, `deleteCredentials`, `takeRefreshLease`, `saveRefreshedTokens`, `releaseRefreshLease` and `markNeedsLogin`.

Brief C17 drafts the login, from R17.2 (refresh races), R17.3 (the SDK's OAuth support), R17.4 (27 authorization servers probed) and R17.5 (how other clients log in). On 2026-10-31 the user decided:
- **D31:** a configured client ID, else dynamic client registration (DCR);
- **D32:** tokens in plain columns of the 0600 database;
- **D38:** the redirect on any free port.

D30 had already put the login under `bun run mcp`.

`@modelcontextprotocol/client` 2.4.0 offers two kinds of provider:
- **`OAuthClientProvider`,** for `auth()`, which does discovery, registration, PKCE, the code exchange and refresh;
- **the minimal `AuthProvider`:** `token()`, called before every request, and `onUnauthorized()`, which the transport awaits on a 401 before retrying the request once. A second 401 throws `SdkHttpError` (`ClientHttpAuthentication`), checked in its `.d.mts`.

It exports `refreshAuthorization`, `UnauthorizedError` and `OAuthError`. It has no listener, doesn't check `state`, and refreshes only after a 401 (R17.3).

## Goals / Non-Goals

**Goals:**
- One command, `bun run mcp login <name>`, which prints the URL to open, takes the browser's redirect or a pasted one, and saves what later runs need.
- Runs that use the saved token, refresh it before it expires, and never lose a rotating refresh token to a race between runs.
- An error that names the command whenever a login is missing or spent.

**Non-Goals:**
- Client ID metadata documents (CIMD), until one is published under the user's name (D31).
- Encrypting tokens at rest, until backups exist (D32).
- Logging in from inside a container; the paste covers SSH meanwhile.
- OAuth for stdio servers, which have none, and for SIWC (M5).

## Decisions

### 1. Two providers over the same rows (C17)

- **The login uses `auth()`** with an `OAuthClientProvider` over the credential rows. The provider:
  - saves the discovery state, the client information and the tokens, each with the issuer stamp the SDK gives it, round-tripped as R17.3 requires;
  - keeps the code verifier and `state` in memory, for the one login.
- **A run uses the minimal `AuthProvider`:**
  - `token()` returns the saved access token;
  - `onUnauthorized()` refreshes under the lease (section 5), or throws the "log in again" error.

  So in a run the SDK never registers a client, never starts an authorization, and never refreshes on its own. That matters because it treats a transient refresh failure as a reason to re-authorise (R17.3), and its own refresh can't hold the lease that R17.2 found necessary.

### 2. The command

```
bun run mcp login <name> [--client-id <id>] [--client-secret '${NAME}'] [--redirect-uri <uri>] [--scope <scopes>]
bun run mcp logout <name>
```

- `login` takes a Streamable HTTP server; a stdio server is refused, as having no OAuth login.
- It resolves the server's references as a run does (`mcp-client`), since its URL and headers may hold some.
- It is the one subcommand that makes network requests.
- `--client-secret` takes a reference, as every secret on the command line does. The login resolves it and keeps the value with the client information, like the tokens (D32).
- `logout` deletes the server's saved logins, and so does `remove`. Before, the add-mcp-servers design left that to this change.
- `get` shows a remote server's login: `yes`, `no`, or `needs a new login`.

### 3. Registration (D31)

The client comes from the first of these that applies:
1. `--client-id`, with `--client-secret` and `--redirect-uri` when the registration needs them;
2. the client an earlier login saved for the same issuer;
3. DCR, with `client_name` `mecha-gremlin`, `application_type` `native`, `token_endpoint_auth_method` `none`, `grant_types` `authorization_code` and `refresh_token`, and the one loopback redirect URI. Any secret the server returns is kept.

An authorization server that offers no DCR, when no client ID is given, gets an error that names `--client-id`. GitHub's is one: its remote server takes a personal access token through `--header` meanwhile. CIMD waits for a published document, as D31 says.

### 4. The redirect (D38)

- **The listener** is bound to 127.0.0.1 alone (a `listen()` without a host takes every interface, R17.5) and serves one path, `/callback`. The redirect URI is `http://127.0.0.1:<port>/callback`.
- **The port:**
  1. a `--redirect-uri`'s port, whose host must be `127.0.0.1` or `localhost`;
  2. else the port of the redirect URI a saved client registered, when it is free;
  3. else a free port the system picks.

  When a client registered through DCR finds its port taken, the login registers it again with the new one. A server that matches redirect URIs exactly, as some do (R17.5), therefore sees the URI it registered.
- **The paste.** While it listens, the login reads stdin. A line holding the address the browser ended on counts as the redirect, which is what works over SSH, as Codex, Claude Code and pi allow (R17.5).
- **Checks:** `state` must match, or the login fails closed. An `error` parameter fails it with the server's error. The callback's parameters go to the SDK, which checks `iss`.
- **Time:** the login waits up to 5 minutes.
- **The browser** gets a short page saying it can close the tab, and then the listener closes.

### 5. Refreshing in a run, under the lease (R17.2)

- **When:**
  - before a server's first request, when its token expires within 5 minutes, as 4.4 planned for SIWC;
  - once after a 401, through `onUnauthorized()`. The transport then retries the request once.
- **How:**
  ```
  takeRefreshLease(id, seen, owner, 30 s)
    taken     → refreshAuthorization(issuer, saved metadata, client, refresh token, resource),
                aborted after 25 s → saveRefreshedTokens(under the lease) → releaseRefreshLease
    not taken → poll the row every 250 ms until the lease is gone or 35 s pass:
                a new refresh token means another run refreshed, so use its tokens;
                otherwise try for the lease again
  ```
- **`invalid_grant`** marks the row `needs_login`, and the server's use fails with an error naming `bun run mcp login <name>`. At the start that fails the run (D33); mid-session, the call.
- **A timeout, a 5xx or a network failure** keeps the tokens and fails only this run's use of the server.
- **Which row:** the server's most recently updated row for its name and its URL as written, since an authorization server can change its issuer.
- **A server whose row needs a login** fails the run before any network request, with the same error.

### 6. Storage (D32)

The rows are those that add-persistence made, in plain columns of the 0600 `db.sqlite`, behind the file tools' fence.
- **The URL** in a row is the server's URL as written, references unresolved, so that no resolved secret is kept in it.
- **`expires_at`** is the time of saving plus `expires_in`, or null without one.
- **`needs_login`** is cleared by every login.

### 7. Never in output

A code, a token, a code verifier or a client secret appears in no output of the command and no record of a run.
- A run redacts a server's access token, refresh token and client secret wherever it redacts its resolved references (`mcp-client`).
- The command shows the authorization URL, which holds the PKCE challenge, never the verifier, and `state`, which is single-use and checked.

### 8. Output

`login` prints plain text, like the rest of the command:
1. the URL, with what to do: open it, sign in, and paste the address the browser ends on if this machine can't be reached from it;
2. `Logged in to <name>: <n> tools.`, after a fresh connection with the new token has listed the server's tools. The listing proves the token works.

## Risks / Trade-offs

- [A server that matches redirect URIs exactly, with a client registered on another port] → the registered port is tried first, and a DCR client is registered again when it is taken; a configured client gives its own `--redirect-uri`.
- [`localhost` resolving to `::1` in the browser, with the listener on 127.0.0.1] → the paste still works; `127.0.0.1` is the default redirect URI.
- [`offline_access` with `prompt=consent`: the SDK adds both when the server offers `offline_access` and the client asks for refresh tokens, and some Entra ID tenants refuse it (R17.3)] → the 2.4.1 opt-out, when published.
- [Plain refresh tokens at rest, where the 2026-07-28 specification asks for confidentiality] → the 0600 file and the fence now, encryption with backups (D32). The shell can read the database, as the README says.
- [A crash between the server's rotation and our save loses the grant (C17)] → `needs_login`, and a new login.
- [An authorization server without DCR] → `--client-id`, or a personal token through `--header`.
