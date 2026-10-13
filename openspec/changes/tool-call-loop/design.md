## Context

`core` has one function, `runTurn`, which runs a single streamed, stateless Responses turn. The server's hello uses it to say hi.

The brief already sketches the rest of the loop:
- **Layering:** `core` is pure functions, and "the caller orchestrates": no engine object, no injected adapters. The app's loop is about 60 lines over `core` functions (4.3).
- **4.3** names the pieces: `classify`, `validateArgs` and `toOutputItem`.
- **4.5** tabulates tool-execution failures.
- **C1** makes the history the Responses items themselves, replayed in full on every turn because `store: false`.
- **C4** reduces tools to a few that we write ourselves in TypeScript.
- **C9** schedules handling of calls the model writes as text for M2.

**Probe, 2026-10-12, on this machine.** This was a throwaway loop against `prism-ml/bonsai-27b` (Qwen3.5 architecture, MLX) on LM Studio 0.4.26, with `store: false` and a `read_file` function tool. It asked what the `check` script in `package.json` runs.
- **Reasoning off:**
  - turn 1 returned one `function_call` (`read_file`, `{"path":"package.json"}`);
  - turn 2 replayed 4 items (developer, user, call, `function_call_output`) and answered correctly;
  - 44 s and 32 s per turn.
- **Reasoning on (the model's default):**
  - turn 1 returned a `reasoning` item (plain `reasoning_text`, no `encrypted_content`), a `message` item whose only text was `"\n\n"`, and the `function_call`;
  - replaying all 6 items worked, and the answer began with `"\n\n"`;
  - 24 s and 48 s per turn.
- **Events:**
  - call arguments arrived in a single `response.function_call_arguments.done` event, with no deltas, so the stream is silent while the model writes a call;
  - `response.completed` carried every output item.
- **Caching:** LM Studio reported `cached_tokens` on every later turn, 375 of 683 and 403 of 709. The second run's first turn already hit 256 cached tokens left over from the first run.

## Goals / Non-Goals

**Goals:**
- Pure, tested `core` pieces for tool calling, with no new runtime dependency.
- A `read_file` tool that a model can't use to read outside the working directory or to read `.env` files.
- An agent loop in the server: the smallest correct one, honouring the brief's rules that every call gets exactly one output and tool failures go back to the model.
- `bun run hello` answers a question about a file using that loop, still with zero settings.
- Everything testable without a model server.

**Non-Goals:**
- **Calls the model writes as text,** and nudging it to retry (C9, D8). The probe shows bonsai's calls arrive structured.
- **Budgets, the context-fill check, the finalize turn, retries and stream timeouts** (C8, D9). The turn cap is the only limit.
- **The pure `nextStep` policy.** It earns its keep once there are policies to choose between (M2).
- **Collecting output items from `response.output_item.done`.** `response.completed` carries them on LM Studio and OpenAI. It matters for SIWC (M5).
- **Other tools** (`shell`, `write_file`, `activate_skill`), parallel execution, the workspace container (C3), persistence, and compaction.

## Decisions

**1. Chat history is the Responses items, kept as received.**
- **Type:** `core` exports `HistoryItem`, the SDK's `ResponseInputItem | ResponseOutputItem`. A history is an array of them.
- **What the loop appends, in order:**
  - the caller's starting items: a `developer` item for instructions (C1: LM Studio reportedly ignores `instructions`), then the `user` item;
  - every item of each turn's `response.output`, in order: reasoning, message and calls alike, as the SDK's README says;
  - one `function_call_output` per call.
- **`toInput(history)`** wraps the SDK's `toResponseInputItems`, which the SDK's README recommends for manually managed history. It removes SDK-only fields such as `parsed_arguments` and `created_by`.
  - The SDK throws `TypeError` on an item type it doesn't know, so `toInput` returns `err(message)` instead, keeping `core`'s errors-as-values contract.
  - It is imported from `openai/lib/responses/ResponseInputItems`, which the SDK exports under `./lib/*`.
- **Why not our own message model:** it would mean translation code, and it would lose reasoning content, encrypted reasoning and item IDs. C1 and C11 already chose verbatim items, stored one row per item later.
- **Alternatives:**
  - `previous_response_id`. That needs `store: true`, which C1 rules out.
  - Filtering the replay to messages and calls. The SDK's README warns that dropping reasoning or call items can make the next request fail.

**2. Tools: the Standard Schema interface in `core`, zod in the server.**
- **Type:** a `Tool<Args>` is `{ name, description, schema }`. The schema implements Standard Schema v1, `~standard.validate`, together with Standard JSON Schema, `~standard.jsonSchema`.
- **No dependency:** `core` declares those interfaces itself, as types only (about 40 lines), as the Standard Schema spec suggests. It never imports a schema library.
- **The server writes tools in zod 4.** I checked 4.6.6: a classic zod schema implements both `~standard.validate` and `~standard.jsonSchema`. So one object gives:
  - the JSON Schema the model sees;
  - the runtime check;
  - the handler's argument type.
- **`toFunctionTool(tool)`** returns `{ type: "function", name, description, parameters, strict: true }`.
  - `parameters` is `schema["~standard"].jsonSchema.input({ target: "draft-07" })`. That's the dialect the SDK's own helpers request.
  - The top-level `$schema` key is dropped: it names the draft but constrains nothing.
  - **`strict: true`** makes OpenAI constrain generation to the schema. LM Studio ignores it (R5.2), and arguments are validated client-side anyway. OpenAI's strict subset needs every object closed and every property required, so tools use `z.strictObject` with required fields; see Risks.
  - Tools are converted once per loop, so `tools[]` is identical on every turn (4.6).
- **Alternatives:**
  - JSON Schema objects plus a validator library in `core` (Brief 4.2). It adds a dependency to the publishable package, and handlers would get `unknown`.
  - A hand-rolled validator. Zero dependencies, but it grows with every tool and would duplicate what zod already does well.
  - Zod as a `core` dependency. That ties `core`'s public types to one library.

**3. `classify(output)`: calls win, whitespace is nothing.**
- **Result:** `{ kind: "calls", calls }`, `{ kind: "final", text }` or `{ kind: "empty" }`.
  - **calls:** if the output holds any `function_call` items, it is `calls`, in output order. Text alongside them doesn't make it an answer: the probe's reasoning-on turn paired a `"\n\n"` message with its call.
  - **final:** otherwise, the text is the concatenation of every message's `output_text` and `refusal` parts, trimmed. A refusal is shown as the answer rather than lost.
  - **empty:** the text is empty after trimming.
- **Input:** it takes the output array, not the whole `Response`, so tests stay small.
- **Alternative:** `runTurn`'s existing `text`. It would call `"\n\n"` an answer and ignore the calls.

**4. `validateArgs(tool, raw)`: parse, check the shape, then validate.**
- **Steps:**
  1. Raw arguments that are empty or whitespace mean `{}`.
  2. `JSON.parse`.
  3. The value must be a plain object: not an array, `null` or a primitive.
  4. `~standard.validate`, which is awaited because Standard Schema allows async validators.
- **Result:** `ok(args)` with the schema's output type, or `err(error)`.
- **`error` is written for the model,** following Brief 4.5: "Output item with the validation error and the expected schema". It names the tool and says what was wrong: invalid JSON with the parser's message, not an object, or one line per schema issue as `path: message`. It ends with the tool's expected JSON Schema, so the model can correct itself on the next turn.

**5. The loop lives in the server, as a session.**
- **`await createSession(config, { tools, history, maxTurns = 8 })`** does all the setup the config implies:
  - it chooses the model: LM Studio's loaded one, or `MODEL` for another provider;
  - it builds the `openai` client from the base URL and key;
  - it takes the reasoning effort from the config.

  The caller passes the config and never sees a client or a model lookup. Choosing the model can fail before any turn, for example when LM Studio has nothing loaded, so `createSession` is async. It resolves to `err(reason)`, or to `ok(session)`, where the session has:
  - `model`: the chosen model;
  - `note`: set when the model was picked out of several;
  - `steps`: an async generator that yields one step per model turn, as the turn completes and before the next one starts;
  - `history`: the session's own history, which grows as it runs. Nothing reads it yet. It starts as a copy of the history the caller passed in.
- **The steps are `core`'s results, as they are,** plus what only the session knows:
  - `calls`: the turn's calls, each with its outcome, after they ran;
  - `final` or `empty`: `classify`'s result. It is the last step;
  - `turn_failed`: `runTurn`'s error, whole, so the hello keeps its provider-specific messages. It is the last step;
  - `turn_limit`: the session's own. It is the last step;
  - `history`: `toInput`'s error, when the history can't be replayed. It is the last step.

  A step for a turn the model completed carries the turn's number, usage and seconds; the session times turns with `performance.now()`. Steps don't carry the history. The session is paused while the caller handles a step, so `session.history` at that moment is the history as of that step. A future caller can persist a session turn by turn from it, a stopped one included.
- **Why a generator:** the caller sees each turn as it completes, and acts on it between turns. That's the shape a later step needs: one that asks the user for input and takes the reply back before the session goes on. It isn't built yet. The reply could come back through the generator's `next(reply)`, or through a function on the step, which keeps `for await` working.
- **Tools carry their handlers.** The server pairs each `Tool<Args>` with `run(args) => Promise<ToolOutcome>` through a small helper, which validates and then runs. The arguments stay typed from the zod schema to the handler, while the loop holds a plain list. `core` never sees handlers.
- **Outcomes, not strings.** A `ToolOutcome` is a `Result` holding text: `ok(output)` or `err(error)`. `core`'s `toOutputItem(callId, outcome)` (Brief 4.3) renders a failure as `Error: <error>`, so that convention lives in one place. The loop also knows whether a call succeeded, for progress, without parsing its text.
- **Each turn:**
  1. Build the input with `toInput(history)`.
  2. Run `runTurn({ model, input, tools, reasoning })`.
  3. Append `response.output`.
  4. `classify` the output.
  5. On `calls`, for each call in order: find the tool by name, validate, run, and append exactly one `function_call_output`.
- **Failures that stay inside the loop** become failed outcomes, which the model sees as the call's output, and the loop continues (Brief 4.5):
  - an unknown tool: "unknown tool X; available: …";
  - invalid arguments: the `validateArgs` text;
  - a handler that throws: the error message.
- **Turn cap.** If the last allowed turn still returns calls, they are not run. Each gets an output saying it wasn't run because the turn limit was reached, so the history stays replayable for a future finalize turn (C8). The last step is then `turn_limit`.
- **Calls run sequentially and in order** (Brief 4.5). `parallel_tool_calls` is left at its default.
- **Progress:** the hello prints each step as it arrives: the turn's usage line, then its calls with their outcomes. A run takes a minute or more locally, so progress has to be live.
- **Alternatives:**
  - A session in `core`: the "engine object" the brief rules out.
  - A progress callback plus a single result at the end, which was the first version. It reports progress, but a callback can't pause the loop for the caller's reply.
  - Passing in a client, which was an earlier version. Every caller would build the same client from the same config.
  - Steps with names of their own, which was the version before this one: `answer` for `final`, and one `stop` step whose reason was `empty`, `turn_failed`, `turn_limit` or `history`. They said nothing `core`'s results don't, and the `stop` step's fields were optional, because each reason set only some of them.
  - A pure `nextStep` now: with three outcomes it would be a switch statement in another file (see Non-Goals).

**6. `read_file`: confined, refuses secrets and binary files, capped.**
- **Schema:** `z.strictObject({ path: z.string() })`. Paths are relative to the root it was created for; the hello uses the working directory.
- **Confinement, checked twice:**
  - **Lexical check:** resolve against the root, and refuse anything outside it before touching the disk. That covers `..` and absolute paths.
  - **Real-path check:** take the real path of the target and refuse if it is outside the real path of the root. That catches symbolic links.
- **Refusals:**
  - **`.env` files:** a real-path or requested name beginning with `.env`, which covers `.env`, `.env.local` and a link named `notes.txt` that points at `.env`. `.envrc` is covered too, by design, since direnv files hold secrets as well.
  - **Directories.**
  - **Binary files:** a NUL byte in the first 8 KiB.
  - **Missing files.**
- **Cap:** the first 32 KiB, cut back to a UTF-8 character boundary (Brief C11: never cut inside a character), followed by `[truncated: showing the first N of M bytes]`. Any remaining invalid UTF-8 is decoded with replacement characters. 32 KiB is about 8k tokens, which keeps a capped file inside even LM Studio's default 8k context (R5.5) and well inside bonsai's 262k.
- **Every failure is a failed outcome** naming the path and the reason, so the model sees `Error: …`. Unexpected I/O errors become "can't read" failures instead of throwing.
- **I/O uses `node:fs/promises`,** so the same code runs under Bun and under Vitest.
- **Alternatives:**
  - No `.env` rule. A model steered by a file's contents could read `.env` and print the key to stdout. The workspace container (C3) removes app secrets from the agent's reach later; until then, this rule stands in.
  - Listing a directory instead of refusing. That's another tool's job.

**7. The hello asks a question about a file.**
- **Arguments:** `bun run hello [file] [question…]`.
  - With no arguments, it asks about `package.json`: "What exact command does the check script run? Quote it." The probe used that question because the model can't answer it without the tool.
  - With only a file, the question is "What is this file for? Answer in two or three sentences."
  - Words after the file are joined into the question, so quoting is optional.
- **Starting history:**
  - a developer item: answer questions about files in the working directory, read the file with `read_file` before answering, and keep it brief;
  - a user item naming the file and the question.
- **Output:** everything goes through the structured logger to stdout (decision 10): the question, a record per turn with its token usage and seconds, each call and its result, the answer, and errors.
- **Exit codes:**
  - 0 when there is an answer;
  - 1 on any failure: the turn-failure messages stay as they are, and new messages cover the turn limit and a missing answer.
- **Wiring:** `main.ts` is the hello. It reads the process's globals directly: `process.env`, `process.argv`, `process.cwd()` and the global `fetch`. It logs through the structured logger (decision 10), which writes with `console.log`, and sets `process.exitCode` at top level. Nothing is injected, there is no `import.meta.main` guard, and nothing exports from it.
- **Alternative:** a `run(io)` that takes its I/O as parameters, with a `main.ts` that wires in the real process behind an `import.meta.main` guard. That was the first change's design. Vitest can fake every one of those globals, so the injection bought testability the tests get anyway, at the cost of an interface, a `fetch` parameter threaded through `resolveModel` and `fetchModels`, and a guard.
- **Names:** `bun run hello` and the `model-hello` capability keep their names, as asked. Its Purpose line is updated when the specs are synced.

**8. Tests.**
- **`core`:** unit tests with a hand-written Standard Schema fake. That proves `core` relies only on the interface, and keeps zod out of `core`'s dev dependencies.
- **Zod wiring:** the server's tests cover it (`toFunctionTool` and `validateArgs` with the real `read_file` schema).
- **Loop:** an `openai` client built on a fake `fetch` that answers `/v1/responses` from a queue of scripted turns. Tests assert the exact replayed input of the second request.
- **Hello:** the tests fake the globals `main.ts` reads, then import it afresh with `vi.resetModules()`, so its top-level code runs as it would under `bun run hello`. That means:
  - `vi.stubEnv` for every `MODEL_*` setting, set or cleared, so the shell's own can't leak in;
  - `vi.stubGlobal` for `fetch`;
  - `vi.spyOn` for `process.cwd`, `performance.now` and `console.log`. Vitest replaces `console` in its workers, so spying on stdout itself wouldn't see the log.

  The tests read the log as JSON records (`LOG_FORMAT=json`), which pins every field; one test checks the formatted default end to end.

  Vitest undoes every fake after each test (`restoreMocks`, `unstubEnvs`, `unstubGlobals`). Because importing `main.ts` runs it, the test file never imports it statically, and it spells out the question texts itself. Stryker now mutates `main.ts` too.
- **`read_file`:** real temporary directories, with files, nested paths, `..`, absolute paths, links that point inside and outside the root, `.env` files, a directory, a binary file, and a 3-byte character straddling the cap.
- **Stryker** covers the new code like the old. The live round trip against LM Studio is a manual check, as before.

**9. The server's code lives in folders by concern, without index files.** The folders are `main` (the entry point, with its helpers beside it: `args.ts`, `fields.ts` and `failure.ts`), `config`, `model` (model choice and LM Studio's API), `session` (the agent loop), `tools` and `log`. Every import names the file it uses, and the tests mirror the folders.

**10. A hand-rolled structured logger, on stdout.**
- **Records:** `log.info`, `log.warn` and `log.error` take a message and fields typed as JSON values, so the logger only ever receives JSON. Data goes in fields (`turn`, `tool call`, `tool result`, `answer`); errors keep their sentences as messages.
- **Everything goes to stdout,** the answer included. The earlier split of the answer on stdout and progress on stderr existed only for piping, which isn't a concern.
- **Formatted by default:** a line per record (`HH:MM:SS LEVEL message key=value …`). A value is bare when it can't be misread and JSON otherwise. A multi-line string, such as an answer or a validation error, goes in an indented block under the line.
- **`LOG_FORMAT=json`** writes one JSON object per record instead, with an ISO 8601 time, for machines and later the scheduler's logs. It is read before anything else, so even a configuration error is logged in the chosen format. An unknown value fails, in the formatted output.
- **Alternatives:** a logging library such as pino. This one fits in sixty lines, and its formatting is what we want.

**11. One `Result` type, in `core`.**
- **Shape:** `Result<T, E>` is `Ok<T>`, `{ ok: true, value }`, or `Err<E>`, `{ ok: false, error }`. `ok(value)` and `err(error)` build them. Every function that reports failures as values returns one: `validateArgs`, `toInput`, `runTurn`, `loadConfig`, `fetchModels`, `pickModel`, `resolveModel`, `createSession` and every tool handler. Each used to declare its own pair of shapes, with its own names for the same two things (`args`, `input`, `output`, `config`, `payload`; `reason`, `detail`, `problems`).
- **`ok` returns an `Ok<T>`, not a `Result<T, never>`:** a union with an impossible failure half would still need a check before `.value` could be read. The named halves also let a helper say it always fails, such as `runTurn`'s `aborted(): Err<TurnError>`.
- **`runTurn`'s error is an object,** `{ kind, detail, status? }`, as `TurnError`. Its kind is `error.kind`, where it used to be a field named `error`.
- **Names kept only where they say more than `Result` does:** `ToolOutcome` (what a handler returns, written for the model), `TurnResult` and `ModelChoice`. The aliases that only renamed a `Result` are gone: `ArgsResult`, `InputResult`, `ConfigResult`, `ModelsResult` and `TurnFailure`.

**12. Functions never change their arguments, and the types say so.**
- **The session's history:** `createSession` creates both the history and the generator that grows it. The generator appends to an array of its own session, not to one it was passed. The caller's starting array is copied and left unchanged, and `session.history` is a readonly view.
- **Readonly types:** every object type the code defines has readonly properties, arrays and records, for example `Ok`, `Err`, `Turn`, `TurnError`, `Config`, `SessionOptions`, the steps, and the log's `Json` and `Fields`. TypeScript rejects a write or a `push` through any of them.
- **Lint:**
  - `no-param-reassign` with `props` rejects assigning a parameter or its properties.
  - `typescript/prefer-readonly-parameter-types` requires every explicitly typed parameter to be readonly all the way down, so a new function can't quietly take a mutable type. It skips inferred parameter types, such as a callback's, which `no-param-reassign` still covers.
  - Both need type information, so oxlint runs with `oxlint-tsgolint`.
- **Exceptions:**
  - Other packages' types are allowed by name, because they can't be made readonly: the `openai` client and its Responses items, `Uint8Array`, and Bun's `AbortSignal`, `Request`, `RequestInit` and `URL`.
  - `TurnRequest` is the SDK's request without `stream`, an unnamed mapped type that the allowlist can't match. It is readonly on top, and `runTurn`'s parameter for it is exempt inline.
- **What type information brought along:** the enabled categories' type-aware rules. They found three casts in the sources, now gone. They also found a `consistent-return` warning on a switch that TypeScript knows is exhaustive, so that rule gives way to `noImplicitReturns`. Tests may still cast, because they build malformed values on purpose.

**13. Every mutant is caught.**
- **The bar:** Stryker fails below a 100% mutation score, locally and in CI (`thresholds.break`).
- **Tests first:** most mutants that survived pointed at behaviour no test checked:
  - `runTurn`: HTTP 403, 429 and 400, timeouts, errors that aren't the SDK's, and responses without details;
  - LM Studio: malformed payloads;
  - settings that are missing one at a time.

  Assertions now check exact details and messages, not just kinds.
- **Then simpler code:** a mutant that behaves exactly like the original usually means the code checks something twice, so the repetition went:
  - `loadConfig` checks each setting into its own `Result`, so nothing is checked again only to narrow a type;
  - `statusOf`, `hasClassName` and `read_file`'s `errorCode` read through `Object()`, which wraps any thrown value, instead of guarding each case;
  - `runTurn` no longer checks for `APIUserAbortError`, which the SDK throws only once the caller's signal is aborted;
  - `runTurn` no longer handles an SSE `error` event, which the SDK throws as an `APIError` before it gets there;
  - LM Studio entries without `loaded_instances` are skipped explicitly;
  - the logger writes the readable format when it's asked for `pretty`, so `main.ts`' fallback to `pretty` has an effect a test can see.
- **Only then a comment:** two `// Stryker disable next-line` comments remain, each with its reason. One is `main.ts`' final `throw`, which can't run. The other is how far `read_file` reads, which only changes memory use.

## Risks / Trade-offs

- **A local model calls the wrong path, or answers without reading.** → The developer item tells it to read first. Errors such as "no such file" go back to it. The default question can't be answered without the file, and the cap stops a loop that never answers.
- **LM Studio's intermittent HTTP 500 on multi-turn tool calls** (BT#2257, R5.7). → The failed turn is reported with its detail, and the history so far is kept. Retries come with C8.
- **OpenAI's strict subset rejects a schema** (an optional field, or an open object) with HTTP 400. → Tools use `z.strictObject` with required fields; a `strict` option per tool can be added when a tool needs one. `read_file` qualifies.
- **OpenAI replay with `store: false` isn't verified in this change.** That is S3's subject. → The `openai` provider works with the same code. A failure there comes back as `bad_request` with the API's detail.
- **Prompt injection through file contents.** → The tool is read-only, confined to the working directory, refuses `.env` files, and only logs what it read. Real isolation is the workspace container (C3, D3).
- **The history grows with every turn, and each turn resends it all** (C8). → With 8 turns and 32 KiB outputs that's bounded. Budgets and the context check come in M2.
- **`toResponseInputItems` lives under the SDK's `lib/` path.** → It is exported (`./lib/*`) and documented in the SDK's README, and the `^7.32` peer range pins its behaviour. `toInput` is the only caller.
- **Slow local runs:** a question takes one to two minutes on bonsai-27b. → A log record per turn shows it's alive. Reasoning stays off by default for LM Studio.

## Migration Plan

Nothing to migrate. `bun run hello` changes behaviour: it asks a question instead of saying hi. The README documents the new arguments. Rolling back means reverting the change.

## Open Questions

None blocking. The turn cap (8) and the read cap (32 KiB) are constants for now. They become per-profile settings when model profiles arrive (Brief 4.4).
