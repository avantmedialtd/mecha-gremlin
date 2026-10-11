## 1. Core: tool calling (`tool-calls`)

- [ ] 1.1 `packages/core/src/standard-schema.ts`: the Standard Schema v1 and Standard JSON Schema interfaces, declared as types only, following the published spec, with no package dependency
- [ ] 1.2 `packages/core/src/tools.ts`:
  - the `Tool<Args>` and `ToolOutcome` types;
  - `toFunctionTool(tool)`: the `draft-07` input JSON Schema with `$schema` dropped, and `strict: true`.
- [ ] 1.3 `classify(output)`: `calls`, in output order and winning over any text; `final`, the trimmed `output_text` and `refusal` parts of every message; `empty`
- [ ] 1.4 `validateArgs(tool, raw)`:
  - empty or whitespace-only arguments mean `{}`; then `JSON.parse`, then the object check, then an awaited `~standard.validate`;
  - each issue is rendered `path: message`, with `(root)` for the root;
  - every error names the tool and ends with the expected JSON Schema.
- [ ] 1.5 `packages/core/src/history.ts`:
  - `HistoryItem`;
  - `toOutputItem(callId, outcome)`, which prefixes failures with `Error: `;
  - `toInput(history)`, which wraps `toResponseInputItems` from `openai/lib/responses/ResponseInputItems` and returns `{ ok: false, detail }` instead of throwing.
- [ ] 1.6 Export the new API and types from `packages/core/src/index.ts`
- [ ] 1.7 Core tests, using a hand-written Standard Schema fake:
  - every `tool-calls` scenario, including the asynchronous validator and the "schema not asked" cases;
  - a test that `core`'s `package.json` names no dependency or peer dependency other than `openai`.

## 2. Server: the `read_file` tool (`read-file-tool`)

- [ ] 2.1 Add `zod` 4 to `packages/server`'s dependencies, and check that `bun.lock` holds a single copy
- [ ] 2.2 A helper that pairs a `Tool<Args>` with its handler `run(args) => Promise<ToolOutcome>`, validating with `validateArgs` before running, so arguments stay typed from the schema to the handler
- [ ] 2.3 `packages/server/src/read-file.ts`: `readFileTool(root)`:
  - **Schema:** a `z.strictObject({ path: z.string() })` with descriptions.
  - **Confinement:** the lexical check, then the real-path check.
  - **Refusals:** `.env*` names, checked on both the requested and the real name; directories; missing files; binary files (a NUL byte in the first 8 KiB).
  - **Cap:** 32 KiB, cut at a UTF-8 boundary, with the truncation note.
  - I/O through `node:fs/promises`; every failure is a failed outcome.
- [ ] 2.4 `read_file` tests in real temporary directories, covering every `read-file-tool` scenario:
  - links pointing inside and outside the root, and a link to `.env`;
  - a 3-byte character straddling the cap;
  - extra arguments rejected;
  - `toFunctionTool` producing the closed schema from zod's real JSON Schema.

## 3. Server: the agent loop (`agent-loop`)

- [ ] 3.1 `packages/server/src/loop.ts`: `runLoop(client, { model, reasoning?, tools, history, maxTurns = 8, onEvent? })`:
  - tools converted once, and `toInput` on every turn;
  - `runTurn`, then the output appended, then `classify`;
  - calls run in order, each answered exactly once: unknown tool, invalid arguments, and a handler that throws;
  - "not run" outputs at the turn limit;
  - results as values, always with the history: `turn_failed` (with error kind, detail and status), `empty`, `turn_limit`, `history`.
- [ ] 3.2 Progress through `onEvent`: turn completed (number, usage, seconds); call started (name, raw arguments); call finished (success and bytes, or the error)
- [ ] 3.3 A test helper that builds completed SSE turns from `message`, `reasoning` and `function_call` items, and a fake `fetch` that serves them from a queue and captures request bodies
- [ ] 3.4 Loop tests for every `agent-loop` scenario, asserting the second request's exact replayed `input` and the order of progress events

## 4. Server: the hello asks about a file (`model-hello`)

- [ ] 4.1 `hello.ts`:
  - `run(io)` gains `args` and `cwd`;
  - parse `[file] [question…]`, with the defaults;
  - build the `developer` and `user` items;
  - run the loop with `readFileTool(cwd)` and the configured `reasoning.effort`;
  - print the trimmed answer to stdout;
  - remove `GREETING`.
- [ ] 4.2 stderr:
  - the "asking" line, then each call with its arguments and its result, then a usage line per turn (input with cached, output with reasoning, seconds);
  - failure messages for `turn_failed`, keeping the provider-aware auth and unreachable messages, and for `turn_limit`, `empty` and `history`.
- [ ] 4.3 `main.ts`: pass `process.argv.slice(2)` and `process.cwd()`
- [ ] 4.4 Hello tests for every `model-hello` scenario:
  - default question; file and question; file only;
  - an answer after reading `package.json` from a temporary working directory;
  - progress on stderr;
  - turn fails; turn limit; no answer.

  Also update the existing provider, configuration and model-choice tests to the loop's request shape.

## 5. Docs and verification

- [ ] 5.1 README:
  - what the hello does now;
  - `bun run hello [file] [question…]`, with examples;
  - what `read_file` will and won't read;
  - the layout table's package descriptions.
- [ ] 5.2 `bun run check` passes: format, lint, type-check and tests
- [ ] 5.3 `bun run mutation`: review the surviving mutants in the new code, and add tests where a survivor shows a real gap
- [ ] 5.4 Against the local LM Studio:
  - `bun run hello` answers the default question with the `check` script's command, shows the `read_file` call and the per-turn usage on stderr, and exits 0;
  - `bun run hello README.md` and a custom question also work;
  - asking about `.env` gets a refusal back from the tool, not the file.
