## Context

The `tool-call-loop` change was merged on 2026-10-13. A `/code-review` of it found 10 problems, and the user chose to fix all of them. They are small and spread over both packages: the server's failure messages, its logger, `LOG_FORMAT`, the session's turn limit, `read_file`, and `core`'s `validateArgs`. The specs already require some of the fixes; others need the specs to say more.

The review's findings, as numbered in its report:
1. the turn-limit message names the default limit, not the session's;
2. most failed turns give no next step;
3. an LM Studio that stops mid-session isn't named;
4. a JSON log field can overwrite `time`, `level` or `message`;
5. `maxTurns` isn't checked;
6. `validateArgs` can reject;
7. `read_file`'s cut can walk back without limit;
8. the formatted log doesn't handle multi-line messages or `\r\n`;
9. `LOG_FORMAT` isn't trimmed like the other settings;
10. `logFormat` doesn't return a `Result`.

## Goals / Non-Goals

**Goals:**
- Make the code do what its specs say, and the specs say what the code does, for each finding.
- Keep the 100% mutation score: every new branch and message gets a test that would notice it changing.

**Non-Goals:**
- No new behaviour beyond the findings, such as retrying a rate-limited turn.
- No change to the `core` types `TurnError` and `Turn`.

## Decisions

### 1. A next step for every kind of failed turn (2, 3)

`failure.ts` maps each `TurnErrorKind` to a message that names the cause, includes the detail and gives a next step. An unreachable server and a rejected key depend on the provider, so `model.ts` answers both, as it already does for the key: `unreachable(config, detail)` uses LM Studio's message for `lmstudio`, the same one `fetchModels` gives at start-up.

- **The messages don't repeat the HTTP status.** The `openai` SDK's error message already starts with it, as in "429 slow down". Repeating it would need a fallback for a status that's missing, and no failure of that kind ever lacks one, so the fallback would be dead code.
- **Alternative: next steps in `core`.** Rejected: `core` knows nothing of `MODEL_BASE_URL` or `lms`, and the next steps are about this app's settings.

### 2. `LOG_FORMAT` is read by `config.ts` (9, 10)

`loadLogFormat(env)` lives in `config.ts`, beside `loadConfig`, and reads the variable with the same `read` that every other setting uses: trimmed, and blank counts as unset. It returns a `Result`, with the error message that `main.ts` used to build. `main.ts` still checks it before the configuration, because the logger has to exist to report anything else.

- **Alternative: `logFormat` stays in `log.ts` and trims for itself.** Rejected: that's a second copy of the rule for reading a setting.
- **Alternative: `loadConfig` reads it too.** Rejected: its errors are logged through a logger built from this setting, so the setting has to come first, on its own.

### 3. The turn limit (1, 5)

- **The message counts the turns.** The `turn_limit` step already carries the last turn, and that turn's number is the session's limit, so the step needs no new field.
- **The limit is checked first.** `createSession` checks `maxTurns` with `Number.isInteger` and `>= 1` before it chooses the model, so a bad limit costs no request.
- **Alternative: a branded positive-integer type.** Rejected: a caller would still have to make one at run time, and `createSession` already returns a `Result` for this.

### 4. Log fields can't take the record's names (4)

`Fields` is intersected with `{ readonly time?: never; readonly level?: never; readonly message?: never }`, so a field with one of those names and a value doesn't type-check.

- **The undefined case.** Without `exactOptionalPropertyTypes`, `time: undefined` still type-checks. So the logger drops undefined fields before it builds a record, which both formats did in effect already, and the record's own keys can't be overwritten.
- **Alternative: nest the fields under a key of their own.** Rejected: it changes the JSON format.
- **Alternative: rename a field that clashes.** Rejected: it does so silently.

### 5. `validateArgs` never rejects (6)

The call to `~standard.validate` gets its own `try`. Building the message's JSON Schema gets one too, since `~standard.jsonSchema.input` may throw for a target the library doesn't support: when it throws, the message ends without the schema. The session's catch-all still guards the handler, but `validateArgs`' spec no longer depends on it.

### 6. The cut steps back at most 3 bytes (7)

`characterBoundary` stops after 3 continuation bytes. A valid character has at most 3, so valid text cuts exactly as before. In invalid text, `TextDecoder` already replaces each broken byte with U+FFFD.

### 7. Line breaks in the formatted log (8)

Lines are split with `/\r?\n/`, for fields and messages alike. A message's first line stays on the record's line. Its other lines follow, indented by four spaces, as a field block's lines are, and before any field block.

## Risks / Trade-offs

- **[A next step can't fit every case]** A 429 can mean a burst of requests or an empty quota, and a 4xx other than a rejected key has many causes. → Every message includes the server's own detail, and its next step names the usual cause first.
- **[`loadLogFormat` changes the server's internal API]** `logFormat` leaves `log.ts`. → Only `main.ts` used it.
