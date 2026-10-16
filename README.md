# mecha-gremlin

A self-hosted, scheduled agent runner, in early development. The design and its open decisions live in [`Brief.md`](Brief.md). Changes go through OpenSpec, under `openspec/`.

## Layout

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@mecha-gremlin/core`: stateless functions. `runTurn` runs one streamed model turn over the Responses API and returns the reply or a classified error. The tool-calling pieces are tools defined by any [Standard Schema](https://standardschema.dev) library, `classify` for a turn's output, `validateArgs`, `toOutputItem`, and `toInput`, which replays the chat history. |
| [`packages/yaml`](packages/yaml) | `@mecha-gremlin/yaml`: `parseYaml`, which uses Bun's built-in parser, `Bun.YAML`, on Bun, and the [`yaml`](https://www.npmjs.com/package/yaml) package elsewhere. The two give the same values for everything frontmatter uses. |
| [`packages/process`](packages/process) | `@mecha-gremlin/process`: `spawnProcess`, which uses `Bun.spawn` on Bun and `node:child_process` elsewhere, and gives the process the same shape on both: its pid, its output as web streams, a promise of how it exited, and `unref()`. |
| [`packages/server`](packages/server) | `@mecha-gremlin/server`: the app. So far it asks the model a question about a file, which the model reads with the `read_file` tool in an agent loop. It runs on Bun or Node. |

Inside `packages/server/src`, the code is grouped by concern:
- `main`: the entry point, and its helpers for the arguments, the log fields and the failure messages;
- `config`;
- `model`: model choice and LM Studio's API;
- `session`: the agent loop, as a session that yields each turn's result;
- `tools`;
- `log`: the structured logger.

`yaml` and `process` choose their implementation on every call, from the global object: Bun's when `globalThis.Bun` is defined, the other one otherwise. Nothing uses them yet.

No package has index files: every import names the file it uses. The `package.json` of `core`, `yaml` and `process` exports each module by name, so the server imports `@mecha-gremlin/core/turn`, `@mecha-gremlin/core/result` and so on. The tests mirror the folders.

## Prerequisites

- [Bun](https://bun.com) 1.4 or later.
- [Node.js](https://nodejs.org) 26 or later, for `bun run hello:node` and `bun run test:node`, and so for `bun run check`.
- An OpenAI-compatible model server. By default that's a local [LM Studio](https://lmstudio.ai), with its server running (`lms server start`) and **a model loaded** (`lms load <model>`, or load one in the app). The server never makes LM Studio load a model on demand.

## Run

```sh
bun install
bun run hello                                       # asks what package.json's check script runs
bun run hello README.md                             # asks what README.md is for
bun run hello package.json which vitest version     # your own question; quotes are optional
bun run hello:node README.md                        # the same, on Node
```

The command is `bun run hello [file] [question…]` on Bun, or `bun run hello:node [file] [question…]` on Node, with the same arguments and settings. The model reads the file with the `read_file` tool, and the loop runs until it answers, for at most 8 turns. A question usually takes two turns: one to read the file and one to answer. On a local 27B model, turns took from 15 seconds to about 2 minutes in testing, growing with the size of the file.

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

Settings come from the environment, and from a local `.env` file, which is gitignored. Each value is trimmed, and a blank one counts as unset.
- **On Bun,** `.env` is read along with `.env.local`, and a file for `NODE_ENV` (`.env.development` when it's unset).
- **On Node,** only `.env` is read, through the `--env-file-if-exists` flag in `hello:node`. Without a `.env`, Node prints ".env not found. Continuing without it." to stderr, and carries on.

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
bun run test           # unit tests (Vitest) on Bun; no LM Studio needed. test:watch for watch mode
bun run test:node      # every test again, on Node
bun run typecheck      # tsc --noEmit over the whole workspace
bun run lint           # oxlint, with type information; warnings fail too
bun run format         # oxfmt: 4-space indentation, single quotes; format:check only checks
bun run check          # format:check, lint, typecheck, test and test:node, as CI would run them
bun run mutation       # Stryker mutation testing on Bun, which fails below 100%; report in reports/mutation/
```

- **Formatting.** oxfmt formats code and config files. Markdown, `openspec/`, `.claude/` and `.opencode/` are excluded in `.oxfmtrc.json`, so prose documents and generated command files keep their layout.
- **Tests run on Bun and on Node,** the two runtimes the app runs on. `bun run test` runs every test on Bun, and `bun run test:node` runs them all again on Node.
  - Each script names its runtime in `TEST_RUNTIME`, and a server test, `runtime.test.ts`, fails unless the tests run on the runtime it names, so it also fails for tests run without a script. Vitest's and Stryker's command-line scripts start Node, so `test`, `test:watch` and `mutation` start them with `--bun`.
  - `test:node`, and so `check`, needs Node 26: without Node, Bun stands in for `node`, and the runtime test fails.
  - `yaml` and `process` export both of their implementations, so the tests run each on the runtime that has it: the Node ones on both runtimes, and the Bun ones on Bun. Node's run reports the Bun ones as skipped. Mutation testing runs on Bun, where both run.
  - Three workarounds keep the tests and mutation testing working on Bun. Each is commented where it's applied:
    - `vitest.config.ts` inlines `zod`: under Bun, Vitest's own import of `zod` comes back without its `z` export. The line can go once the tests pass on Bun without it.
    - `bun run mutation` preloads `stryker.preload.ts`, for a Bun bug ([oven-sh/bun#41151](https://github.com/oven-sh/bun/issues/41151)) that otherwise stops Stryker loading its Vitest runner. The file and the `--preload` flag go once the bug is fixed.
    - `stryker.config.mjs` gives Stryker's Vitest runner `related: false`: under Bun, it finds no test files related to the mutated files, so no test would run. Per-test coverage still picks the tests each mutant runs. The option can go once the runner finds those files under Bun.
- **Lint rules beyond oxlint's defaults.** Every if/loop body needs braces (`curly`), and a `let` that is never reassigned must be a `const` (`prefer-const`). Functions are arrow functions assigned to a `const` (`func-style`, `prefer-arrow-callback`); a generator, which can't be an arrow, is a `function*` expression. A `const` can't be used before its line has run, so everything is defined before it's used (`no-use-before-define`): helpers come first, and a file reads bottom-up. Object types are `type` aliases, never interfaces (`typescript/consistent-type-definitions`).
- **Functions never change their arguments.**
  - A parameter can't be reassigned, nor its properties assigned (`no-param-reassign`).
  - Every typed parameter must be readonly all the way down (`typescript/prefer-readonly-parameter-types`), so TypeScript rejects a write or a `push` through it. The code's own object types are readonly for that reason.
  - Types from other packages can't be made readonly, so `.oxlintrc.json` allows them by name. The `openai` SDK's request type is readonly only on top, and `runTurn`'s parameter for it is exempt inline.
- **Linting uses type information,** through `oxlint-tsgolint`. That also turns on the type-aware rules in the enabled categories, such as `no-floating-promises`. Two of them are adjusted:
  - Tests may use type assertions (`no-unsafe-type-assertion` is off there), since they build malformed values on purpose.
  - `consistent-return` is off: TypeScript's `noImplicitReturns` checks the same thing, and knows when a switch covers every case.
- **The packages' boundaries are enforced by the linter,** through overrides in `.oxlintrc.json`.
  - `core` may not touch `process`, `Bun` or `console`.
  - `yaml` and `process` may not touch `process` or `console`: they report only through their results, and a spawned process gets only the environment it's given.
- **Every mutant must be caught.**
  - Stryker fails below a 100% mutation score, so a new branch or message needs a test that would notice it changing.
  - A mutant that behaves exactly like the original code, or sits in code that can't run, is usually better removed by simplifying the code.
  - Where the code can't reasonably change, a `// Stryker disable next-line` comment turns the mutant off, with the reason on the line above. There are three: `main.ts`' final `throw`, how far `read_file` reads, and the `yaml` package's log level, where `''` behaves exactly like `'error'`.
- **Vitest is pinned to 4.x** until [stryker-js#6210](https://github.com/stryker-mutator/stryker-js/issues/6210) is fixed: Stryker's Vitest runner silently stops working on Vitest 5 (see `stryker.config.mjs`).
- **Tests fake the app's globals.** The app reads the environment, `fetch`, the clock and `console` directly, with nothing injected. Tests fake them with `vi.stubEnv`, `vi.stubGlobal` and `vi.spyOn`, and Vitest undoes every fake after each test. Importing `main.ts` runs it, so its tests import it only after faking, and never statically.

## CI

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) builds every pushed branch, and pull requests from forks. It runs two jobs:

1. **Check and test:**
   - a frozen install, then the format check, lint and typecheck;
   - the tests on Bun (failures are annotated on the PR), then the whole suite again on Node;
   - the hello, started on Node against a port where nothing listens. It must exit with 1, saying it can't reach LM Studio. The tests load the code through Vite, so this is the one check that Node itself loads the server;
   - `bun audit`, report only: the step shows as failed when there are advisories, but the job still passes.
2. **Mutation testing:** once the checks pass, Stryker runs on Bun and uploads its HTML report as the `mutation-report` artifact. The job fails if any mutant survives. It sets up only Bun, not Node.

Actions are pinned to commit SHAs, and there is deliberately no dependency cache shared between builds.
