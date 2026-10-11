# mecha-gremlin

A self-hosted, scheduled agent runner, in early development. The design and its open decisions live in [`Brief.md`](Brief.md). Changes go through OpenSpec, under `openspec/`.

## Layout

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@mecha-gremlin/core`: stateless functions. So far `runTurn`, which runs one streamed model turn over the Responses API and returns the reply or a classified error. |
| [`packages/server`](packages/server) | `@mecha-gremlin/server`: the app. So far it says hi to the model loaded in LM Studio and prints the reply. |

## Prerequisites

- [Bun](https://bun.com) 1.4 or later.
- [LM Studio](https://lmstudio.ai) with its server running (`lms server start`) and **a model loaded** (`lms load <model>`, or load one in the app). The server never triggers JIT loading.

## Run

```sh
bun install
bun run hello
```

The reply goes to stdout. Progress, usage and errors go to stderr, so `bun run hello | pbcopy` copies just the reply.

## Configuration

Settings come from the environment. Bun also reads a local `.env` file, which is gitignored.

| Variable | Default | Meaning |
|---|---|---|
| `LMSTUDIO_BASE_URL` | `http://127.0.0.1:1234` | LM Studio server origin |
| `LMSTUDIO_API_TOKEN` | `lm-studio` | Bearer token; any value works while LM Studio's "Require Authentication" is off |
| `LMSTUDIO_MODEL` | first loaded model | A loaded model's key or instance id |
| `LMSTUDIO_REASONING_EFFORT` | `none` | Sent as `reasoning.effort`; `none` keeps reasoning models quick |

## Develop

```sh
bun run test           # unit tests (Vitest); no LM Studio needed. test:watch for watch mode
bun run typecheck      # tsc --noEmit over the whole workspace
bun run lint           # oxlint; warnings fail too
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
