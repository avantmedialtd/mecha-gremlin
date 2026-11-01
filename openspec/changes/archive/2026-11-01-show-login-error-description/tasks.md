## 1. The login

- [x] 1.1 In `packages/agent/src/mcp/login.ts`, name the redirect's `error_description` in parentheses after the error code, as in `…: access_denied (The user has not been granted access to the requested resource).` Name it only when it matches `ERROR_CODE`, which also refuses an empty string, and leave it out otherwise.

## 2. Tests

- [x] 2.1 In `test/mcp/login.test.ts`, test the delta's scenarios:
  - "A refusal": no description, so the message is unchanged;
  - "A refusal with a description";
  - "A description in other characters": assert that no part of it appears, nor any `\u001b`;
  - an empty `error_description`, which is left out.

  Keep the test of a code in other characters passing.

## 3. Documentation and checks

- [x] 3.1 Add a line to the Brief's log for this change, by category only.
- [x] 3.2 Run `bun run check`, a scoped `bun run mutation` over `src/mcp/login.ts` (100%), and `openspec validate show-login-error-description --strict`, and fix what fails.
