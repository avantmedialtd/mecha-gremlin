## 1. The login

- [x] 1.1 In `packages/agent/src/mcp/login.ts`, save a client given with `--client-id` with `redirect_uris` holding the one redirect URI the login used.
- [x] 1.2 Take the saved client's redirect URI when no `--client-id` is given, or when it gives the saved client's ID. Keep to its port, and fail naming the port when it's taken, when the authorization server's metadata lists no `registration_endpoint`; let a taken port give way to one the system picks otherwise. Change `listenForRedirect`'s options in `src/mcp/redirect.ts` if that's the simpler way.
- [x] 1.3 Reword the refusal for an authorization server without registration: its issuer, the redirect URI to register, and the command with `--client-id` and `--redirect-uri`, with `--client-secret '${NAME}'` for a client with a secret.

## 2. Tests

- [x] 2.1 Give the fake authorization server in `test/mcp/auth-server.ts` a way to hold a client registered beforehand to exact redirect URIs, port included, refusing any other redirect URI at its authorization endpoint.
- [x] 2.2 In `test/mcp/login.test.ts`, test the new and changed scenarios of the `mcp-login` delta:
  - the refusal's wording;
  - a configured client logged in again;
  - the same client given again;
  - a configured client's port taken;
  - a configured client's redirect URI in the row.

  Keep the existing tests of a registered client's port passing.

## 3. Documentation and checks

- [x] 3.1 Update the help text's login options, and the README's "A client of your own" and "Logging in again". Say that:
  - a client registered ahead of time needs the redirect URI it registered;
  - later logins remember both;
  - with an authorization server that can't register clients, a taken port fails the login.
- [x] 3.2 Add a line for 2026-11-01 to the Brief's log, by category only.
- [x] 3.3 Run `bun run check`, a scoped `bun run mutation` over `src/mcp/login.ts`, `src/mcp/redirect.ts` and `src/main/mcp-help.ts` (100%), and `openspec validate remember-login-redirect --strict`, and fix what fails.
