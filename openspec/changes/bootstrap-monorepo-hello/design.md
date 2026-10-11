## Context

`Brief.md` sets the direction:
- TypeScript on Bun;
- a public monorepo split into a stateless `core` and an opinionated app;
- the official `openai` SDK against OpenAI and LM Studio.

Its challenge C1 proposes the Responses API as the only wire format, streamed and stateless, but D1 is still open. Section 4.3 sketches `core`'s signatures, and 4.9 says the app should check which model is loaded instead of relying on LM Studio's JIT loading.

The repo currently holds only OpenSpec scaffolding and the brief. This is the first code.

**Smoke test, 2026-10-11, on this machine:**
- LM Studio 0.4.x is serving on `127.0.0.1:1234`, with one model loaded: `prism-ml/bonsai-27b`, a reasoning model with a 262k context and 4 parallel slots.
- `POST /v1/responses` with `stream: true, store: false` works.
  - With `reasoning: { effort: "none" }`, the reply ("Hi there! How can I help you today? 😊") arrived in about 16 s. The stream ended with `response.completed`, and usage reported `input_tokens_details.cached_tokens`.
  - With reasoning left on, or set to `low`, the model was still producing reasoning text after 60–90 s, at roughly 2 tokens a second.
  - A non-streaming request with reasoning on returned nothing within 180 s.

## Goals / Non-Goals

**Goals:**
- The brief's package layout in its smallest form:
  - `packages/core`, stateless, with no config, I/O opinions or logging;
  - `packages/server`, the entry point.
- `bun run hello` prints the reply of the model loaded in LM Studio to a "Hi!".
- `core`'s first function, `runTurn`, has the shape the brief sketches. It streams, uses `store: false`, and returns a result value instead of throwing, so later work extends it rather than replacing it.
- Fail fast and clearly when LM Studio is unreachable, needs a token, has no model loaded, or doesn't have the configured model loaded.
- Tests that need no running LM Studio, plus type-checking.

**Non-Goals:**
- Tools, the agent loop, scheduling, persistence, Docker/compose, OpenAI-hosted models and SIWC. All of those come in later changes.
- Retries, timeouts other than the SDK default, and the full error taxonomy from Brief 4.3. Only the kinds that can occur here are classified.
- Loading models through LM Studio's REST API; the brief does that in M4. Here a missing model is an error, with a hint.
- A long-running process. "Server" here is the app package's entry point; it runs once and exits.

## Decisions

**1. Workspace layout and TypeScript config.**
- **Workspaces:** the root `package.json` declares `"workspaces": ["packages/*"]`. `@mecha-gremlin/core` and `@mecha-gremlin/server` each point their `exports` straight at `src/index.ts`; Bun runs TypeScript directly, so there's no build step.
- **Shared tsconfig:** the root `tsconfig.json` holds the shared compiler options and includes every package for one workspace-wide `tsc --noEmit`. Each package has a tsconfig with a relative `"extends": "../../tsconfig.json"` and its own `include`. This follows Brief C7: Bun reads the tsconfig in the directory it starts in, and a relative `extends` passes options on.
- **Decorator flags are not added yet.** They arrive with TypeORM, in the same root file.
- **Alternatives:** a `tsconfig.base.json` plus project references (more files, no benefit yet), or one tsconfig per package with no root typecheck (two commands instead of one).

**2. `runTurn(client, request, options?)` in `core`.**
- **Request:**
  - It accepts a `TurnRequest`, which is the SDK's streaming Responses create params without `stream`.
  - It forces `stream: true`, and defaults `store: false` when the caller doesn't set it.
  - The caller constructs the client: `baseURL`, key and `maxRetries: 0`, so retry policy will live in the loop (Brief 4.3).
- **Streaming:**
  - It iterates the SDK's event stream from `client.responses.create({ ...request, stream: true }, { signal })`.
  - It keeps the response from the terminal event: `response.completed`, `response.incomplete` or `response.failed`.
  - The reply text comes from that response's `message` items, by concatenating `output_text` parts. That avoids depending on SDK convenience helpers.
- **Return value:**
  - `{ ok: true, text, response, usage }`, or `{ ok: false, error, detail, status? }`.
  - `error` is one of `unreachable | timeout | auth | rate_limit | bad_request | server_error | incomplete | failed | aborted | fatal`.
- **Error classification is structural.** Brief 4.3 recommends this because `instanceof` breaks across SDK copies.
  - **HTTP errors:** by `error.status`.
  - **Transport errors:** by the error's class name, walking up inherited classes (`APIConnectionTimeoutError`, `APIConnectionError`, `APIUserAbortError`). The SDK leaves `error.name` as `"Error"`, so `name` can't be used.
  - **Aborts:** by the caller's own `signal.aborted`, because the SDK ends iteration silently when a stream is aborted.
  - **Errors after streaming has begun** count as `failed`: the endpoint was reachable. That includes an SSE `error` event, which the SDK throws.
- **Packaging:** `openai` is a peer dependency of `core`, so the app's copy is the one used.
- **Alternatives:**
  - Non-streaming `responses.create`. It hung for 180 s with reasoning on in the smoke test, and C1 wants streaming anyway.
  - The SDK's `responses.stream()` helper with `finalResponse()`. It's equally short, but couples the result to helper semantics. Iterating the raw events also matches what the loop will need for liveness later.
  - Throwing on error, which the brief's design rules out.

**3. Model resolution in `server`: the loaded model, never JIT.**
- **Request:** `GET {base}/api/v1/models`, LM Studio's native REST, with the bearer token. Loaded models are `type: "llm"` entries with non-empty `loaded_instances`.
- **Choice:**
  - With `LMSTUDIO_MODEL` set, it must match a loaded instance id or a loaded model key, otherwise the server exits with the list of loaded models and an `lms load <model>` hint.
  - Without it, the first loaded instance is used, and when several are loaded the server says which one it picked.
  - None loaded is an error, with a hint.
- **Testability:** the decision is a pure function, `pickModel(payload, configured?)`, so it can be tested without a network.
- **Alternatives:**
  - The OpenAI-compatible `/v1/models`. It lists every downloaded model, not just the loaded ones, so using it could trigger a JIT load with the 8k default context (Brief R5.5).
  - A hard-coded model name. That is personal configuration in public code.

**4. No reasoning by default for the hello.**
- **Default:** the server sends `reasoning: { effort: "none" }`, overridable with `LMSTUDIO_REASONING_EFFORT` (for example `low`, `medium` or `high`).
- **Why:** with reasoning on, the loaded model takes minutes to say hi (see Context), and the point of this change is a quick end-to-end check.
- **Alternatives:** omit the parameter (the model's default: minutes per hello here), or stream reasoning to the terminal (more output code for little value now).

**5. Configuration from the environment, validated at start-up.**

| Variable | Default | Notes |
|---|---|---|
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234` | origin only; a trailing slash is trimmed; must be http(s) |
| `LMSTUDIO_API_TOKEN` | `lm-studio` | any non-empty value works while LM Studio auth is off (R5.6) |
| `LMSTUDIO_MODEL` | none | optional |
| `LMSTUDIO_REASONING_EFFORT` | `none` | |

`loadConfig(env)` is a pure function returning a config or a list of problems. It respects the brief's "config validation at boot" in miniature, with no schema library yet. Bun loads a local `.env` automatically, and `.env` is gitignored, keeping the brief's "public code, private data" rule.

**6. Output contract.**
- **stdout** gets only the reply text, so `bun run hello | pbcopy` works.
- **stderr** gets progress ("Saying hi to … at …"), a usage line (output and reasoning tokens, elapsed seconds), and errors.
- **Exit code:** 0 on success, 1 on any failure.
- **Testability:** the entry point is `run({ env, fetch, stdout, stderr }): Promise<number>`, so it can be tested with a fake `fetch`. `main.ts` just wires it to `process` when run directly (`import.meta.main`).

**7. Tests.**
- `bun test` covers `core` with a real `OpenAI` client whose `fetch` returns canned SSE streams and HTTP errors. That exercises the SDK's actual parsing.
- `server`'s `loadConfig`, `pickModel` and `run` are tested with fakes too.
- `tsc --noEmit` type-checks the workspace.
- The real LM Studio call is checked by running `bun run hello` manually; it isn't part of the automated tests.

## Risks / Trade-offs

- **TypeScript 7 (native) with `@types/bun`.** It's a new major. → If `tsc` misbehaves, pin TypeScript 6.x; nothing depends on TS 7 features.
- **`reasoning.effort: "none"` on models without reasoning.** LM Studio presumably ignores it, but that's unverified. → It's configurable, and a model that rejects it returns an error the user can see. Brief spike S2 covers it properly.
- **The SDK default timeout (10 minutes) is the only bound on a slow local generation.** → Acceptable for a manual hello. Real budgets and deadlines are Brief C8 (M2).
- **LM Studio's native REST shape (`/api/v1/models`) is LM Studio-specific and may change.** → It's parsed defensively in one pure function with tests, and a shape mismatch is reported as such.
- **Naming drift from the brief.** It says `packages/app`; this uses `packages/server`. → Noted in the proposal; reconcile when D10 is settled.
