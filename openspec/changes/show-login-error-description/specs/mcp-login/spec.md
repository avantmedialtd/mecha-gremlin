## MODIFIED Requirements

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
  - a redirect with an `error` parameter SHALL fail it, naming the error, and its `error_description` when it has one. Either SHALL be printed only when it holds nothing but the characters RFC 6749 allows it, so that no control sequence reaches the terminal: an error code in other characters SHALL be named as one, and a description in other characters, or an empty one, SHALL be left out;
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

#### Scenario: A refusal with a description
- **WHEN** the redirect holds `error=access_denied` and `error_description=The user has not been granted access to the requested resource`
- **THEN** the login fails, with an error naming `access_denied` and that description

#### Scenario: A description in other characters
- **WHEN** the redirect holds `error=access_denied` and an `error_description` with a control character in it
- **THEN** the login fails, with an error naming `access_denied`, and no part of the description

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
