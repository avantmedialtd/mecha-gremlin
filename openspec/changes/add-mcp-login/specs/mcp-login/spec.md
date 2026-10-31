## ADDED Requirements

### Requirement: Log in to a Streamable HTTP server with OAuth
`bun run mcp login <name>` SHALL log in to the Streamable HTTP server it names, with OAuth's authorization code flow and PKCE (S256):
1. It SHALL check the server's entry and resolve its references as a run does (`mcp-client`), failing as a run would.
2. It SHALL discover the server's protected-resource metadata and its authorization server's metadata. A server that offers neither SHALL be refused, with an error saying it offers no OAuth login.
3. It SHALL take or register a client ("Register a client for the login").
4. It SHALL print the authorization URL to stdout, with what to do: open it in a browser and sign in, and paste the address the browser ends on if the browser can't reach this machine.
5. It SHALL take the redirect ("Take the redirect at a loopback listener or pasted"), and exchange its code for tokens, with the code verifier and the `resource` the SDK sends.
6. It SHALL save the login ("Save what later runs need"). It SHALL then connect to the server with the new token, list its tools, and print `Logged in to <name>: <n> tools.`

- **Options:** `--client-id <id>`, `--client-secret <reference>`, `--redirect-uri <uri>` and `--scope <scopes>`, each as `--option value` or `--option=value`. `--scope` replaces the scope the SDK would ask for.
- **Refused:** a stdio server, with an error saying that a local server has no OAuth login; and an unknown name, as the other subcommands refuse one.
- **Output:**
  - every problem SHALL be printed as an `error:` line, and the command SHALL exit with 1, or with 0 on success;
  - a code, a token, a code verifier or a client secret SHALL appear in no output.

#### Scenario: A login through the browser
- **WHEN** `login docs` runs against a server whose authorization server offers dynamic client registration, and the browser opens the printed URL and is redirected back
- **THEN** the command prints the URL, then `Logged in to docs: 2 tools.`, and exits with 0, and a later run reaches `docs` with the saved token

#### Scenario: No OAuth
- **WHEN** `login docs` runs against a server that offers no protected-resource metadata
- **THEN** it exits with 1, with an error saying `docs` offers no OAuth login

#### Scenario: A local server
- **WHEN** `login playwright` runs, and `playwright` is a stdio server
- **THEN** it's refused, with an error saying a local server has no OAuth login

#### Scenario: Nothing secret printed
- **WHEN** a login with a configured client secret succeeds
- **THEN** neither the code, the tokens, the code verifier nor the secret appears in stdout or stderr

#### Scenario: The scope given
- **WHEN** `login docs --scope 'read write'` runs
- **THEN** the authorization URL asks for the scope `read write`

### Requirement: Register a client for the login
The login's client SHALL be the first of these that applies:
1. the client `--client-id` names, with the secret that `--client-secret`'s reference resolves to, when one is given. `--client-secret` SHALL hold a reference, as every secret on the command line does (`mcp-servers`);
2. the client that an earlier login saved for the same server, URL and issuer;
3. a client registered through dynamic client registration. It is named `mecha-gremlin`, with `application_type` `native`, `token_endpoint_auth_method` `none`, `grant_types` `authorization_code` and `refresh_token`, and the login's one redirect URI. A secret the server returns SHALL be kept.

An authorization server that offers no dynamic registration, when no client is given or saved, SHALL be refused, with an error naming `--client-id`.

#### Scenario: Dynamic registration
- **WHEN** the first login to `docs` runs with no `--client-id`
- **THEN** the authorization server receives one registration, with those fields, and the client is saved with the login

#### Scenario: A saved client
- **WHEN** `docs` is logged in a second time, and its registered port is free
- **THEN** no registration is sent, and the saved client is used

#### Scenario: A configured client
- **WHEN** `login docs --client-id abc --client-secret '${DOCS_SECRET}'` runs
- **THEN** no registration is sent, the authorization URL's `client_id` is `abc`, and the code exchange authenticates with the secret `DOCS_SECRET` holds

#### Scenario: A literal secret
- **WHEN** `--client-secret` is given a value that isn't a reference
- **THEN** it's refused, with an error saying to give it as a reference, in single quotes, and the value appears in no output

#### Scenario: No dynamic registration
- **WHEN** the authorization server offers no registration endpoint, and no client is given or saved
- **THEN** it's refused, with an error naming `--client-id`

### Requirement: Take the redirect at a loopback listener or pasted
- **The listener** SHALL be bound to 127.0.0.1 alone, and SHALL serve one path, `/callback`. The redirect URI SHALL be `http://127.0.0.1:<port>/callback`, unless `--redirect-uri` gives another, whose scheme SHALL be `http` and whose host SHALL be `127.0.0.1` or `localhost`.
- **The port** SHALL be:
  1. `--redirect-uri`'s;
  2. else the port of the redirect URI the saved client registered, when it's free;
  3. else a port the system picks.

  A client registered through dynamic registration whose port is taken SHALL be registered again with the new one.
- **The paste.** While it listens, the login SHALL read stdin. A line holding a URL with the redirect's parameters SHALL be taken as the redirect, as if the browser had reached the listener.
- **Checks:**
  - a redirect whose `state` doesn't match SHALL fail the login, with no code exchanged;
  - a redirect with an `error` parameter SHALL fail it, naming the error;
  - the redirect's parameters SHALL go to the SDK, which checks `iss`.
- **Time.** The login SHALL wait up to 5 minutes for the redirect, and then fail, saying so.
- **The browser** SHALL get a short page saying the tab can be closed. The listener SHALL close once it has the redirect, or the login has failed.

#### Scenario: The listener
- **WHEN** a login starts with no `--redirect-uri` and no saved client
- **THEN** it listens on 127.0.0.1 only, and the printed URL's `redirect_uri` is `http://127.0.0.1:<that port>/callback`

#### Scenario: A pasted redirect
- **WHEN** the browser's redirect never reaches the listener, and the address it ended on is pasted on stdin
- **THEN** the login completes as if the browser had reached the listener

#### Scenario: A wrong state
- **WHEN** the redirect's `state` differs from the one sent
- **THEN** the login fails, with an error saying the state doesn't match, and no token request is made

#### Scenario: A refusal
- **WHEN** the redirect holds `error=access_denied`
- **THEN** the login fails, with an error naming `access_denied`

#### Scenario: Too long
- **WHEN** no redirect comes within 5 minutes
- **THEN** the login fails, saying it waited 5 minutes, and the listener is closed

#### Scenario: The registered port
- **WHEN** a client registered through dynamic registration with port P logs in again while P is free, and once more while P is taken
- **THEN** the first login listens on P and sends no registration, and the second listens on another port, after registering again

### Requirement: Save what later runs need
The login SHALL save, in the store's `credential` table (`store`), one row for the server's name, its URL as written in its entry, and the issuer. The row SHALL hold:
- the client information, the discovery state and the tokens, as the SDK gives them, with their issuer stamps;
- `expires_at`: the time of saving plus the tokens' `expires_in`, or nothing when they have none;
- `needs_login`, cleared.

A later login with the same issuer SHALL replace the row.

#### Scenario: The row
- **WHEN** a login succeeds with tokens whose `expires_in` is 3600
- **THEN** the credential table holds one row for the server, its URL with its references unresolved, and the issuer, with the tokens and an `expires_at` an hour after the login

#### Scenario: A second login
- **WHEN** `docs` is logged in twice
- **THEN** one row remains, holding the second login's tokens, with `needs_login` cleared

### Requirement: Log out
`bun run mcp logout <name>` SHALL delete every saved login of the server, print `Logged out of <name>.`, or `<name> has no login.` when it has none, and exit with 0. `bun run mcp remove <name>` SHALL delete them too.

#### Scenario: Logging out
- **WHEN** `docs` is logged in, and `logout docs` runs
- **THEN** it prints `Logged out of docs.`, the server's rows are gone, and a later run fails at `docs` with an error naming `bun run mcp login docs`

#### Scenario: Removing
- **WHEN** a server that is logged in is removed
- **THEN** its rows are gone
