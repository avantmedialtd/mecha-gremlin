# mecha-gremlin

A self-hosted, scheduled agent runner, in early development. The design and its open decisions live in [`Brief.md`](Brief.md). Changes go through OpenSpec, under `openspec/`.

## Layout

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@mecha-gremlin/core`: stateless, provider-independent types and functions. `model-call`, `history` and `statistics` define Gremlin's call, native replay and typed provider statistics contracts. `tools` defines tools through any [Standard Schema](https://standardschema.dev) library and validates their arguments. `skills` checks a SKILL.md and renders the skills catalog and a skill's activation, `output` caps a command's output as it streams in, and `patch` parses and applies Codex's V4A patches. Core depends on neither model SDK. |
| [`packages/yaml`](packages/yaml) | `@mecha-gremlin/yaml`: `parseYaml`, which uses Bun's built-in parser, `Bun.YAML`, on Bun, and the [`yaml`](https://www.npmjs.com/package/yaml) package elsewhere. The two give the same values for everything frontmatter uses. |
| [`packages/process`](packages/process) | `@mecha-gremlin/process`: `spawnProcess`, which uses `Bun.spawn` on Bun and `node:child_process` elsewhere, and gives the process the same shape on both: its pid, its output as web streams, a promise of how it exited, and `unref()`. |
| [`packages/agent`](packages/agent) | `@mecha-gremlin/agent`: the agent. It carries out a task in an agent loop, with a shell, file tools and skills. It runs on Bun or Node. |

Inside `packages/agent/src`, the code is grouped by concern:
- `main`: the entry point, and its helpers for the arguments, the log fields and the failure messages;
- `config`;
- `model`: model choice, LM Studio's model list, and the Responses and Anthropic Messages adapters;
- `session`: the agent loop, as a session that yields each step's result;
- `skills`: finding and reading the skills `SKILLS_PATH` lists;
- `exec`: running a command, its environment, and stopping a session's processes at the end;
- `tools`: `read`, `write`, `edit`, `apply_patch`, `shell` and `activate_skill`, and the fence the file tools share;
- `log`: the structured logger.

`yaml` and `process` choose their implementation once, when each module loads, from the global object: Bun's when `globalThis.Bun` is defined, the other one otherwise. The agent reads skills' frontmatter with `yaml`, and runs commands and `ps` with `process`.

At the top, [`test`](test) holds the signal guard, a Vitest setup file for every package's tests (see Develop).

No package has index files: every import names the file it uses. The `package.json` of `core`, `yaml` and `process` exports each module by name, so the agent imports `@mecha-gremlin/core/model-call`, `@mecha-gremlin/core/result` and so on. The tests mirror the folders.

## Prerequisites

- [Bun](https://bun.com) 1.4 or later.
- [Node.js](https://nodejs.org) 26 or later, for `bun run agent:node` and `bun run test:node`, and so for `bun run check`.
- A configured model: [LM Studio](https://lmstudio.ai), an OpenAI Responses endpoint, or the direct Claude API. For LM Studio, start the server (`lms server start`) and load the **named** model (`lms load <model>`, or load one in the app). The agent never loads a model on demand. A browsing task needs more context than LM Studio's default: see [Set up for browsing](#set-up-for-browsing).
- For browsing with the example skill, [playwright-cli](https://www.npmjs.com/package/@playwright/cli) and [Google Chrome](https://www.google.com/chrome/).

## Run

Install dependencies, then put the required settings for your provider in a local `.env` file (see [Configuration](#configuration)). A task is required on every run; no browsing task runs by default.

```sh
bun install
```

Then:

```sh
WORK_DIR=. bun run agent 'Which runtime does README.md describe?'       # a task of your own, quoted
WORK_DIR=. bun run agent:node 'Which runtime does README.md describe?'  # the same, on Node
```

These ask about this repository's README, so `WORK_DIR=.` points them at it; a setting on the command line overrides `.env`.

The command is `bun run agent <task…>` on Bun, or `bun run agent:node <task…>` on Node, with the same arguments and settings. The arguments, joined with spaces, are the task. Missing or blank tasks fail before any network request.

**Quote the task,** in single quotes unless it holds one. The shell reads `?`, `*`, `&`, `;`, `!` and `$` itself: in zsh, macOS's default shell, an unquoted `?` stops the command with "no matches found" before Bun runs.

The model carries out the task with its tools, offered in this order: `read`; `write` and `edit`, or `apply_patch` in their place when `FILE_TOOLS` is `apply-patch`; `shell`; and `activate_skill` when skills are loaded. The loop runs until it answers, for at most the configured `MAX_STEPS`. A question about a file usually takes two steps: one to read it and one to answer. A browsing task takes many more, about two for each page action. On a local 27B model, a model call took from 15 seconds to about 2 minutes in testing, growing with the size of what the model reads.

Everything is logged to stdout as structured records, one per line:
- the skills loaded, and any that couldn't be;
- the task, with the run's ID and the working directory;
- each model call's provider-specific statistics, including reported usage, cache counts and rate-limit headers, even when a call fails;
- each tool call and its result;
- the answer;
- the processes stopped when the session ends, if there were any;
- errors.

With `LOG_FORMAT=pretty`, records are formatted for reading. A model-call line includes the provider's statistics rather than only a few common token counts:

```text
22:02:03 INFO  model call step=1 providerStats={"provider":"openai","usage":{"kind":"partial","value":{"input_tokens":812,"output_tokens":48}},"rateLimits":{}} seconds=9.2
```

`LOG_FORMAT=json` writes each record as a JSON object instead, with its time in ISO 8601. Usage is marked `complete`, `partial` or `unavailable`; absent counts aren't turned into zero. Claude leaves out the usage fields that don't apply to a reply, so its complete usage shows only those it reported. Claude input counts distinguish uncached input, cache writes and cache reads. Its total input is the sum of those three; Responses input already includes cached input. Thinking and reasoning tokens are included in output tokens.

### The file tools

`read` reads UTF-8 text files under the working directory, `WORK_DIR`, and inside the loaded skills' directories, by absolute path. It pages through a file by line: `offset` is the first line to read, from 1, and `limit` the most lines. Each call returns at most 32 KiB in whole lines, with a note giving the `offset` to continue from. A single line longer than that is cut, and the rest of it can be seen only through the shell.

The model writes and changes files with one of two sets of tools, which `FILE_TOOLS` chooses. The two are never offered together:

- **`write-edit`:** `write` creates or replaces a whole file, creating missing directories, and `edit` replaces exact text in a file. Its `old_string` must occur exactly once, unless `replace_all` is set.
- **`apply-patch`:** `apply_patch` takes a patch in the V4A format of OpenAI's Codex, which adds, updates, moves and deletes files. It finds the lines to change leniently, as Codex does, and changes nothing unless the whole patch applies.

The four tools share a fence. They refuse:

- paths outside the working directory, including through `..`, absolute paths and symbolic links. `read` may also read inside the skills' directories, which the other three can't write;
- `.env` files and anything else whose name starts with `.env`, because they hold secrets such as `MODEL_API_KEY`;
- directories and binary files.

`write`, and `apply_patch` adding a file, won't replace a file larger than 32 KiB, the most one read returns, since the model may not have read all of it. `edit` and `apply_patch` change files of up to 10 MiB that are valid UTF-8. Every refusal goes back to the model as the tool's output, so the model can explain it or try something else. These limits guard the file tools alone: the shell can read and write anything you can.

### The shell

`shell` runs a command with `bash -c` on this computer, as you, in the working directory. (The workspace container comes later, in M1.)

- **Each call is a fresh shell:** `cd` and variables don't carry over, and stdin is closed.
- **A command gets 120 seconds.** Then its process group gets SIGTERM, and SIGKILL 2 seconds later.
- **Each output stream keeps its first and last 16 KiB.** When it cuts, the model is told how to see the rest: write the output to a file, then read it a part at a time with `read`, search it with `grep`, or print a part with `sed -n` or `tail -c`.
- **Background jobs end with the command,** once bash has exited and the command's output has closed, or after a second. A process that leaves the command's process group keeps running, as playwright-cli's browser does.
- **The session's processes are stopped when it ends,** whether it answers, fails, or gets Ctrl-C, SIGTERM or a hangup. Every command carries the run's ID in `GREMLIN_RUN_ID`, and every process that `ps` shows carrying it gets SIGTERM, then SIGKILL 2 seconds later. A match that looks wrong, more than 32 processes, pid 1 or below, or the agent's own process or its parent, gets no signal at all, and the log says why; so does a `ps` that can't show environments or takes over 10 seconds. Signals are ignored while the processes are stopped. On macOS, `ps` hides the environment of Apple's own programs, and if the agent's process is killed with SIGKILL nothing is stopped: playwright-cli's browser then closes after 15 minutes idle.
- **The environment is built from scratch:** `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and `LC_ALL` from yours, fixed values against prompts, pagers and colour codes, the run's ID, and a playwright-cli session of the run's own.

**What the shell can reach: anything your account can.** A model steered by a web page can read your files, run programs and send data out. Building the environment from scratch keeps your other variables, and `.env`'s, out of what commands inherit and print by accident, such as an environment dump or a log. It doesn't stop a command that goes looking: `ps -E -p $PPID` shows the agent process's own environment on macOS, and `.env` is a readable file. Run it attended, against sites you choose.

### Skills

A skill is a folder with a `SKILL.md`, in the [Agent Skills](https://agentskills.io) format. `SKILLS_PATH` lists the directories that hold skills, separated by `:` as in `PATH`: each of their subdirectories with a `SKILL.md` is a skill. Nothing else is searched, so skills written for other agents stay out unless you list them. The model sees each skill's name and description, loads a skill's instructions with `activate_skill`, and reads the skill's other files with `read`.

For example, to browse with Microsoft's playwright-cli skill, which ships with the CLI and drives Google Chrome:

```sh
npm install -g @playwright/cli
mkdir -p ~/gremlin-work
WORK_DIR=~/gremlin-work SKILLS_PATH=$(npm root -g)/@playwright/cli/skills \
    bun run agent 'Use the playwright-cli skill to find the title of https://example.com'
```

### Set up for browsing

- **Load the model with at least 32k of context.** The skill's instructions are about 4k tokens, and one page's snapshot can be 8k, while LM Studio loads models with 8k unless told otherwise: `lms load <model> --context-length 32768`, then check the loaded context with `lms ps`.
- **Give the agent a working directory of its own,** outside the repository, such as `~/gremlin-work` above. Commands run there, and playwright-cli writes its snapshots there, in `.playwright-cli/`. `WORK_DIR` is required; in this repository, `.playwright/` and `.playwright-cli/` are gitignored.
- **Turn on LM Studio's token auth:** "Require Authentication" in its server settings, with one of its tokens in `.env` as `MODEL_API_KEY`. It keeps other local processes and web pages away from LM Studio's API, though not this shell.
- **Keep keys in `.env`, not on the command line,** where a command could read them with `ps -E -p $PPID`. Neither this nor a dedicated `WORK_DIR` stops a command that goes looking.

## Configuration

Settings come from the environment, and from a local `.env` file, which is gitignored. Each value is trimmed, and a blank one counts as unset.
- **On Bun,** `.env` is read along with `.env.local`, and a file for `NODE_ENV` (`.env.development` when it's unset).
- **On Node,** only `.env` is read, through the `--env-file-if-exists` flag in `agent:node`. Without a `.env`, Node prints ".env not found. Continuing without it." to stderr, and carries on.

There are no implicit provider, model or operational settings. The Claude cache policy below is the only new provider default. Missing or invalid settings are reported together before networking.

| Variable | Required | Meaning |
|---|---|---|
| `MODEL_PROVIDER` | Yes | `lmstudio`, `openai` or `anthropic` |
| `MODEL_BASE_URL` | Yes | HTTP(S) base URL. Responses examples: `http://127.0.0.1:1234/v1` or `https://api.openai.com/v1`. For Claude, use `https://api.anthropic.com` or a proxy prefix: the SDK appends `/v1/messages` itself. |
| `MODEL_API_KEY` | Yes | Provider API key or LM Studio token. With LM Studio authentication off, any explicitly supplied nonempty value works. |
| `MODEL` | Yes | The model to use; LM Studio verifies this key or instance ID is already loaded. |
| `MODEL_REASONING_EFFORT` | Yes | Responses: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Anthropic: `low`, `medium`, `high`, `xhigh`, `max`. Check that the selected model supports the value. |
| `MODEL_MAX_OUTPUT_TOKENS` | Anthropic only | Positive safe integer in decimal digits, sent as Claude's per-call `max_tokens`. Rejected for Responses providers. |
| `ANTHROPIC_WORKSPACE_ID` | No | Optional Anthropic workspace ID for a key that needs one. |
| `LOG_FORMAT` | Yes | `pretty` or `json`. |
| `WORK_DIR` | Yes | Existing directory for the shell and file tools. A relative path resolves against the current directory; the real path is used. |
| `MAX_STEPS` | Yes | Maximum model calls in a session, a positive whole number. The old name `MAX_TURNS` is rejected. |
| `FILE_TOOLS` | Yes | `write-edit` or `apply-patch` (see [The file tools](#the-file-tools)). |
| `SKILLS_PATH` | No | Skill roots separated by `:`. If absent, no skills are loaded and no other directory is searched. |

For example, with LM Studio already serving a loaded model, a `.env` can contain:

```dotenv
MODEL_PROVIDER=lmstudio
MODEL_BASE_URL=http://127.0.0.1:1234/v1
MODEL_API_KEY=replace-with-your-lm-studio-token
MODEL=your-loaded-model
MODEL_REASONING_EFFORT=none
MAX_STEPS=30
FILE_TOOLS=write-edit
LOG_FORMAT=pretty
WORK_DIR=/absolute/path/to/existing/workdir
```

For the direct Claude API, replace the provider-specific lines with an Anthropic API key and a model available to your account, and keep the explicit operational settings above:

```dotenv
MODEL_PROVIDER=anthropic
MODEL_BASE_URL=https://api.anthropic.com
MODEL_API_KEY=replace-with-your-anthropic-api-key
MODEL=claude-sonnet-4-6
MODEL_REASONING_EFFORT=medium
MODEL_MAX_OUTPUT_TOKENS=4096
```

Claude uses the native Messages API, not a Claude subscription or an OpenAI compatibility endpoint. Every request enables automatic five-minute prompt caching; cache writes can cost more, and a hit depends on prompt length, prefix matching and cache lifetime. The agent reports the actual cache usage instead of promising a hit. Each request also asks for Claude's cache diagnostics against the previous reply, so a model call's `diagnostics` names what changed when the cache couldn't reuse that request's prefix; `null` means nothing did, or it is the first call. Tool schemas retain their constraints and are validated locally; Anthropic strict-tool mode is not enabled. Signed thinking and other native assistant blocks stay in the session's in-memory history, and a session cannot switch providers. History is not persisted to a database.

**Migrating:** Existing `.env` files must now supply every required setting and every invocation must supply a task. LM Studio no longer selects its first loaded model. Consumers of the old OpenAI-shaped core `callModel`, `toInput`, `toOutputItem`, `toFunctionTool` and `classify` exports must use Gremlin's provider-neutral core types and the agent's provider adapters instead. No persisted history migration is needed.

## Develop

```sh
bun run test           # unit tests (Vitest) on Bun; no LM Studio needed. test:watch for watch mode
bun run test:node      # every test again, on Node
bun run typecheck      # tsc --noEmit over the whole workspace
bun run lint           # oxlint, with type information; warnings fail too
bun run spellcheck     # CSpell, over code and docs alike
bun run format         # oxfmt: 4-space indentation, single quotes; format:check only checks
bun run check          # format:check, lint, spellcheck, typecheck, test and test:node, as CI would run them
bun run mutation       # Stryker mutation testing on Bun, which fails below 100%; report in reports/mutation/
```

- **Formatting.** oxfmt formats code and config files. Markdown, `openspec/`, `.claude/` and `.opencode/` are excluded in `.oxfmtrc.json`, so prose documents and generated command files keep their layout.
- **Spelling.** CSpell checks every file git doesn't ignore, except `bun.lock` and the command files OpenSpec generates under `.claude/commands/` and `.opencode/`.
  - It accepts American and British spellings.
  - Its TypeScript, Node, npm, full-stack, shell, Python, SQL and Docker dictionaries apply to every file, not only to their own file types, since the docs and config talk about code too.
  - A word it doesn't know goes in `words` in `cspell.json`. A token that isn't a word, such as a test string or a cluster of command-line flags, goes in `ignoreWords`.
- **Tests run on Bun and on Node,** the two runtimes the app runs on. `bun run test` runs every test on Bun, and `bun run test:node` runs them all again on Node.
  - Each script names its runtime in `TEST_RUNTIME`, and one of the agent's tests, `runtime.test.ts`, fails unless the tests run on the runtime it names, so it also fails for tests run without a script. Vitest's and Stryker's command-line scripts start Node, so `test`, `test:watch` and `mutation` start them with `--bun`.
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
  - Types from other packages can't always be made readonly, so `.oxlintrc.json` allows them by name or a narrow adapter boundary exempts them inline.
- **Linting uses type information,** through `oxlint-tsgolint`. That also turns on the type-aware rules in the enabled categories, such as `no-floating-promises`. Two of them are adjusted:
  - Tests may use type assertions (`no-unsafe-type-assertion` is off there), since they build malformed values on purpose.
  - `consistent-return` is off: TypeScript's `noImplicitReturns` checks the same thing, and knows when a switch covers every case.
- **The packages' boundaries are enforced by the linter,** through overrides in `.oxlintrc.json`.
  - `core` may not touch `process`, `Bun` or `console`.
  - `yaml` and `process` may not touch `process` or `console`: they report only through their results, and a spawned process gets only the environment it's given.
- **Every mutant must be caught.**
  - Stryker fails below a 100% mutation score, so a new branch or message needs a test that would notice it changing.
  - A mutant that behaves exactly like the original code, or sits in code that can't run, is usually better removed by simplifying the code.
  - Where the code can't reasonably change, a `// Stryker disable next-line` comment turns the mutant off, with the reason on the line above. There are four: `main.ts`' final `throw`, the `yaml` package's log level, where `''` behaves exactly like `'error'`, and two for the sweep's `ps`: its process group, since it lists the same processes from any group, and its working directory, since `''` means the current one, which works the same while it exists.
- **Tests fake the app's globals.** The app reads the environment, `fetch`, the clock and `console` directly, with nothing injected. Tests fake them with `vi.stubEnv`, `vi.stubGlobal` and `vi.spyOn`, and Vitest undoes every fake after each test. Importing `main.ts` runs it, so its tests import it only after faking, and never statically.
- **Tests start real processes, and a guard checks every signal they send.** The shell's and the sweep's tests run real commands, on Bun and on Node, and assert outcomes and signals, never elapsed time. [`test/signal-guard.ts`](test/signal-guard.ts), a Vitest setup file that Stryker never mutates, wraps `process.kill`. It refuses, and fails the test for, a signal that could reach pid 0, -1 or 1, the test process or its parent, or a process the test file can't vouch for: one it started, one carrying a run ID it registered, or a descendant of either. So even a mutant that widens the sweep's match can't reach your own processes. Processes a test leaves carry a fresh random run ID, and end on their own after 30 seconds at most.

## CI

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) builds every pushed branch, and pull requests from forks. It runs two jobs:

1. **Check and test:**
   - a frozen install, then the format check, lint, spell check and typecheck;
   - the tests on Bun (failures are annotated on the PR), then the whole suite again on Node;
   - the agent, started on Node against a port where nothing listens. It must exit with 1, saying it can't reach LM Studio. The tests load the code through Vite, so this is the one check that Node itself loads it;
   - `bun audit`, report only: the step shows as failed when there are advisories, but the job still passes.
2. **Mutation testing:** once the checks pass, Stryker runs on Bun and uploads its HTML report as the `mutation-report` artifact. The job fails if any mutant survives. It sets up only Bun, not Node.

Actions are pinned to commit SHAs, and there is deliberately no dependency cache shared between builds.
