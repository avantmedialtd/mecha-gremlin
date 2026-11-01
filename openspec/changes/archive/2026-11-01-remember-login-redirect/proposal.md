## Why

The first real login, on 2026-11-01, was to a server whose authorization server offers no dynamic client registration and matches redirect URIs exactly, port included. The login refused it, as it should, but its error named neither the authorization server to register a client with nor the redirect URI to register: only `--client-id`, "with `--client-secret` and `--redirect-uri` if it has them".

Logging in with such a client has a second gap. A client given with `--client-id` is saved without the redirect URI it was used with, although the README says that a later login uses the saved client "and its redirect URI". So `bun run mcp login <name>` with no options, the command a spent login's error asks for, would send the saved client with a port the system picks. Such an authorization server refuses that in the browser, and the login waits 5 minutes for a redirect that can't come.

## What Changes

- **The refusal says what to do.** When the authorization server offers no dynamic registration and no client is given or saved, the error names the authorization server's issuer, says to register a client with it whose redirect URI is `http://127.0.0.1:<port>/callback`, and gives the command: `bun run mcp login <name> --client-id <id> --redirect-uri http://127.0.0.1:<port>/callback`, with `--client-secret` for a client that has a secret.
- **A configured client keeps its redirect URI.** A client given with `--client-id` is saved with the redirect URI the login used. A later login that uses it again, with no `--client-id` or the same one, and no `--redirect-uri`, sends that redirect URI and listens on its port.
- **A port that can't give way doesn't.** When the saved redirect URI's port is taken, the login gives way to a port the system picks only when the authorization server offers dynamic registration, which registers a client for the new port. Otherwise it fails, naming the port, as it does for `--redirect-uri`'s.
- **The help and the README** say that a client registered ahead of time needs the redirect URI it registered, and that later logins remember both.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-login`: changes three requirements:
  - "Register a client for the login": the refusal's content;
  - "Take the redirect at a loopback listener or pasted": the saved redirect URI's port, and when it gives way;
  - "Save what later runs need": a configured client's redirect URI.

## Impact

- **`packages/agent`:**
  - `src/mcp/login.ts`: the refusal, the saved client and the port rule;
  - `src/mcp/redirect.ts`, if the port rule is simpler there;
  - `src/main/mcp-help.ts`;
  - their tests.
- **The repository root:** the README's "Logging in" section, and the Brief's log.
- **Not in scope:**
  - a fixed default port for configured clients;
  - Client ID Metadata Documents, which the authorization server in question doesn't accept either;
  - registering a client through an authorization server's own admin API.
