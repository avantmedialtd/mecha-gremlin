## MODIFIED Requirements

### Requirement: Register a client for the login
The login's client SHALL be the first of these that applies:
1. the client `--client-id` names, with the secret that `--client-secret`'s reference resolves to, when one is given. `--client-secret` SHALL hold references only, as every secret on the command line does (`mcp-servers`), and SHALL need `--client-id`;
2. the client that an earlier login saved for the same server, URL and issuer;
3. a client registered through dynamic client registration. It is named `mecha-gremlin`, with `application_type` `native`, `token_endpoint_auth_method` `none`, `grant_types` `authorization_code` and `refresh_token`, and the login's one redirect URI. A secret the server returns SHALL be kept.

An authorization server that offers no dynamic registration, when no client is given and none is saved that can be used again, SHALL be refused. The error SHALL name the authorization server's issuer, and say to register a client with it whose redirect URI is `http://127.0.0.1:<port>/callback`. It SHALL give the command that logs in with that client, `bun run mcp login <name> --client-id <id> --redirect-uri http://127.0.0.1:<port>/callback`, and say to add `--client-secret` for a client that has a secret.

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

#### Scenario: A secret without a client
- **WHEN** `login docs --client-secret '${DOCS_SECRET}'` runs with no `--client-id`
- **THEN** it's refused, with an error naming `--client-id`

#### Scenario: No dynamic registration
- **WHEN** the authorization server, whose issuer is `https://auth.example.com`, offers no registration endpoint, and no client is given or saved
- **THEN** it's refused, with an error naming `https://auth.example.com`, the redirect URI `http://127.0.0.1:<port>/callback`, and `bun run mcp login docs --client-id <id> --redirect-uri http://127.0.0.1:<port>/callback`

### Requirement: Take the redirect at a loopback listener or pasted
- **The listener** SHALL be bound to 127.0.0.1 alone, and SHALL serve one path, the redirect URI's. The redirect URI SHALL be `http://127.0.0.1:<port>/callback`, unless `--redirect-uri` gives another, whose scheme SHALL be `http`, whose host SHALL be `127.0.0.1` or `localhost`, and which SHALL name a port. A redirect URI saved with a client SHALL be sent exactly as saved.
- **The port** SHALL be:
  1. `--redirect-uri`'s;
  2. else the port of the redirect URI saved with the client, when the login uses the saved client again: when no `--client-id` is given, or the one given is the saved client's;
  3. else a port the system picks.

  `--redirect-uri`'s port SHALL be kept to, and so SHALL the saved redirect URI's when the authorization server offers no dynamic registration, since no client could be registered for another. A port kept to that is taken SHALL fail the login, naming the port. A saved port that is taken otherwise SHALL give way to one the system picks.
- **Using a saved client again.** A saved client SHALL be used again only while its saved redirect URIs include the one in use, or it has none saved. Otherwise the login SHALL go on as when no client is saved.
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

#### Scenario: A configured client logged in again
- **WHEN** `docs`, whose authorization server offers no dynamic registration, was logged in with `--client-id abc --redirect-uri http://127.0.0.1:8765/callback`, and `bun run mcp login docs` runs with no options
- **THEN** it listens on port 8765, and the authorization URL's `client_id` is `abc` and its `redirect_uri` is `http://127.0.0.1:8765/callback`

#### Scenario: The same client given again
- **WHEN** that login runs with `--client-id abc` and no `--redirect-uri`
- **THEN** it listens on port 8765, and the authorization URL's `redirect_uri` is `http://127.0.0.1:8765/callback`

#### Scenario: A configured client's port taken
- **WHEN** port 8765 is taken when `bun run mcp login docs` runs again
- **THEN** the login fails, naming `127.0.0.1:8765`, and prints no authorization URL

### Requirement: Save what later runs need
The login SHALL save, in the store's `credential` table (`store`), one row for the server's name, its URL as written in its entry, and the issuer. The row SHALL hold:
- the client information, the discovery state and the tokens, as the SDK gives them, with their issuer stamps. A client given with `--client-id` SHALL be saved with the redirect URI the login used, as its one redirect URI;
- `expires_at`: the time of saving plus the tokens' `expires_in`, or nothing when they have none;
- `needs_login`, cleared.

A later login with the same issuer SHALL replace the row.

#### Scenario: The row
- **WHEN** a login succeeds with tokens whose `expires_in` is 3600
- **THEN** the credential table holds one row for the server, its URL with its references unresolved, and the issuer, with the tokens and an `expires_at` an hour after the login

#### Scenario: A second login
- **WHEN** `docs` is logged in twice
- **THEN** one row remains, holding the second login's tokens, with `needs_login` cleared

#### Scenario: A configured client's redirect URI
- **WHEN** a login with `--client-id abc --redirect-uri http://127.0.0.1:8765/callback` succeeds
- **THEN** the row's client information holds the client ID `abc` and one redirect URI, `http://127.0.0.1:8765/callback`
