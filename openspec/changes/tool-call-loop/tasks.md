## 1. Core: tool calling (`tool-calls`)

- [x] 1.1 `packages/core/src/standard-schema.ts`: the Standard Schema v1 and Standard JSON Schema interfaces, declared as types only, following the published spec, with no package dependency
- [x] 1.2 `packages/core/src/tools.ts`:
  - the `Tool<Args>` and `ToolOutcome` types;
  - `toFunctionTool(tool)`: the `draft-07` input JSON Schema with `$schema` dropped, and `strict: true`.
- [x] 1.3 `classify(output)`: `calls`, in output order and winning over any text; `final`, the trimmed `output_text` and `refusal` parts of every message; `empty`
- [x] 1.4 `validateArgs(tool, raw)`:
  - empty or whitespace-only arguments mean `{}`; then `JSON.parse`, then the object check, then an awaited `~standard.validate`;
  - each issue is rendered `path: message`, with `(root)` for the root;
  - every error names the tool and ends with the expected JSON Schema.
- [x] 1.5 `packages/core/src/history.ts`:
  - `HistoryItem`;
  - `toOutputItem(callId, outcome)`, which prefixes failures with `Error: `;
  - `toInput(history)`, which wraps `toResponseInputItems` from `openai/lib/responses/ResponseInputItems` and returns `{ ok: false, detail }` instead of throwing.
- [x] 1.6 Export the new API and types from `packages/core/src/index.ts`
- [x] 1.7 Core tests, using a hand-written Standard Schema fake:
  - every `tool-calls` scenario, including the asynchronous validator and the "schema not asked" cases;
  - a test that `core`'s `package.json` names no dependency or peer dependency other than `openai`.

## 2. Server: the `read_file` tool (`read-file-tool`)

- [x] 2.1 Add `zod` 4 to `packages/server`'s dependencies, and check that `bun.lock` holds a single copy
- [x] 2.2 A helper that pairs a `Tool<Args>` with its handler `run(args) => Promise<ToolOutcome>`, validating with `validateArgs` before running, so arguments stay typed from the schema to the handler
- [x] 2.3 `packages/server/src/tools/read-file.ts`: `readFileTool(root)`:
  - **Schema:** a `z.strictObject({ path: z.string() })` with descriptions.
  - **Confinement:** the lexical check, then the real-path check.
  - **Refusals:** `.env*` names, checked on both the requested and the real name; directories; missing files; binary files (a NUL byte in the first 8 KiB).
  - **Cap:** 32 KiB, cut at a UTF-8 boundary, with the truncation note.
  - I/O through `node:fs/promises`; every failure is a failed outcome.
- [x] 2.4 `read_file` tests in real temporary directories, covering every `read-file-tool` scenario:
  - links pointing inside and outside the root, and a link to `.env`;
  - a 3-byte character straddling the cap;
  - extra arguments rejected;
  - `toFunctionTool` producing the closed schema from zod's real JSON Schema.

## 3. Server: the agent loop (`agent-loop`)

- [x] 3.1 `packages/server/src/loop/loop.ts`: `runLoop(client, { model, reasoning?, tools, history, maxTurns = 8, onEvent? })`:
  - tools converted once, and `toInput` on every turn;
  - `runTurn`, then the output appended, then `classify`;
  - calls run in order, each answered exactly once: unknown tool, invalid arguments, and a handler that throws;
  - "not run" outputs at the turn limit;
  - results as values, always with the history: `turn_failed` (with error kind, detail and status), `empty`, `turn_limit`, `history`.
- [x] 3.2 Progress through `onEvent`: turn completed (number, usage, seconds); call started (name, raw arguments); call finished (success and bytes, or the error)
- [x] 3.3 A test helper that builds completed SSE turns from `message`, `reasoning` and `function_call` items, and a fake `fetch` that serves them from a queue and captures request bodies
- [x] 3.4 Loop tests for every `agent-loop` scenario, asserting the second request's exact replayed `input` and the order of progress events

## 4. Server: the hello asks about a file (`model-hello`)

- [x] 4.1 `hello.ts`:
  - `run(io)` gains `args` and `cwd`;
  - parse `[file] [question…]`, with the defaults;
  - build the `developer` and `user` items;
  - run the loop with `readFileTool(cwd)` and the configured `reasoning.effort`;
  - print the trimmed answer to stdout;
  - remove `GREETING`.
- [x] 4.2 stderr:
  - the "asking" line, then each call with its arguments and its result, then a usage line per turn (input with cached, output with reasoning, seconds);
  - failure messages for `turn_failed`, keeping the provider-aware auth and unreachable messages, and for `turn_limit`, `empty` and `history`.
- [x] 4.3 `main.ts`: pass `process.argv.slice(2)` and `process.cwd()`
- [x] 4.4 Hello tests for every `model-hello` scenario:
  - default question; file and question; file only;
  - an answer after reading `package.json` from a temporary working directory;
  - progress on stderr;
  - turn fails; turn limit; no answer.

  Also update the existing provider, configuration and model-choice tests to the loop's request shape.

## 5. Docs and verification

- [x] 5.1 README:
  - what the hello does now;
  - `bun run hello [file] [question…]`, with examples;
  - what `read_file` will and won't read;
  - the layout table's package descriptions.
- [x] 5.2 `bun run check` passes: format, lint, type-check and tests
- [x] 5.3 `bun run mutation`: review the surviving mutants in the new code, and add tests where a survivor shows a real gap
- [x] 5.4 Against the local LM Studio:
  - `bun run hello` answers the default question with the `check` script's command, shows the `read_file` call and the per-turn usage on stderr, and exits 0;
  - `bun run hello README.md` and a custom question also work;
  - asking about `.env` gets a refusal back from the tool, not the file.

## 6. Globals instead of injected I/O

- [x] 6.1 `hello.ts` merges into `main.ts`, which reads the process's globals directly: the settings, the arguments, the working directory and `fetch`. It prints the answer with `console.log` and logs the rest with `console.error`. The `run(io)` injection and the `import.meta.main` guard are gone.
- [x] 6.2 `resolveModel` and `fetchModels` use the global `fetch`, and the loop times turns with `performance.now`
- [x] 6.3 Tests fake those globals and import `main.ts` afresh:
  - `vi.stubEnv` for every `MODEL_*` setting;
  - `vi.stubGlobal` for `fetch`;
  - `vi.spyOn` for `console`, `process.cwd` and `performance.now`.

  Vitest undoes every fake after each test, and Stryker mutates `main.ts` too.

## 7. The loop as an async generator

- [x] 7.1 `runLoop` yields one step per turn as it completes: `calls` (each call with its outcome), `answer` or `stop`. Each step carries its own copy of the history, and the turn's stats when the model completed it. The `onEvent` callback and the single result type are gone.
- [x] 7.2 `main.ts` prints each step as it arrives, through a `for await`. The byte count of an output moves to `main.ts`, with a test on a non-ASCII file.
- [x] 7.3 Loop tests assert the steps, including that a step arrives before the next turn's request is sent

## 8. Folders by concern

- [x] 8.1 The server's code moves into folders by concern: `main/main.ts`, `config/config.ts`, `model/model.ts` and `model/lmstudio.ts`, `loop/loop.ts`, and `tools/read-file.ts` and `tools/tool-handler.ts`. There are no index files: every import names the file it uses.
- [x] 8.2 Tests mirror the folders, with the shared fake model server at `test/fake-model.ts`. The `hello` and `start` scripts point at `main/main.ts`.

## 9. A structured logger

- [x] 9.1 `log/log.ts`: a hand-rolled logger. `info`, `warn` and `error` take a message and JSON fields, and every record goes to stdout. The output is formatted by default; `LOG_FORMAT=json` gives one JSON object per line, and an unknown `LOG_FORMAT` fails first.
- [x] 9.2 `main.ts` logs everything through it, the answer included, as records: `asking`, `turn`, `tool call`, `tool result` or `tool failed`, and `answer`. Errors keep their sentences as messages.
- [x] 9.3 Logger unit tests: the expected local time is computed from a fixed instant rather than by pinning the time zone. The hello tests read the log as JSON records, and one test covers the formatted default.

## 10. The loop as a session

- [x] 10.1 `runLoop` becomes `createSession(config, { model, tools, history })` in `session/session.ts`. It builds its own client from the config and takes the reasoning effort from it too. It returns `{ steps, history }`: the generator of steps, and the session's own, growing history. Steps no longer carry history copies.
- [x] 10.2 `main.ts` passes the config and iterates `session.steps`. The session tests fake the global `fetch`, check that the client comes from the config, and check that the history keeps up step by step.
- [x] 10.3 `createSession` chooses the model too, so it's async. It resolves to `{ ok: false, reason }` when no model can be used, or to the session with its `model` and the note on how it was picked. `main.ts` no longer calls `resolveModel`.

## 11. Steps carry `core`'s results

- [x] 11.1 The session yields `classify`'s `final` and `empty` results as they are, with the turn's stats, and `runTurn`'s failure whole, in a `turn_failed` step. `turn_limit` and `history` are steps of their own. The `answer` and `stop` steps are gone, and so are the `detail` texts that `stop` carried for `empty` and `turn_limit`; nothing read them.
- [x] 11.2 `core` exports `TurnFailure`. `main.ts` switches on the step's kind, and the session tests assert the new steps.

## 12. `main.ts` keeps only the program

- [x] 12.1 Its helpers move beside it in `main/`: `args.ts` (`parseArgs` and the default file and questions), `fields.ts` (`parsed` and `turnFields`, for the log) and `failure.ts` (the message for a session that ends without an answer). `main.ts` keeps the developer prompt, `run` and the entry line; the hello tests still cover the helpers through it.

## 13. One `Result` type

- [x] 13.1 `packages/core/src/result.ts`: `Result<T, E>`, its halves `Ok<T>` and `Err<E>`, and the constructors `ok` and `err`, which return exactly `Ok<T>` and `Err<E>`. Exported from `core`, with a unit test.
- [x] 13.2 `core` returns it from `validateArgs`, `toInput` and `runTurn`. `ToolOutcome` and `TurnResult` are defined with it; `runTurn`'s error becomes `TurnError`, `{ kind, detail, status? }`. `ArgsResult`, `InputResult` and `TurnFailure` are gone.
- [x] 13.3 The server returns it from `loadConfig`, `fetchModels`, `pickModel`, `resolveModel`, `createSession` and `read_file`, and the steps for a failed turn or history carry the original error as `error`. `ConfigResult` and `ModelsResult` are gone, and `read_file`'s own `failure` helper gives way to `err`.
- [x] 13.4 Tests assert the new shapes, and the specs follow: a new `result` capability, and a `model-turn` delta for `runTurn`'s result.

## 14. Readonly arguments

- [x] 14.1 `createSession` creates the history and the step generator that grows it, so no function changes an array it was passed. The per-session setup (reasoning, function tools, handlers) moves into `createSession` beside them.
- [x] 14.2 Every object type the code defines is readonly: properties, arrays and records, in `core`, the server and the test helpers.
- [x] 14.3 Lint: `no-param-reassign` with `props`, and `typescript/prefer-readonly-parameter-types`, which skips inferred types and allows other packages' types by name. oxlint runs with type information through `oxlint-tsgolint`, and its type-aware rules removed three casts from the sources. `consistent-return` gives way to TypeScript's `noImplicitReturns`, and tests may still cast.
