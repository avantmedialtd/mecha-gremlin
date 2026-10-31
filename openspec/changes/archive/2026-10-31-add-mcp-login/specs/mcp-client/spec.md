## ADDED Requirements

### Requirement: Use a server's login in a run
For a Streamable HTTP server with a saved login (`mcp-login`), a run SHALL use the server's most recently saved row for its name and its URL as written.
- **The token.** Every request SHALL carry the row's access token as a bearer token, in place of any `Authorization` header in the entry.
- **A spent login.** A row marked `needs_login` SHALL fail the run before any network request, with an error naming the server and `bun run mcp login <name>`.
- **Refreshing.** The run SHALL refresh the token before the server's first request when it expires within 5 minutes, and once after a 401, after which it SHALL send the request once more. A refresh SHALL:
  - take the row's lease for 30 seconds, and send the refresh request outside any transaction, cancelling it after 25 seconds;
  - save the new tokens only while it still holds the lease, which saving them releases;
  - when another run holds the lease, check every 250 ms, for up to 35 seconds: use the tokens that run saved once they appear, and try for the lease again whenever it's free. After 35 seconds, the server's use SHALL fail, as a failed refresh does.
- **A refused refresh.** `invalid_grant` SHALL mark the row `needs_login`, and fail the server's use with an error naming `bun run mcp login <name>`. At the start, that fails the run; during the session, the call.
- **A failed refresh.** A timeout, a server error or a network failure SHALL keep the tokens, and fail only this run's use of the server.
- **No flow of its own.** In a run, the SDK SHALL NOT register a client, start an authorization or refresh a token itself.
- **Redaction.** The server's access token, refresh token and client secret SHALL be redacted wherever its resolved references are ("Connect every enabled server before the session").

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

## MODIFIED Requirements

### Requirement: Reach Streamable HTTP servers with their headers
A Streamable HTTP server SHALL be reached at its resolved `url`, with its resolved headers on every request, and with its saved login's access token when it has one ("Use a server's login in a run"). A server without a login that answers with 401 SHALL be reported as needing one, with the command that gives it: `bun run mcp login <name>`.

#### Scenario: A header from the environment
- **WHEN** an entry's header is `Authorization: Bearer ${DOCS_TOKEN}` and `DOCS_TOKEN` is `t0k`
- **THEN** every request to the server carries `Authorization: Bearer t0k`

#### Scenario: A resolved URL that breaks a rule
- **WHEN** the `url` is `https://docs.example.com/mcp?key=${DOCS_KEY}`, and `DOCS_KEY` is `a#b`
- **THEN** the run fails before any network request, with an error naming the server and saying its URL has a fragment, and `a#b` appears in no record

#### Scenario: A server that wants a login
- **WHEN** a server without a saved login answers its first request with 401
- **THEN** the run fails before the first model call, with an error naming the server, saying it needs a login, and naming `bun run mcp login` with the server's name
