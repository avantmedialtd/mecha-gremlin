## 1. `core`: the model call (`model-call`, `tool-calls`)

- [x] 1.1 `git mv packages/core/src/turn.ts packages/core/src/model-call.ts` (design decision 1):
  - `runTurn` becomes `callModel`;
  - `TurnRequest`, `TurnResult`, `TurnError`, `TurnErrorKind` and `TurnOptions` become `ModelCallRequest`, `ModelCallResult`, `ModelCallError`, `ModelCallErrorKind` and `ModelCallOptions`;
  - the abort's detail becomes "the model call was aborted", and the comments speak of the model call;
  - the inline oxlint exemption stays on the request parameter.
- [x] 1.2 `packages/core/src/tools.ts`: `Turn` becomes `Reply`, which `classify` returns. `src/history.ts`' comment says the history is replayed on every model call.
- [x] 1.3 `git mv packages/core/test/turn.test.ts packages/core/test/model-call.test.ts`. Its describe and test titles follow `model-call`'s requirements and scenarios, such as "Completed call", "Response ends incomplete" and "Response fails mid-stream".

## 2. The session (`agent-loop`)

- [x] 2.1 `packages/server/src/session/session.ts` (design decisions 1 and 2):
  - the exported `MAX_TURNS = 8` and its comment go. `maxTurns` becomes `maxSteps`, and is required. The positive-integer check stays, and its error names `maxSteps`;
  - `TurnStats` becomes `StepStats`, carried as `stats`;
  - the `turn_limit` step becomes `step_limit`, and `turn_failed` becomes `model_call_failed`, carrying a `ModelCallError`;
  - the output of a call that isn't run says "not run: the step limit was reached";
  - it imports `callModel` from `@mecha-gremlin/core/model-call`, and `Reply` from `@mecha-gremlin/core/tools`;
  - its comments speak of steps and model calls.
- [x] 2.2 `packages/server/test/session/session.test.ts`:
  - the describe titles follow `agent-loop`'s requirement titles;
  - "The model never stops calling tools" passes `maxSteps: 8`, as the `MAX_TURNS` import goes;
  - the not-positive-integer test also covers a step limit left out;
  - helpers named after turns follow design decision 7.

## 3. The server (`server`, `structured-log`)

- [x] 3.1 `packages/server/src/config/config.ts` (design decision 4):
  - `MAX_STEPS`, through `DEFAULT_MAX_STEPS`, `checkMaxSteps` and `config.maxSteps`. The default's comment counts two steps for each page action;
  - while `MAX_TURNS` is set, whatever the provider and whatever `MAX_STEPS` holds, `loadConfig` reports "MAX_TURNS is now MAX_STEPS; rename it in your settings."
- [x] 3.2 `packages/server/src/main/fields.ts`: `turnFields` becomes `modelCallFields`, which gives `step` where it gave `number`. `src/main/main.ts` logs `model call` from a step's `stats`, and passes `maxSteps`.
- [x] 3.3 `packages/server/src/main/failure.ts`: `turnFailed` becomes `modelCallFailed`. The cases are `model_call_failed` and `step_limit`, with design decision 5's messages.
- [x] 3.4 Tests. Describe titles follow `server`'s requirement titles, and helpers named after turns follow design decision 7.
  - `test/config/config.test.ts`: `MAX_STEPS`'s values and default. `MAX_TURNS` is refused when set alone, beside a valid `MAX_STEPS`, and beside an unknown provider;
  - `test/main/failure.test.ts`: design decision 5's messages;
  - `test/main/main.test.ts`:
    - `model call` records with `step`;
    - `SETTINGS` keeps `MAX_TURNS` and adds `MAX_STEPS`;
    - "The step limit comes from the settings";
    - "The step limit's former name";
  - `test/log/log.test.ts`: `structured-log`'s examples, `model call step=1` and "The model call failed.";
  - `test/fake-model.ts`: `turnBodies` becomes `modelCallBodies`, `script(...turns)` becomes `script(...replies)`, and `turnUsage` becomes `callUsage`;
  - `test/model/lmstudio.test.ts` and `test/model/model.test.ts`: `maxSteps` in their configurations.

## 4. README

- [x] 4.1 README:
  - the packages table's `core` row: `callModel` calls the model once over the Responses API, streamed, and returns the reply or a classified error; `classify` is for a model call's output;
  - the packages list: the session "yields each step's result";
  - the imports example: `@mecha-gremlin/core/model-call`;
  - the Run section: "for at most `MAX_STEPS` steps, 30 by default". A question about a file usually takes two steps, a browsing task about two for each page action, and on a local 27B model a model call took from 15 seconds to about 2 minutes;
  - the log list: each model call's token usage;
  - the settings table: `MAX_STEPS`, "The most steps a session takes: a positive whole number", with a note that it was `MAX_TURNS` until this change, and that the server refuses the old name;
  - the lint notes: `callModel`'s parameter is exempt inline.

  The sample log stays as it is for now. The session replaces it in 6.3.

## 5. Checks

- [ ] 5.1 Only the expected "turn"s remain. `grep -rnoiE '[a-z_]*turn[a-z_]*' packages README.md openspec/specs | grep -viE ':[a-z_]*return[a-z_]*$'` lists only:
  - the verb: "Turn on LM Studio's token auth", "turns on the type-aware rules" and "turns the mutant off" in the README, "a later turn of its event loop" in `spawn.test.ts`, and "turned into input", "turn a history", "turning chat history" and "turns into a different string" in the specs;
  - `MAX_TURNS`, in `config.ts`, its tests, `main.test.ts`' `SETTINGS`, the README's note and the `server` spec;
  - the three Purposes that 7.1 updates.
- [x] 5.2 `bun run check` passes, and `bun run mutation` reaches 100%
- [ ] 5.3 CI passes on the branch: both jobs, with the mutation job at 100%

## 6. Live check (the session's)

- [x] 6.1 Against the local LM Studio, with `SKILLS_PATH` set to playwright-cli's skills and a dedicated `WORK_DIR`:
  - `bun run server` answers "Example Domain" and exits 0, logging `model call` records numbered by `step`;
  - `bun run server:node` does the same on Node.
- [x] 6.2 With `MAX_TURNS=5` in the environment, `bun run server` exits 1 before any network call, with an error that names `MAX_STEPS`
- [x] 6.3 Replace the README's sample log with the pretty output of 6.1's run on Bun

## 7. After archiving (the session's)

- [ ] 7.1 After `openspec archive`:
  - **Purposes:**
    - `agent-loop`: "The server's loop that alternates model calls and tool calls until the model answers, with its step limit, call ordering and failure handling.";
    - `model-call`: "The core library's contract for calling the model once over an OpenAI-compatible Responses endpoint: streamed, stateless by default, and returning the reply text and usage or a classified error as a value.";
    - `tool-calls`: "classifying a model call's output" where it says "classifying a turn's output".
  - **Order** (design decision 6):
    - `model-call`: "Core stays free of configuration and side effects" goes back to last;
    - `tool-calls`: "Classify a model call's output" goes back between "Convert a tool to a Responses function tool" and "Validate a call's arguments";
    - `server`: "Carry out a task through the agent loop, and log the answer", "Log each model call and tool call", "Choose the model according to the provider", "Read the configuration from the environment, and validate it at start-up", "Actionable failure messages", "Run the server on Bun or on Node", then "Stop the session's processes when the server ends".
  - Run `openspec validate --all --strict`.
