## Context

`add-mcp-login` (archived 2026-10-31) takes a client, in this order:
- from `--client-id`;
- from the earlier login's saved row;
- from dynamic registration (D31).

It listens for the redirect on `--redirect-uri`'s port, else on the saved client's registered port while it's free, else on any free port (D38).

A client from `--client-id` is saved as `{ client_id, client_secret, issuer }`. The SDK's client information holds `redirect_uris` only when a registration returned them, so nothing records the redirect URI that a configured client was used with.

RFC 8252 §7.3 has authorization servers accept any port in a loopback redirect URI, but some match it exactly. The one the first real login met does. Against those, a configured client works only on the port it registered.

## Goals / Non-Goals

**Goals:**
- When no client can be registered, an error that says what to register, where, and which command to run after.
- `bun run mcp login <name>` with no options working again for a configured client. A spent login's error asks for that command.
- When the only port that can work is taken, a clear failure, not a 5-minute wait.

**Non-Goals:**
- Choosing a port for the user, or a default port for configured clients. D38 stands for registered clients, and the error says that any free port will do.
- Logging in to authorization servers that take neither registration nor a configured client.
- Detecting, from the terminal, a redirect URI that the authorization server refused. It shows its error in the browser and never redirects.

## Decisions

- **Save the redirect URI in the client's `redirect_uris`.** A configured client is saved as `{ client_id, client_secret, issuer, redirect_uris: [the one used] }`. A registered client already has that field, so the existing rules apply unchanged:
  - a later login listens on its port;
  - the saved client is used while its redirect URIs include the one in use.

  No column or marker is added. Rows saved before this change, which lack the field, behave as before.
- **The same `--client-id` counts as the saved client.** A login given the saved client's ID with `--client-id`, and no `--redirect-uri`, takes the saved redirect URI, as a login with no options does. It's the same client at the same issuer, so its registered redirect URI is the same. A different ID gets a port the system picks, as now.
- **Give way only where a registration can follow.** A taken saved port gives way to another only in two cases:
  - the authorization server's metadata lists a `registration_endpoint`;
  - there is no metadata, and the SDK then tries `/register`.

  The saved client's redirect URIs then don't include the new one, so a client is registered for it, as already happens for a registered client.

  When the metadata lists no registration endpoint, no client can work on another port, so the login fails with the listener's error, which names the port. The same condition decides the refusal, so the two can't disagree.
- **The refusal's wording.** The refusal names:
  - the issuer, as the metadata gives it;
  - the redirect URI to register, with a `<port>` placeholder;
  - the command, with `<id>` and `<port>` placeholders, and `--client-secret '${NAME}'` for a client with a secret.

  The issuer is remote text, like the SDK's error descriptions, which the login already prints.

## Risks / Trade-offs

- **A configured client whose redirect URI changes** at the authorization server, after it was saved. The saved redirect URI is then wrong, and the browser shows the authorization server's error. A login with `--client-id` and the new `--redirect-uri` fixes it, and the new one is saved in its place. `--redirect-uri` alone isn't enough: the saved client isn't used with a redirect URI it wasn't saved with, so the login goes on as with no saved client. An authorization server without registration then refuses it, and the error names both options.
- **A configured client whose port is taken, on an authorization server that offers registration.** The login registers a client of its own, and saves it in place of the configured one, as it does for a registered client today. Accepted: the login succeeds, and `--client-id` brings the configured client back.
