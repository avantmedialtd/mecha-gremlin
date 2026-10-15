## Why

The agent's next step is to use Agent Skills, starting with Microsoft's playwright-cli skill, so it can drive a browser. The skill needs three things the agent lacks: skills it can find and load, a shell to run the skill's `playwright-cli` commands, and a turn budget that fits a browsing task. D18 settled where the shell runs until M1: on the host (Brief C12). After this change, `bun run hello` can carry out a task with the playwright-cli skill from start to finish.

## What Changes

- **`core`: skills as pure functions** (Brief 4.3):
  - `parseSkill` reads a SKILL.md's YAML frontmatter and body leniently, as the Agent Skills client guide recommends (Brief R12.7). It rejects a skill only when its frontmatter can't be parsed or it has no description, and warns about the rest.
  - `renderCatalog` and `renderActivation` build the skills section of the developer item and the text `activate_skill` returns.
  - `core` gains its first runtime dependency, `yaml`.
- **`core`: capped command output.** A head-and-tail reducer keeps the start and end of a stream within a byte limit, cuts on UTF-8 character boundaries, and makes NUL bytes visible. It is a streaming form of Brief 4.3's `truncateMiddle` and `normalizeOutput`, without their `binary` flag for now.
- **`server`: skills.**
  - Skills are loaded from the directories listed in `SKILLS_PATH`, earlier directories taking precedence. With it unset, no skill is loaded.
  - The developer item lists the loaded skills. An `activate_skill` tool, whose `name` is an enum of them, returns a skill's instructions, its directory and a list of its files.
- **`server`: a `shell` tool, on the host** (D18). It runs `bash -c` in the working directory with C3's process control: a process group of its own, a timeout that kills the group, closed stdin, an environment built from scratch, and capped output. When the session ends, whether it answers, fails, gets Ctrl-C, or is sent SIGTERM or a hangup, every process the session started is stopped if the group kill or the run-ID sweep can reach it. That includes processes that left the group, such as playwright-cli's browser.
- **`server`: `read_file` also reads files inside the loaded skills' directories,** by absolute path, so the model can read a skill's references.
- **BREAKING: the hello carries out a task instead of answering a question about a file.**
  - The command becomes `bun run hello [task…]`. With no task, it still asks what the `check` script in `package.json` runs.
  - Three new settings: `WORK_DIR`, the shell's working directory and `read_file`'s root, defaulting to the current directory; `SKILLS_PATH`; and `MAX_TURNS`, defaulting to 30.
- **Not in this change:**
  - the workspace container, which comes in M1 (C3, D3);
  - `write_file`, and images for the model;
  - budgets, the context check and compaction (C8, C5);
  - per-task skill selection, per-skill settings and trust (4.7);
  - any permission system, including enforcing a skill's `allowed-tools`, which the non-goal rules out.

## Capabilities

### New Capabilities
- `skills`: finding and parsing skills, the catalog in the developer item, and the `activate_skill` tool.
- `shell-tool`: the `shell` tool: how it runs a command, what the model gets back, its limits, and how a session's processes are stopped.

### Modified Capabilities
- `read-file-tool`: it may also read files inside the loaded skills' directories, by absolute path. Its other limits stay.
- `model-hello`: it carries out a task with the shell, `read_file` and the skills, instead of answering a question about a file. It gains three settings, logs the skills it loaded, and stops the session's processes when it ends.
- `tool-calls`: `core` may depend on `yaml`, which isn't a schema library. `core` still declares the Standard Schema interfaces itself.

## Impact

- **Code:**
  - `packages/core/src`: new `skills` and `output` modules, exported by name.
  - `packages/server/src`: new `skills/` and `exec/` folders, `tools/shell.ts` and `tools/activate-skill.ts`; changes to `tools/read-file.ts`, `config/config.ts` and `main/`.
  - Tests for all of it, the README and `.gitignore`.
- **Dependencies:** `yaml` 2.9 in `core`.
- **Security:** the shell runs as you, on the host (D18). A model steered by a web page can reach anything your account can, so `read_file`'s confinement no longer bounds what the agent can read. Its refusals stay as a guard on that tool alone.
  - **What building the environment from scratch does:** it keeps secrets out of what commands inherit and print by accident, such as environment dumps, daemons and logs.
  - **What it doesn't do:** stop a command from reading them. A command can read the hello's environment from its parent process, and `.env` is a readable file.
  - **LM Studio's token auth** protects its API from other local processes and from web pages, not from this shell.
  - C12's analysis judged a host shell defensible for attended runs against sites you pick.
- **Runtime:** a browsing task takes many turns, two for each page action, and on a local model that can be several minutes. It also needs a model loaded with a context of at least 32k tokens. LM Studio's default is 8k, and the skill's instructions plus one snapshot already exceed that.
- **Brief:**
  - The design answers Q12–Q17, and the `shell` tool brings part of C3's process control to the host before M1.
  - It departs from 4.3 and 4.7 in places:
    - the catalog function is `renderCatalog`;
    - `activate_skill` lives in the server;
    - every file a skill has is listed, and the catalog gives no paths;
    - output is captured as a stream rather than truncated after the fact.
