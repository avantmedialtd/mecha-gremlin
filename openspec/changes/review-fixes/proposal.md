## Why

A code review of the merged `tool-call-loop` change found 10 places where the code breaks its own specs or misbehaves on an edge case. Three are visible today: most failed turns give no next step, an LM Studio that stops mid-session isn't named as the cause, and an invalid `LOG_FORMAT` is reported as `undefined` instead of a `Result`. The rest are latent: nothing the hello does triggers them yet, but the next caller of the session or the logger would.

## What Changes

- **Every failed turn says what to do next.** Each kind of turn failure gets a message that names the cause and a next step: a timeout, a rate limit, a rejected request, a server error, an incomplete or failed response, an aborted turn and an unexpected error. An unreachable LM Studio gets the same message mid-session as at start-up, suggesting `lms server start`.
- **`LOG_FORMAT` is read like every other setting.** Its value is trimmed, and a blank value means the default, `pretty`. Reading it returns a `Result`, as the `result` spec requires. That settles the open question of how strictly to read it: as leniently as the rest.
- **The turn-limit message names the session's own limit**, not the default of 8.
- **`createSession` refuses a turn limit that isn't a positive integer**, before any request. A limit of `NaN` used to run forever, and 0 still sent a turn.
- **Log fields can't take the record's own names.** The type rules out fields named `time`, `level` or `message`, and in JSON output an undefined field can no longer overwrite them.
- **`validateArgs` never rejects.** A schema library that throws, or whose JSON Schema can't be produced, gives an error for the model like any other bad call.
- **`read_file` cuts back at most 3 bytes** to a character boundary. A file of invalid UTF-8 can no longer shrink the output to nothing.
- **The formatted log handles every line break.** A message that spans several lines continues on indented lines, and `\r\n` splits lines like `\n`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `model-hello`: "Actionable failures" gives a next step for each kind of failed turn, and suggests starting LM Studio's server whenever LM Studio is unreachable.
- `structured-log`: field names can't reuse the record's own; multi-line messages and `\r\n` line breaks in the formatted output; `LOG_FORMAT` is trimmed, and blank means `pretty`.
- `agent-loop`: `createSession` refuses a turn limit that isn't a positive integer.
- `tool-calls`: `validateArgs` returns an error when the schema library throws, and leaves the JSON Schema out when it can't be produced.
- `read-file-tool`: the cut to a character boundary moves back at most 3 bytes.

## Impact

- **Server:**
  - `main/failure.ts` and `main/main.ts`: the messages and the `LOG_FORMAT` check;
  - `model/model.ts` and `model/lmstudio.ts`: one message for an unreachable LM Studio;
  - `config/config.ts`: reads `LOG_FORMAT`, which moves out of `log/log.ts`;
  - `log/log.ts`: the field type and the formatted output;
  - `session/session.ts`: the turn limit check;
  - `tools/read-file.ts`: the cut.
- **Core:** `tools.ts`' `validateArgs`.
- **Tests and docs:** a test for each fix, so mutation testing stays at 100%; the README's `LOG_FORMAT` row.
- **No new dependency.** The command line doesn't change. Inside the server, `logFormat` becomes `loadLogFormat` in `config.ts`.
