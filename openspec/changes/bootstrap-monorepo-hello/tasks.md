## 1. Workspace setup

- [x] 1.1 Root `package.json`: private, `"workspaces": ["packages/*"]`, scripts `hello` (`bun packages/server/src/main.ts`), `test` (`bun test`) and `typecheck` (`tsc --noEmit`); dev dependencies `typescript` and `@types/bun`
- [x] 1.2 Root `tsconfig.json` with the shared Bun-style compiler options (strict, `noEmit`, bundler resolution, `verbatimModuleSyntax`), including every package's `src` and `test`
- [x] 1.3 `.gitignore` (`node_modules`, `.env`, `*.env`) and a short `README.md` covering prerequisites (Bun, LM Studio with a loaded model), `bun install`, `bun run hello`, the environment variables, and `bun test` / `bun run typecheck`

## 2. Core package (`model-turn`)

- [x] 2.1 `packages/core/package.json` (`@mecha-gremlin/core`, `exports` → `./src/index.ts`, `openai` as a peer dependency and dev dependency) and a `tsconfig.json` extending `../../tsconfig.json`
- [x] 2.2 `packages/core/src/turn.ts`: the `TurnRequest` and `TurnResult` types; `runTurn(client, request, { signal })` streaming via `client.responses.create({ ...request, stream: true, store: request.store ?? false })`, keeping the terminal event's response and extracting `message`/`output_text` text
- [x] 2.3 Structural error classification in `turn.ts` (`status` for HTTP errors; class name, walking inherited classes, for connection and timeout errors; the caller's signal for aborts), covering every kind in the spec
- [x] 2.4 `packages/core/src/index.ts` re-exporting the public API
- [x] 2.5 `packages/core/test/turn.test.ts`, with a real `OpenAI` client and a fake `fetch` serving canned SSE and HTTP errors: completed turn (text and usage), reasoning item excluded, request body has `stream: true` and `store: false`, explicit `store: true` kept, 401 → `auth`, 500 → `server_error`, connection failure → `unreachable`, `response.incomplete` → `incomplete`, `response.failed` → `failed`, no terminal event → `failed`, abort → `aborted`

## 3. Server package (`model-hello`)

- [x] 3.1 `packages/server/package.json` (`@mecha-gremlin/server`, dependencies `@mecha-gremlin/core: workspace:*` and `openai`, `start` script) and a `tsconfig.json` extending `../../tsconfig.json`
- [x] 3.2 `packages/server/src/config.ts`: pure `loadConfig(env)` returning the config (defaults, trailing slash trimmed, http(s) check) or a list of problems naming each variable
- [x] 3.3 `packages/server/src/lmstudio.ts`: pure `pickModel(payload, configured?)` (LLMs with loaded instances only; configured id or key match; first-of-many note; defensive shape checks), plus `fetchModels(config, fetch)` calling `GET {base}/api/v1/models` with the bearer token and classifying unreachable, auth and unexpected-shape failures
- [x] 3.4 `packages/server/src/hello.ts`: `run({ env, fetch, stdout, stderr })` that loads config, resolves the model, builds the `OpenAI` client (`baseURL: {base}/v1`, token, `maxRetries: 0`, injected `fetch`), calls `runTurn` with input "Hi!" and the configured `reasoning.effort`, writes the reply to stdout, writes progress, usage and errors to stderr, and returns the exit code
- [x] 3.5 `packages/server/src/main.ts`: wire `run` to `process.env`, global `fetch`, `process.stdout`/`stderr` and `process.exitCode` under `import.meta.main`
- [x] 3.6 `packages/server/test/`: `loadConfig` cases (defaults, invalid URL, effort pass-through); `pickModel` cases (one loaded, several loaded, configured loaded, configured not loaded, none loaded, embeddings-only); and `run` cases with a fake `fetch` (successful hello with the stdout/stderr split and exit 0, LM Studio unreachable, token rejected, turn failure → exit 1 with empty stdout)

## 4. Verify

- [x] 4.1 `bun install` produces `bun.lock` with a single `openai` copy; `bun test` passes; `bun run typecheck` passes
- [x] 4.2 Run `bun run hello` against the local LM Studio and confirm the reply prints, the model is named on stderr, and the exit code is 0
- [x] 4.3 Confirm `core` has no `process.env`, `Bun.env` or `console` references

## 5. Provider-neutral configuration

- [x] 5.1 `config.ts`: `MODEL_PROVIDER` (`lmstudio` or `openai`), `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL` and `MODEL_REASONING_EFFORT`, with per-provider defaults and validation (including LM Studio's base URL ending in `/v1`)
- [x] 5.2 `model.ts`: `resolveModel` dispatches on the provider and `keyRejected` gives each provider's hint; `lmstudio.ts` keeps only LM Studio's own API and derives its native endpoint from the base URL's origin
- [x] 5.3 `hello.ts`: use the base URL as given, omit `reasoning` when unset, and give provider-aware key and unreachable messages
- [x] 5.4 Tests for both providers (defaults and required settings, no LM Studio call with `openai`, no `reasoning` by default, a generic key message), and the README configuration table
- [x] 5.5 `bun run hello` still works against the local LM Studio with no settings
