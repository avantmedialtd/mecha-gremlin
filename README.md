# mecha-gremlin

A self-hosted, scheduled agent runner, in early development. The design and its open decisions live in [`Brief.md`](Brief.md). Changes go through OpenSpec, under `openspec/`.

## Layout

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@mecha-gremlin/core`: stateless functions. So far `runTurn`, which runs one streamed model turn over the Responses API and returns the reply or a classified error. |
| [`packages/server`](packages/server) | `@mecha-gremlin/server`: the app. So far it says hi to the configured model and prints the reply. |

## Prerequisites

- [Bun](https://bun.com) 1.4 or later.
- An OpenAI-compatible model server. By default that's a local [LM Studio](https://lmstudio.ai), with its server running (`lms server start`) and **a model loaded** (`lms load <model>`, or load one in the app). The server never makes LM Studio load a model on demand.

## Run

```sh
bun install
bun run hello
```

The reply goes to stdout. Progress, usage and errors go to stderr, so `bun run hello | pbcopy` copies just the reply.

## Configuration

Settings come from the environment. Bun also reads a local `.env` file, which is gitignored.

| Variable | Default with `lmstudio` | Default with `openai` | Meaning |
|---|---|---|---|
| `MODEL_PROVIDER` | `lmstudio` | | How the model is chosen: `lmstudio` asks LM Studio which model is loaded; `openai`, for OpenAI or any other OpenAI-compatible service, needs `MODEL` |
| `MODEL_BASE_URL` | `http://127.0.0.1:1234/v1` | `https://api.openai.com/v1` | The OpenAI-compatible API's base URL |
| `MODEL_API_KEY` | `lm-studio` | required | Bearer key. Any value works while LM Studio's "Require Authentication" is off |
| `MODEL` | the first loaded model | required | The model to use. With `lmstudio` it must be loaded |
| `MODEL_REASONING_EFFORT` | `none` | the model's default | Sent as `reasoning.effort`; `none` keeps local reasoning models quick |

For example, to say hi to OpenAI instead:

```sh
MODEL_PROVIDER=openai MODEL_API_KEY=sk-… MODEL=gpt-5.5 bun run hello
```

## Develop

```sh
bun run test           # unit tests (Vitest); no LM Studio needed. test:watch for watch mode
bun run typecheck      # tsc --noEmit over the whole workspace
bun run lint           # oxlint; warnings fail too, and every if/loop body needs braces
bun run format         # oxfmt, 4-space indentation; format:check only checks
bun run check          # format:check, lint, typecheck and test, as CI would run them
bun run mutation       # Stryker mutation testing (a few minutes); report in reports/mutation/
```

- **Formatting.** oxfmt formats code and config files. Markdown, `openspec/`, `.claude/` and `.opencode/` are excluded in `.oxfmtrc.json`, so prose documents and generated command files keep their layout.
- **Tests run on Node.** Vitest runs the tests on Node, not Bun, so Bun-specific behaviour (decorators, `Bun.spawn`) needs checks run with `bun` itself.
- **`core`'s boundaries are enforced by the linter.** It may not touch `process`, `Bun` or `console`, through an override in `.oxlintrc.json`.
- **Vitest is pinned to 4.x.** Stryker's Vitest runner silently stops working on Vitest 5 (see `stryker.config.mjs`).

## CI

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) builds every pushed branch, and pull requests from forks. It runs two jobs:

1. **Check and test:**
   - a frozen install, then the format check, lint, typecheck and tests (failures are annotated on the PR);
   - `bun audit`, report only: the step shows as failed when there are advisories, but the job still passes.
2. **Mutation testing:** once the checks pass, Stryker runs and uploads its HTML report as the `mutation-report` artifact.

Actions are pinned to commit SHAs, and there is deliberately no dependency cache shared between builds.
