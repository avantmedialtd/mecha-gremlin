## 1. The login

- [ ] 1.1 Write the login's `OAuthClientProvider` in `agent/src/mcp/`, over the store's credential rows:
  - it saves the discovery state, the client information and the tokens with the issuer stamps the SDK gives;
  - it computes `expires_at` and clears `needs_login`;
  - it keeps the code verifier and `state` in memory;
  - its client metadata is the design's, section 3.
- [ ] 1.2 Write the redirect's listener and the paste:
  - 127.0.0.1 only, `/callback`;
  - the port from `--redirect-uri`, else the saved client's when it is free, else one the system picks, registering a DCR client again when its port is taken;
  - stdin read for a pasted address;
  - `state` checked fail-closed, an `error` parameter reported;
  - 5 minutes at most, and the page for the browser;
  - the listener closed on every path.
- [ ] 1.3 Write the flow:
  - check the entry and resolve its references as a run does;
  - discover the server's metadata, refusing a server without any;
  - take or register the client, refusing an authorization server without DCR when none is given (naming `--client-id`);
  - print the URL and what to do, take the redirect, and exchange the code with the callback's parameters for the SDK to check `iss`;
  - save, then connect with the new token, list the tools, and print `Logged in to <name>: <n> tools.`

  No code, token, verifier or secret is printed.

## 2. Runs

- [ ] 2.1 Give the HTTP connection a minimal `AuthProvider` when the server has a login: `token()` from the most recent row for the server's name and URL as written, and `onUnauthorized()` refreshing once.
- [ ] 2.2 Write the refresh under the lease:
  - `takeRefreshLease` for 30 s;
  - `refreshAuthorization` with the saved metadata, client and `resource`, cancelled after 25 s;
  - `saveRefreshedTokens`, then `releaseRefreshLease`;
  - while another run holds the lease, checking every 250 ms for up to 35 s, then the tokens it saved, or another try.

  Before the first request, refresh when the token expires within 5 minutes. `invalid_grant` calls `markNeedsLogin`; other failures keep the tokens.
- [ ] 2.3 Fail a run before any network request when a server's row needs a login, and give a 401 without a login an error naming `bun run mcp login <name>`. Add the server's access token, refresh token and client secret to the values its texts are redacted of.

## 3. The command

- [ ] 3.1 Add `login <name>` with `--client-id`, `--client-secret` (a reference), `--redirect-uri` and `--scope`, and `logout <name>`, to the arguments and to `main/mcp.ts`. `remove` deletes the server's logins too.
- [ ] 3.2 Show a remote server's login in `get`: `yes`, `no` or `needs a new login`. Add `login` and `logout`, with `login`'s options, to the help text, within 80 columns.

## 4. Tests

- [ ] 4.1 Write a fake authorization server, in-process over HTTP on 127.0.0.1, for the tests. It has:
  - protected-resource and authorization-server metadata;
  - DCR, which can be turned off;
  - an authorization endpoint the test follows as the browser would;
  - a token endpoint that rotates refresh tokens and revokes the grant when one is used twice;
  - answers that can be refused, slowed or failed.

  `fakeFetch` passes its origin to the real `fetch`.
- [ ] 4.2 Test every scenario of the `mcp-login` spec and of the `mcp-servers` and `mcp-client` deltas, on both runtimes. Run the two runs at once as two stores on one database, and the 5 minutes with fake timers.

## 5. Documentation and checks

- [ ] 5.1 Add to the README's "MCP servers" section a part on logging in:
  - `bun run mcp login <name>`, the URL it prints, and pasting the address over SSH;
  - `--client-id` for an authorization server without DCR, with `--client-secret` as a reference and `--redirect-uri`;
  - `logout`;
  - that tokens are kept in `db.sqlite`, 0600, unencrypted, where the shell can read them;
  - that runs refresh them, and what "needs a new login" means.

  Replace the line that says OAuth isn't supported.
- [ ] 5.2 Update the Brief: the log, and C17's command name, now `bun run mcp login`.
- [ ] 5.3 Add new words to `cspell.json`, then run:
  - `bun run check`;
  - a scoped `bun run mutation` over every source file this change touches, at 100%, with every timeout looked at;
  - `openspec validate add-mcp-login --strict`.

  Fix what fails.
