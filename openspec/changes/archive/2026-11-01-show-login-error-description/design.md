## Context

When the authorization server refuses an authorization request, it sends the browser to the redirect URI with `error`, and optionally `error_description` and `error_uri` (RFC 6749 §4.1.2.1).

The login (`add-mcp-login`) names `error`, after checking it against `ERROR_CODE`. That check holds `error` to the characters RFC 6749 allows it, `%x20-21 / %x23-5B / %x5D-7E`. A code in any other character is named only as "an error code in characters that OAuth allows in none". Anyone who can reach the listener, or get a line pasted on stdin, controls those parameters, and the check keeps escape sequences off the terminal.

RFC 6749 gives `error_description` the same character set. The login reads neither `error_description` nor `error_uri` today.

Errors from the token endpoint are a different path. There, the SDK's errors carry the authorization server's description already, as in `InvalidGrantError: …`.

## Goals / Non-Goals

**Goals:**
- A refusal at the redirect that says why, in the authorization server's words, when it gave a reason.
- No more of the terminal exposed to a redirect's parameters than now.

**Non-Goals:**
- `error_uri`, a link the user would have to trust and open.
- Rewording the descriptions, or mapping codes to advice of our own.
- The token endpoint's and refreshes' errors, which already carry their descriptions.

## Decisions

- **The description goes in parentheses, after the code.** For example:

  `…refused the login to docs: access_denied (The user has not been granted access to the requested resource).`

  This keeps the sentence's shape, and the code still comes first, for anyone matching on it.
- **One character check for both.** The description is printed only when it matches the same expression as the code, `ERROR_CODE`, which also refuses an empty string. A description in any other character is left out entirely: no part of it is printed, and nothing replaces it. The code is still named, so the refusal still says what happened.
- **Neither redacted nor shortened.** The description is the authorization server's text, like the SDK's error descriptions, which the login already prints whole.

## Risks / Trade-offs

- **A very long description** from an authorization server. It is printed whole. That costs screen space, not safety, since only printable characters pass. Accepted.
- **A misleading description** sent by anyone who can reach the listener. It sits beside a refusal that the login reports as one anyway, and holds nothing that a code in the same position couldn't. Accepted.
