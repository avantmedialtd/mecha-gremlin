# mecha-gremlin

A self-hosted, scheduled agent runner, in early development. The design and its open decisions live in [`Brief.md`](Brief.md). Changes go through OpenSpec, under `openspec/`.

## Layout

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@mecha-gremlin/core`: stateless functions. `runTurn` runs one streamed model turn over the Responses API and returns the reply or a classified error. The tool-calling pieces are tools defined by any [Standard Schema](https://standardschema.dev) library, `classify` for a turn's output, `validateArgs`, `toOutputItem`, and `toInput`, which replays the chat history. |
| [`packages/server`](packages/server) | `@mecha-gremlin/server`: the app. So far it asks the model a question about a file, which the model reads with the `read_file` tool in an agent loop. |

Inside `packages/server/src`, the code is grouped by concern:
- `main`: the entry point, and its helpers for the arguments, the log fields and the failure messages;
- `config`;
- `model`: model choice and LM Studio's API;
- `session`: the agent loop, as a session that yields each turn's result;
- `tools`;
- `log`: the structured logger.

There are no index files: every import names the file it uses. The tests mirror the folders.

## Prerequisites

- [Bun](https://bun.com) 1.4 or later.
- An OpenAI-compatible model server. By default that's a local [LM Studio](https://lmstudio.ai), with its server running (`lms server start`) and **a model loaded** (`lms load <model>`, or load one in the app). The server never makes LM Studio load a model on demand.

## Run

```sh
bun install
bun run hello                                       # asks what package.json's check script runs
bun run hello README.md                             # asks what README.md is for
bun run hello package.json which vitest version     # your own question; quotes are optional
```

The command is `bun run hello [file] [question…]`. The model reads the file with the `read_file` tool, and the loop runs until it answers, for at most 8 turns. A question usually takes two turns: one to read the file and one to answer. On a local 27B model, turns took from 15 seconds to about 2 minutes in testing, growing with the size of the file.

Everything is logged to stdout as structured records, one per line:
- the question;
- each turn's token usage, including the input tokens served from the model server's cache;
- each tool call and its result;
- the answer;
- errors.

The default output is formatted for reading:

```text
08:12:01 INFO  asking model=prism-ml/bonsai-27b baseUrl=http://127.0.0.1:1234/v1 file=package.json question="What exact command does the check script run? Quote it."
08:12:13 INFO  turn number=1 inputTokens=376 cachedTokens=256 outputTokens=26 reasoningTokens=0 seconds=11.3
08:12:13 INFO  tool call tool=read_file arguments={"path":"package.json"}
08:12:13 INFO  tool result tool=read_file bytes=814
08:12:20 INFO  turn number=2 inputTokens=710 cachedTokens=512 outputTokens=21 reasoningTokens=0 seconds=6.7
08:12:20 INFO  answer text="`bun run format:check && bun run lint && bun run typecheck && bun run test`"
```

`LOG_FORMAT=json` writes each record as a JSON object instead, with its time in ISO 8601.

### What `read_file` reads

`read_file` reads UTF-8 text files under the working directory: the directory you run the command in. It refuses:

- paths outside the working directory, including through `..`, absolute paths and symbolic links;
- `.env` files and anything else whose name starts with `.env`, because they hold secrets such as `MODEL_API_KEY`;
- directories and binary files.

It returns at most 32 KiB of a file, and notes when it cut the file short. Every refusal goes back to the model as the tool's output, so the model can explain it or try something else.

## Configuration

Settings come from the environment. Bun also reads a local `.env` file, which is gitignored.

| Variable | Default with `lmstudio` | Default with `openai` | Meaning |
|---|---|---|---|
| `MODEL_PROVIDER` | `lmstudio` | | How the model is chosen: `lmstudio` asks LM Studio which model is loaded; `openai`, for OpenAI or any other OpenAI-compatible service, needs `MODEL` |
| `MODEL_BASE_URL` | `http://127.0.0.1:1234/v1` | `https://api.openai.com/v1` | The OpenAI-compatible API's base URL |
| `MODEL_API_KEY` | `lm-studio` | required | Bearer key. Any value works while LM Studio's "Require Authentication" is off |
| `MODEL` | the first loaded model | required | The model to use. With `lmstudio` it must be loaded |
| `MODEL_REASONING_EFFORT` | `none` | the model's default | Sent as `reasoning.effort`; `none` keeps local reasoning models quick |
| `LOG_FORMAT` | `pretty` | `pretty` | `pretty` formats the log for reading; `json` writes one JSON object per record |

For example, to ask OpenAI instead:

```sh
MODEL_PROVIDER=openai MODEL_API_KEY=sk-… MODEL=gpt-5.5 bun run hello
```

## Develop

```sh
bun run test           # unit tests (Vitest); no LM Studio needed. test:watch for watch mode
bun run typecheck      # tsc --noEmit over the whole workspace
bun run lint           # oxlint; warnings fail too
bun run format         # oxfmt: 4-space indentation, single quotes; format:check only checks
bun run check          # format:check, lint, typecheck and test, as CI would run them
bun run mutation       # Stryker mutation testing (a few minutes); report in reports/mutation/
```

- **Formatting.** oxfmt formats code and config files. Markdown, `openspec/`, `.claude/` and `.opencode/` are excluded in `.oxfmtrc.json`, so prose documents and generated command files keep their layout.
- **Tests run on Node.** Vitest runs the tests on Node, not Bun, so Bun-specific behaviour (decorators, `Bun.spawn`) needs checks run with `bun` itself.
- **Lint rules beyond oxlint's defaults.** Every if/loop body needs braces (`curly`), and a `let` that is never reassigned must be a `const` (`prefer-const`). Functions are arrow functions assigned to a `const` (`func-style`, `prefer-arrow-callback`); a generator, which can't be an arrow, is a `function*` expression. A `const` can't be used before its line has run, so everything is defined before it's used (`no-use-before-define`): helpers come first, and a file reads bottom-up. Object types are `type` aliases, never interfaces (`typescript/consistent-type-definitions`).
- **`core`'s boundaries are enforced by the linter.** It may not touch `process`, `Bun` or `console`, through an override in `.oxlintrc.json`.
- **Vitest is pinned to 4.x.** Stryker's Vitest runner silently stops working on Vitest 5 (see `stryker.config.mjs`).
- **Tests fake the app's globals.** The app reads the environment, `fetch`, the clock and `console` directly, with nothing injected. Tests fake them with `vi.stubEnv`, `vi.stubGlobal` and `vi.spyOn`, and Vitest undoes every fake after each test. Importing `main.ts` runs it, so its tests import it only after faking, and never statically.

## CI

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) builds every pushed branch, and pull requests from forks. It runs two jobs:

1. **Check and test:**
   - a frozen install, then the format check, lint, typecheck and tests (failures are annotated on the PR);
   - `bun audit`, report only: the step shows as failed when there are advisories, but the job still passes.
2. **Mutation testing:** once the checks pass, Stryker runs and uploads its HTML report as the `mutation-report` artifact.

Actions are pinned to commit SHAs, and there is deliberately no dependency cache shared between builds.
