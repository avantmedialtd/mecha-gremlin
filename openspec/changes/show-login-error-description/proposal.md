## Why

On 2026-11-01, a login that `remember-login-redirect` had unblocked was refused at the redirect with `error=access_denied`. The login printed just that: `The authorization server refused the login to <name>: access_denied.`

The authorization server had sent more. Its `error_description` said that the signed-in user had not been granted access to the requested resource. That description named the cause and pointed to the fix, but the login dropped it, and finding the cause took reading the authorization server's code.

## What Changes

- **A refusal names its description.** When the redirect holds an `error`, the login's error gives the code, then the authorization server's `error_description` in parentheses, when it has one. For example:

  `The authorization server refused the login to docs: access_denied (The user has not been granted access to the requested resource).`
- **Only what OAuth allows reaches the terminal.** RFC 6749 restricts both `error` and `error_description` to the same printable ASCII characters. The login already checks the code against them. It now checks the description too, and leaves out a description that holds anything else, or nothing at all.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-login`: "Take the redirect at a loopback listener or pasted". Its checks name the `error_description`, and there are two new scenarios.

## Impact

- **`packages/agent`:** `src/mcp/login.ts`, and `test/mcp/login.test.ts`.
- **The repository root:** the Brief's log.
- **Not in scope:**
  - `error_uri`;
  - errors from the token endpoint and from refreshes, whose descriptions the SDK's errors already carry.
