## Why

The code calls one model request a turn: `runTurn`, `MAX_TURNS`, the `turn` log record. The sources that define the word mean a user's whole exchange by it, and call one model request, with the tool calls it asked for, a step (Brief R15.1). OpenAI's `reasoning.context` seems to agree. The two meanings can't collide while a run takes one user message, but they will once a session can ask the user and resume. And from M1 the word reaches what is persisted: a task's limits, TASK.md files and the run log. D21 settles on renaming now (Brief C13).

## What Changes

- **The words:**
  - a *model call* is one request to the model;
  - a *step* is a model call and the tool calls it asked for;
  - a *turn* is left for a user's whole exchange, which nothing names yet.
- **BREAKING: `MAX_TURNS` becomes `MAX_STEPS`,** still a positive whole number that defaults to 30. While `MAX_TURNS` is set, the server refuses to start and says it was renamed, rather than ignore it.
- **BREAKING for log readers: the `turn` record becomes `model call`,** beside `tool call`, and its `number` field becomes `step`.
- **`core`:** `runTurn` becomes `callModel`, in `@mecha-gremlin/core/model-call`, and its types follow: `ModelCallRequest`, `ModelCallResult`, `ModelCallError`, `ModelCallErrorKind` and `ModelCallOptions`. `classify` returns a `Reply` rather than a `Turn`.
- **The session:**
  - `maxTurns` becomes `maxSteps`, and the caller must pass it. The session's own default of 8 goes, so the setting's 30 is the only default;
  - `TurnStats` becomes `StepStats`, carried as `stats`;
  - the `turn_limit` and `turn_failed` steps become `step_limit` and `model_call_failed`.
- **The messages** count steps, and speak of the request or the reply rather than the turn: "The model didn't answer within 30 steps: it was still calling tools. Try a narrower task, or raise MAX_STEPS."
- **The README:** the setting, the loop's description, and a sample log from a real run.

Nothing else changes. The same requests go to the model in the same order, and the limit counts what it counted.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `agent-loop`: the step limit, which the caller must set, and the session's step names (`StepStats`, `step_limit`, `model_call_failed`). Every requirement is replaced, since each has "turn" in its title or in a scenario's.
- `model-call`, renamed from `model-turn` on this branch before this change: `callModel` in place of `runTurn`. Three requirements are replaced for their titles.
- `tool-calls`: `classify` classifies a model call's output. That requirement is replaced for its title.
- `server`, renamed from `model-hello` on this branch before this change: `MAX_STEPS` and the refusal of `MAX_TURNS`, the `model call` record, and the messages. Four requirements are replaced, and one is modified.
- `structured-log`: its examples log a `model call` record rather than a `turn`.

## Impact

- **Code:**
  - `core`: `src/turn.ts` becomes `src/model-call.ts`, with its test; `src/tools.ts`; a comment in `src/history.ts`;
  - the server: `session/session.ts`, `main/main.ts`, `main/fields.ts`, `main/failure.ts` and `config/config.ts`;
  - the tests that name turns, in `core` and the server;
  - the README.
- **Dependencies:** none.
- **Users:** set `MAX_STEPS` where `MAX_TURNS` was set. Anything that reads the log looks for `model call` and `step` instead of `turn` and `number`.
- **Builds on** the capability renames on this branch: `model-hello` became `server`, and `model-turn` became `model-call`.
