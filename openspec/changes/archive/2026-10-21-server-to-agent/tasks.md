## 1. The package and the scripts (`server`)

- [x] 1.1 `git mv packages/server packages/agent`. In `packages/agent/package.json` (design decision 2):
  - `name` becomes `@mecha-gremlin/agent`;
  - `description` becomes "The mecha-gremlin agent: carries out a task with a shell, read_file and skills".
- [x] 1.2 Root `package.json` (design decision 3):
  - `server` becomes `agent`: `bun packages/agent/src/main/main.ts`;
  - `server:node` becomes `agent:node`: `node --env-file-if-exists=.env packages/agent/src/main/main.ts`.

  No alias keeps the old names.
- [x] 1.3 Run `bun install`, so `bun.lock`'s workspace entries name `packages/agent` and `@mecha-gremlin/agent`. Check that `git diff bun.lock` touches only those entries.
- [x] 1.4 "The server" becomes "the agent" in code comments (design decision 4):
  - `src/config/config.ts`;
  - `src/exec/env.ts`, `src/exec/run.ts` and `src/exec/sweep.ts`;
  - `test/signal-guard.ts` at the root.

  Where a comment means the OS process, write "the agent's process". `src/main/failure.ts` and `src/model/lmstudio.ts` mean the model server or LM Studio's, so they don't change. Check with `grep -rni server packages/*/src test`.

## 2. Tests

- [x] 2.1 `packages/agent/test/main/main.test.ts`:
  - `runServer` becomes `runAgent`, and `startServer` becomes `startAgent`. Their `server: FakeServer` parameter is the fake model server and keeps its name;
  - the `server-*` temp-directory prefixes become `agent-*`;
  - the describe title becomes "Stop the session's processes when the agent ends", and the test becomes "no handler outlives the agent";
  - the comments that mean this program, such as "The servers this file starts" and "the server uses real paths", speak of the agent.
- [x] 2.2 The other tests' names follow the spec's scenario titles:
  - `skills.test.ts`: "the agent reports a skill without frontmatter" and "the agent reports a warning";
  - `shell.test.ts`: "the agent's secrets stay out".

  Model-server names stay: `FakeServer`, `session.test.ts`'s `server` parameter, "explains an unreachable server", "suggests starting LM Studio's server" and "a server error". Check with `grep -rni server packages/*/test test`.
- [x] 2.3 `bun run check` passes.

## 3. CI

- [x] 3.1 `.github/workflows/ci.yml`:
  - the `NODE_VERSION` comment says Node starts the agent;
  - the `test:node` comment says the agent runs on Node as well as Bun;
  - the step becomes "Start the agent on Node" and runs `bun run agent:node`;
  - its comment and its `::error::` message speak of the agent.

  Push with gh's credential, `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push`, because the keychain's token can't push workflow files.
- [x] 3.2 CI passes on the branch: both jobs, with the mutation job at 100%.

## 4. README and Brief

- [x] 4.1 README (design decision 8):
  - "the server" becomes "the agent" wherever it means this program: the packages table (`packages/agent`, `@mecha-gremlin/agent`, described as the agent, not the app), `packages/agent/src`, the runtimes and imports paragraphs, the Prerequisites' Node line, Run's commands and prose, the session and shell sections, the Skills example, "Give the agent a working directory of its own", the `.env`-on-Node note, the `MAX_STEPS` row, the `MODEL_PROVIDER=openai` example, the tests section's `runtime.test.ts` sentence and the CI section's Node step;
  - **kept:** "An OpenAI-compatible model server", `lms server start`, "the model server's cache" and "LM Studio's server settings".

  Afterwards, `grep -ni server README.md` shows only those.
- [x] 4.2 Brief.md (design decision 7):
  - D22 after D21;
  - `agent/` in 4.2's layout between `process/` and `app/`, with the loop moved out of `app`'s line;
  - the dated 2026-10-21 line after 2026-10-16's.

  Records, R14 and D19 keep their wording.
- [x] 4.3 `bun run spellcheck` and `bun run format:check` pass.

## 5. Live check (the session's)

- [x] 5.1 With the main checkout's `.env` settings and a model loaded in LM Studio:
  - `bun run agent 'Which runtime does README.md describe?'` answers and exits 0;
  - `bun run agent:node` does the same on Node.

  If LM Studio isn't running, say so, and rely on CI's Node start-up check.
- [x] 5.2 `bun run server` fails, saying there's no such script.

## 6. After archiving (the session's)

- [x] 6.1 After `openspec archive` (design decision 6), in one commit:
  - `git mv openspec/specs/server openspec/specs/agent`, and the title line becomes `# agent Specification`;
  - the Purpose lines of `agent`, `agent-loop`, `read-file-tool`, `shell-tool`, `skills` and `structured-log`, as decision 6 words them;
  - the scenario titles "The agent reports a skill it can't use", "The agent reports a warning" and "The agent's secrets stay out".
- [x] 6.2 Check:
  - "Run the agent on Bun or on Node" and "Stop the session's processes when the agent ends" are still the `agent` spec's last two requirements;
  - `openspec validate --specs --strict` passes, and `openspec doctor` finds nothing;
  - `grep -rni server openspec/specs` shows only model-server meanings.
- [x] 6.3 The memory note `folders-not-flat-no-indexes` points to `packages/agent/src`, not `packages/server/src`.
