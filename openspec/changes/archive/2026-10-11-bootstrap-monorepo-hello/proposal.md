## Why

The repo has a brief (`Brief.md`) but no code. The smallest useful first step is to stand up the Bun monorepo layout from the brief, with a stateless `core` package and a `server` package that the rest of the work builds on. That skeleton should prove the whole path end to end: the server talks to a model through `core`, using the Responses API the brief recommends (C1). By default the model is the one loaded in a local LM Studio, but any OpenAI-compatible provider can be configured.

## What Changes

- **Bun workspaces monorepo:**
  - a root `package.json` with `packages/*` workspaces;
  - a shared root `tsconfig.json`, which per-package tsconfigs extend through a relative path (Brief C7);
  - scripts for running the hello, type-checking and testing;
  - a short README.
- **`packages/core` (`@mecha-gremlin/core`):** the first stateless core function, `runTurn`.
  - It runs one model turn through the official `openai` SDK's Responses API, streamed and with `store: false`.
  - It returns the reply text and token usage, or a classified error as a value.
  - It does no configuration, logging or provider-specific discovery.
- **`packages/server` (`@mecha-gremlin/server`):** an entry point that:
  1. reads provider-neutral `MODEL_*` settings from the environment;
  2. chooses the model by provider: with `lmstudio`, the default, it finds the model that is actually loaded rather than triggering JIT loading (Brief 4.9); with `openai`, for any other OpenAI-compatible service, it uses `MODEL`;
  3. sends "Hi!" through `core`'s `runTurn`;
  4. prints the reply.

  It exits non-zero, with an actionable message, when the model server is unreachable, rejects the key, has no suitable model loaded, or the turn fails.
- **Tests** for both packages, using a fake `fetch` so no model server is needed, plus `tsc --noEmit` type-checking.

## Capabilities

### New Capabilities
- `model-turn`: the `core` library contract for running a single model turn over an OpenAI-compatible Responses endpoint and returning the reply text, usage, or a classified error.
- `model-hello`: the server entry point that chooses the model (the one loaded in LM Studio by default, or a named model from any OpenAI-compatible provider), greets it, and prints the reply, including its configuration and failure behaviour.

### Modified Capabilities
<!-- None: there are no existing specs. -->

## Impact

- **New files:** root `package.json`, `tsconfig.json`, `bun.lock`, `.gitignore`, `README.md`; `packages/core/**`; `packages/server/**`.
- **Dependencies:**
  - `openai` 7.x, a peer dependency of `core` and a dependency of `server` (Brief 4.2: a single copy, so error classification works);
  - dev dependencies `typescript` 7.x and `@types/bun` 1.4.x.
- **Runtime:** Bun 1.4.x on the host. By default LM Studio must be running locally, at `http://127.0.0.1:1234/v1`, with a model loaded; `MODEL_PROVIDER=openai` points the server at any other OpenAI-compatible service instead. No Docker yet, because compose (Brief 4.9) comes in a later change.
- **Naming:** the brief's draft layout (4.2) calls the app package `app`. This change names it `server`, as requested, and the brief can follow when the layout is settled (D10).
- **Decisions:** this exercises Brief D1, the Responses API, on LM Studio for the hello path. D1 itself stays open until the fuller spike S2.
