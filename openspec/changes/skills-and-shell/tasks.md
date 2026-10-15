## 1. Core: skills (`skills`, `tool-calls`)

- [ ] 1.1 Add `yaml` at its newest version (2.9.1 or later) to `packages/core`'s `dependencies`, and check that `bun.lock` holds a single copy. Update `tools.test.ts`'s package test to tool-calls' scenario "No schema library in core": it now expects exactly `['yaml', 'openai']`, dependencies first
- [ ] 1.2 `packages/core/src/skills.ts`: `parseSkill(directoryName, text)` (design decision 2):
  - the text must start with a `---` line, and the frontmatter ends at the next `---` line, with CRLF accepted;
  - `parse(frontmatter, { logLevel: 'error' })`, which must give a mapping. The `''` mutant of `'error'` behaves the same, so it gets a `// Stryker disable next-line StringLiteral` comment with that reason;
  - a description that isn't blank, or a failure;
  - the name, falling back to the directory's name when it's missing, not a string or blank;
  - the warnings: that fallback, a name that differs from the directory's, a name over 64 characters, a description over 1,024 characters;
  - every other key ignored.
- [ ] 1.3 `renderCatalog(skills)`: the instruction (a skill's own files, by absolute path), then `<available_skills>` sorted by name, with `&`, `<` and `>` escaped (decision 3)
- [ ] 1.4 `renderActivation(skill, files)`: takes the skill and every file path below its directory, relative to it. It returns the `skill_content` element:
  - the body;
  - the `Skill directory:` line, and the line saying paths to the skill's own files are relative to it;
  - inside `<skill_resources>`, the files sorted, without `SKILL.md` at the top and without any path that has a segment starting with `.`;
  - at most 100, then a line giving how many more files there are, hidden ones not counted.
- [ ] 1.5 Unit tests for every `skills` scenario about `parseSkill`, the catalog and the activation text. Include:
  - frontmatter in the shapes seen in real skills: a flow-style nested `metadata` with trailing commas, a `homepage` key, and a quoted description holding backticks and colons;
  - a custom tag (`!thing`) and a collection used as a key, asserting with a spy that `process.emitWarning` isn't called.

## 2. Core: capped output (`shell-tool`)

- [ ] 2.1 `packages/core/src/output.ts`: `startCapture(limit)`, `appendCapture(capture, chunk)` and `renderCapture(capture)` (decision 6):
  - the head and a rolling tail of `limit / 2` bytes each, and the total;
  - the `[… N bytes omitted …]` line, with N counting every byte not shown;
  - cuts moved to UTF-8 boundaries by at most 3 bytes;
  - U+FFFD for invalid UTF-8, and `␀` for NUL.
- [ ] 2.2 Unit tests:
  - short and long output, with the exact counts from the spec's "Long output" scenario;
  - a 3-byte and a 4-byte character at the head's cut and at the tail's start;
  - characters split across chunks;
  - invalid UTF-8 and NUL bytes;
  - adding a chunk leaves the earlier capture unchanged.

## 3. Server: loading skills and `activate_skill` (`skills`)

- [ ] 3.1 `packages/server/src/skills/skills.ts`: `loadSkills(skillsPath, cwd)` (decision 1):
  - splits on `:`, skips empty entries, and resolves each root against `cwd`;
  - reads each root's subdirectories in sorted order, each `SKILL.md` with `parseSkill`;
  - records each skill's directory by its real path;
  - leaves out a skill whose name is already taken.

  It returns the skills, the ones not loaded (`path`, `reason`) and the warnings (`skill`, `warning`), for `main.ts` to log. All I/O goes through `node:fs/promises`.
- [ ] 3.2 `packages/server/src/tools/activate-skill.ts`: `activateSkillTool(skills)` (decision 3):
  - `defineTool`, with `z.strictObject({ name: z.enum(names) })` and the description from decision 3;
  - lists the files below the skill's directory at activation time, and renders them with `renderActivation`;
  - remembers the skills already activated, and answers a second activation with the short note.
- [ ] 3.3 Tests in real temporary directories for every `skills` scenario about loading and activation:
  - **roots:** a root holding a skill, entries that aren't skills, a relative root with empty entries, a blank `SKILLS_PATH`, a missing root, a root that is a file, a linked skill directory;
  - **names:** two roots that collide, and two directories in one root that declare the same name;
  - **rejected and warned:** a `SKILL.md` without frontmatter, frontmatter that isn't valid YAML, and a skill whose name differs from its directory;
  - **activation:** a skill under a hidden directory, `.DS_Store` and `.git/config` left out, 150 files plus a `.git` of 500, a second activation, an unknown name (the schema's error), and the closed schema with its enum.

## 4. Server: `read_file` reads the skills' directories (`read-file-tool`)

- [ ] 4.1 `readFileTool(root, skillDirectories)` (decision 4):
  - any path resolves against the root, an absolute one staying as it is;
  - it's allowed when it lands inside the root or any skill directory, both lexically and by real path;
  - the refusal says it is outside "the directories read_file may read";
  - the tool's and the `path` argument's descriptions mention absolute paths inside a skill's directory.

  Update the `READ_LIMIT` comment: a browsing run needs a larger context than LM Studio's 8k default.
- [ ] 4.2 Tests:
  - the new scenarios: a skill's file by absolute path, a link out of a skill directory, a relative path that exists only in a skill directory;
  - `.env` inside a skill directory is refused;
  - the existing refusal messages updated.

## 5. Server: the shell (`shell-tool`)

- [ ] 5.1 `packages/server/src/exec/env.ts`: `commandEnv(parentEnv, runId)`. It returns exactly the copied variables that are set, the fixed values (`PLAYWRIGHT_MCP_IDLE_TIMEOUT` included), `GREMLIN_RUN_ID` and `PLAYWRIGHT_CLI_SESSION` (decision 5). Its test asserts the exact object
- [ ] 5.2 `packages/server/src/exec/run.ts`: `runCommand(command, options)`. The options are `cwd`, `env`, `timeoutMs`, `graceMs`, `pipeWaitMs` and `captureBytes`. It:
  - checks the working directory first, and fails naming it when it's gone;
  - spawns `bash -c` with `node:child_process`, `detached: true` and stdin ignored;
  - settles once, on `error` or `exit`, never on `close` alone;
  - reads both streams into captures;
  - on timeout, sends SIGTERM to the group, then SIGKILL when the grace ends, even if bash has exited;
  - without a timeout, waits up to `pipeWaitMs` after bash exits, then SIGKILLs the group;
  - signals a group only when it is an integer above 1, through `process.kill`, ignoring `ESRCH`;
  - destroys both streams and clears every timer before it returns;
  - resolves to `ok({ exitCode or signal, timedOut, cut, stdout, stderr })`, or `err(reason)`;
  - exposes a way to kill the running command's group and wait for it to end, for `dispose()`.
- [ ] 5.3 `packages/server/src/exec/sweep.ts`:
  - a pure `findRunProcesses(psOutput, runId)`: the pid, ppid and pgid of each line holding `GREMLIN_RUN_ID=<id>`, preceded by a space and followed by a space or the end of the line;
  - a pure `checkMatches(matches, ownPid, parentPid)`: refuses a pid of 1 or below, the CLI's own pid or its parent, and more than 32 matches;
  - a pure `descendants(listing, pids)`, from the same listing;
  - `sweep(runId, { graceMs })`:
    - runs `ps axeww -o pid=,ppid=,pgid=,command=` with `maxBuffer` of 64 MiB and the environment `PATH` and `LC_ALL=C`;
    - sends SIGTERM, then polls every 50 ms until the grace ends;
    - SIGKILLs the survivors and their descendants' groups, but only groups above 1 that aren't the CLI's own;
    - skips `ESRCH` and `EPERM`;
    - resolves to a `Result` with the number stopped, and never rejects.
- [ ] 5.4 `packages/server/src/tools/shell.ts`: `createShell({ workDir, runId, parentEnv, limits })` returns `{ handler, dispose }`:
  - `limits` defaults to 120 s, 2 s, 1 s and 32 KiB;
  - the closed schema and the description from decision 5, built from the limits;
  - `.playwright/` created before the first command, ignoring failure;
  - the outcome text: `exit code: N` or `killed by SIGx`, `timed out after N s`, the `stdout:` and `stderr:` sections, `(no output)`, and the line on how to see cut output;
  - `dispose()`:
    - closes the shell, so later calls, and calls that haven't reached their spawn yet, fail saying the session is stopping and spawn nothing. The check sits right before `spawn`;
    - kills a running command's group and waits for it;
    - then sweeps;
    - returns the same promise on every call.
- [ ] 5.5 A Vitest setup file (`setupFiles`; Stryker never mutates it) that wraps `process.kill` for every test. It fails the test when a signal would reach:
  - 0, -1 or 1;
  - the test process or its parent;
  - a process the test can't vouch for.

  The test vouches for:
  - its own descendants;
  - processes carrying a run ID it registered;
  - the descendants of either, remembered from every listing it made;
  - every member of a process group whose leader was spawned during the test. The setup file records each spawned pid by wrapping `ChildProcess.prototype.spawn`.

  Signal 0 always passes.
- [ ] 5.6 Tests with real processes under Vitest on Node, which run on macOS locally and on ubuntu in CI, for every `shell-tool` scenario:
  - **the command:** the working directory, stdin, exit codes, a signal, a failed spawn, a deleted working directory, the cut-output line;
  - **the environment:** a variable set in the test's environment doesn't reach the command;
  - **the group:**
    - the timeout, SIGTERM ignored;
    - a child that finishes its cleanup within the grace after bash has exited. End the command with `; true` so bash doesn't exec the child;
    - a background job that closes both pipes, a job holding a pipe;
    - a process in a session of its own, with and without holding stdout. After the one holding stdout, both streams are destroyed, and its next write fails with `EPIPE`;
  - **the cap:** large output and NUL bytes;
  - **`findRunProcesses`:** recorded `ps` output from macOS and from procps, with another run's ID that only starts with this one, and an `OLD_GREMLIN_RUN_ID`;
  - **the guard:** 33 matches, the CLI's own pid and its parent;
  - **`sweep()`:** tagged processes, one ignoring SIGTERM, a tagged parent with an untagged child in its own group, and nothing to stop;
  - **`dispose()`:** no command after `dispose()`, and a second call.

  The rules from decision 10:
  - assert outcomes and signals, never elapsed time;
  - helpers print `ready` once their handlers are installed, and the test waits for it;
  - tagged processes are `node`, never `sleep`;
  - every test that leaves a tagged process or calls `dispose()` uses a fresh random run ID;
  - poll for a grandchild's end until `ESRCH` or a zombie;
  - `sleep 30`, not `sleep 1000`.

## 6. Server: the hello carries out a task (`model-hello`)

- [ ] 6.1 `config.ts`:
  - `loadWorkDir(env)`, beside `loadLogFormat`, returns `WORK_DIR`'s trimmed value or undefined, so `main.ts` has it even when `loadConfig` fails;
  - `loadConfig` reads `SKILLS_PATH`, and `MAX_TURNS`, a positive integer in decimal digits defaulting to 30;
  - `MAX_TURNS` is checked whatever `MODEL_PROVIDER` holds, so an unknown provider doesn't hide its error;
  - each problem is named in its own error, and both functions stay pure.
- [ ] 6.2 `main/args.ts`: `parseArgs` returns the task: the arguments joined with spaces, or the default task
- [ ] 6.3 `main.ts`:
  - **settings:** resolves `WORK_DIR` against the current directory and checks it's an existing directory, even when `loadConfig` reports errors, then logs every error and exits; afterwards uses its real path everywhere;
  - **skills:** loads them, and logs `skill not loaded`, `skill warning` and `skills`;
  - **run ID:** the first 8 hexadecimal characters of `crypto.randomUUID()`;
  - **handlers:** installs them for SIGINT, SIGTERM and SIGHUP before `createSession`. The first signal logs `interrupted`, stops the loop over the steps, awaits `dispose()` and exits with 130, 143 or 129; later signals are ignored;
  - **session:** builds the developer item (decision 9), adding the catalog when there are skills, and passes `read_file`, `shell`, then `activate_skill` to `createSession` with `maxTurns`;
  - **log:** `asking` with `model`, `baseUrl`, `run`, `workDir` and `task`;
  - **at the end:** awaits `dispose()` in a `finally`, logs `stopped` or `cleanup failed`, and removes the handlers.
- [ ] 6.4 `main/failure.ts`:
  - the turn-limit message suggests a narrower task or a higher `MAX_TURNS`;
  - the timeout, incomplete and no-answer messages speak of the task.
- [ ] 6.5 Tests for every `model-hello` scenario, with the fake model server, a temporary `WORK_DIR` (a symbolic link in its own test) and a temporary `SKILLS_PATH`:
  - **setup:** `WORK_DIR`, `SKILLS_PATH` and `MAX_TURNS` join `main.test.ts`' `SETTINGS`, so a developer's own settings can't leak in;
  - **the task:** the default task, a task from the arguments;
  - **the session:** the tools offered with and without skills, the developer item, an answer after a real `shell` command, `MAX_TURNS`;
  - **settings errors:** the new settings' errors, including the three-error scenario;
  - **records:**
    - the `skills` and `asking` records, the latter with a fresh random run ID;
    - the `warn` records `skill not loaded` (with `path` and `reason`) and `skill warning` (with `skill` and `warning`), from a `SKILLS_PATH` with a missing root, a `SKILL.md` without frontmatter, and a skill whose name differs from its directory;
  - **cleanup:**
    - `stopped` after a command leaves a detached `node` process, with a random run ID;
    - `cleanup failed` with the sweep's `ps` made to fail;
    - each signal, and SIGINT twice, emitted on `process` while a turn is pending, with `process.exit` stubbed and awaited with `vi.waitFor`;
    - the listener count restored;
  - **failures:** the updated failure messages.

## 7. Docs

- [ ] 7.1 README:
  - **the hello:** its task form, with quoted examples and why quoting matters in zsh;
  - **settings:** `WORK_DIR`, `SKILLS_PATH` and `MAX_TURNS` in the settings table;
  - **the shell:** what it does, its limits, and what it can reach: anything your account can (D18). An environment built from scratch stops accidental leaks, not a command that goes looking;
  - **skills:** the playwright-cli example (`SKILLS_PATH=$(npm root -g)/@playwright/cli/skills`);
  - **set-up:**
    - loading the model with at least 32k of context (`lms load <model> --context-length 32768`, checked with `lms ps`);
    - a dedicated `WORK_DIR` outside the repository;
    - LM Studio's token auth;
    - keys in `.env`, not on the command line, where a command can read them with `ps -E -p $PPID`. The OpenAI example keeps `MODEL_API_KEY` in `.env` and passes only `MODEL_PROVIDER=openai MODEL=gpt-5.5` inline;
  - **other sections:** what `read_file` reads now, the layout table, and the Stryker-disable count.
- [ ] 7.2 `packages/server/package.json`'s `description`: the app carries out a task with a shell, `read_file` and skills
- [ ] 7.3 `.gitignore`: add `.playwright/` and `.playwright-cli/`

## 8. Verification

- [ ] 8.1 `bun run check` passes: format, lint, type-check and tests
- [ ] 8.2 `bun run mutation` reaches 100%. Where a mutant can't be caught, simplify the code, or disable it with a `// Stryker disable` comment and its reason
- [ ] 8.3 CI passes on ubuntu, including the shell and sweep tests against procps' `ps`
- [ ] 8.4 Against the local LM Studio, after recording the loaded model's context with `lms ps`:
  - `bun run hello` answers the default task by reading `package.json`;
  - with `SKILLS_PATH=$(npm root -g)/@playwright/cli/skills` and a dedicated `WORK_DIR`, `bun run hello 'Use the playwright-cli skill to find the title of https://example.com'` activates the skill, runs `playwright-cli`, answers "Example Domain", and exits 0;
  - afterwards `pgrep -fl gremlin-<run>` prints nothing, where `<run>` is the `asking` record's `run`. Either the model closed the browser itself, or the log shows `stopped`;
  - Ctrl-C during a long `sleep` leaves no `sleep` running, and the exit code is 130;
  - `bun run hello 'Use the playwright-cli skill to list stories 10 to 12 on the Hacker News front page'`, which needs a snapshot beyond the cap or a file read, either answers or stops cleanly at `MAX_TURNS`.
- [ ] 8.5 After `openspec archive`, which is the archiving session's step, not the implementer's:
  - replace the placeholder Purposes of `openspec/specs/skills/spec.md` and `openspec/specs/shell-tool/spec.md`;
  - rewrite model-hello's Purpose: the hello carries out a task through the agent loop with a shell, `read_file` and skills;
  - move "Carry out a task and log the answer" to the top of model-hello, and "Never read outside the root and the skill directories" to second place in read-file-tool;
  - run `openspec validate --all --strict`.
