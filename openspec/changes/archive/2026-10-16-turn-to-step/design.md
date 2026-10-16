## Context

The agent loop sends one request to the model, runs the tool calls in the reply, and repeats until the model answers. The code calls each request a turn: `core`'s `runTurn`, the session's `TurnStats`, `turn_limit` and `turn_failed`, the `MAX_TURNS` setting, the `turn` log record, and the messages. About 460 uses across the code, tests, specs and README.

Elsewhere, "turn" usually means a user's whole exchange: Codex's app-server, Claude Code's glossary, Gemini and BFCL define it so, and call one model call a step (Brief R15.1). OpenAI's `reasoning.context` appears to mean the same by `current_turn`. Only the "max turns" limits of OpenAI's and Claude's Agent SDKs count model calls as turns. D21 chose the step vocabulary, before M1 starts persisting the word (Brief C13).

**Measured with OpenSpec 1.6.0:**
- A MODIFIED requirement can't retitle a scenario, even together with a RENAMED entry (hello-to-server's design).
- A requirement can't be both REMOVED and ADDED in one change: "Requirement present in both ADDED and REMOVED".
- Archive won't empty a capability: "Spec must have at least one requirement … No files were changed".
- OpenSpec appends ADDED requirements at the end of a spec.

So no change can rename a capability. The commit before this change moved two folders instead: `model-hello` is now `server`, and `model-turn` is now `model-call`. `openspec validate --specs --strict` passes with both moved.

## Goals / Non-Goals

**Goals:**
- One meaning per word, in the code, the specs, the log and the README:
  - a **model call** is one request to the model;
  - a **step** is a model call and the tool calls in its reply;
  - a **turn** is a user's whole exchange, and nothing uses the word for anything else.
- The server sends the same requests in the same order, and its limit counts what it counted.
- Anyone who set `MAX_TURNS` finds out at once.

**Non-Goals:**
- **Counting turns.** A session takes one user message, so it runs one turn. Naming the turn waits until a session can ask the user and resume.
- **Changing what happens at the limit.** That's D20's change: run the last step's calls, then a finalize step.
- **Logging a model call before its tools run.** A step is yielded after its tool calls have run (`agent-loop`), so its record comes then, as the `turn` record did.
- **An alias for `MAX_TURNS`.** The server refuses it instead (decision 4).
- **Rewriting the Brief's records,** which say "turn" as they were written. C13 and D21 record the change, and a note at the top of Part 4 maps the words.

## Decisions

**1. The names.**

| Today | After | Where |
|---|---|---|
| `runTurn` | `callModel` | `core`, `src/turn.ts` becomes `src/model-call.ts` |
| `TurnRequest`, `TurnResult`, `TurnError`, `TurnErrorKind`, `TurnOptions` | `ModelCallRequest`, `ModelCallResult`, `ModelCallError`, `ModelCallErrorKind`, `ModelCallOptions` | `core/model-call` |
| `Turn`, as `classify` returns it | `Reply` | `core/tools` |
| `maxTurns`, optional, defaulting to `MAX_TURNS` = 8 | `maxSteps`, required | `createSession` |
| `TurnStats`, carried as `turn` | `StepStats`, carried as `stats` | the session's steps |
| `turn_limit`, `turn_failed` | `step_limit`, `model_call_failed` | the session's steps |
| `MAX_TURNS`, `DEFAULT_MAX_TURNS`, `checkMaxTurns`, `config.maxTurns` | `MAX_STEPS`, `DEFAULT_MAX_STEPS`, `checkMaxSteps`, `config.maxSteps` | the settings |
| the `turn` record, with `number` | the `model call` record, with `step` | the log |
| `turnFields`, `turnFailed` | `modelCallFields`, `modelCallFailed` | `main/fields.ts`, `main/failure.ts` |

- **`callModel`, not `runStep`:** it sends one request and runs no tools, and the session's loop makes the step. 4.4's run log already calls this event a `model_call`.
- **`Reply`:** `classify` sorts what the model sent back into calls, a final text, or nothing.
- **`stats`, not `step`:** a step's stats would otherwise be read as `step.step`.
- **`model_call_failed`:** what failed is `callModel`, and it carries a `ModelCallError` as it is. The step that ran out is `step_limit`.
- **The detail `callModel` gives an abort** becomes "the model call was aborted", and its comments speak of the model call.

**2. The session's default goes.** The session defaulted to 8 turns and the setting to 30, under the same name, `MAX_TURNS`. The server always passes the setting, so 8 counted only in tests and misled readers. `maxSteps` is required, and `createSession` still refuses one that isn't a positive integer, before it chooses the model. A JavaScript caller that leaves it out gets that refusal too.
- **Alternative:** a session default of 30, the setting's. Two copies of one number would drift.

**3. The log record.** `model call` sits beside `tool call` and carries what it did before, under `step` instead of `number`:

```text
18:06:45 INFO  model call step=1 inputTokens=813 cachedTokens=0 outputTokens=49 reasoningTokens=33 seconds=9.1
18:06:45 INFO  tool call tool=activate_skill arguments={"name":"playwright-cli"}
```

- **Its fields describe the model call:** tokens, and the request's seconds. The tool calls have records of their own.
- **Alternative:** a `step` record. It would hold the model call's numbers under the step's name.

**4. `MAX_TURNS` is refused, not ignored.** `MAX_STEPS` is read as `MAX_TURNS` was: a positive whole number in decimal digits, 30 by default, checked whatever the provider. While `MAX_TURNS` is set, `loadConfig` also reports "MAX_TURNS is now MAX_STEPS; rename it in your settings." So the server exits with code 1, before any network call, with every other problem reported too.
- **Why:** an ignored setting would quietly put the limit back to 30, and nobody would know.
- **Alternatives:**
  - reading `MAX_TURNS` as an alias: two names for one setting, for good;
  - a silent break, as `hello` had: a missing script fails by itself, and an ignored setting doesn't.

**5. The messages.**

| When | Message |
|---|---|
| the server fails the request | "The model server at … failed the request (…). Try again; if it keeps failing, check its logs or status page." |
| the response is incomplete | "The model stopped before finishing its reply (…). Try a narrower task." |
| the request is aborted | "The model call didn't finish (…). Run the command again." |
| something unexpected | "The model call failed unexpectedly (…). Try again; if it keeps happening, report it as a bug." |
| the step limit | "The model didn't answer within N steps: it was still calling tools. Try a narrower task, or raise MAX_STEPS." |
| an empty reply | "The model gave no answer: its reply had neither text nor tool calls. Try again, or rephrase the task." |

The others never named the turn and don't change. The output of a call the limit stops says "not run: the step limit was reached".

**6. The spec deltas.** Every requirement whose title, or one of whose scenarios' titles, holds "turn" is replaced: REMOVED, then ADDED under a new title. Other requirements are MODIFIED.

| Capability | Today | After |
|---|---|---|
| `agent-loop` | Create a session from the configuration | Create a session from the configuration and a step limit |
| | Alternate model turns and tool calls until the model answers | Alternate model calls and tool calls until the model answers |
| | Run every call in order and answer each exactly once | Run every tool call in order and answer each exactly once |
| | Stop at the turn limit | Stop at the step limit |
| | End with a step, not a throw | End every session with a step, not a throw |
| | Yield the result of each turn as it completes | Yield each step as it completes |
| `model-call` | Run one streamed, stateless model turn | Call the model once, streamed and stateless |
| | Return the reply text and usage on completion | Return the reply text and usage when the call completes |
| | Classify failures as values | Classify a call's failures as values |
| `tool-calls` | Classify a completed turn's output | Classify a model call's output |
| `server` | Carry out a task and log the answer | Carry out a task through the agent loop, and log the answer |
| | Log each tool call and turn | Log each model call and tool call |
| | Configuration from the environment, validated at start-up | Read the configuration from the environment, and validate it at start-up |
| | Actionable failures | Actionable failure messages |

- **MODIFIED:** `server`'s "Choose the model according to the provider", and `structured-log`'s "Formatted output by default", whose examples log a `model call` record.
- **Order.** `agent-loop` replaces every requirement, so its order is the ADDED order. Elsewhere the ADDED requirements land at the end, and are moved back after archiving: `model-call`'s "Core stays free of configuration and side effects" goes last again, `tool-calls`' classify requirement returns to its place, and `server`'s four go back to theirs, ahead of "Choose the model according to the provider" and around it.
- **Purposes,** after archiving: `agent-loop`'s, `model-call`'s and `tool-calls`' speak of model calls and steps.

**7. The tests.** They follow the names, and their describe titles follow the requirement titles. Test helpers named after turns take model-call names, such as `turnBodies` becoming `modelCallBodies`, `heldTurn` `heldModelCall`, and `script(...turns)` `script(...replies)`. `main.test.ts`' list of settings that are cleared for every test keeps `MAX_TURNS` and adds `MAX_STEPS`, so a developer's own settings can't leak in.

## Risks / Trade-offs

- **Anything that parses the log for `turn` records breaks.** → The proposal marks it BREAKING, and the README's sample log shows the new records. In JSON the record is `"message":"model call"`.
- **A `MAX_TURNS` left in a `.env` stops the server.** → On purpose (decision 4): the error names `MAX_STEPS`.
- **A rename this wide can hide a change in behaviour.** → Apart from decisions 2 and 4, the tests change only names and strings. The mutation score stays at 100%, and the live check compares a real run's records.
- **A missed "turn".** → A task greps for the word in `packages`, the specs and the README. What should remain is listed there: the verb, as in "turns the rewrite off", and the archived changes.
- **Reordering after archiving is manual.** → The after-archive tasks give each spec's order, and `openspec validate --all --strict` runs last.

## Migration Plan

Set `MAX_STEPS` where `MAX_TURNS` was set, and read `model call` records with `step` where `turn` records with `number` were read. Rolling back means reverting the change. The capability renames are a commit of their own, and can stay or go separately.

## Open Questions

None.
