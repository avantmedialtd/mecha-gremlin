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
bun test            # unit tests; no LM Studio needed
bun run typecheck   # tsc --noEmit over the whole workspace
```
