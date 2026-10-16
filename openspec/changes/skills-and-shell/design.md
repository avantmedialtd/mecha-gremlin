## Context

The agent has one tool, `read_file`, confined to the working directory, and a session that runs at most 8 turns by default. `core` has the tool-calling pieces (`toFunctionTool`, `classify`, `validateArgs`, `toOutputItem`, `toInput`) and `runTurn`. The hello asks a question about a file.

The Brief already decides most of this change's shape:
- **D18:** until M1, the shell runs on the host, as the user. C12 lists what a host shell needs: an environment built from scratch, a working directory of its own, a `.playwright/` folder and a per-run `PLAYWRIGHT_CLI_SESSION`, `CI=1`, cleanup at run end, and LM Studio's token auth.
- **C4 and 4.7:** skills are SKILL.md folders; the catalog goes in the developer item; an `activate_skill` tool with an enum of names loads one.
- **C3:** the shell's process control: process-group kills, a short pipe wait, closed stdin, prompt-disabling variables, a head-and-tail output cap read from the streams, `GREMLIN_RUN_ID`, and a run-end sweep.
- **R12:** what the playwright-cli skill needs, how its daemon behaves, and the Agent Skills client guide.

**Probes, 2026-10-15, on the development Mac** (throwaway scripts, not project code):
- **Finding a run's processes.** On macOS, `ps axeww -o pid=,command=` shows the environment of the user's own processes, except Apple's platform binaries; `ps -e` doesn't. A playwright-cli session started with `GREMLIN_RUN_ID` in its environment showed it on its daemon (Node), but not on its 7 Chrome processes.
- **Stopping them.** SIGTERM to the daemon alone stopped all 7 Chrome processes, and the CLI then reported the session closed. In the review's runs this took 60–160 ms.
- **What the CLI prints.**
  - Action commands such as `open`, `goto` and `click` print about 250 B, and write the page's snapshot to `.playwright-cli/page-….yml` in the working directory.
  - An explicit `snapshot` prints the whole tree to stdout: 48,250 bytes for Hacker News' front page. That's despite SKILL.md's comment that it saves to a file.
- **An idle backstop.** The CLI sets its daemon's idle timeout from `PLAYWRIGHT_MCP_IDLE_TIMEOUT`, in milliseconds. The default is an hour.
- **Parsing skills.** `yaml` 2.9.1 parsed the frontmatter of all five skills installed on this machine. That included a nested, flow-style `metadata` with trailing commas, a non-standard `homepage` key, and a 1,008-character description. With its default options, `yaml` sends warnings such as an unresolved tag to `process.emitWarning`, which prints to stderr.

**Constraints:**
- tests and mutation testing run on Bun, the production runtime, once the `tests-on-bun` change is in, which this change builds on. `core`'s tests also run on Node, because `core` must work there;
- Stryker's score must stay at 100%;
- parameters are readonly and failures are `Result` values;
- code lives in folders by concern, with no index files;
- dependencies are at their newest versions.

## Goals / Non-Goals

**Goals:**
- With `SKILLS_PATH` pointing at playwright-cli's skills, `bun run hello '<task>'` can carry out a browsing task: activate the skill, run `playwright-cli` commands, read what they print and the snapshot files they write, and answer.
- Skills are loaded as the Agent Skills spec and client guide describe, leniently enough for skills written for other clients.
- A host shell with C3's process control. When a session ends, whether by an answer, a failure, Ctrl-C, SIGTERM or a hangup, every process the group kill or the run-ID sweep can reach is stopped.
- Everything is testable without a model server. The shell is tested with real processes, on the Mac and on CI's ubuntu, without a test that can hurt the developer's own processes, even under mutation.

**Non-Goals:**
- **The workspace container** (C3, D3). It comes in M1, and the process-control code moves into its exec server then.
- **`write_file`,** and images for the model. The shell can write files, and playwright-cli's snapshots are text.
- **Budgets, the context check, the finalize turn and compaction** (C8, C5). `MAX_TURNS` is the only limit.
- **Per-task skill selection, per-skill settings, slash-command activation and trust checks** (4.7). Every skill in `SKILLS_PATH` is offered.
- **Enforcing a skill's `allowed-tools`,** or any other permission system (the non-goal).
- **A persistent shell,** where `cd` and variables carry over between calls; model-chosen timeouts; streaming output while a command runs.
- **Recovery after the hello itself is killed with SIGKILL, or crashes.** Nothing of the hello runs then. playwright-cli's idle timeout is the backstop (decision 5).
- **Windows.**

## Decisions

**1. Skills come from `SKILLS_PATH`, and only from there.**
- **Format:** `SKILLS_PATH` lists skills roots, separated like `PATH` (`:`). A root is a directory whose subdirectories are skills, `<root>/<name>/SKILL.md`: the layout of `.agents/skills`, and of playwright-cli's package (`$(npm root -g)/@playwright/cli/skills`). Relative entries resolve against the current directory, and empty entries are ignored.
- **What counts as a skill:** each subdirectory of a root that holds a file named exactly `SKILL.md`. Other entries are skipped without a word, and nothing deeper is searched.
- **One skill per name:** roots are read in the order listed, and each root's subdirectories in sorted order. When a name is already taken, in the same root or an earlier one, the later skill isn't loaded, and a `warn` record names it and the skill that took the name. Names can collide inside one root, because a name that differs from its directory is used anyway (decision 2).
- **A missing root** (not there, or not a directory) gets a `warn` record, and the other roots still load.
- **Real paths:** each skill's directory is recorded by its real path, with symbolic links resolved. `~/.claude/skills` holds links into `~/.agents/skills`, for example, and `read_file`'s real-path check must agree with the directory the model was given (decision 4).
- **Unset or blank:** no skills, no catalog and no `activate_skill`.
- **Why explicit:** scanning `~/.agents/skills` here would load skills written for other agents, such as `find-skills`, which tells an agent to install more skills (Q13). Pointing at the installed package's copy keeps the skill in step with the CLI (R12.1).
- **Alternatives:**
  - The guide's default scan of `<project>/.agents/skills` and `~/.agents/skills`.
  - A copy made with `playwright-cli install --skills`, which goes stale.
  - The `skills:` list of a TASK.md (4.7), which needs tasks first.

**2. `core` parses SKILL.md leniently.**
- **`parseSkill(directoryName, text)`** returns a `Result`. It holds `{ name, description, body, warnings }`, or the reason the skill can't be used.
  1. The text must start with a `---` line, and the frontmatter ends at the next `---` line. CRLF line endings are accepted. Without frontmatter, the skill can't be used.
  2. The frontmatter is parsed with `yaml`'s `parse(frontmatter, { logLevel: 'error' })`, and must be a mapping. Otherwise the skill can't be used, and the reason quotes the parser's first line.
     - With its default `logLevel`, `yaml` sends warnings to `process.emitWarning`, which prints to stderr, and `core` must not write there (model-turn).
     - `'silent'` would also stop errors from throwing.
     - Under `'error'`, an unresolved tag such as `!thing` simply reads as a string.
  3. `description` must be a string that isn't blank once trimmed; otherwise the skill can't be used. The guide treats a description as essential, because it's all the model sees before activation.
  4. `name` is the trimmed string. When it's missing, not a string, or blank, the directory's name is used, with a warning. A name that differs from the directory's, or is longer than 64 characters, gets a warning and is used anyway.
  5. A description longer than 1,024 characters gets a warning and is used whole.
  6. The body is the text after the closing `---`, trimmed.
  7. Every other key is ignored: `license`, `compatibility`, `metadata`, `allowed-tools` and any unknown one. `allowed-tools` would need a permission system, and per-skill settings come later.
- **Why lenient:** the client guide asks for it (R12.7), and real skills stray from the spec. `browser-use` here has a nested `metadata` and a `homepage` key.
- **Why in `core`:** it's pure, data in and data out, and Brief 4.3 puts `parseSkill` there.
- **`yaml` becomes `core`'s first runtime dependency.** It has no dependencies of its own, runs anywhere `core` does, and is at its newest version, 2.9.1. tool-calls' "no schema library" scenario now allows it by name.
- **Alternatives:**
  - YAML parsed in the server, with `core` taking the parsed object. That splits one job across two packages.
  - A hand-written parser. It would fail on quoting, block scalars and flow maps.
  - `Bun.YAML`. `core` may not use `Bun` (lint): it must work on Node too, and its tests run there as well.
  - The guide's retry for unquoted colons. None of the skills here needed it, and a skill that fails to parse is reported by name.

**3. The catalog goes in the developer item, and a skill is activated with `activate_skill`.**
- **The catalog** (`renderCatalog(skills)` in `core`) is a short instruction, then the skills sorted by name:
  ```
  Skills give you instructions for particular kinds of task. When a task matches a skill's
  description, call activate_skill with the skill's name before you start, then follow its
  instructions. Read a skill's own files with read_file, by absolute path.

  <available_skills>
  <skill>
  <name>playwright-cli</name>
  <description>Automate browser interactions, test web pages and work with Playwright tests.</description>
  </skill>
  </available_skills>
  ```
  - `&`, `<` and `>` in names and descriptions are escaped, so a description can't close a tag.
  - Sorting keeps the developer item byte-identical between runs with the same skills, which the prompt cache wants (4.6).
  - The skill's location isn't listed: activation gives its directory, so the guide lets the catalog leave it out.
- **`activate_skill`** is a tool in the server, offered only when at least one skill is loaded.
  - **Description:** "Load a skill's full instructions, with its directory and the list of its files. Name a skill from the available_skills list in your instructions."
  - **Schema:** `z.strictObject({ name: z.enum(names) })`, so the model can't name a skill that doesn't exist. `validateArgs` rejects any other name, and its error shows the names the schema accepts.
  - **Output** (`renderActivation(skill, files)` in `core`): the body, wrapped, with the directory and the skill's files:
    ```
    <skill_content name="playwright-cli">
    …the body of SKILL.md…

    Skill directory: /opt/homebrew/lib/node_modules/@playwright/cli/skills/playwright-cli
    Paths to this skill's own files, such as references/…, are relative to the skill directory.

    <skill_resources>
    <file>references/element-attributes.md</file>
    …
    </skill_resources>
    </skill_content>
    ```
  - **The path line is narrow on purpose.** playwright-cli's SKILL.md also shows paths that commands print, such as `.playwright-cli/page-….yml`. Those are relative to the working directory, and the developer item says so (decision 9). A blanket "relative paths in this skill" would send the model to the skill's directory for them.
  - **Files** are listed when the skill is activated, not read.
    - Every file below the skill's directory is listed by its path relative to that directory, sorted. `SKILL.md` at the top is left out, and so is every path with a segment starting with `.`, judged on the relative path, so a skill under `~/.agents/skills` still lists its files.
    - At most 100 are listed. When more remain, a line inside `<skill_resources>` gives how many more files there are; hidden files aren't counted.
  - **A second activation** of the same skill in a session returns a short note saying it's already active, rather than the same instructions again (the guide's deduplication).
- **Why a tool rather than reading SKILL.md:**
  - the enum stops invented names;
  - the frontmatter is stripped;
  - the model is told where the files are;
  - every activation is a logged tool call;
  - a small model follows a named tool more reliably than "read the file at this path" (C4, Q12).
- **Alternatives:**
  - File-read activation through `read_file`.
  - The catalog in the tool's description. That keeps the developer item free of skills, but 4.6 puts the catalog with the rules, and the instruction to use skills belongs there.
  - Listing the files' contents up front. It costs context the model may never need.

**4. `read_file` also reads files inside the skills' directories.**
- **`readFileTool(root, skillDirectories)`** resolves any path against the root, an absolute path staying as it is. The path is allowed when it lands inside the root or inside any skill directory, checked twice:
  - lexically;
  - by real path, after following links.

  Each check passes when the path is inside any allowed directory. A link that leads outside every allowed directory is refused.
- **Unchanged:** the `.env` refusal, directories, binary files and the 32 KiB cap.
- **The refusal** says the path is outside "the directories `read_file` may read".
- **The description and the `path` argument's description** say that a path is relative to the working directory, or absolute inside a skill's directory, so the model knows to use the absolute paths activation gives it.
- **Why not a separate tool:** one reading tool keeps `tools[]` small (C4), and the guide says to allowlist skill directories for the agent's file tool (R12.7). The host shell could `cat` the files too, but `read_file` caps them, refuses binary files, and is logged as a read.

**5. `shell` runs `bash -c` on the host, with C3's process control.**
- **Schema:** `z.strictObject({ command: z.string() })`. The model can't choose a timeout. Strict mode would need a required, nullable field, and nothing in this change needs more than the fixed limit.
- **Limits are parameters:** `createShell` takes `limits`, made of `timeoutMs`, `graceMs`, `pipeWaitMs` and `captureBytes`, which default to 120 s, 2 s, 1 s and 32 KiB. The description, the `timed out after N s` line and `dispose()`'s grace all come from them, so tests can use milliseconds.
- **Before spawning,** the runner checks that the working directory still exists. If it doesn't, the outcome fails with an error naming the directory. Otherwise both runtimes would report `spawn bash ENOENT`, which reads as if bash were missing.
- **Spawn:** `node:child_process`'s `spawn('bash', ['-c', command], { cwd: workDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`:
  - `detached: true` gives the command a process group of its own, so one signal reaches everything it started that stayed in the group (R8). Ctrl-C's SIGINT goes to the terminal's foreground group and so misses it; decision 8 handles that.
  - stdin is `/dev/null`, so a command that reads input gets end-of-file instead of waiting (C3).
  - `node:child_process` rather than `Bun.spawn`. It behaves the same on Bun and on Node for every primitive used here (the review's experiments), so M1's exec server can reuse the runner on either runtime.
  - The outcome settles once, on `error` or `exit`, never on `close` alone. Node fires `close` with code -2 after a spawn error.
- **Environment, built from scratch, never from `process.env`.** Bun fills `process.env` from `.env` and the user's shell, and children inherit it (C12). bash is started with only:
  - from the CLI's own environment, when set: `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and `LC_ALL`;
  - fixed values:
    - C3's list: `CI=1`, `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0` and `DEBIAN_FRONTEND=noninteractive`;
    - `NO_COLOR=1` and `TERM=dumb`, against colour codes;
    - `PLAYWRIGHT_MCP_IDLE_TIMEOUT=900000`, which closes an abandoned browser after 15 minutes idle rather than an hour;
  - per session: `GREMLIN_RUN_ID` and `PLAYWRIGHT_CLI_SESSION` (decision 7).

  bash adds its own variables, such as `PWD`, `SHLVL` and `_`, to what the command sees.
- **Limits:**
  - **Timeout:** at `timeoutMs`, the group gets SIGTERM. Once the timeout has fired, the grace governs: the group gets SIGKILL when `graceMs` ends, even if bash has already exited, so a child shutting down cleanly gets the whole grace (C3).
  - **After bash exits** (without a timeout), the runner waits up to `pipeWaitMs` for stdout and stderr to close, then SIGKILLs the whole group and returns what it read. A background child can't hang the call by holding a pipe (R10), and background jobs don't outlive the command.
  - **A process that leaves the command's process group isn't stopped this way.** It can leave by starting a session of its own, as playwright-cli's daemon does, through job control such as `set -m`, or through a tool that makes its own group, such as GNU `timeout`.
  - When the session ends, the sweep stops it if `ps` shows its run ID (decision 7). On macOS, an Apple binary's run ID doesn't show.
  - **Group kills** go only to an integer process group above 1. After a failed spawn, `child.pid` is undefined, and `-(pid ?? 0)` would be `kill(0)`, the CLI's own group.
  - **Handles:** when the runner returns, it destroys both streams and clears every timer it set. A child that left the group may still hold a pipe, and the hello must not wait for it before exiting.
  - **Output cap:** each stream keeps its first 16 KiB and its last 16 KiB through `core`'s capture (decision 6). That's the same 32 KiB as `read_file`, so a typical page's snapshot arrives whole. Memory stays flat whatever the command writes, because the streams are read and the middle discarded, never buffered (C3).
- **What the model gets back** is an `ok` outcome whatever the exit code:
  ```
  exit code: 1
  stdout:
  …
  stderr:
  …
  ```
  - The first line is `exit code: N`, or `killed by SIGKILL` when a signal ended bash.
  - When the timeout fired, the next line is `timed out after N s`, with N the timeout in seconds.
  - A stream's section appears only when it isn't empty, and `(no output)` stands in when both are.
  - When a stream was cut, a last line says how to see the rest: write the output to a file in the working directory, then search it with `grep`, or print a part with `sed -n` or `tail -c`. `read_file` stops at 32 KiB, the same as the shell's cap. Explicit snapshots of large pages are cut, so this matters on the skill's main path.

  A non-zero exit isn't a failed outcome: the model needs the output to act on it (Brief 4.5). The outcome fails only when bash can't be started, or once the shell is closed (decision 7), and the error says why.
- **The description tells the model:**
  - the command runs in bash, in the working directory;
  - each call is a fresh shell, so `cd` and variables don't carry over;
  - stdin is closed;
  - background processes stop when the command ends, unless they leave its process group, as playwright-cli's browser does;
  - the output cap and the time limit;
  - commands run on this computer as the user, so it should stop only what it started. A playwright-cli browser closes with `playwright-cli close`, never `kill-all` or `close-all`, which reach other tools' browsers. The session's processes are stopped when it ends anyway.
- **Alternatives:**
  - A persistent shell, as in OpenHands and SWE-ReX. It keeps `cd` and variables between calls, but needs prompt sentinels and process control of its own.
  - `Bun.spawn`. With the tests on Bun it could be tested, but it would tie the runner to Bun, and `node:child_process` already does everything needed.
  - One pipe for both streams. That needs a wrapper around the command, and two sections read just as well.
  - A timeout the model chooses.

**6. `core` caps command output with a pure reducer.**
- **`core/output.ts`:**
  - `startCapture(limit)` returns an empty capture;
  - `appendCapture(capture, chunk)` returns a new capture. It keeps the first `limit / 2` bytes, a rolling window of the last `limit / 2`, and the total byte count;
  - `renderCapture(capture)` returns the text:
    - the head, then, when anything was dropped, a line of its own reading `[… N bytes omitted …]`, then the tail;
    - N counts every byte not shown, including those dropped by moving a cut to a character boundary;
    - cuts move to UTF-8 character boundaries, by at most 3 bytes;
    - invalid UTF-8 decodes as U+FFFD, and NUL shows as `␀`.
- **Immutable:** a chunk never changes the capture it's added to (the readonly rules), and memory is bounded by the limit, not by the stream.
- **Why in `core`:** Brief 4.3 lists `truncateMiddle` and `normalizeOutput` there, and M1's exec server reuses them. Their `binary` flag isn't needed yet.

**7. When a session ends, every process it started is stopped.**
- **Run ID:** every hello run gets one, the first 8 hexadecimal characters of `crypto.randomUUID()`, logged in the `asking` record.
- **Every command carries it** as `GREMLIN_RUN_ID` (C3), and as `PLAYWRIGHT_CLI_SESSION=gremlin-<run id>`. So a run drives a browser of its own, not the `default` session every caller of the install shares (R12.2).
- **The `.playwright/` folder:** before its first command, the shell creates `.playwright/` in the working directory if it's missing. playwright-cli then scopes `list` and `close-all` to the sessions started from that directory (R12.2). That holds only within the working directory, and only for the CLI's own scoping: a host shell can still reach anything the user can (D18). A failure to create it is ignored, since playwright-cli works without it.
- **The shell's `dispose()`**, called when the session ends, whatever the outcome:
  1. **Closes the shell.** From then on, a `shell` call starts nothing and fails with "the session is stopping; the command was not run".
     - Killing the running command resumes the session, which goes straight on to its next call or turn while the sweep is still running. Without the closed state, a new command could start after the listing and outlive the run.
     - The handler checks the state immediately before `spawn`, after its own awaits (the working-directory check and the `.playwright/` folder). A call that began before `dispose()` therefore can't start a command after it.
  2. **Kills the running command,** if there is one, with SIGKILL to its group, and waits for it to end. Its dying processes then don't show up in the listing, and the count is deterministic.
  3. **Lists processes** in one call, `ps axeww -o pid=,ppid=,pgid=,command=`, with a large output limit (64 MiB) and a fixed environment (`PATH`, `LC_ALL=C`). A process matches when its line holds `GREMLIN_RUN_ID=<run id>`, preceded by a space and followed by a space or the end of the line. The match runs over the command line and the environment as `ps` prints them, so a process whose arguments name this run's ID matches too.
  4. **Guards against a wide match.** The sweep signals nothing, and reports why, when a match is pid 1 or below, is the CLI's own process or its parent, or there are more than 32 matches. Stryker activates one mutant at a time, so a mutant that widens the matcher can't also remove this guard, which has tests of its own.
  5. **Signals.** Before signalling, it records each match's descendants from the same listing. It sends each match SIGTERM, then polls every 50 ms until they've all exited or the grace ends.
  6. **Escalates.** When the grace ends, it SIGKILLs the matches still running, and the process groups of their descendants still running. A daemon killed this way would otherwise leave Chrome, which leads its own group and hides its environment, beyond any sweep. A group kill goes only to a group above 1 that isn't the CLI's own, the runner's rule, so a parsing slip can't reach the hello's group or every process the user owns.
  7. **Skips** processes that have already exited (`ESRCH`) or belong to another user (`EPERM`). Those can't be part of the run.
  8. **Resolves to a `Result`:** the number of processes it stopped, or why the sweep couldn't run. It never rejects, and later calls return the first call's promise.
- **Why it works,** measured on this Mac (Context):
  - the daemon shows the run ID, and SIGTERM to it stops the browser;
  - Linux's procps takes the same `ps` flags, and CI runs the sweep's tests on ubuntu;
  - playwright-cli's daemon starts a session of its own and so escapes every group kill, and an idle headless session lives an hour unless `PLAYWRIGHT_MCP_IDLE_TIMEOUT` says otherwise (R12.2). Codex Desktop's skill leaks them in exactly this way.
- **Alternatives:**
  - `playwright-cli -s=gremlin-<id> close`. It only works for that one tool, while the sweep catches any process that escaped its group.
  - Reading `/proc/<pid>/environ`, which exists only on Linux.
  - Relying on the CLI's idle timeout alone, which leaves a browser running for 15 minutes after every run.

**8. Ctrl-C, SIGTERM and a hangup stop the session's processes too.**
- **The problem:** a command runs in a process group of its own, so the terminal's SIGINT, and the hangup when the terminal closes, never reach it. Without handling, they would leave it running with nothing to time it out.
- **When the handlers live:** `main.ts` installs handlers for SIGINT, SIGTERM and SIGHUP before `createSession`, and removes them in `run()`'s `finally`, once `dispose()` has resolved. No handler outlives the hello, and repeated imports in tests don't pile up listeners.
- **The first signal:**
  - logs a `warn` record `interrupted` with the signal;
  - stops the loop over the session's steps;
  - awaits `dispose()`;
  - exits with 130 for SIGINT, 143 for SIGTERM or 129 for SIGHUP.
- **Later signals** are ignored while `dispose()` runs. Under `bun run`, one Ctrl-C reaches `main.ts` twice, and a "second Ctrl-C forces exit" rule would skip cleanup every time.
- **`process.exit` is used here, unlike anywhere else,** because the session may be suspended mid-turn, waiting on the model, and has no way to end on its own.
- **Alternative:** passing an abort signal through the session into `runTurn` and the shell, so the session ends with a step. That's cleaner, but it widens `createSession`'s contract for a case where exiting is all that's wanted.

**9. The hello carries out a task.**
- **Arguments:** `bun run hello [task…]`. The arguments, joined with spaces, are the task, and with none it's "What exact command does the check script in package.json run? Quote it.", the old default question, now self-contained.
- **Quote the task,** in single quotes unless it holds one. The shell reads `?`, `*`, `&`, `;`, `!` and `$` itself. In zsh, macOS's default shell, an unquoted `?` stops the command with "no matches found" before Bun runs. The examples in the README and here are all quoted.
- **Starting history:**
  - **developer item:** "You carry out tasks on this computer. You have a shell, and read_file for reading text files. The working directory is {workDir}, and paths that commands print are relative to it. Keep your final answer brief." When skills are loaded, the catalog follows.
  - **user item:** the task.
- **Tools, in this order:**
  1. `read_file`, rooted at the working directory, with the skills' directories;
  2. `shell`;
  3. `activate_skill`, when skills are loaded.
- **Settings:**
  - **`WORK_DIR`:** the shell's working directory and `read_file`'s root, defaulting to the current directory.
    - `loadWorkDir(env)`, beside `loadLogFormat` in `config.ts`, reads the raw value, so `main.ts` has it even when `loadConfig` fails. `main.ts` resolves it against the current directory, checks that it's an existing directory, and uses its real path everywhere: the developer item, the `asking` record, `read_file`'s root and the shell's working directory. On macOS `/tmp` and `/var` are links, and a path built from `pwd` would otherwise fail `read_file`'s lexical check.
    - `main.ts` checks `WORK_DIR` even when `loadConfig` reports errors, and logs every error before exiting.
  - **`SKILLS_PATH`:** decision 1.
  - **`MAX_TURNS`:** a positive integer in decimal digits, defaulting to 30, which leaves room for about a dozen page actions at two turns each. `loadConfig` checks it whatever `MODEL_PROVIDER` holds, so an unknown provider doesn't hide its error. It's passed to `createSession`. The session's own default of 8 stays, so the `agent-loop` capability is unchanged.
- **Log:**
  - `skills` (`info`), when at least one skill loads, with the field `names`;
  - `skill not loaded` (`warn`), with `path` and `reason`: no frontmatter, YAML that can't be parsed, no description, a name already taken, or a missing root;
  - `skill warning` (`warn`), with `skill` and `warning`;
  - `asking`, which now carries `model`, `baseUrl`, `run`, `workDir` and `task`;
  - `stopped` (`info`), with `count`, when `dispose()` stopped any processes, logged once whichever path awaited it;
  - `cleanup failed` (`warn`), with `error`, when the sweep couldn't run. The hello keeps its exit code.

  The tool-call and turn records stay as they are.
- **Failures:**
  - the turn-limit message names the limit and suggests a narrower task or a higher `MAX_TURNS`;
  - messages that spoke of a question or a smaller file now speak of the task.
- **Names:** `bun run hello` and the `model-hello` capability keep their names, as they did in the tool-loop change. When the specs are synced:
  - model-hello's Purpose says the hello carries out a task through the agent loop with a shell, `read_file` and skills;
  - the new `skills` and `shell-tool` specs get Purposes in place of OpenSpec's placeholder;
  - "Carry out a task and log the answer" moves back to the top of model-hello, and "Never read outside the root and the skill directories" back to second place in read-file-tool. OpenSpec appends added and renamed requirements at the end.
- **Alternatives:**
  - Keeping `[file] [question…]` alongside the task. It's ambiguous: is `README.md` a file or a task?
  - Defaulting `WORK_DIR` to a fixed directory outside the repository, as C12 suggests. The default task would then find no `package.json`. The README recommends a dedicated directory for browsing instead.

**10. Tests.**
- **`core`:**
  - `parseSkill`'s cases, including frontmatter that makes `yaml` warn: a custom tag, and a collection used as a key. They assert that `process.emitWarning` isn't called;
  - the catalog's order and escaping;
  - activation's wrapping, file list and cap;
  - the capture's boundaries, notes and decoding.

  All are pure unit tests. `logLevel: 'error'` turned into `''` behaves the same, so that one mutant gets a `// Stryker disable next-line StringLiteral` comment with the reason.
- **Skill loading and `activate_skill`:** real temporary directories with:
  - roots, relative and empty entries, a blank `SKILLS_PATH`;
  - links, names that collide across roots and within one, a missing root;
  - YAML that can't be parsed, hidden files, a skill under a hidden directory.
- **`read_file`:** absolute paths inside a skill directory; a link out of a skill directory; `.env` inside a skill directory.
- **The shell runner and the sweep:** real processes under Vitest on Bun, the production runtime, locally on macOS and on CI's ubuntu, with the limits passed in milliseconds. The rules:
  - **Assert outcomes and signals, never elapsed time.** Timing assertions flake under Stryker's concurrent runs.
  - **Wait for helpers.** A helper process prints `ready` once it has installed its handler, and the test waits for that line before signalling it. Where a command must first run `trap` or print, the timeout stays well above process start-up, about 1 s.
  - **Tagged processes are `node`, never `sleep`,** because macOS hides an Apple binary's environment from `ps`. For example: `node -e "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref()"`.
  - **Run IDs:** a test that leaves a tagged process alive, or calls `dispose()`, uses a fresh random run ID. Fixed IDs such as `a1b2c3d4` are only for pure tests and for commands that end at once.
  - **Checking a process is gone:** a test's own children report their signal on `exit`. For grandchildren, it polls until `kill(pid, 0)` throws `ESRCH` or `ps -o stat=` shows a zombie.
  - Long-running commands use `sleep 30`, not `sleep 1000`.
  - **A safety net for mutation runs:** a Vitest setup file, which Stryker never mutates, wraps `process.kill` and fails the test when a signal would reach:
    - 0, -1 or 1;
    - the test process or its parent;
    - a process the test can't vouch for.

    **What the test vouches for:**
    - its own descendants;
    - processes carrying a run ID it registered;
    - the descendants of either, remembered from every listing it made during the test;
    - every member of a process group whose leader was spawned during the test. The file records each spawned child's pid by wrapping `ChildProcess.prototype.spawn`. That covers the runner's group kills after bash has exited, when the group's remaining members have been reparented and, on macOS, hide their environment.

    Signal 0 delivers nothing, so the wrapper always lets it through. The shell and the sweep call `process.kill` through the `process` object, so the wrapper sees every signal.
- **The hello:**
  - the existing fake model server, real shell commands in a temporary `WORK_DIR`, and a temporary `SKILLS_PATH`;
  - `WORK_DIR`, `SKILLS_PATH` and `MAX_TURNS` join `main.test.ts`' `SETTINGS`, so a developer's own settings can't leak into the tests;
  - the signal tests emit the signal on `process` while a turn is pending, stub `process.exit`, and wait for it with `vi.waitFor`;
  - a test checks that `process` ends with as many signal listeners as it started with.
- **Live, by hand:** with LM Studio and the playwright-cli skill, a browsing task answers. Afterwards no process of the run's session is left.
- **Stryker:** 100%, as before. A `// Stryker disable` comment needs its reason above it.

**11. Documentation.**
- **README:**
  - the hello's task form, with quoted examples;
  - the new settings;
  - what the shell can reach (D18), in plain words, including what an environment built from scratch does and doesn't protect;
  - the playwright-cli example;
  - loading the model with at least 32k of context, for example `lms load <model> --context-length 32768`, and checking with `lms ps`;
  - a dedicated `WORK_DIR` outside the repository;
  - keys go in `.env`, not on the command line, where a command can read them with `ps -E -p $PPID`. The OpenAI example keeps `MODEL_API_KEY` in `.env` and passes only `MODEL_PROVIDER=openai MODEL=gpt-5.5` inline. Neither this nor a dedicated `WORK_DIR` stops a command that goes looking;
  - LM Studio's token auth;
  - the Stryker-disable count.
- **`packages/server/package.json`'s description** stops saying the app asks about a file.
- **`.gitignore`** gains `.playwright/` and `.playwright-cli/`, for runs whose working directory is the repository.

## Risks / Trade-offs

- **A prompt-injected model has the user's whole account** (D18). → Runs are attended, against sites the user picks (C12).
  - Building the environment from scratch keeps secrets out of what commands inherit and print by accident. It doesn't stop a command reading them: `ps -E -p $PPID` on macOS and `/proc/$PPID/environ` on Linux show the hello's environment, and `.env` is a readable file.
  - LM Studio's token auth protects its API from other local processes and web pages, not from this shell.
  - M1 moves the shell into the workspace container.
- **A browsing run needs a large context.** The skill's instructions are about 4k tokens, and one snapshot read can be about 8k. LM Studio loads models at 8k unless told otherwise. → The README says to load with at least 32k and check with `lms ps`. The live check records the loaded context. A context check waits for C8.
- **A small local model ignores the skill or misuses it.** → The developer item says to activate a matching skill first, and the task can name the skill. Errors and refusals go back to the model, and `MAX_TURNS` ends a run that goes in circles.
- **Context grows with every snapshot,** up to 32 KiB each. → The skill teaches `find`, `--depth` and `eval`, and a cut output says how to see the rest. Budgets and compaction come later (C8, C5).
- **The sweep can't see every process.** → macOS hides the environment of Apple's own binaries and of Chrome.
  - The daemon shows its run ID, and stopping it stops the browser (measured).
  - The escalation kills descendants' groups, so a daemon killed with SIGKILL can't strand Chrome.
  - The per-command group kill covers everything that stays in its group.
  - An Apple binary that leaves the group outlives the run, and nothing runs at all if the hello is SIGKILLed or crashes. The 15-minute idle timeout is the backstop for the browser.
- **A mutant could widen the sweep to the developer's own processes.** →
  - The guard refuses more than 32 matches, pids of 1 or below, and the CLI's own process and its parent, whatever the matcher says.
  - Group kills go only to groups above 1, other than the CLI's own.
  - The test-side wrapper fails any signal that a test can't vouch for.
- **`bash -c` with a command over 128 KiB fails on Linux.** → That affects CI only. On the Mac the limit is 1 MiB, and a failed spawn comes back as an error.
- **`ps` output differs between systems.** → The sweep matches only the `GREMLIN_RUN_ID=<id>` word, and its tests run on macOS and ubuntu.
- **`.playwright/` and `.playwright-cli/` appear in the working directory,** which is the repository when `WORK_DIR` is unset. → Both are gitignored, and the README recommends a dedicated `WORK_DIR`.
- **`yaml` is `core`'s first runtime dependency.** → It has no dependencies of its own and is at its newest version. tool-calls' package scenario names it.

## Migration Plan

`bun run hello [file] [question…]` becomes `bun run hello [task…]`. For example, `bun run hello README.md 'Which runtime?'` becomes `bun run hello 'Which runtime does README.md describe?'`. With no arguments, the hello behaves as before. The README documents the change. Rolling back means reverting the change.

## Open Questions

None blocking. Several values are constants for now:
- the 120 s shell timeout and the 2 s grace;
- the 16 KiB + 16 KiB output cap;
- the 100-file list;
- the 15-minute browser idle timeout;
- `MAX_TURNS`' default of 30.

They become per-profile settings when model profiles arrive (4.4).
