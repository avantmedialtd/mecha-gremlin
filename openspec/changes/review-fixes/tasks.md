## 1. Failure messages (`model-hello`)

- [x] 1.1 `model/lmstudio.ts`: `lmStudioUnreachable(baseUrl, why)`, the message `fetchModels` gives when LM Studio can't be reached, which `fetchModels` now uses
- [x] 1.2 `model/model.ts`: `unreachable(config, detail)`, which is LM Studio's message with `lmstudio` and "Can't reach … Check MODEL_BASE_URL." otherwise
- [x] 1.3 `main/failure.ts`:
  - a message for each `TurnErrorKind`, naming the cause, with the detail and the next step from the spec's table;
  - the turn-limit message counts the `turn_limit` step's turn number instead of `MAX_TURNS`.
- [x] 1.4 Tests:
  - `failure()` on its own, in a new `test/main/failure.test.ts`: each kind's exact message with both providers where they differ, and a turn limit other than 8;
  - `main.test.ts`: a 429 from the Responses endpoint, LM Studio refusing the first turn after listing a loaded model, and another provider that can't be reached;
  - `unreachable` and `lmStudioUnreachable` on their own.

## 2. `LOG_FORMAT` (`structured-log`)

- [x] 2.1 `config/config.ts`: `loadLogFormat(env)`, which returns a `Result` and reads `LOG_FORMAT` with `read`, as every other setting is read; remove `logFormat` from `log/log.ts`
- [x] 2.2 `main/main.ts`: check the log format with `loadLogFormat`, still before the configuration
- [x] 2.3 Tests:
  - `loadLogFormat` in `config.test.ts`: unset, blank, padded, `pretty`, `json`, and other values with their exact message;
  - `main.test.ts`: " json " writes JSON records.
- [x] 2.4 README: settings are trimmed, and a blank one counts as unset

## 3. The logger (`structured-log`)

- [x] 3.1 `log/log.ts`: `Fields` rules out `time`, `level` and `message`; undefined fields are dropped before either format builds a record
- [x] 3.2 Formatted output: lines split at `/\r?\n/`; a multi-line message keeps its first line in place, and its other lines follow indented by four spaces, before any field block
- [x] 3.3 Tests:
  - `// @ts-expect-error` for each of the three names;
  - JSON output with `time: undefined`;
  - a multi-line message with a field;
  - `\r\n` in a field and in a message.

## 4. The session's turn limit (`agent-loop`)

- [x] 4.1 `session/session.ts`: `createSession` refuses a `maxTurns` that isn't a positive integer, naming it, before it chooses the model
- [x] 4.2 Tests: 0, -1, 2.5, `NaN` and `Infinity`, each without a request; a limit of 1 still runs one turn

## 5. `validateArgs` (`tool-calls`)

- [x] 5.1 `core/src/tools.ts`: catch a `~standard.validate` that throws or rejects; build the message's JSON Schema in its own `try`, and end the message without it when `~standard.jsonSchema.input` throws
- [x] 5.2 Tests with the Standard Schema fake: a validator that throws, one that rejects, one that throws something other than an `Error`, and a JSON Schema that throws

## 6. `read_file` (`read-file-tool`)

- [x] 6.1 `tools/read-file.ts`: `characterBoundary` moves back at most 3 bytes
- [x] 6.2 Tests: the four-byte character and the invalid UTF-8 scenarios

## 7. Verification

- [x] 7.1 `bun run check` passes
- [x] 7.2 `bun run mutation` scores 100%
- [x] 7.3 `openspec validate review-fixes --strict` passes
- [x] 7.4 The hello still answers against LM Studio (`bun run hello`), when LM Studio is running
