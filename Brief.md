# Brief: Self-hosted scheduled agent runner

> Input for a spec. Decisions below are settled unless marked **open**. Your job: turn this into a full spec (architecture, package layout, data model, interfaces, milestones). Push back where a decision looks wrong; don't silently change it.

> **Revision 2, 2026-10-11.** This revision adds the research done on 2026-10-11, a fact-check of that research, and a first round of analysis. How to read it:
> - The title and the quoted instruction above open the original brief. **Part 1** holds the rest of it, word for word. The only additions in Part 1 are lines starting with **▸**. They point elsewhere, and no original line was changed.
> - **Part 2** is the research, with sources and a confidence label on each finding: **[H]** high, **[M]** medium, **[L]** low or unconfirmed, **[K]** background knowledge not re-checked. Several findings are newer than Claude's training data and rest on the cited sources alone.
> - **Part 3** opens with where each settled decision and known risk stands, then challenges them. Each challenge is a **proposal awaiting your decision**. None has been applied.
> - **Part 4** is a draft design that assumes the recommended options. Sections that depend on an open decision name it.
> - **Part 5** is the log of decisions, open questions and spikes, to work through one step at a time.
> - **Verification.** There were two review rounds, both summarised in the Verification log at the end.
>   - **Round one:** after the first draft, 15 independent agents re-checked 333 claims against primary sources and reviewed the design. Some ran local tests on Bun 1.4.3, Postgres 16 and Docker Desktop. Their 56 factual corrections and 31 design issues are folded in.
>   - **Round two:** one agent audited that all 106 findings had landed correctly, and another did a fresh review of the revised design. Their 38 issues are folded in too.
>   - Anything still unverified is marked [M] or [L], or listed as a spike.
> - **Since revision 2, 2026-10-12:** R11 records the first pass of spike S2, a tool loop on LM Studio. C1, Q3 and the spikes table point to it.
> - **2026-10-15:** R12 records the research for loading skills and using the playwright-cli skill. C12 weighs where the shell runs before M1, and D18 records the choice. Q12–Q17 list the skills questions still to settle.
> - **2026-10-16:** R13 records how the tests and mutation testing run on Bun, the runtime the app uses. The change `tests-on-bun` moves them there.
> - **2026-10-16, later:** R14 records what it takes to keep the server running on Node as well as Bun, and D19 records the choice to do so. Two small packages use Bun's built-ins on Bun and Node's modules elsewhere, and the change `bun-or-node` adds them.
> - **2026-10-16, evening:** R15 records what "turn" means elsewhere, how other agent loops count and stop, and how LM Studio handles `tool_choice:"none"`. C8 proposes a finalize turn at the turn limit ahead of the budgets (D20), and C13 proposes calling the loop's unit a step (D21). D20 is open. D21 was decided the same evening, and the change `turn-to-step` carries it out.
> - **2026-10-21:** D22 names the package that carries out a task `agent`: it serves nothing, and "server" also meant the model server and the exec server. 4.2 puts it beside M1's `app`, which runs agents. The change `server-to-agent` renames it.
> - **2026-10-22:** R16 surveys the tools ten coding harnesses give a model to write files. D23 records the choice: `read`, `write` and `edit` by default, renaming `read_file`, and `apply_patch` in place of `write` and `edit` by the `FILE_TOOLS` setting. C4's table, ▸4 and M1's slice name them. The change `file-write-tools` adds them.
> - **2026-10-27:** D24 adds the direct Claude API beside OpenAI and LM Studio. One shared loop calls provider-specific Responses or Messages adapters; `core` depends on neither SDK. The in-memory history keeps provider-native replay data, and statistics retain each provider's named fields. Configuration and the task are explicit. The change `add-anthropic-support` carries this out; database persistence and new OpenAI encrypted-reasoning behavior remain separate work.
> - **2026-10-29:** R17 records the research for MCP servers: TypeORM and SQLite on Bun and Node, SQLite against the Postgres design, the MCP TypeScript SDK's client, MCP authorization with a probe of 27 OAuth servers, and how twelve harnesses act as MCP clients. C14 proposes SQLite in a data folder in place of Postgres, and C15 the TypeORM conventions it needs. C16 proposes MCP servers that need no OAuth first, C17 the login command and a lease for token refresh, and C18 MCP tools in the agent. D25–D35 are open. R17.6 records spike S6 the same day, and D25–D28 were decided: SQLite for good, through `better-sqlite3` 13, in a package of its own, `@mecha-gremlin/store`, with a required `DATA_DIR`. The change `add-persistence` carries them out. R18 records the research for the MCP client's design, and 4.12 drafts the design, with D36 and D37 open.
> - **2026-10-29, later:** the change `add-persistence` adds `store` to 4.2's layout, with the `credential` table and its refresh lease. Every run opens the database in `DATA_DIR` before any network request, and the file tools refuse the folder. TypeORM's own loggers print a failed migration whatever its `logging` option says, so the store gives TypeORM a logger that prints nothing.
> - **2026-10-30:** D29 is decided: MCP servers are rows in the database, written by a command, not a file. The change `add-mcp-servers` proposes the command, `bun run mcp`, and the MCP client. A review of its first draft found that Bun's fetch sends loopback requests through `HTTP_PROXY` too (R18.1); 4.12's note lists the rules the change revised.
> - **2026-10-30, later:** the change `add-mcp-servers` carries out D29. It decides D33, D34, D36 and D37 as recommended, and gives D30's command the form `bun run mcp`, with `add`, `list`, `remove`, `disable` and `enable` now, under which the login can later become `bun run mcp login`. A run connects to every enabled server before its first model call, and offers their tools after its own. `@mecha-gremlin/process` gains a stdin pipe, and the logger escapes control characters, since a server's text now reaches its records.
> - **2026-10-31:** the change `simplify-mcp-command` gives `bun run mcp add` flags, as `claude mcp add` takes them, in place of a JSON entry: a remote server is a name and a URL, with `--header` for its headers, and a local one a name, with `--env` for its variables, and its command after `--`. A server gets 30 s to start and 2 min for each call, unless `--startup-timeout` or `--tool-timeout` says otherwise. The command prints plain text for people, with problems and warnings on stderr, and needs only `DATA_DIR`; a new subcommand, `get`, shows one server's settings. What is stored for a server, and what a run does, are unchanged.
> - **2026-10-31, later:** D31, D32 and D38 are decided: a configured client ID, else dynamic registration; plain tokens in the 0600 database; and the login's redirect on any free port. The change `add-mcp-login` proposes `bun run mcp login <name>`, which prints the URL to open and takes the redirect or a pasted address, and runs that refresh the token under the credential's lease. D35 is settled by the order the work took.
> - **2026-10-31, evening:** the change `add-mcp-login` carries out D31, D32 and D38. `bun run mcp login <name>` sends a Streamable HTTP server an initialize without a token and discovers its authorization server where the 401's `WWW-Authenticate` points, else at the well-known URLs (R17.4); it takes a client given with `--client-id`, else the one saved for its issuer, else registers one, and prints the URL to open. It takes the redirect on 127.0.0.1, on the port the saved client registered while that is free, or a pasted address, checks `state`, has the SDK exchange the code, which checks `iss`, saves the row, and lists the server's tools with the new token. `logout` and `remove` delete a server's logins, and `get` shows them. A run sends the saved token through the SDK's minimal `AuthProvider`, refreshes it ahead of expiry and after a 401 under the credential's lease, marks the row on `invalid_grant`, and redacts the tokens. The login exchanges the code through the SDK's `fetchToken()`, not `auth()`, which on a refused code warns on the console and sends the code again.
> - **2026-11-01:** the first real login, to an authorization server without dynamic registration that matches redirect URIs exactly, port included, showed two gaps. Its refusal named neither where to register a client nor the redirect URI to register; and a client given with `--client-id` was saved without the redirect URI it was used with, so a later login with no options, the one a spent login's error asks for, would have sent a port the system picked, which such a server refuses. The change `remember-login-redirect` has the refusal name the authorization server's issuer, the redirect URI to register and the command that logs in with it, and saves a configured client with its redirect URI, which a later login uses again. Where no client could be registered for another port, the login keeps to that one, and fails when it's taken.
> - **2026-11-01, later:** when an authorization server refused a login at the redirect, the login named the error code alone, and dropped the `error_description` that says why. The change `show-login-error-description` names the description too, in parentheses after the code. Like the code, it is printed only when it holds nothing but the characters RFC 6749 allows it: a description in other characters, or an empty one, is left out, so that no control sequence reaches the terminal.
> - **2026-11-01, evening:** R19 records how a task reaches a run through the shell and `bun run`: a file's text arrives intact as one quoted argument, within the system's limit on arguments, and `bun run` starts a script in its package's root, wherever the command was typed. C19 proposes taking the task from a file by default, and D39 and D40 are decided: `--prompt`, or `-p`, gives the task inline instead, and a task file's frontmatter is part of the task. Q25 asks what each provider does with a first request larger than the model's context. The change `read-task-file` proposes both decisions, and refuses a task file that the file tools would refuse.
> - **2026-11-01, night:** the change `read-task-file` carries out D39 and D40. A run takes its task from the file its one argument names, trimmed and otherwise verbatim, frontmatter included, or inline with `--prompt` or `-p`. A task given in both ways, or in neither, fails the run before any request, reported with the configuration's problems, and so does a task file that is binary, blank, an environment file or inside the data folder. The `asking` record keeps the task's text, and names the file it came from.
> - **2026-11-01, late night:** R20 records where the file tools' fence came from and what each of its rules stops, given the shell that every run has. C20 proposes that no file tool refuse a path for where it is, while the refusals that don't depend on where a file is stay. D41 and D42 are decided as asked: the file tools refuse nothing by path, and no setting brings the fence back, since "if we need sandboxing, we will use containers". D43 is decided too, as recommended: a task file refuses neither `.env` files nor the data folder. Q26 asks whether the file tools should expand `~`. The change `remove-file-tool-fence` proposes all three decisions.
> - **2026-11-02:** the change `remove-file-tool-fence` carries out D41, D42 and D43. `read`, `write`, `edit` and `apply_patch` resolve a relative path against the working directory, take an absolute one as it is, and refuse no path for where it is: outside the working directory, through a link, in a skill's directory or the data folder, or named like an `.env` file. What doesn't depend on where a file is stays refused, with the same messages: a directory, a binary file, a file too large to replace whole or to edit, text that isn't UTF-8, and a patch that names a file twice or doesn't apply whole. A task file may be any text file, `DATA_DIR` may be or contain `WORK_DIR`, and no setting brings the fence back.
> - **2026-11-05:** R21 records how a run chooses its MCP servers: every enabled server connects for every run, so under D33 a server that can't start fails tasks that never use it, and the only fix the error offers, `disable`, takes the server from every task. C21 proposes that a task file's frontmatter name the servers the task needs, in an `mcp` list, as 4.7's `skills:` list names its skills, with every enabled server when it names none. D44–D46 are open, and Q27 asks whether a task should narrow a server's tools too.
> - **2026-11-05, later:** R22 records how twelve other harnesses let a definition file or a run choose MCP servers. Only Claude Code's sub-agents name configured servers in their frontmatter; elsewhere a file narrows tools by server pattern or brings servers of its own, a run's own choice is a flag, and no harness chooses servers one by one through an environment variable. Every harness but Codex, whose servers can be `required`, carries on without a server that fails, only Claude Code tells the model, and every harness strips a definition file's frontmatter from the prompt. R23 records how the two YAML parsers read the frontmatter notes hold, some of which neither accepts. D45 now recommends stripping the block from the prompt, and D47 and D48 ask about frontmatter that isn't valid YAML and keys the run doesn't read. R24 records what letting a task go without a server would take, and C22 proposes a `?` that marks a listed server optional (D49). D44–D49 are decided: a task file's `mcp` list chooses its servers, with every enabled server when it has none; the block is stripped from the prompt, superseding D40; a disabled server the list names, and frontmatter that isn't valid YAML, fail the run; a key the run doesn't read gets a warning; and a `?` marks a server the run may go without. The change `choose-task-mcp-servers` proposes them.
> - **2026-11-05, late morning:** the change `choose-task-mcp-servers` carries out D44–D49. A task's frontmatter, from a file or from `--prompt`, is stripped from what the model gets when its lines parse as a YAML mapping or are empty; a block that parses as anything else, as after a horizontal rule, stays in the task. Its `mcp` list chooses the servers a run connects, every enabled one when it has none, and a `?` after a name marks a server the run may go without, which is left out, when it's disabled or can't be used, with an `mcp server left out` warning and a paragraph at the end of the model's instructions; a run whose servers all start sends the instructions it sent before. Frontmatter that isn't valid YAML, an `mcp` value that isn't a list of names, a name given twice and a task that is blank without its frontmatter fail the run before the store opens, and a listed name that no server has, or a disabled server the list requires, before any network request. A key the run doesn't read gets a warning, the `asking` record names the list, and D33's error names the ways to run without a server: `bun run mcp disable` or a task's list that leaves it out, for a task without a list, and leaving it out or marking it with `?`, for a task whose list requires it. A failure of the store itself fails the run, for an optional server too, and a login whose server has a problem no longer suggests running without the server.
> - **2026-11-09:** R25 records the research of 2026-11-08 for a light scheduler, asked for as one that hooks into native cron and falls back to a library where there is none. `Bun.cron`'s OS-level form sets no working directory, loses a job's output under Debian cron and rewrites the whole crontab when `crontab -l` fails. The native schedulers disagree on fires missed during sleep, on overlap and on DST, and the Debian-based images have none. croner 11 flips two of the DST behaviours 4.8 pins. R26 records whether the scheduler should be written in Rust: Rust's own sleeps, like Go's, Node's and Bun's, stop while a machine sleeps, so a scheduler that sleeps until the next fire is late in every language unless it caps its wait or uses the operating system's wall-clock timers, and Rust's measured gain over Bun is 14–27 MiB of memory, depending on what its runs share, and seconds of CPU a day. C23 proposes one resident scheduler that waits for the next fire, capped at 60 s, and starts each run as its own process. C24 weighs its language. D6, D50 and D51 are decided as asked: a scheduler of its own, written in Rust in `packages/scheduler`, started with a TOML config of its jobs and a data directory for its own log and theirs. D52–D54 are open, Q28–Q30 and S11–S15 are new, and D12, Q24, 3.0, 4.8 and Part 1 gain notes.

---

# Part 1: Original brief

## Why this exists

Anthropic's on-machine scheduled tasks are being retired. I want my own replacement: an agent that runs on a schedule, calls an LLM, uses tools against a real file system, and persists state between runs.

Primary goal: solve my own problem. Secondary: the core may become an open-source library, and the whole thing may become an Avant Media client deliverable. Owning the stack is the point. If it becomes a client product, compliance and safeguards are features I add to code I own, not constraints I fight in someone else's framework.

## Non-goals (deliberately out of scope)

- **Sandboxing and permission management.** The agent gets unrestricted file-system and shell access. Isolation is Docker: the container is the boundary, mounted volumes define what it can touch. No permission system in application code.
- **Adopting an existing agent harness** (OpenClaw, Hermes Agent, LangChain, Mastra, etc.). Rejected because they bring breadth I don't need, abstractions I'd have to learn, and breaking changes I don't control.
- **Provider-agnostic abstraction layers** beyond what the OpenAI SDK already gives.

▸ The isolation non-goal holds, but where the boundary sits matters. If the agent's shell runs in the same container as the app's secrets and database access, the boundary encloses both (C3).

▸ **2026-11-01:** the file tools follow this non-goal too. They refuse no path for where it is, and when sandboxing is needed, it is a container (C20, D41, D42).

## Settled decisions

| Area | Decision | Reason |
|---|---|---|
| Language/runtime | TypeScript on Bun | The work is I/O-bound. Instant edit-run loop matters more than anything Rust offers here. No compile step. |
| Database | Postgres | Concurrent scheduled runs writing at once. Full-text search, `jsonb`, `pgvector` available. Negligible overhead in a container. |
| ORM | TypeORM | Model the domain in TypeScript classes. No language switching into SQL (Drizzle) or a schema DSL plus codegen (Prisma). Raw SQL escape hatch for native features like `pgvector`. |
| LLM client | Official `openai` npm SDK | Same SDK for OpenAI and LM Studio (override `baseURL` and use a dummy key locally). Model choice is config, not a code path. |
| Models | OpenAI (GPT) and local models via LM Studio | Claude is out: a Claude subscription can't be used for API calls. |
| Deployment and isolation | Docker / docker compose | Same artefact for my machine and any future client box. |
| Repo | Single public monorepo with workspaces | See layering. No two-repo split, no symlinks. |

▸ How each settled decision stands after research: 3.0. None has been reversed. One has been widened: the server runs on Bun or Node (D19, 2026-10-16).

▸ Later update: D24 revises the one-client and no-Claude decisions, using direct Claude API access alongside Responses providers.

▸ **2026-10-29:** D25 reverses the Postgres decision: SQLite in a data folder takes its place (C14). D26 makes `better-sqlite3` 13 its driver under TypeORM, with the conventions C15 lists (R17.6).

▸ **2026-11-09:** D50 makes the scheduler a Rust package, against "TypeScript on Bun" for that package alone. The agent stays TypeScript on Bun or Node (C24).

## Layering

**1. Core libraries (open source, unopinionated)**
- Pure, stateless functions you ask to do one thing. Data in, data out.
- No persistence, no scheduling, no I/O opinions, no infrastructure dependencies.
- No "engine" object that owns a loop and calls back into injected adapters. **No DI, no persistence interfaces.** The caller orchestrates.
- Candidate libraries (spec should refine): build tool schemas from skills, run one model turn, extract tool calls from a response, format tool results back into messages, compaction (history to compacted history), message ordering for cache-friendly prefixes.

▸ The refined list, with signatures, is in 4.3. One candidate changes under C4: with SKILL.md skills there are no per-skill tool schemas to build. Skills become a catalog in the preamble plus one `activate_skill` tool. "Run one model turn" is the only candidate that does I/O, through a client the caller passes in. The loop's *policy* can still be a pure function (`nextStep`).

**2. App (also in the public repo, deliberately opinionated)**
- Postgres + TypeORM, scheduler, orchestration loop, skill loading, logging.
- Makes no apology for its choices and doesn't abstract them away.

**Privacy model: public code, private data.**
Everything private (secrets, client specifics, my own skills and task definitions) lives in persistence and config, never in source. So the whole repo is publishable.
- Enforce this mechanically, not by vigilance: secret scanning on commit, config schema validation at boot.

▸ Proposed shape: a private git repo (tasks, skills) mounted into the containers, plus untracked env files for secrets, alongside the public repo (4.2, 4.9). Secret scanning (gitleaks in pre-commit and CI, plus GitHub push protection) and config validation at boot start in M1, before any secret exists (4.10).

## Components the app needs

1. **Scheduler.** Fires task runs. Must handle overlapping runs safely. (**Open:** in-process scheduler vs cron/systemd timer invoking a CLI; where task definitions live, presumably the DB.)
2. **Agent loop.** Call model with tools, then:
   - If the response has tool calls: execute them, append each result tagged with its tool-call ID, call again.
   - Repeat until a final answer.
   - Tool errors and timeouts are fed back to the model as results, not thrown.
   - Hard cap on iterations.
   - Graceful fallback when a weak local model narrates a tool call in prose instead of returning it structured.
3. **Skills.** Self-describing units (JSON Schema plus handler), loaded from a registry. A task gets the relevant subset, not every skill, because too many tools degrade the model's choices. (**Open:** skill format and on-disk vs DB storage. Ideally compatible in spirit with the SKILL.md convention.)
4. **Base tools.** Shell exec, file read/write. That's most of what's needed.
5. **Persistence.** Runs, messages (history as `jsonb`), task definitions, skill config, run state between executions.
6. **Run log.** Append-only record of every tool call and result. Cheap now, essential for debugging ("what did it do at 3am") and for any future client accountability.
7. **Compaction.** Never compact the system prompt or original task. Only compress the conversational middle. Build the seam now, but don't build a sophisticated summariser until real runs show context growth is a problem.
8. **Prompt caching.** Keep the stable prefix (system prompt, tool schemas) pinned and byte-identical at the front. Compaction only touches the middle, so the two don't fight. Caching behaviour differs between OpenAI and LM Studio, so don't assume one uniform feature.

▸ **1. Scheduler.** Proposal: an in-process tick driven by the database (4.8, D6). Where task definitions live: C6, D5. Until they exist, a run takes its task from a file, or inline with `--prompt` (C19). **2026-11-09:** D6 is decided instead: a resident scheduler of its own, written in Rust and started with a TOML config of its jobs and a data directory (D50, D51; R25, R26, C23, C24).

▸ **2. Agent loop.** Draft in 4.5. Budgets and a context-fill check beyond the iteration cap: C8. Narration handling: C9, using LM Studio's own markers (R5.2). What a turn is, and how other agent loops count and stop: R15. Naming the loop's unit a step: C13.

▸ **3. Skills.** The SKILL.md spec has no typed tools (R7), so C4 proposes a different split. Storage: on disk (4.7). For the first skills change: R12, Q12–Q17. A task's MCP servers, by the same rule: C21 and C22.

▸ **4. Base tools.** The shell, and the file tools `read`, `write` and `edit`, with `apply_patch` in place of `write` and `edit` as the alternative (D23, R16). Where they execute: C3. Before M1, the shell runs on the host (C12, D18). Process-group kill, pipe and stdin handling, and output caps: C3, 4.5, R8, R10.

▸ **5. Persistence.** One row per history item rather than one `jsonb` array per run (C11). Entity draft: 4.4. SQLite in a data folder, whose first tables hold MCP servers' OAuth credentials: C14, C17.

▸ **6. Run log.** Keep it out of the agent's reach with C3 plus a database role that can only INSERT into it (4.4).

▸ **7. Compaction.** The seam ships in M2. The summariser waits for evidence (4.10). Compaction and caching do fight, unless compaction is rare and chunky (C5).

▸ **8. Prompt caching.** Caching now differs by OpenAI model generation as well as by backend (R3, R5.3). Request layout: 4.6.

## Known risks to address in the spec

- **TypeORM runtime type gap:** queries that typecheck but fail at runtime. Mitigate with conventions and tests.
- **TypeORM on Bun:** verify decorators, `reflect-metadata`, and migrations work cleanly under Bun before committing. Have a fallback plan if not.
- **OpenAI-compatible is ~95% compatible:** stick to mainstream chat-completions plus tool-calling. Verify LM Studio supports exactly what the loop uses.
- **OpenAI subscription for API calls:** confirm the auth mechanism and its limits before relying on it.
- **Scope creep:** the harness stays small. The failure mode is slowly reimplementing LangChain badly.

▸ How each known risk stands after research: 3.0.

▸ **TypeORM on Bun** now also means on Node, where decorators can't run, and on SQLite: R17.1, C15.

## What I want back

1. Monorepo layout (workspace packages, what goes where).
2. Core library list with function signatures.
3. TypeORM entity model.
4. Agent loop design including error, timeout, and iteration-cap handling.
5. Skill format and loading.
6. Scheduler design and concurrency handling.
7. Docker/compose setup.
8. Milestones, smallest useful end-to-end slice first (one scheduled task, one model, shell + file tools, persisted run log).
9. Your list of open questions and any decisions you'd challenge.

▸ Where each draft lives: 1 → 4.2, 2 → 4.3, 3 → 4.4, 4 → 4.5, 5 → 4.7, 6 → 4.8, 7 → 4.9, 8 → 4.10, and 9 is Part 3 plus Part 5. Every draft depends on the open decisions in Part 5.

---

# Part 2: Research (2026-10-11)

**Method.**
- **Passes:** three research passes on 2026-10-11 (OpenAI; LM Studio; TypeORM, Bun and Agent Skills), followed by an independent fact-check of every load-bearing claim (Verification log).
- **Sources:** official docs, changelogs, npm metadata, and GitHub releases, issues and source code (read with `gh`).
- **Local checks:**
  - Bun 1.4.3 on macOS: transpiler output and spawn behaviour. These ran in memory or in a scratch directory outside the repo.
  - During the fact-check: database behaviour reproduced on Postgres 16, and Docker networking on Docker Desktop (Docker 29.8.2). See R10.
- **OpenAI pages:** they carry no dates and were fetched on 2026-10-11. help.openai.com and openai.com returned HTTP 403 to fetchers, so the first pass read them through search snippets and the fact-check read archived copies (web.archive.org).
- **Shorthand:**
  - **OAI** = developers.openai.com.
  - **LMS docs** = lmstudio.ai/docs (source: github.com/lmstudio-ai/docs, last commit 2026-10-08).
  - **LMS CL x** = lmstudio.ai/changelog/lmstudio/lmstudio-vx.
  - **LMS BT#n** = github.com/lmstudio-ai/lmstudio-bug-tracker/issues/n.

## R1. OpenAI: what a subscription can pay for

**R1.1 No ChatGPT plan includes Platform API credits.** API usage is billed separately, pay-per-token. **[H]** (help.openai.com/en/articles/8156019)

**R1.2 "ChatGPT plan usage" through Sign in with ChatGPT (SIWC).**
- **Launch.** Identity-only Sign in with ChatGPT entered beta on 2026-07-29 with partner sites (Airtable, GitLab, HubSpot, Notion, Supabase, Vercel). *Plan usage*, meaning spending a user's ChatGPT allowance on AI requests in your own app, was announced at OpenAI DevDay on 2026-09-29 as a limited preview ("Use your ChatGPT allowance in participating apps"). WorkOS (2026-10-01) and The Star (2026-10-04) reported it. It is the official, non-Codex way to spend a plan from your own code. **[H]** on mechanics, **[M]** on eligibility.
- **Sources:**
  - OAI /siwc/quickstart.
  - OAI /siwc/token-sharing-open-source and its sub-pages /sign-in, /profiles-and-sessions, /models-and-inference, /preview-limitations, /token-reference, /errors-and-recovery, /self-hosted-vms and /codex-app-server.
  - help.openai.com/en/articles/20001542 and learn.chatgpt.com/docs/sign-in-with-chatgpt.

**Eligibility**
- **Plans: OpenAI's sources conflict.**
  - The developer docs, the cookbook, learn.chatgpt.com and the 2026-09-29 release note say that eligible Plus and Pro users qualify. The exact wording differs between them.
  - The help article (20001542, revised around 2026-10-05) says plan usage in commercial apps "is only available with Go, Plus, and Pro", and that "Supported open-source tools remain available to all ChatGPT users".
  - So whether Business or Go can use plan usage in an open-source, locally hosted client is not established.
  - An ineligible account gets HTTP 403 `subscription_sharing_user_not_eligible`.
- **Who it's for.** Plan usage is "available to all open-source partners and selected private clients" (/siwc/quickstart). The open-source flow is written for "open-source and locally hosted apps", and includes a guide for running an open-source app on a remote VM. "If you're interested in offering it in a paid or remotely hosted app, complete the interest form."
- **Partners.** The partner directory (learn.chatgpt.com/docs/sign-in-with-chatgpt#partners; the help article only links to it) lists OpenClaw, OpenCode, Pi and T3 as open-source integrations.

**Auth**
- **Flow.** OAuth with PKCE (S256) and a loopback redirect at `http://127.0.0.1:<port>/auth/callback`. Only the port may vary, and `localhost` is not accepted.
- **Registration.**
  - `client_id=dynamic_agent_client` plus `ext_agent_host_id` is the **first-time registration entry point, not the client ID to keep**. The callback returns an issued `client_id` (`oaiapp_…`), which must be stored and used for the code exchange, every refresh and later sign-ins.
  - `ext_agent_host_id` must be stable and distinct per host, so a host that imports credentials keeps its own ID.
  - The authorise request also sends `agent_name_hint`.
- **Scopes.** Identity: `openid profile email`; validate the ID token. Plan usage: `offline_access resource.invoke chatgpt.tokens.use.direct`.
- **Token lifetimes.** Access tokens last 1 hour (`expires_in` 3600). Refresh tokens last 30 days and are replaced on every refresh. The docs say to "serialize refreshes for the same session". A racing refresh fails with `refresh_token_reused`, which forces a new OAuth sign-in.
- **Refresh.** `POST auth.openai.com/api/accounts/oauth/token` with `resource=https://api.openai.com/v1`, the issued client ID, and `scope` omitted so the grant is kept.
- **Containers and remote machines.** The loopback login can't complete inside a container or on a remote VM directly. The docs' self-hosted VM procedure completes OAuth locally and then transfers the credentials.

**Endpoint**
- **Inference** is `POST https://api.openai.com/v1/responses` only. The official SDK works with the OAuth access token passed as the API key and retries turned off: the docs' Python example uses `max_retries=0`, which is `maxRetries: 0` in JS.
- **The docs say verbatim:** "do not point it at ChatGPT's `backend-api` endpoints."
- **Model catalogue.** `GET https://api.openai.com/v1/models` with the same token returns the account's catalogue. It comes back as a `models` array with `slug`, `display_name` and `visibility` (filter on `visibility == "list"`), not the usual `data[]`/`id` list.
- **WebSocket.** A WebSocket transport also exists. There, `previous_response_id` works only within one authenticated connection.

**Request constraints**
- `store:false` and `stream:true` are required over HTTP.
- `role:"system"` items are rejected; use `instructions` or developer messages instead.
- **Omit these 15 fields:** `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation` and `user`. An unsupported input, tool, model or service-tier override returns HTTP 400 `subscription_sharing_unsupported_capability`; check `error.param`.
- **No `previous_response_id`** over HTTP, so the full input is replayed every turn.
- **Unsupported tools:** image generation, file search, Code Interpreter, native computer use, hosted MCP and connectors, and `tool_search`. `programmatic_tool_calling` isn't accepted in top-level tools. Web search "remains subject to model and account/workspace policy".
- **Function tools:** "Group function/custom tools in namespaces or supply them through `additional_tools` input items". openai-node 7.32.0 has types for both: `NamespaceTool` (type `namespace`), and `additional_tools` input items, which take the developer role only.

**Limits**
- **Pool.** Requests draw on the plan's "ChatGPT Work and Codex usage", the same pool as your own Codex work.
- **Plus vs Pro.** On Plus, the five-hour limit is shared across all apps using the plan. On Pro the five-hour limit doesn't apply, but app usage still draws on the same weekly allowance. Users can cap each app's weekly usage in Settings → Usage, as a percentage of the weekly allowance.
- **At a limit, plan usage stops.** OpenAI "does not silently switch the request to another billing path".
  - Before the stream opens, the error is HTTP 429 `subscription_sharing_usage_limit_exceeded`. After streaming has begun, the same code arrives in a `response.failed` event.
  - The limit may be the app's own weekly cap rather than the whole plan. The docs say not to "infer a reset time from this code alone"; the reset time appears only in ChatGPT settings → Usage.
- **Other errors.**
  - `subscription_sharing_usage_unavailable` (503, also possible mid-stream) means usage couldn't be checked: retry with bounded backoff.
  - Admission failures before the stream (401, 403, 503) can return a bare `{"detail":"…"}` body instead of the standard error object.
- **Credits.** A user can turn on "Allow other apps to use credits after reaching your usage limit". It is off by default, and the app's limit must be set to 100%. Requests then continue on ChatGPT credits instead of stopping, and with automatic credit purchases this can cause charges with no separate notice.

**Unattended and personal use.** The docs don't address either explicitly. Both sides are in Q9.

**R1.3 Codex "Sign in with ChatGPT".** **[H]**
- **Sources:** learn.chatgpt.com/docs/auth, learn.chatgpt.com/docs/auth/ci-cd-auth, OAI /siwc/token-sharing-open-source/codex-app-server.
- Codex CLI, SDK and app-server officially run on plan usage, but the docs say "API keys are still the recommended default for automation" and "The right way to authenticate automation is with an API key."
- The ChatGPT `auth.json` may be used only on trusted private runners: "one auth.json per runner", and "Do not share the same file across concurrent jobs". Codex refreshes it when its `last_refresh` is more than about 8 days old.
- Enterprise Codex access tokens are "intended for trusted scripts, schedulers, and private CI runners".
- Codex app-server can run on a SIWC token through a custom provider with `wire_api="responses"`. This is documented on the codex-app-server page above.

**R1.4 The unofficial route: the Codex backend.** **[H]** facts, **[M]** reading.
- **Who uses it.** Some apps call `chatgpt.com/backend-api/codex/responses` directly with Codex OAuth tokens. OpenCode does, and so do subscription-to-API relays such as sub2api.
- **Status.**
  - OpenAI never published a contract for that endpoint, and the SIWC docs say "do not point it at ChatGPT's `backend-api` endpoints".
  - No terms-of-service clause names it. But the Terms of Use (effective 2026-01-01) forbid you to "Automatically or programmatically extract data or Output".
  - On 2026-08-21, Tibo Sottiaux (OpenAI, Codex) said that converting a subscription into API traffic "to then re-serve or share across many users is not something we support and this type of usage gets flagged by our fraud-prevention systems". In the same post he said that using your subscription through official clients or OSS sign-in clients (Pi, OpenCode) is "completely fine".
- **Reading.** Unsupported: accepted for one person's own use through a sign-in client, flagged when a subscription becomes shared API traffic, and now superseded by SIWC. A bespoke unattended runner calling it directly falls between those two cases.
- **Constraints, from community reverse-engineering:** `store:false`, streaming, replaying encrypted reasoning, Codex's own prompt in `instructions`, and Codex's 5-hour and weekly windows.

**R1.5 Third-party harness timeline.** The recollection that OpenAI publicly welcomed third-party harnesses right after Anthropic's block is mostly right **[M]**. Hours after the block, OpenAI said it was working with OpenCode so that Codex users could use their *Codex* subscriptions there. The dated events below are **[H]**.
- **2026-01-09.** Anthropic blocked third-party harnesses from using Claude subscriptions, server-side (VentureBeat, 2026-01-09; OpenCode issue #7410, opened 02:20 UTC).
- **2026-01-09, 21:40 UTC.** Tibo Sottiaux posted: "We are working with OpenCode to allow Codex users to use their Codex subscriptions and usage limits in OpenCode directly." (x.com/thsottiaux/status/2009742187484065881)
- **2026-01-10.** OpenCode v1.1.11 added "Codex authentication support" (01:54 UTC). A follow-up post, "Codex ❤️ OSS", named OpenHands, RooCode and Pi (19:01 UTC).
- **2026-08-21.** The fraud-flagging and "completely fine" post quoted in R1.4 (x.com/thsottiaux/status/2090675027670978569).
- **2026-09-29, 17:47 UTC, during the DevDay keynote.** "You can now use your ChatGPT subscription directly in over 60 partners products… Devin, OpenCode, Lovable" (x.com/thsottiaux/status/2104991529416999243). Official sources count 16 launch partners.
- **Context.** OpenCode now ships a SIWC provider (`dynamic_agent_client`, resource `https://api.openai.com/v1`).

## R2. OpenAI: Chat Completions vs Responses

**R2.1 Status.** "While Chat Completions remains supported, Responses is recommended for all new projects." Chat Completions is not deprecated and has no entry on the deprecations page. **[H]** (OAI /api/docs/guides/migrate-to-responses, /api/docs/deprecations)

**R2.2 Tool calling is restricted on Chat Completions.** **[H]**
- **Migration guide:** "Starting with GPT-5.4, Chat Completions does not support tool calling with `reasoning_effort` values other than `none`."
- **Reasoning guide:** "Chat Completions does not support function calling with GPT-6 Astra or GPT-6.1 Sol."
- **Function-calling guide:** "GPT-6 Astra and GPT-6.1 Sol require the Responses API for tool calling."
- **Changelog (2026-09-03, GPT-6 Astra):** "Tool calling requires the Responses API."
- **gpt-6.1-sol model page:** "Chat Completions is supported without tool calling."
- **Exceptions and edge cases:**
  - The gpt-6-astra model page omits the caveat; all the guides and the changelog state it.
  - GPT-6 Astra returns HTTP 400 on `reasoning_effort: none`, so the GPT-5.4+ rule alone already rules out Chat Completions tool calls on it.
  - gpt-6-sol, as distinct from gpt-6.1-sol, follows the general rule: tools only with effort `none`.

**R2.3 Reasoning across turns.** "In Chat Completions, reasoning is dropped between calls" (OAI /blog/responses-api).

**R2.4 Stateless pattern and reasoning items.** (OAI /api/docs/guides/reasoning; openai-node 7.32.0 types)
- **Basic pattern:** set `store:false` and replay every reasoning item. New in 2026: `encrypted_content` is returned by default. The old `include:["reasoning.encrypted_content"]` is still accepted but no longer needed.
- **Reuse across models:** persisted reasoning can be reused only within one model family (gpt-5.6-sol, -terra and -luna share it). Across families the API *silently omits* the incompatible reasoning items rather than failing the request.
- **Across user turns:** carrying reasoning across user turns depends on `reasoning.context`. `all_turns` is documented as the default only for the GPT-5.6 family (GPT-6.1 Sol supports it). Earlier models default to `current_turn`.
- **When streaming:** store the reasoning item from `response.output_item.done`. Its `encrypted_content` in `response.output_item.added` may be incomplete.

**R2.5 Published claims for Responses over Chat Completions.**
- Cache utilisation: "40% to 80% improvement when compared to Chat Completions in internal tests" (the archived cookbook words it as "from 40% to 80%").
- "3% improvement in SWE-bench".
- The blog adds "5% better on TAUBench".

**R2.6 Assistants API.** "Officially sunset on August 26, 2026, and is no longer available." The deprecation was announced on 2025-08-26.

## R3. OpenAI: prompt caching

Sources: OAI /api/docs/guides/prompt-caching, /api/docs/guides/prompt-caching/diagnostics, /api/docs/guides/function-calling, and openai-node 7.32.0 types.

**R3.1 GPT-5.6 and later.**
- **Minimum length:** 1,024 visible input tokens.
- **Breakpoints:**
  - An implicit breakpoint sits at the end of the latest *eligible* message. Eligible means a user message, the last tool response in a consecutive group of tool responses, or the last developer message in the initial group of developer messages.
  - Assistant messages, reasoning items, `function_call` items and developer messages added later in the conversation are not eligible.
  - Explicit `prompt_cache_breakpoint` markers can be placed on content blocks, with up to 4 cache writes per request.
- **Configuration:** `prompt_cache_options {mode: implicit|explicit, ttl: "30m"}`. 30m is the only value and the default, and each reuse refreshes it.
- **Pricing:** **cache writes cost 1.25× the input price.** Reads cost 0.1× (0.05× on GPT-6.1 Sol).
- **Parameters:**
  - `prompt_cache_retention` is deprecated.
  - `prompt_cache_key` is optional, and routing is automatic, but the key partitions billed cache reuse: a request under a different key is reported and billed as a miss even when the prefix is physically cached. Omit it, or use one stable key per task; never one per run or per turn.
  - On supported GPT-6-family models, a `configuration_update` input item changes reasoning effort without breaking the cached prefix. **[M]**

**R3.2 Earlier models.**
- **Minimum length:** "varies by request settings".
- **Breakpoints:** at model-dependent intervals (every 2,048 tokens on GPT-5.5), and `cached_tokens` is rounded down to a multiple of 128.
- **Retention:**
  - `prompt_cache_retention` is either `in_memory` (typically 5–10 minutes idle, up to 1 hour) or `24h`.
  - **`24h` is a maximum, not a lifetime.** Entries "typically" stay around 30 minutes and can last up to 24 hours. The SDK calls it "a maximum retention policy".
  - It has been the **default for organisations without zero data retention (ZDR)**, on models that support both values, since the changelog entry of 2026-05-29.
  - Models with `24h`: gpt-5.5 and 5.5-pro (which accept only `24h`; `in_memory` errors), 5.4, 5.2, the 5.1 family, 5, 5-codex and 4.1. Other earlier models have only `in_memory`.
- **Cost and routing:** no charge for cache writes. `prompt_cache_key` is a routing hint; keep each key to about 15 requests per minute.

**R3.3 Usage reporting.**
- Responses: `usage.input_tokens_details.cached_tokens` and `cache_write_tokens`.
- Chat Completions: `usage.prompt_tokens_details.cached_tokens` and `cache_write_tokens`.
- The discount on cached input is "up to 95%". Cached tokens still count toward tokens-per-minute limits.

**R3.4 What breaks the cache.**
- **Breakers:** changing the model, the tools (any edit or reordering), `parallel_tool_calls`, `text.format`, `reasoning.effort`, verbosity, or compaction. The diagnostics page adds three more:
  - a service-tier change (`service_tier_changed`; the returned tier can differ from the one requested);
  - a `prompt_cache_key` change;
  - any edit to earlier input (`input_changed`).
- **`tool_choice` is safe.** The guide says to "change which tools are callable while keeping their definitions stable to preserve reusable prefixes": set `tool_choice:"none"` or use `allowed_tools` instead of removing tools. The diagnostics page gives the same fix for `tools_changed`. `tool_choice` appears neither among the settings that affect the cache nor among the nine miss reasons.

**R3.5 Under SIWC,** `prompt_cache_retention` must be omitted (R1.2).

## R4. OpenAI: skills

OpenAI has adopted SKILL.md.
- **Codex** (learn.chatgpt.com/docs/build-skills):
  - A skill is a `SKILL.md` with `name` and `description`, and the docs say it will "build on the open agent skills standard".
  - Codex finds skills in `.agents/skills`, `~/.agents/skills` and `/etc/codex/skills`, and loads the full instructions only when a skill is used.
  - It arrived in Codex and ChatGPT around December 2025 (Simon Willison, 2025-12-12 and 2025-12-20).
- **API** (OAI /api/docs/guides/tools-skills, /api/docs/changelog):
  - Described as "compatible with the open Agent Skills standard". Launched in the Responses API on 2026-02-10. Not available in Chat Completions.
  - **Two modes:**
    - *Hosted:* `environment.type` is `"container_auto"` or `"container_reference"`. It runs in an OpenAI container, with skills uploaded through `POST /v1/skills` (referenced as `skill_reference`) or sent inline.
    - *Local:* `environment.type: "local"`. It runs the shell in your own runtime and reads skills from local paths given as name, description and path.
  - Both modes use OpenAI's own `shell` tool type rather than a function tool, and the platform injects the skill catalogue itself.
  - Since 2026-09-10 the Agents API public beta also loads skills, from `environment.capability_directories` in its sandbox. It needs the `OpenAI-Beta: agents=v1` header, has no ZDR, and is US-only.
  - LM Studio offers function tools, plus remote MCP if you opt in (R5.1), but no `shell` tool. So both forms would split the code path (C4).

## R5. LM Studio (latest release 0.4.26, 2026-10-08)

**R5.1 Endpoints.** **[H]**
- **OpenAI-compatible** (LMS docs /developer/openai-compat, LMS CL 0.4.26):
  - `GET /v1/models`.
  - `POST` on `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings` and `/v1/completions` (legacy).
  - `/v1/decisions` (0.4.26), which needs a "decision model".
- **Anthropic-compatible:** `POST /v1/messages` since 0.4.1 (2026-01-30).
- **`/v1/responses`:**
  - It arrived in **0.3.29 (2025-10-06)**, with function tools, SSE streaming, `reasoning.effort`, `previous_response_id`, and remote MCP if you opt in (lmstudio.ai/blog/lmstudio-v0.3.29).
  - 0.3.39 (2026-01-15) made it Open Responses compliant (lmstudio.ai/blog/openresponses).
  - **Stateless use works.** The docs' comparison table allows assistant messages in the request. Codex `--oss` is an officially supported client that uses this endpoint, so full client-held history works.
- **Native REST:** `/api/v1/{chat, models, models/load, models/unload, models/download[/status]}` has been official since **0.4.0 (2026-01-28)**. The old `/api/v0/*` is still documented. Only `/api/v1/chat` lets you set `context_length` per request (LMS docs /developer/rest).

**R5.2 Tool calling on `/v1/chat/completions`.** **[H]**
- **`tool_choice`:**
  - `"auto"`, `"none"` and `"required"` work since 0.3.15. The changelog says `"required"` works on the llama.cpp engine only.
  - A named-function object is rejected with HTTP 400: `Invalid tool_choice type: 'object'. Supported string values: none, auto, required` (LMS BT#670, still open; last report April 2026).
- **Streaming:**
  - Tool calls arrive as OpenAI-style `delta.tool_calls` chunks: id and name first, then argument fragments. Arguments stream as they are generated (0.3.17).
  - Parallel-call streaming was fixed in 0.3.18 and 0.3.19.
  - `finish_reason` is `"tool_calls"` in both streaming and non-streaming responses.
- **Native parsing.** A model counts as native when its chat template supports tools and LM Studio knows its output format. LM Studio then parses its calls into `tool_calls`. Formats added over time:
  - Qwen/Hermes `<tool_call>`, Llama 3.1/3.2 and Mistral;
  - gpt-oss Harmony, which also gets a constrained tool-call grammar on llama.cpp since 0.4.7;
  - Qwen3-Coder/3.5 XML-style, GLM, MiniMax M2, Seed-OSS, Nemotron, LFM2 and Gemma 4.
- **Default (prompt-based) parsing**, for every other model: LM Studio injects a system prompt using `[TOOL_REQUEST]{json}[END_TOOL_REQUEST]`, and rewrites `tool`-role messages as `user`.
- **Tool-name normalisation**, for all models: names are converted to snake_case before the model sees them (0.3.23, introduced as a gpt-oss reliability fix). Keep tool names in snake_case so the name the model sees matches the registered one.
- **Malformed calls.**
  - The docs' wording: "If LM Studio cannot parse any correctly formatted tool calls, it will simply return the response to the standard `response.choices[0].message.content` field" (LMS docs /developer/openai-compat/tools; its list of native models is out of date).
  - In the BT#2224 case, Chat Completions returned HTTP 200 with `tool_calls: []` and `finish_reason: "stop"`, while `/v1/responses` returned HTTP 500 (R5.7).
- **Flags.**
  - `parallel_tool_calls` is not documented.
  - The warning that `strict` is "not yet supported and will be ignored" was logged for `POST /v1/responses` on 0.4.20 (LMS BT#2257, August 2026). How Chat Completions handles `strict` is unconfirmed.

**R5.3 Prompt/KV caching.**
- **Reporting [H].** Reuse of a shared prefix is on by default.
  - `/v1/responses` reports `usage.input_tokens_details.cached_tokens` (lmstudio.ai/blog/openresponses).
  - `/v1/chat/completions` does **not** return `prompt_tokens_details.cached_tokens` (LMS BT#2390 and BT#2419, both open in September 2026). Cache hits there show up only in debug logs (`lms log stream`).
- **MLX [H].** mlx-engine 1.8.5 (lmstudio.ai/blog/mlx-engine-agentic-workloads, 2026-06-05) added a disk-backed cache.
  - It saves the KV cache in 256-token chunks keyed by their content, and evicts the least recently used.
  - It restores the longest cached prefix across requests, including from other conversations that share the same system prompt.
  - It deletes its temp file when the model unloads.
  - Text-only models got it in mlx-engine PR #352 (2026-07-24). Models with a quantised KV cache or speculative decoding are excluded.
  - An `enable_disk_cache` load option was added in PR #369 (2026-08-21).
- **llama.cpp [M].** A new engine layer, "LM Studio Engine Protocol", has been on by default since 0.4.19. Users' logs show upstream llama-server behaviour (LMS BT#2086, BT#2257):
  - each request goes to the slot whose cached prompt shares the longest prefix with it;
  - there is an 8 GiB prompt cache in host RAM (`--cache-ram`), which can be changed only through the advanced llama.cpp argument overrides added in 0.4.24.
- **0.4.15.** It fixed the prompt cache being dropped on every message *when using Claude Code*, which means the Anthropic-compatible `/v1/messages` path (LMS CL 0.4.15). It isn't tied to the other endpoints.
- **`previous_response_id` [M].** 0.4.17 (2026-06-26) fixed chained responses re-processing an ever-growing prompt. LMS BT#2074 is still open, labelled fixed-in-next-update.

**R5.4 Concurrency.** **[H]** except where marked.
- **llama.cpp:** continuous batching since 0.4.0 (lmstudio.ai/blog/0.4.0), controlled by two load options:
  - **Max Concurrent Predictions**, default 4; requests beyond that are queued.
  - **Unified KV Cache**, on by default; all requests share one KV budget instead of fixed slices.
- **Setting it:** `lms load --parallel N` (0.4.1). A `parallel` field on the REST load endpoint appears only in the 0.4.7 changelog ("Add parallel parameter to /api/v1/load endpoint"); the REST load reference doesn't list it. **[L]** `GET /api/v1/models` does document a per-instance `parallel` value, so the runner can check it.
- **MLX:** batching for text models since 0.4.2 (2026-02-06), and for vision models since 0.4.13 (2026-05-13). The docs page still says "MLX coming soon", which is out of date.

**R5.5 Headless operation and JIT loading.** **[H]**
- **llmster, the headless daemon (0.4.0).** Install with `curl -fsSL https://lmstudio.ai/install.sh | bash` (Linux and Mac), then run `lms daemon up` and `lms server start [--port --bind --cors]`. The docs give a systemd startup guide for Linux only; there is nothing for macOS launchd.
- **Desktop-app alternative.** The "run LLM server on login" setting keeps the server running from the tray after the window closes. The last server state is restored on launch, and any `lms` command wakes the service.
- **JIT loading** (on by default):
  - A request naming a downloaded model that isn't loaded makes LM Studio load it, and the request waits.
  - OpenAI-compatible endpoints send no load-progress events, and `/v1/models` lists every downloaded model.
  - JIT-loaded models unload after 60 minutes idle by default. A `ttl` field in the request body changes that per request.
  - Auto-Evict (on by default) keeps at most one JIT-loaded model, and leaves manually loaded models alone.
  - Models loaded with `lms load` never expire unless you pass `--ttl`. With JIT off, you must load the model first.
  - Sources: LMS docs /developer/core/headless, /developer/core/ttl-and-auto-evict.
- **Default context length: 8k since 0.4.16.** Preload with an explicit `--context-length`.

**R5.6 Auth.** **[H]**
- API tokens arrived in 0.4.0 and are **off by default**. Turn on "Require Authentication" in Server Settings and create tokens, with permissions, in the GUI.
- Clients send `Authorization: Bearer <token>`; the Anthropic endpoint also accepts `x-api-key`. In the `openai` SDK, set `apiKey` to the token. With auth off, any non-empty string works (LMS docs /developer/core/authentication).
- There is no command-line way to enable auth or create tokens (lmstudio-ai/lms#489, open), so it needs one GUI step.
- The server binds to 127.0.0.1 by default.

**R5.7 Unconfirmed: user reports without staff confirmation.** **[L]**
- **`tool_choice:"required"`** can return empty content with `finish_reason:"stop"` (LMS BT#1904), or tool-call text inside `content` (LMS BT#2115, 0.4.18).
- **`/v1/responses`:**
  - It can return HTTP 500 "Failed to parse tool call" instead of falling back to text (LMS BT#2224, July 2026).
  - The `instructions` field is reportedly ignored (LMS BT#1154).
  - Multi-turn tool calls intermittently fail with HTTP 500 "Engine protocol predict request failed: fetch failed" (LMS BT#2257, open, 2026-08-09).
- **`parallel_tool_calls:false`.** On 0.4.9, Gemma 4 returned nine identical tool calls in one message despite the flag (LMS BT#1756). The reporter closed the issue on 2026-04-09, pointing to 0.4.10 ("Improve Gemma 4 tool call reliability"), with no staff reply. No release note through 0.4.26 mentions the flag, so whether it is enforced now is unknown.
- **Cache under concurrency:**
  - Concurrent MLX requests may invalidate each other's cache (LMS BT#2320, August 2026).
  - Processing a new prompt pauses MLX generations already running (LMS BT#1709).
  - For llama.cpp, it is *inferred* from upstream llama-server, not from LM Studio docs, that up to N concurrent conversations keep their cache (one slot each, plus the RAM cache).
- **Load and reload:**
  - When the shared KV cache is full, concurrent requests fail instead of queueing (LMS BT#1628).
  - JIT/API-initiated loads and TTL reloads come back with Max Concurrent Predictions set to 4 (LMS BT#1714, BT#2061; no staff reply).
- **Docker:** *now verified on Docker Desktop, see R10.* The research pass expected `host.docker.internal` to reach a host service bound only to 127.0.0.1, with this fallback: if it doesn't, bind to 0.0.0.0 and turn on auth.

**R5.8 What the LM Studio research pass recommended, taken on its own:**
- Use `/v1/chat/completions` and keep the history in the runner: it is the most mature path, and prefix caching works there.
- Preload with `lms load … --context-length --parallel` rather than relying on JIT defaults.
- When `content` contains tool-call markers but `tool_calls` is empty, treat it as a failed call and retry.

That recommendation was made without the OpenAI findings; C1 weighs both.

## R6. TypeORM

**R6.1 Status.** **[H]**
- **Versions.** The latest is **1.1.2 (2026-10-08)**. 1.0.0 shipped on 2026-05-19, 1.1.0 on 2026-07-13 and 1.1.1 on 2026-09-01. The 0.3.x line is still maintained under the npm `legacy` tag (0.3.31, 2026-07-13).
- **Breaking changes in 1.0:**
  - Only `DataSource` remains; `Connection` and the global helpers are gone.
  - `relations` and `select` must use object syntax.
  - Removed: `findByIds`, `findOneById`, `exist()`, `@EntityRepository`, `getCustomRepository`, `TYPEORM_*` env loading, and the lock modes `pessimistic_partial_write` and `pessimistic_write_or_fail`.
  - **`null`/`undefined` in a high-level `where` now throw** (`invalidWhereValuesBehavior`). The guard covers different APIs from different versions:
    - **find, count and exists:** `find*`, `findBy`, `exists`, `count` and `qb.setFindOptions()` throw since 1.0.0.
    - **Writes:** Repository/EntityManager `update`, `delete`, `softDelete`, `restore`, `increment` and `decrement` throw by default only since **1.1.0** (#12690, #12692).
    - **QueryBuilder:** `.where()`, `.andWhere()` and `.orWhere()` are exempt by design (#11878). There an object-style `null`/`undefined` compiles to `col = NULL`, which is always false, so the query silently matches zero rows.
    - **Entity instances:** criteria passed as entity instances are not validated.
  - Non-nullable `ManyToOne` (and owning `OneToOne`) relations now load with INNER JOIN.
  - **Runtime requirements:** Node `^20.19.0 || ^22.13.0 || >=24.11.0`, which the release notes simplify to "Node.js 20+". Targets ES2023.
  - **Drivers:** two families each keep only one client package. MySQL/MariaDB accept only `mysql2`; the `mysql` package and `connectorPackage` option are gone (#11766). SQLite accepts only `better-sqlite3`; `sqlite3` and the `flags` and `busyTimeout` options are gone (#11836). MongoDB needs driver v7+, and Expo needs SDK v52+. Every other database stays, and **Postgres still uses `pg`**, an optional peer at `^8.5.1`, unchanged from 0.3.x.
  - A codemod exists: `npx @typeorm/codemod v1 src/`.
- **ESM.** Still CommonJS internally, with a thin `index.mjs` wrapper and no `"type":"module"`. `reflect-metadata` is now a dependency, imported by the entry point.
- **Decorators.**
  - TypeORM needs legacy `experimentalDecorators`. Standard TC39 decorators are not supported; issue #9862 is open, and on 2026-07-08 a maintainer said it needs a package split, after "driver and platform support". The alternative is EntitySchema.
  - **`emitDecoratorMetadata` is documented as required but is functionally optional.** TypeORM 1.1.2 reads `design:type` in nine decorator files, for three things:
    - guessing a column type when none is given (`@Column`, `@PrimaryColumn`, `@VirtualColumn`);
    - auto-detecting Promise-typed lazy relations, including `@TreeParent` and `@TreeChildren`, which have no `lazy` option;
    - detecting hstore columns and embedded arrays.
  - With an explicit `type` on every column, `lazy: true` where needed, and `hstoreType`/`array: true` set explicitly, entities work with metadata off. An untyped `@Column()` then throws `ColumnTypeUndefinedError` at import, which fails fast.
- **Maintenance health.**
  - Vendure's parent company Elevantiq took over ("The Future of TypeORM", 2024-10-01). Releases resumed with 0.3.21 on 2025-03-03, and 2025 had 8 releases (0.3.21–0.3.28).
  - The team's 1.0 blog post claims "575 PRs (vs 63 the previous year) and closed over 2,300 issues". GitHub data shows about 292 PRs merged in 2025 against 64 in 2024 (still about 4.5×), and 2,252 issues closed in 2025.
- **Sources:** typeorm.io/blog/typeorm-1-0, typeorm.io/docs/releases/1.0/release-notes/, typeorm.io/docs/data-source/null-and-undefined-handling, github.com/typeorm/typeorm releases (1.1.0, 1.1.2), PR #11878, issue #9862, npm registry metadata, typeorm.io/blog/future-of-typeorm.

**R6.2 TypeORM on Bun** (latest Bun is 1.4.3, released 2026-10-10).
- **No official support [H].** TypeORM's CI runs Linux tests on Node 20 and 24 and Windows tests on Node 22, with no Bun or Deno job. Its docs mention Bun once, about binary data being `Uint8Array`.
- **Decorators [H].**
  - `emitDecoratorMetadata` has worked since Bun 1.0.3 (2023-09-22). Bun issue #4136 re-tested a TypeORM repro and was closed as working (2026-07-29).
  - Bun 1.3.10 (2026-02-26) compiled TC39 decorators whenever it didn't see `experimentalDecorators`.
  - Since 1.3.11, and stated in the 1.4.0 notes, `emitDecoratorMetadata: true` on its own also selects legacy decorators. On 1.4.x Bun compiles TC39 decorators, which TypeORM can't use, only when it sees **neither** flag.
- **Gotchas.** 1–4 were verified on Bun 1.4.3 **[H]**:
  1. **Which tsconfig applies.**
     - **Bun's runtime transpiles every file with the settings of the `tsconfig.json` in the working directory**, not the one nearest the file, and it does not walk up from there. This applies to `bun <file>`, `bun run`, `bun test` and `bunx --bun`. The CLI help says "Default $cwd/tsconfig.json"; PR #38719, which would change this, is open.
     - With the flags only in the root tsconfig, starting from `packages/app` compiles TC39 decorators, and TypeORM 1.1.2 then fails with `TypeError: undefined is not an object (evaluating 'object.constructor')`. Starting with `bun run --filter app …` or `bunx --bun typeorm … -d src/data-source.ts` from there does the same.
     - A *relative* `extends` (`./base.json`, `../../tsconfig.json`) passes the flags on.
     - A *package-specifier* `extends` (such as `"@tsconfig/bun"`) is not resolved at all, so any setting that lives only in the package base is lost (issue #6326). Fix PRs #27248 and #34496 were closed unmerged; #40823 is open. `@tsconfig/bun` sets no decorator flags itself, so `extends: "@tsconfig/bun"` plus inline flags works.
     - `--tsconfig-override=<path>` works only when Bun runs the file itself (`bun --tsconfig-override=… <file>`, `bun test`). `bunx`, `bun x`, `bun run <bin>` and package scripts ignore it.
  2. **"Cannot access before initialization."** With metadata on, for `author: User` Bun emits `typeof User === "undefined" ? Object : User`. With circular imports this throws `ReferenceError: Cannot access 'User' before initialization.` on 1.4.3 (Bun #7591, open; the issue title has the 2023 wording). The fix is to type relation properties as `Relation<User>`, as TypeORM's ESM FAQ describes.
  3. **Import `Relation` as a type.** Use `import type { Relation }` or `import { type Relation }`. A plain value import is kept by Bun and fails with `SyntaxError: Export named 'Relation' not found` (Bun #20994). The same applies to any interface used as a decorated property's type (Bun #6172; fix PR #35471 is open).
  4. **Nullable columns.** Bun's metadata ignores `strictNullChecks` (Bun #44120), so always give columns an explicit `type`.
  - **With `emitDecoratorMetadata` off,** Bun emits no `design:type` code, so gotchas 2 and 4 cannot arise (R6.1).
- **CLI and migrations [M].**
  - `cli.js` starts with a `node` shebang, so plain `bunx typeorm` runs under Node: Bun's docs say a `#!/usr/bin/env node` executable is run with `node`. `--bun` forces Bun, which was checked locally with a node-shebang bin.
  - Use `bunx --bun typeorm migration:run -d src/data-source.ts` or `bun ./node_modules/typeorm/cli.js …`. In 1.1.2, `migration:generate` needs a positional path: `bunx --bun typeorm migration:generate src/migrations/Name -d src/data-source.ts`.
  - Run it from a directory whose tsconfig carries the flags (gotcha 1).
  - The CLI loads `.ts` files through `import()`/`require()`, which Bun handles natively. TypeORM's docs describe only ts-node. The 2025-07-02 comment on TypeORM #9738 says only that running `cli.js` directly works, and doesn't mention Bun.
- **`pg` driver [M].**
  - Pure-JS `pg` 8.23.1 is commonly used on Bun, and the old Bun crash issues are closed.
  - `pg-native` historically failed to load on Bun (undefined symbol `node::EmitAsyncInit`; node-postgres #3201, Bun #28131). Bun closed #28131 as fixed for 1.4.0 (PR #36747), but it is untested on 1.4.x, and libpq is still a NAN addon while Bun's NAN support is incomplete (#4290, open). Use pure-JS `pg`.
- **Bundling [M].** Bun #14888 (open, filed against Bun 1.1.33) concerns `bun build --compile --minify`: every entity table was created as `"_"` from minified class names. On 1.4.3, `--keep-names` did not preserve class names; omitting `--minify-identifiers` did. Don't minify identifiers, and name entities and migrations explicitly.
- **Sources:**
  - bun.com/blog/bun-v1.0.3, /bun-v1.3.10, /bun-v1.3.11, /bun-v1.4.0; bun.com/docs/pm/bunx.
  - github.com/oven-sh/bun issues 4136, 6172, 6326, 7591, 14888, 20994, 28131, 28605, 44120; PRs 27248, 34496, 35471, 36747, 38719, 40823.
  - typeorm.io/docs/help/faq/#how-to-use-typeorm-in-esm-projects, github.com/typeorm/typeorm/issues/9738, typeorm `.github/workflows/tests.yml`.

**R6.3 Postgres features for a job scheduler.** **[H]**
- **SKIP LOCKED.**
  - `.setLock("pessimistic_write").setOnLocked("skip_locked")` produces `FOR UPDATE SKIP LOCKED`. Find options also accept `lock: { mode, onLocked, tables }`.
  - `getMany`/`getOne` throw `PessimisticLockTransactionRequiredError` outside a transaction.
- **Locking queries that join.**
  - Name the locked table (`FOR UPDATE OF <alias>`, which is `setLock(mode, undefined, ["alias"])` or `lock.tables`) **whenever the locking query joins another table**, not only on outer joins.
  - Without a table list, Postgres locks the matching rows of every joined table, and SKIP LOCKED also skips rows whose joined rows are locked. Outer joins are simply the case where Postgres errors instead of over-locking.
  - Since 1.x uses INNER JOIN for non-nullable `ManyToOne`, a `find({ relations, lock })` no longer errors. It silently locks the related row instead.
  - The QueryBuilder path inserts lock-table aliases unescaped, so use lowercase aliases. The find-options path escapes them.
- **Partial unique indexes.**
  - `@Index([...], { unique: true, where: '"status" = \'queued\'' })` takes a raw SQL string; quote camelCase column names.
  - Schema diffing never compares the predicate itself. With an **auto-generated** index name, which hashes the `where`, a predicate change shows up as drop and create. With an **explicit** name, edits to the predicate are not detected.
  - For upserts against a partial index, use `orUpdate(cols, conflictCols, { indexPredicate })`.
  - The 1.0 release notes call PR #11318 "partial index support", but it actually adds `@Index({ type: "gin" | "brin" | "hash" | … })`.
- **`jsonb`:** long supported.
- **pgvector:** native `vector` and `halfvec` column types since 0.3.27 (2025-09-19, PR #11437).
  - Declare one as `@Column("vector", { length: 1536 }) embedding: number[]`; values come back as `number[]`.
  - TypeORM runs `CREATE EXTENSION IF NOT EXISTS "vector"` when the DataSource starts, and only warns if it lacks the rights.
  - There is no HNSW or IVFFlat index type: create those in a migration and mark them `@Index("name", { synchronize: false })`.
  - Write similarity queries in raw SQL with `<->`, `<=>` and `<#>`.
- **Sources:**
  - github.com/typeorm/typeorm docs (query-builder/1-select-query-builder.md, entity/1-entities.md), `SelectQueryBuilder.createLockExpression`, PR #11437, issue #10118.
  - postgresql.org/docs/current/sql-select.html (the locking clause).

**R6.4 Unconfirmed.** **[L]**
- TypeORM has made no official statement about Bun.
- Whether `pg` is stable on Bun under heavy load: there is no TypeORM or node-postgres test coverage on Bun.
- Whether TypeScript 7 (7.0.2, 2026-07-08) type-checks `emitDecoratorMetadata` code the same way 6.x does. This affects type-checking only, since Bun does its own transpiling.

## R7. Agent Skills (SKILL.md)

- **Origin [H].** Anthropic released it as an open standard on 2025-12-18. The spec lives in the `agentskills/agentskills` repo, was last edited on 2026-08-04, and has no version number.
- **Frontmatter [H].**
  - **`name` (required):**
    - 1–64 characters, no leading, trailing or double hyphens, and must match the directory name.
    - The spec says "unicode lowercase alphanumeric characters (a-z, 0-9) and hyphens". The reference validator (skills-ref) applies NFKC normalisation and accepts any Unicode lowercase letter or digit; its tests accept `技能` and `мой-навык`.
    - An ASCII-only check is therefore stricter than upstream. That's fine for your own skills, but it could reject third-party ones.
  - **`description` (required):** 1–1024 characters.
  - **Optional fields:** `license`; `compatibility` (up to 500 characters); `metadata`; `allowed-tools` (space-separated, marked experimental).
  - **`metadata`** is a string-to-string map, and the reference parser coerces each value with `str()`. Anything structured stored there must be a JSON-encoded string.
- **Directory layout [H].** `SKILL.md`, plus optional `scripts/`, `references/` and `assets/`. References should be relative and one level deep.
- **Progressive disclosure [H].**
  - Only name and description (about 50–100 tokens) load at startup. The body loads on activation, and resources load on demand.
  - The client guide recommends scanning `<project>/.agents/skills` and `~/.agents/skills`, often also `.claude/skills`, with project-level skills overriding user-level ones.
  - Activation is either by reading the file, or through an `activate_skill` tool whose name parameter is an enum of skill names.
- **Adopters [H].** Claude and Claude Code, OpenAI Codex and ChatGPT, GitHub Copilot, VS Code, Cursor, Gemini CLI, JetBrains Junie, Amp, OpenCode, OpenHands, Goose, Roo Code, Kiro, Factory, Mistral Vibe, Databricks, Snowflake, Spring AI, and others.
- **Typed tools: the spec has none [H].** Skills are instructions plus scripts. A script's interface is documented through `--help`, with JSON on stdout.
  - Claude Code adds its own fields (`arguments`, `context: fork`, `hooks` and others), but claude.ai and the Skills API reject unknown keys.
  - Codex keeps client-specific extras in a separate `agents/openai.yaml`: UI fields, `policy.allow_implicit_invocation`, and `dependencies.tools` (required MCP servers). **It holds no typed tool schemas.** It is a precedent for a client-specific sidecar file, not for typed skill tools; a typed-schema sidecar would be a Gremlin convention.
- **Sources:** agentskills.io/specification, /client-implementation/adding-skills-support, /skill-creation/using-scripts; github.com/agentskills/agentskills (skills-ref parser and validator); code.claude.com/docs/en/skills; learn.chatgpt.com/docs/build-skills.

## R8. Bun: scheduling and process control

- **`Bun.cron` [H].**
  - **OS-level** (Bun 1.3.11, 2026-03-18): `await Bun.cron(path, expr, title)` registers with crontab, launchd or Task Scheduler, and the script exports `default.scheduled()`. `Bun.cron.parse` and `Bun.cron.remove` came in the same release.
  - **In-process** (Bun 1.3.12, 2026-04-09): `Bun.cron(expr, handler)` returns a `CronJob` with `stop`, `ref` and `unref`. It was UTC-only, with no options argument.
  - **Bun 1.4.0** (2026-08-20; PR #35122, merged 2026-07-22) changed the default for in-process jobs and `parse` from UTC to the system's local zone. It added a `{ tz }` option taking an IANA zone to both: `Bun.cron(expr, handler, { tz })` and `Bun.cron.parse(expr, from, { tz })`. An unknown zone throws `TypeError`.
  - **Syntax:** only 5-field expressions are accepted, with `* , - /`, names and `@` nicknames. A seconds field is rejected (verified).
  - **Overlap:** runs never overlap; the next fire is scheduled after the handler settles.
  - **Errors:** a synchronous throw in the handler emits `uncaughtException`, and a rejected promise emits `unhandledRejection`. Without a listener, either one exits the process with code 1; with a listener, the job keeps running.
  - **Scope:** it schedules within one process only and doesn't coordinate across instances.
- **croner 10.0.1 (2026-02-01) [H].**
  - It states it works on "Bun >=1.0.0" and runs a Bun CI job. It supports seconds and year fields, `L`/`W`/`#`, `timezone`, `protect` (prevents overlapping runs), `nextRuns` and `catch`, and it also runs on Node.
  - Without a `timezone`, it uses the process time zone, which is UTC in a container. DST behaviour: R10.
- **`Bun.spawn` [H].** Options include `timeout`, `killSignal` (default SIGTERM), `signal`, `maxBuffer` and `detached` (which calls `setsid`). Tested on Bun 1.4.3 on macOS:
  - **`timeout`** kills only the direct child; grandchildren started by `sh -c` survive.
  - **`detached: true`** followed by `process.kill(-proc.pid, "SIGKILL")` kills the whole process group.
  - **`maxBuffer`** works with the async API, but it kills the child rather than truncating, and captured output overshot the limit by up to about 64 KB. It applies **to each stream separately**: 90 KB on stdout plus 90 KB on stderr with a 100 KB limit ran to completion. For a hard cap, read the streams yourself and truncate.
  - **`stderr`** defaults to `"inherit"`; pass `"pipe"` to capture it.
  - **Pipes held open:** a backgrounded grandchild keeps the stdout pipe open (R10).
- **Sources:** bun.com/docs/runtime/cron, bun.com/blog/bun-v1.3.12, bun.com/blog/bun-v1.4.0, github.com/oven-sh/bun/pull/35122 (and PR #36461, an open docs PR), github.com/Hexagon/croner, bun.com/docs/runtime/child-process, bun-types 1.4.3 `bun.d.ts`.

## R9. Background facts used in the analysis

These come from general knowledge **[K]**, apart from the TypeORM bullet, which the fact-check confirmed.

- **No Mac GPU in containers.** Docker Desktop on macOS gives containers no access to the Mac's Metal GPU, so LM Studio runs on the host.
- **`jsonb` is never updated in place.** A Postgres UPDATE writes a new row version holding the whole value, re-TOASTed if it's large. Appending to an ever-growing `jsonb` array rewrites the whole history on every turn: O(n²) bytes written over a run.
- **TypeORM 0.3.x dropped `null` and `undefined` filters [H].** It silently removed both from a find `where`, so `findOneBy({ id: undefined })` returned an arbitrary row (#9316, "findOneBy( { id: null or undefined } ) method return the first record"). 1.x's throw (R6.1) closes this for the high-level APIs.
  - A related hole is **still open on 1.1.2**: a bare primitive under a relation key, such as `findOneBy({ run: runId })`, drops the criterion and returns an arbitrary row (#12712; fix PRs #12730, #12771 and #12860 are unmerged).
  - It sits outside the typed `FindOptionsWhere` API, so only a `tsc` type-check catches it; Bun doesn't type-check.
- **Classic cron is awkward inside containers.** Jobs don't inherit the container's environment, output doesn't reach `docker logs` without redirection, and it needs PID-1 and supervisor handling.
- **No systemd on macOS.** The equivalent is launchd.

## R10. Behaviour reproduced during the fact-check

All **[H]**, reproduced locally on 2026-10-11.

- **Postgres 16:**
  - A unique violation (23505) inside a transaction puts the whole transaction into the aborted state. Every later statement fails with 25P02 until rollback.
  - `INSERT … ON CONFLICT DO NOTHING RETURNING id` works against a partial unique index, both without a conflict target and with `ON CONFLICT (task_id) WHERE status IN (…)`. A row whose status is outside the predicate never conflicts, even in the same transaction.
  - **Deadlock.** A tick that locks a task row and then inserts a run, running concurrently with a finalisation that updates a run row and then the task row, deadlocks. This was reproduced in both directions.
  - **NUL bytes.** `jsonb` rejects `\u0000` ("unsupported Unicode escape sequence … \u0000 cannot be converted to text"), and `text` columns can't hold NUL at all.
  - **Lone surrogates.** When a string is cut in the middle of an emoji, `JSON.stringify` (Bun 1.4.3) emits an escape for the lone surrogate U+D83D. `jsonb` rejects it with "Unicode low surrogate must follow a high surrogate".
  - **Grants.** A table owner can REVOKE UPDATE/DELETE from itself and then GRANT them straight back, and a superuser ignores grants entirely. An INSERT-only guarantee therefore needs a runtime role that is neither owner nor superuser.
  - **Foreign-key actions bypass grants.** With `ON DELETE CASCADE` or `SET NULL` on a foreign key into an INSERT-only table, a non-owner role with no DELETE or UPDATE on that table still deletes or rewrites its rows, by deleting the parent row. Referential actions run as the table owner.
  - **Outer joins and locking.** `… LEFT JOIN … FOR UPDATE SKIP LOCKED` fails with "FOR UPDATE cannot be applied to the nullable side of an outer join". `FOR UPDATE OF <table>` or a `NOT EXISTS` filter avoids it.
- **Docker Desktop on macOS (Docker 29.8.2):**
  - A container on a normal user-defined network reaches a host server bound only to 127.0.0.1 via `host.docker.internal`. So does a container on internal plus normal networks, which is the workspace's setup in 4.9.
  - A container on an internal-only network can't even resolve the name.
- **Docker docs (not re-tested):**
  - On Linux Docker Engine, `host-gateway` resolves to the default bridge's IP (docker0, usually 172.17.0.1), so a host service bound only to 127.0.0.1 is unreachable from containers.
  - Networks with `internal: true` drop traffic to and from other networks, but can still reach the network's gateway IP, and so any host service listening on it or on 0.0.0.0.
- **Bun 1.4.3:**
  - `Bun.spawn(["sh","-c","echo started; sleep 4 &"])`: the direct child exited in 4 ms, but stdout reached EOF only at 4,012 ms, because the backgrounded grandchild held the pipe.
- **croner 10.0.1 on Bun 1.4.3** (Europe/London, Europe/Budapest):
  - **Fall-back overlap:** fixed-time jobs run once, so computing from `now` doesn't double-fire.
  - **Fall-back, interval jobs:** these skip the whole repeated hour. Hourly goes from 00:00Z to 02:00Z on 2026-10-25, and `*/15` pauses for 75 minutes.
  - **Spring-forward gap:** a job in the gap runs an hour late (02:30 became 03:30 local on 2026-03-29), although croner's README says gap jobs are skipped.

## R11. Spike S2, first pass: a tool loop on LM Studio

All **[H]**, run locally on 2026-10-12.

**Setup.**
- **Server and model:** LM Studio 0.4.26 (build 4), with `prism-ml/bonsai-27b` loaded: Qwen3.5 architecture, MLX, a 262k context and 4 parallel slots. `/api/v1/models` reports it as `trained_for_tool_use`, with reasoning on by default.
- **Script:** a throwaway two-turn loop on `POST /v1/responses`, with `stream: true` and `store: false`.
- **Request:** one function tool (`read_file`, taking `{ path: string }`), a `developer` item, and the question "What exact command does the "check" script in package.json run? Quote it."
- **Runs:** once with `reasoning.effort: "none"` and once with the model's default.

**Findings.**
- **Calls arrive structured.** Both runs returned a `function_call` item rather than text: `name: read_file`, `arguments: {"path":"package.json"}`, `call_id: call_…`, `id: fc_…`. LM Studio parses this model's calls natively (R5.2).
- **Client-held history works.** Turn 2 replayed every item as received and answered correctly, quoting the script. The replay was the developer and user items, all of turn 1's output items, and a `function_call_output`.
- **Reasoning off** (`effort: "none"`):
  - turn 1's output was the call alone, in 44 s;
  - turn 2 was the answer, in 32 s.
- **Reasoning on:**
  - turn 1's output, in 24 s, was:
    - a `reasoning` item with plain `reasoning_text` content, an empty `summary` and no `encrypted_content`;
    - a `message` item whose only text was `"\n\n"`;
    - the call;
  - turn 2, in 48 s, was another reasoning item and the answer, which began with `"\n\n"`;
  - the replayed reasoning items were accepted.
- **One response can mix text and calls.** So "has text" doesn't mean "is the answer": a loop must check for calls first, and treat whitespace-only text as no text.
- **Streaming shape.**
  - Reasoning and answer text stream as deltas (`response.reasoning_text.delta`, `response.output_text.delta`).
  - Call arguments don't. They arrived in a single `response.function_call_arguments.done`, with no `.delta` events. The stream is therefore silent while the model writes a call, so C8's idle limit must allow for a whole call's generation.
  - `response.completed` carried every output item, matching the `response.output_item.done` events.
- **The prompt cache works across turns and conversations.**
  - Every turn reported `usage.input_tokens_details.cached_tokens`. Turn 2 reused 375 of 683 input tokens in one run, and 403 of 709 in the other.
  - The second run's first turn already reused 256 tokens from the first run. That fits the MLX cache sharing 256-token chunks across conversations (R5.3).
- **Not covered yet:**
  - whether the developer item is honoured (this question needed the file either way);
  - `tool_choice: "none"`;
  - malformed calls;
  - BT#2257's intermittent HTTP 500s;
  - the REST `parallel` field;
  - object `tool_choice` and `allowed_tools`;
  - other models.

## R12. Skills, the playwright-cli skill, and where the shell runs

Researched on 2026-10-15 for the next step: loading skills, with enough tools to use Microsoft's playwright-cli skill. The measurements ran on a Mac with Docker Desktop 29.8.2 (linux/arm64) and @playwright/cli 0.1.22, the npm latest. An independent fact-check re-verified the 12 source-based claims that matter most: 11 hold and 1 holds partly. Its corrections are folded in.

**R12.1 What the playwright-cli skill needs from the agent.** **[H]**
- **The skill ships with the CLI.** It lives in the npm package (`skills/playwright-cli/`), identical to the copy in its bundled playwright-core. SKILL.md is 15.4 KB, about 4k tokens, and links to 10 references totalling 53 KB. Its frontmatter's `allowed-tools: Bash(playwright-cli:*) Bash(npx playwright:*) Bash(npx --no-install playwright:*)` is Claude Code's syntax.
- **A shell.** The model drives the browser with `playwright-cli <command>`.
- **File reads, and output in line.**
  - An action command such as `open`, `goto` or `click` prints about 240 B: the page's URL and title, and a relative link to a snapshot file under `<cwd>/.playwright-cli/`, which the model then reads.
  - An explicit `snapshot` prints the whole tree to stdout instead: 48,250 bytes for Hacker News' front page, measured on 2026-10-15. That's despite SKILL.md's comment that it saves to a file.
  - Either way the page is 49 KB, over `read_file`'s 32 KiB cap.
  - Narrower reads exist: `find` (15.6 KB of matches on that page, printed to stdout), `snapshot --depth=N`, and `--raw eval` (about 250 B for the top five titles).
- **Reads inside the skill's directory,** for its references.
- **Copied skills go stale.** `playwright-cli install --skills` copies the skill into a project, and the CLI warns once a day when a copy no longer matches, unless `CI` or `NO_UPDATE_NOTIFIER` is set. The copy inside the installed package always matches.

**R12.2 How playwright-cli runs.** **[H]**
- **A detached daemon per session.** `open` spawns the browser daemon with `detached: true` (its own session and process group) and stdio `['ignore', 'pipe', <log file>]`. It reads stdout until "Daemon listening on", then closes the pipe and `unref()`s. So `open` returns in about 1.9 s even through a pipe, and a group kill aimed at the command misses the browser. The daemon inherits the caller's environment and takes its cwd as the root for output files.
- **One session per install by default.** The CLI looks for a `.playwright/` folder from the cwd upwards. Without one, it hashes its own package root, so every caller of one install shares the `default` session. `PLAYWRIGHT_CLI_SESSION` selects a session, and a headless session exits after an hour idle; `PLAYWRIGHT_MCP_IDLE_TIMEOUT`, in milliseconds, changes that.
- **`kill-all` isn't scoped.** It runs `ps auxww` and SIGKILLs every process whose command line contains `run-mcp-server`, `run-cli-server`, `cli-daemon`, `cliDaemon.js` or `dashboardApp.js`, swallowing errors. On a host that reaches all such processes of the same user, other tools' included. In a container it reaches the container's processes, and without procps it silently does nothing. The skill documents it to the model.
- **Browser and config.** The default is branded Chrome (channel `chrome`), headless. Config merges `~/.playwright/cli.config.json`, then `.playwright/cli.config.json` in the cwd, then `PLAYWRIGHT_MCP_*` variables such as `PLAYWRIGHT_MCP_BROWSER`.
- **Daemons leak in practice.** Codex Desktop's built-in Playwright skill, built on this CLI, has open reports of daemons and Chrome trees outliving tasks; one counted 8 daemons and 56 Chrome processes. Wherever the shell runs, a run needs cleanup at its end.

**R12.3 `docker exec` as the shell's transport.** **[H]** Measured with `oven/bun:1.4.3`.
- **Killing the client never stops the command.** That holds for SIGKILL, SIGTERM, SIGINT and SIGHUP (moby#9098, open since 2014). On SIGTERM and SIGINT the client even exits 0.
- **An in-container `timeout -k <grace> <secs>` bounds it.** It kills the command's process group at the deadline (exit 124) and sends SIGKILL after the grace (137), even after the client is gone. `setsid` children escape it.
- **No hang on held pipes.** Docker closes an exec's streams about 2 s after the exec'd process exits, so a background grandchild can't hang the call; its later output is lost.
- **Clean defaults.** stdin is `/dev/null` unless `-i` is given, only `-e` variables reach the command, and each exec costs about 33 ms.
- **Same-path bind mounts agree.** Paths, realpath, relative symlinks and visibility match on both sides. On Docker Desktop, files land owned by the host user.
- **Sharp edges.** A plain `sleep` as PID 1 collects zombies, so use `--init`. Docker's own start errors come back as exit 126 or 127 on stdout. `bash -c` fails above 128 KiB of argument. An unknown uid gets HOME `/`.
- **A run-ID sweep works, as root.** Scanning `/proc/*/environ` for `GREMLIN_RUN_ID` killed exactly one run's processes, `setsid` ones included. A non-root uid can't read root-owned or non-dumpable environs, so a sweep as the host user is untested.
- **Networking.** On the default bridge, the container reaches the internet and `host.docker.internal`; an `--internal` network blocks both.

**R12.4 Playwright in a linux/arm64 container.** **[H]**, from source, docs and registry metadata; not yet run.
- **No branded Chrome.** Playwright refuses to install it on Linux arm64, in the CLI's bundled core and on main. Google's apt repo now ships arm64 Chrome, but Playwright doesn't support it. The CLI defaults to `chrome`, so a container has to select chromium, for example with `PLAYWRIGHT_MCP_BROWSER=chromium`.
- **Node, not Bun.** The CLI spawns its daemon with `process.execPath`.
- **No matching official image.** The CLI's alpha core expects Chromium r1247, and the v1.64.x images ship r1248. `playwright-cli install-browser chromium` fetches the matching build. A `node:26-trixie-slim` image with it comes to about 1.1 GB, with a 3–5 minute cold build (estimates).
- **Defaults in a container.** Chromium runs with `--no-sandbox`. Playwright's Docker docs recommend `--init` and `--ipc=host`; a larger `/dev/shm` is an alternative.
- **Not yet run.** The real CLI with Chromium hasn't been run in a container here.

**R12.5 OS sandboxes on macOS.**
- **Ready-made profiles stop Chromium [H].** Codex's Seatbelt profile and Anthropic's sandbox-runtime both lack a `mach-register` rule, so Chromium dies at launch (open issues, reproduced in October 2026).
- **An allow-by-default profile ran the skill [M].** It denied the home directory except the working directory, a run HOME and the skill roots, plus `.env` files, LM Studio's port and the Docker socket. The real `open`, `snapshot` and `close` ran inside it with branded Chrome, whose own sandbox has to be off because it can't nest. That run used a subset of the full rules. Inside it, `ps` fails, so `kill-all` kills nothing.
- **Gaps [M].** Other same-user processes' environments stay readable through sysctl; keychain access is unproven; everything outside the home stays readable; the network stays open; and it is macOS-only.

**R12.6 Where other harnesses run the shell.** **[H]**
- **On the host, optionally in an OS sandbox:** Codex CLI, and Claude Code's Bash sandbox, which is off by default.
- **The whole agent in a container or VM:** OpenHands V1, Claude Code's devcontainer, Gemini CLI's sandbox, Docker Sandboxes.
- **The harness outside, its tools inside (C3's split):** OpenHands V0 (an HTTP action server), SWE-ReX (an HTTP server with a token), E2B (envd), and Codex's `exec-server` (JSON-RPC). mini-swe-agent runs one `docker exec` per command in a `sleep 2h` container; its timeout kills only the client, so the command keeps running.
- **Docker Sandboxes (`sbx`) can host just a shell:** a microVM driven with `sbx exec`, whose outbound traffic goes through a host proxy with deny-by-default presets. It needs a Docker sign-in.
- **The lethal trifecta** is private data, untrusted content and a way to send data out, together. Simon Willison: "The only way to stay safe there is to avoid that lethal trifecta combination entirely." A shell that browses has all three unless its boundary removes one.

**R12.7 Adding skills support, per the client guide.** **[H]**
- **Catalog:** each skill's name, description and SKILL.md location, in the system prompt or in the activation tool's description. With no skills, omit it entirely.
- **Activation:** the model reads SKILL.md, or calls a dedicated tool whose `name` parameter is an enum. The tool returns the body without frontmatter, wrapped (for example `<skill_content name="…">`), with the skill's directory and a *list* of its resources, never their contents.
- **Resources** load on demand through the model's file tool, with skill directories allowlisted for reads.
- **Validation is lenient:** warn on a name that doesn't match its directory or is too long; skip a skill only when its description is missing or its YAML can't be parsed. Consider a fallback for unquoted colons, which other clients accept.
- **Over a session:** exempt skill content from compaction, and don't inject a skill that's already active.
- **Trust:** project-level skills can come from an untrusted repository.

**R12.8 Finding and stopping a run's processes on the host.** **[H]** Measured on the development Mac on 2026-10-15, for D18.
- **Listing environments.** `ps axeww -o pid=,command=` and `ps -E` show the environment of the user's own processes, but not of Apple's platform binaries (`/bin/bash`, `/bin/sleep`). `ps -e` shows none. Linux's procps takes the same `axeww` flags.
- **playwright-cli's processes.** A session started with `GREMLIN_RUN_ID` in its environment showed it on the daemon (Node), and not on any of its 7 Chrome processes, which hide their environment.
- **Stopping them.** SIGTERM to the daemon alone stopped every Chrome process, in 60–160 ms in later runs. A daemon killed with SIGKILL instead would leave Chrome, which leads its own process group, beyond a sweep by run ID.
- **`yaml` 2.9.1** parses every installed skill's frontmatter. With its default options it sends warnings, such as an unresolved tag, to `process.emitWarning`, which prints to stderr; `logLevel: 'error'` stops that and still throws on errors.

**Sources:** the installed @playwright/cli 0.1.22 (README.md, skillCheck.js, and playwright-core's lib/tools/cli-client/ and coreBundle.js); agentskills.io/client-implementation/adding-skills-support; github.com/moby/moby/issues/9098; github.com/SWE-agent/mini-swe-agent and SWE-agent/SWE-ReX; github.com/OpenHands/OpenHands at 0.59.0; github.com/openai/codex issues #21292, #31560 and #34474, and codex-rs/exec-server; github.com/anthropics/sandbox-runtime and its issue #210; Docker Sandboxes (docker/docs, `sbx`); mcr.microsoft.com/playwright tags; Google's arm64 apt index; simonwillison.net/2025/Jun/16/the-lethal-trifecta.

## R13. Running the tests and mutation testing on Bun

All **[H]**, measured on 2026-10-16 with Bun 1.4.3, Node 26.11, Vitest 4.1.11 and Stryker 10.0.0. Vitest's and Stryker's command-line scripts start Node, so until now the tests ran on Node while the app runs on Bun.
- **Vitest under Bun** (`bunx --bun vitest run`) runs the tests on Bun.
  - One thing broke: inside Vitest, Bun's import of `zod` came back without its `z` export (258 of 260 exports), so 55 server tests failed.
  - Plain Bun imports `zod` whole.
  - Inlining `zod` in Vitest's config (`server.deps.inline`) made all 228 tests pass on Bun.
- **Stryker under Bun** failed to load its Vitest runner: "First argument must be an Error object".
  - Stryker loads Babel 8, whose stack-trace rewriter wraps Bun's native `Error.prepareStackTrace`.
  - Vite then calls `Error.captureStackTrace` on an object that isn't an `Error`, which V8 accepts and Bun's native function rejects. This is oven-sh/bun#41151, open.
  - A preload that installs a lenient `prepareStackTrace` first fixes it, in Stryker's process and in the test runners it forks.
- **Stryker's Vitest runner** then found no "related" test files under Bun. `related: false` fixes that, and per-test coverage still picks each mutant's tests.
- **Result:** the full mutation run on Bun killed or timed out all 879 mutants, a 100% score, in 30 s. On Node it scores the same in 36 s.
- **A trap:** a Vitest config with an absolute `root` makes Stryker test the unmutated files. Every mutant "survives", and the score reads 0% while the run looks healthy.
- **Vitest 5** (5.0.5) still breaks Stryker's Vitest runner: stryker-js#6210, open. The 4.x pin stays.

**Sources:** github.com/oven-sh/bun/issues/41151; github.com/stryker-mutator/stryker-js/issues/6210; `@babel/core` 8.0.7's lib/errors/rewrite-stack-trace.js; Vite 8.3.4's bundled `CustomError`; zod 4.6.7's package exports.

## R14. Running the server on Bun or Node

All **[H]**, measured on 2026-10-16 with Bun 1.4.3, Node 26.11 and `yaml` 2.9.1, for D19. Skills need YAML parsing and process spawning, which Bun has built in (`Bun.YAML`, `Bun.spawn`) and Node doesn't, or not in the same form.
- **The server already runs on Node.**
  - Node's own type stripping loads it. Pointed at a port where nothing listens, it got as far as "Can't reach LM Studio".
  - 171 of its 172 tests pass on Node. The one failure is R13's runtime test, which asserts Bun.
  - Vitest runs the code through Vite's transform, so passing tests on Node don't show that Node itself can load the server. Only starting it there does.
  - Node 26 accepts `--env-file-if-exists=.env`, which reads that one file. Without it, Node prints ".env not found. Continuing without it." to stderr. Bun also reads `.env.local`, and a file for `NODE_ENV`.
- **YAML: `Bun.YAML` and the `yaml` package.** With `yaml`'s options set as below, both gave equal values, keys in the same order, for the frontmatter of every skill installed on the development Mac.
  - **They agree on:**
    - an empty text, which gives `null`;
    - mappings, sequences and scalars;
    - flow collections with trailing commas;
    - a custom tag, which gives the text after it;
    - anchors;
    - YAML 1.2's scalars: `yes`, `on` and dates stay strings.
  - **With `yaml`'s defaults they differ on two plausible inputs:**
    - a repeated key: Bun keeps the last value, `yaml` throws;
    - a merge key `<<`: Bun merges, `yaml` keeps it as a key.

    `uniqueKeys: false` and `merge: true` close both gaps.
  - **Still different:**
    - several documents in one text: Bun returns an array, `yaml` throws;
    - a collection used as a key: `a,b` against `[ a, b ]`;
    - a key that overrides a merged one: the same values, but Bun lists the overriding key first;
    - error messages. Bun's are one terse line, and `yaml`'s give the position, then a code frame.
  - **Warnings:** `yaml`'s go to `process.emitWarning`, so to stderr, unless `logLevel` is `'error'`. Errors still throw then.
  - **Under Vitest on Bun,** `yaml` keeps all its exports, unlike `zod` (R13).
- **Spawning: `Bun.spawn`, and `node:child_process` on Bun and on Node.**
  - **All three paths agree on:**
    - exit codes;
    - signals, reported by name with a null exit code;
    - an environment holding only what's passed;
    - the working directory;
    - looking a program up in the given `PATH`;
    - stdin at end-of-file;
    - process groups with `detached`;
    - an exit reported while a background child still holds stdout. Cancelling a stream then resolves at once, and closes the pipe: the child's next write fails with `EPIPE`.
  - **They differ** in their messages, and in how a failed start is reported. `Bun.spawn` throws. `node:child_process` mostly emits `error`, but throws when the working directory is a file.
  - **Letting the runtime exit.** While a `sleep` held unread pipes:
    - `unref()` alone kept the runtime running until the `sleep` ended, on every path;
    - cancelling both streams and then calling `unref()` let it exit at once, on every path.
- **Tests can't hide the `Bun` global.** `globalThis.Bun` is neither writable nor configurable. `Bun.YAML.parse` and `Bun.spawn` are writable, so tests can wrap them.
- **Export conditions don't help a test run.** Vite 8.3.4 resolves with `module`, `node` and `development|production`, never `bun`.
- **`engines` isn't enforced.** A workspace package declaring `"bun": ">=99.0.0"` installed and ran on Bun 1.4.3 without a warning.
- **Keeping Node** also keeps C7's fallback, running the app on Node, within reach.

**Sources:** `yaml` 2.9.1's documented options (`logLevel`, `uniqueKeys`, `merge`); Vite 8.3.4's `DEFAULT_SERVER_CONDITIONS`; Node's `child_process` and `stream` documentation.

## R15. Turns, steps and loop limits

Two research agents read each project's docs and source on 2026-10-16, for C8 and D9, and quoted them. No independent fact-check has re-verified them yet. R15.3 was measured on the development Mac. The questions: is one model request what others call a turn, and what do other agent loops do at their limit?

**R15.1 Two meanings of "turn".**
- **The whole exchange:** one user input, and everything the agent does until it answers. **[H]**
  - **Codex's app-server** nests thread → turn → item. A turn is "A single user request and the agent work that follows". `turn/start` begins it with the user's input, and `turn/completed` ends it. The docs imply, without saying, that one turn spans several model calls.
  - **Claude Code's glossary:** "A turn begins when you send a message and ends when Claude finishes responding, with any number of tool calls in between." Its hooks follow suit: `UserPromptSubmit`, `Stop` and `StopFailure` fire once per turn, `PreToolUse` and `PostToolUse` on every tool call.
  - **Gemini:** "A "turn" is a single, complete exchange in a conversation between a user and a model", and "A "step" is a finer-grained action or operation performed by the model, often as part of a larger process to complete a turn". A user message holding only a `functionResponse` is still the same turn.
  - **BFCL v3:** "Each function call and its result constitute a single step", and "Each turn may involve several steps."
  - **Google ADK** calls the exchange an *invocation*: "everything that happens in response to a single user query".
- **OpenAI's `reasoning.context` probably means the same.** `current_turn` "Makes reasoning from the active turn available, but does not render reasoning from earlier turns into the next sample" (R2.4). OpenAI doesn't define the turn there. Two passages point to the whole exchange: for consecutive function calls, the reasoning guide passes back every item "since the last `user` message", and the archived reasoning-items cookbook says "while this is another API call, we consider this as a single turn in the conversation". **[M]**
- **One model call, with the tools it asked for,** is called: **[H]**
  - a *turn* by OpenAI's Agents SDK ("A turn is defined as one AI invocation (including any tool calls that might occur)"), OpenAI's WebSocket-mode guide ("start each turn by sending a `response.create` event"), Claude's Agent SDK ("A turn is one round trip inside the loop"), SWE-agent and Pydantic AI's docs. Anthropic's Messages API calls each user or assistant message a turn;
  - a *step* by Vercel's AI SDK ("A step includes one model generation and the execution of any local tools requested by that generation"), smolagents, BFCL, Gemini, tau-bench (`max_num_steps`) and mini-SWE-agent;
  - an *LLM call* by ADK, an *iteration* by Microsoft Agent Framework, a *round trip* by Anthropic's tool-use docs, and a *round* by LM Studio's `.act()`.
- **OpenTelemetry's GenAI conventions,** still in Development, have no turn. Their operations are `invoke_agent`, `chat` and `execute_tool`, and only `gen_ai.conversation.id` groups calls. **[H]**
- **The split.** The sources that define the word use the whole exchange, and call one model call a step. The limits named "max turns" count model calls, against their own vendors' glossaries. They don't count alike either: OpenAI's counts the call that answers, and Claude's counts tool-use round trips only.
- **Here.** The code and this brief say "turn" for one model request: `runTurn`, `MAX_TURNS`, the `turn` log record, C5's "model turn". Each request's result is already a `SessionStep`. A run has one user message, so all of its turns sit inside one of OpenAI's. The meanings would collide once a session takes a second user message (the `SessionStep` type plans one), once `reasoning.context` is set, and in compaction, which cuts at turn boundaries (C5) and keeps `keepLastTurns` (4.3). C13 proposes new names.

**R15.2 How agent loops limit and stop.** Versions current on 2026-10-16. **[H]** unless marked.

| Framework | Unit | Counts | Default | At the limit | Last call's tools run |
|---|---|---|---|---|---|
| OpenAI Agents SDK (Python 0.24.0; JS alike) | turn | model calls, with their tools | 10 | raises `MaxTurnsExceeded` before call N+1. An optional `max_turns` error handler returns your own fallback output instead, with no model call | yes |
| Claude Agent SDK, Claude Code | turn | tool-use round trips; the call that answers doesn't count | none | an `error_max_turns` result with no `result` field; `query()` raises after yielding it, and the CLI exits non-zero | yes |
| Vercel AI SDK 7.0.142 | step | model calls, with their local tools | 1 (`generateText`, `streamText`); 20 (`ToolLoopAgent`) | stops and returns normally | yes |
| Pydantic AI 2.57.0 | request | model responses acted on | 50 | raises `UsageLimitExceeded` before request N+1 | yes; a batch that would pass `tool_calls_limit` runs none |
| Google ADK 2.12.0 | LLM call | LLM calls | 500 | raises `LlmCallsLimitExceededError` before call N+1 | yes |
| smolagents 1.26.0 | step | model calls, with their actions | 20 | one more call, without tools, writes the answer: "An agent tried to answer a user query but it got stuck…" | yes |
| Microsoft Agent Framework (Python 1.22.0) | iteration | LLM round trips | 40 | one more call with `tool_choice="none"` | yes |
| AutoGen AgentChat (archived) | tool iteration | model calls, with their tools | 1 | a reflection call with `tool_choice="none"`, or a summary of the tool results | yes |
| LangGraph 1.2.15 | super-step | graph rounds; the model and the tools are separate nodes | 10007 in the source, 1000 in the docs | raises `GraphRecursionError` | — |
| LangGraph's `create_react_agent` (deprecated) | remaining steps | super-steps left | — | a reply with tool calls and fewer than 2 steps left becomes "Sorry, need more steps…", without an error | **no** |
| LangChain's `create_agent` | — | — | recursion limit 9999; `ModelCallLimitMiddleware` is opt-in | a canned AI message and the end, or `ModelCallLimitExceededError` | yes |
| Mastra 1.78.0 | step | model calls, with their tools | 5 | stops, like the AI SDK | yes **[M]**: the docs only |

- **Nobody warns the model by default.** LangGraph's `RemainingSteps`, Pydantic AI's `ctx.usage_limits` and smolagents' planning prompts are opt-ins.
- **Retries don't count.** Pydantic AI's limit "bounds the number of turns of the agent loop, not the number of requests sent to the provider".
- **Three endings:**
  - **an error:** OpenAI, Claude, Pydantic AI, ADK, LangGraph;
  - **the last step as it is,** which may hold no text: the AI SDK, Mastra;
  - **one more call without tools,** so the user still gets an answer: smolagents, Microsoft Agent Framework, AutoGen. LangChain's middleware and OpenAI's error handler return a canned or supplied output instead. C8's finalize turn is this pattern.
- **Where the session stands.** It counts model requests, as OpenAI's Agents SDK does. With `MAX_TURNS` at N, it sends at most N requests and runs the calls of the first N − 1. Request N's calls don't run: each gets an output saying so, and the run fails without an answer. Of the loops above, only `create_react_agent` also drops them, and it answers instead of failing. In a live check, a Hacker News task (stories 10 to 12) took 29 turns, against the default limit of 30 (hello-to-server's design).

**R15.3 LM Studio's `tool_choice:"none"` on `/v1/responses`.** **[H]** for one model: measured on 2026-10-16 with LM Studio 0.4.26 and `ornith-1.5-9b-mlx` (Qwen3.5 architecture, MLX, 4-bit). Each of three runs sent four non-streaming requests carrying the server's two tools and reasoning effort `none`.
- **Accepted, by dropping the tools.** The same input counted 177–181 input tokens under `"none"` and 511–515 under `"auto"`: the tool definitions leave the prompt.
- **So the KV prefix is lost.** Under `"none"`, `cached_tokens` was 0 every time. Under `"auto"`, the same input reused the 256-token chunk cached by the request before. A finalize turn sent with `"none"` would prefill the whole history again, the run's largest prompt.
- **It doesn't stop a model that wants a tool.** Asked to read a file under `"none"`, the model wrote a call anyway, in its own syntax and with no definitions to follow, and LM Studio failed the request with HTTP 500 "Failed to parse tool call" in 2 of 3 runs. The third answered in text.
- **An instruction does.** After a call whose output said it wasn't run, this user message got a text answer in 3 of 3 runs, under `"auto"` and under `"none"`: "You have run out of turns, so you can't call tools any more. Answer now: say what you did, what you found, and what remains."
- **Not covered:** streaming, other models, and a long history, where the lost prefix would cost time.

**Sources:** openai/openai-agents-python `src/agents/run.py` and openai.github.io/openai-agents-python/running_agents; openai/openai-agents-js `packages/agents-core/src/runner/turnPreparation.ts`; OAI /api/docs/guides/reasoning, /guides/conversation-state, /guides/function-calling and /guides/websocket-mode, and /cookbook/examples/responses_api/reasoning_items; openai-python `src/openai/types/shared/reasoning.py`; learn.chatgpt.com/docs/app-server; code.claude.com/docs/en/agent-sdk/agent-loop, /cli-reference, /glossary and /hooks; platform.claude.com/docs/en/api/messages and /agents-and-tools/tool-use/how-tool-use-works; ai.google.dev/gemini-api/docs/generate-content/thought-signatures; adk.dev/runtime/event-loop and /runtime/runconfig; google/adk-python 2.12.0 `flows/llm_flows/core/_model_call.py`; ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling and /docs/agents/loop-control; vercel/ai 7.0.142 `generate-text.ts`; docs.langchain.com/oss/python/langgraph/graph-api; langchain-ai/langgraph 1.2.15 `_internal/_config.py`, and prebuilt 1.1.1 `chat_agent_executor.py`; langchain-ai/langchain 1.4.6 `agents/middleware/model_call_limit.py`; pydantic/pydantic-ai 2.57.0 `usage.py`, and pydantic.dev/docs/ai; huggingface/smolagents 1.26.0 `agents.py`; microsoft/agent-framework python-1.22.0 `_tools.py`; microsoft/autogen `_assistant_agent.py`; mastra.ai/reference/agents/generate; github.com/open-telemetry/semantic-conventions-genai; gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html; sierra-research/tau-bench `tool_calling_agent.py`; swe-agent.com/latest/usage/trajectories; lmstudio.ai/docs/typescript/agent/act.

## R16. File-writing tools in coding harnesses

A survey of ten harnesses on 2026-10-21/22, for the `file-write-tools` change and D23, against their current source and docs. **[H]** throughout. The question: what tools do coding agents give a model to write and change files, how do they match the text to change, and what keeps them from overwriting a file?

| Harness | Write | Edit | Matching | Overwrite guard |
|---|---|---|---|---|
| Claude Code | `Write(file_path, content)` | `Edit(file_path, old_string, new_string, replace_all)` | exact; unique unless `replace_all` | read first (newer models may skip it), plus a permission prompt |
| Anthropic text editor tool | `create(path, file_text)` | `str_replace`, `insert` | exact; errors on 0 or many | left to the client; the reference code's `create` refuses existing files |
| Codex CLI | none | `apply_patch` (freeform, V4A) | exact, then trailing whitespace ignored, then trimmed, then punctuation folded | approval policy; `Add File` overwrites |
| Responses API `apply_patch` type | `create_file` | `update_file`, `delete_file` (V4A diffs) | the client's | left to the client |
| Gemini CLI | `write_file` | `replace(…, allow_multiple)` | exact, then whitespace-tolerant, then fuzzy, then an LLM fixer | confirmation with a diff |
| OpenHands | `create` | `str_replace`, `insert`, `undo_edit` | exact, then stripped | `create` refuses existing files; writes atomically |
| opencode | `write` | `edit(…, replaceAll)`; `apply_patch` for GPT | nine fallback matchers | permission prompt; its read-before-write check was removed in April 2026 |
| Cline | none | `editor`; `apply_patch` for GPT | exact after normalising line endings | no whole-file overwrite |
| pi | `write(path, content)` | `edit(path, edits[{oldText, newText}])` | exact, then fuzzy | none |
| Goose | `write(path, content)` | `edit(path, before, after)` | exact, unique | none |

- **The toolset:** a whole-file write plus an exact find-and-replace edit, or `apply_patch` in their place for GPT-family models.
- **Shared rules:** parent directories are created; zero or many matches is an error asking for more context.
- **Names:** Claude Code, pi, opencode and Goose call the pair write and edit, and Claude Code, pi and opencode call the read tool read. Codex's `apply_patch` keeps its name wherever it's offered, since GPT models are trained on it.
- **Reading pages by line** in every harness with a read tool: pi and Claude Code take `offset` and `limit`, Gemini CLI `start_line` and `end_line`, opencode `offset`.
- **The usual guard against overwriting is a person approving a diff.** This agent runs unattended (M1), so the comparable harnesses are pi and Goose, which keep no file state at all.

**Sources,** checked 2026-10-21/22: code.claude.com/docs/en/tools-reference; platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool; github.com/anthropics/claude-quickstarts (computer_use_demo/tools/edit.py); github.com/openai/codex (codex-rs/apply-patch/src/{parser,seek_sequence,file_update,text_file}.rs; codex-rs/core/src/tools/handlers/apply_patch_spec.rs); developers.openai.com/api/docs/guides/tools-apply-patch; github.com/google-gemini/gemini-cli (packages/core/src/tools/{edit,write-file}.ts); github.com/OpenHands/software-agent-sdk (openhands-tools/openhands/tools/file_editor/editor.py); github.com/anomalyco/opencode v1.19.3 (packages/opencode/src/tool/{edit,write}.ts) and PR #22999; github.com/cline/cline (sdk/packages/core/src/extensions/tools/executors/editor.ts); github.com/badlogic/pi-mono (packages/coding-agent/src/core/tools/{write,edit}.ts); github.com/aaif-goose/goose (crates/goose/src/agents/platform_extensions/developer/edit.rs).

## R17. MCP servers: persistence, authorization and the client

Researched on 2026-10-29 for MCP support, in three layers: a data folder holding `db.sqlite` through TypeORM, a command that runs an MCP server's OAuth flow and saves its tokens, and an MCP client in the agent. The measurements ran on Bun 1.4.4 and Node 26.12.1 on macOS arm64, in Linux containers, and against local mock servers. The server survey read 29 vendors' public metadata, without registering a client or requesting a token. Independent verifiers re-checked the 60 claims the decisions rest on: 46 hold, 14 hold partly, and none failed. Their corrections are folded in. R17.5, a survey of other harnesses, wasn't re-checked.

**R17.1 TypeORM and SQLite on Bun and Node.** **[H]** Measured on 2026-10-29 on Bun 1.4.4 (2026-10-22) and Node 26.12.1, macOS arm64, with TypeORM 1.1.2, `better-sqlite3` 13.0.3, `sql.js` 1.15.2 and TypeScript 7.0.2.
- **Release and upstream.** TypeORM 1.1.2 (2026-10-08) is still npm `latest`, and none of the 10 commits on master since touches the SQLite drivers, ESM or decorators. The package is still CommonJS behind a thin `index.mjs` (R6.1).
  - Two PRs are open, each needing two approvals. #12971, "support better-sqlite3 v13", has one: it widens the peer range to `^12.0.0 || ^13.0.0`, passes `nativeBinding` only when set, and says Bun wasn't tested. #12691, a native `bun-sqlite` type, has none, and an unresolved bot finding that a bigint `lastInsertRowid` breaks the id arithmetic.
  - `node:sqlite` (#11164), `bun:sqlite` (#11236), libSQL (#12012) and TC39 decorators (#9862) are open issues with no maintainer commitment.
- **Two server drivers.** Of 1.1.2's SQLite types, `better-sqlite3` and `sqljs` run on a server; `capacitor`, `cordova`, `expo`, `nativescript` and `react-native` are for mobile platforms **[K]**. `type: "sqlite"` is gone: `new DataSource()` throws `MissingDriverError: Wrong driver: "sqlite" given`.
- **What the `better-sqlite3` driver calls.** `new driver(database, { readonly, fileMustExist, timeout, verbose, nativeBinding })`, then `prepare()`, `pragma()` and `close()` on the database, and `reader`, `all()` and `run()` on statements. A proxy that recorded every member read saw only these on both runtimes, plus `then` on both objects, which TypeORM's async functions return: a stand-in with a `then` member would be taken for a promise.
  - `pragma()` sets `key`, `foreign_keys` and `journal_mode = WAL`, and reads `table_xinfo`, `index_list` and `foreign_key_list`, which must come back as arrays of rows. Other PRAGMAs go through `prepare()`.
  - Transactions are plain SQL: `BEGIN TRANSACTION`, or `SAVEPOINT typeorm_N` when nested, then `COMMIT`/`RELEASE` or `ROLLBACK`/`ROLLBACK TO`.
  - The options are `database` (relative to `process.cwd()`; the driver creates the parent folder), `driver`, `key`, `statementCacheSize` (100), `prepareDatabase` (awaited, given the raw handle), `readonly`, `fileMustExist`, `timeout` (5000, the busy timeout), `verbose`, `nativeBinding`, `enableWAL` (off by default) and `poolSize?: never`. typeorm.io's SQLite page lists every settable one but `driver`.
- **Parameters and results.**
  - `query()` takes only positional arrays and maps booleans to 1/0. Entity values, and find and QueryBuilder parameters, turn Dates into UTC `YYYY-MM-DD HH:MM:SS.SSS` text first, but a Date passed to raw `ds.query()` reaches the driver, and `better-sqlite3` rejects it.
  - A write's `changes` becomes `affected`, and `lastInsertRowid` feeds the generated-id arithmetic, so it has to be a number. With `node:sqlite`'s `readBigInts` or `better-sqlite3`'s `defaultSafeIntegers(true)`, `save()` threw a `TypeError` (on Node, `Cannot mix BigInt and other types`) and the insert rolled back. `bun:sqlite`'s `safeIntegers` presumably does the same, untested **[L]**.
  - `ds.query()` of a write returns the connection's last insert rowid, not a count: an UPDATE of 3 rows returned 4. `queryRunner.query(sql, params, true)` returns `{ affected, raw }`.
- **`better-sqlite3` 13 against 12.**
  - 13.0.0 (2026-07-21) moved to Node-API. 13.0.3 is a Node-API 10 addon whose npm package carries prebuilds for darwin, linux, linuxmusl and win32, each on x64 and arm64. The same darwin-arm64 binary ran on both runtimes, and the package also ran on Bun 1.4.4 on Linux arm64 (Debian 13, glibc 2.41; R17.2).
  - 12.11.1, the newest 12.x on npm, is a V8-API addon. Node loads its downloaded prebuild. Bun refuses it with `'better-sqlite3' is not yet supported in Bun` (Bun #4290, open), and the same file under another name crashed Bun.
  - The refusal is a file-name check made before `dlopen` (`BunProcess.cpp` at bun-v1.4.4): any path ending in `better_sqlite3.node`. On Bun, v13 therefore loads from `prebuilds/<platform>-<arch>.node` by default, and a source build in `build/Release/better_sqlite3.node` only if renamed and passed as `nativeBinding`, which TypeORM forwards. Whether v13 compiles automatically where no prebuild exists is untested **[L]**.
- **End to end.** One `.ts` file ran under `node file.ts` and `bun file.ts` with identical output and no warnings, in a `"type": "module"` project with `EntitySchema` entities, `import { DataSource } from 'typeorm'` and `.ts` imports. It covered an explicitly imported migration run by `runMigrations({ transaction: 'all' })` with `synchronize: false`, then an empty schema diff; CRUD; `simple-json`, boolean, `datetime` (back as `Date`) and blob columns; commit, rollback and savepoint rollback; `ON DELETE CASCADE`; a unique violation (`QueryFailedError`, `driverError.code` `SQLITE_CONSTRAINT_UNIQUE`); and a restart with `migrationsRun: true` that didn't rerun the migration. By driver and runtime:

| Driver | Node 26.12.1 | Bun 1.4.4 | Caveat |
|---|---|---|---|
| `better-sqlite3` 13.0.3, the default | passes | passes | outside TypeORM's declared `^12` |
| `better-sqlite3` 12.11.1 | smoke test passes | refused at load | a V8-API addon |
| a stand-in over `node:sqlite`, as `driver` | passes | passes, on Bun's `node:sqlite` | an undocumented option; a release-candidate module |
| a stand-in over `bun:sqlite`, as `driver` | — | passes | relies on Bun 1.4.4's `reader`; `toString()` can't guard multi-statement SQL |
| `sql.js` 1.15.2, `type: "sqljs"` | passes | passes | rewrites the whole file; loses writes across processes |

- **The `driver` option.** The driver uses `options.driver` when set and loads `better-sqlite3` otherwise. The option is typed `any`, the docs page omits it, and custom drivers (#2479) are an open issue.
  - A stand-in of about 25 lines over `node:sqlite`'s `DatabaseSync`, adding only `reader = columns().length > 0` and `pragma(s) = prepare('PRAGMA ' + s).all()`, passed the scenario on both runtimes with no native addon installed. A `bun:sqlite` one passed on Bun through `Statement.reader`, new in Bun 1.4.4 (#16469, filed for TypeORM), which 1.4.3 lacks. Vitest 5.0.5 ran the scenario on both runtimes, and the CLI's `migration:show`, `run` and `generate` worked with the `node:sqlite` stand-in on both.
  - **Multiple statements:** `better-sqlite3`'s `prepare()` throws on two, but `node:sqlite` and `bun:sqlite` compile the first and silently drop the rest, so a two-statement migration string half-applies. `node:sqlite`'s `sourceSQL`, on both runtimes, is an exact prefix of the input, which exposes the tail. `bun:sqlite`'s `toString()` is the expanded SQL with parameters as `NULL`, so a guard built on it missed a `DELETE` after eight placeholders and rejected a valid `select :longname`.
  - **Options:** `node:sqlite` wants `readOnly` and silently ignores `readonly`, so writes then succeed; it has no `fileMustExist`, and its `timeout` defaults to 0, so TypeORM's 5000 must be passed on. `bun:sqlite` has no timeout option, only `PRAGMA busy_timeout`.
  - **Errors:** `node:sqlite` throws `code: 'ERR_SQLITE_ERROR'` with `errcode` 2067, while `better-sqlite3` and `bun:sqlite` give `code: 'SQLITE_CONSTRAINT_UNIQUE'`.
  - **Values:** BLOBs come back as `Uint8Array`, which 1.1.2 handles, dirty-checking included; only `better-sqlite3` returns `Buffer`. `node:sqlite`'s rows have a null prototype, and above 2^53 it throws `ERR_OUT_OF_RANGE` where the other two round silently.
- **`node:sqlite`, and Bun's copy.**
  - In Node 26.12.1 it is Stability 1.2, release candidate (since v25.7.0), and prints no warning. `timeout` defaults to 0, foreign keys to on and `readBigInts` to off. Since 26.11.0, `DatabaseSync` and `StatementSync` are documentation-only deprecated aliases of `Database` and `Statement` (DEP0210, DEP0211). Node 26.13.0 (2026-10-28), which made Node 26 LTS, changes none of this.
  - Bun 1.4.4's `node:sqlite` is native, uses the system SQLite on macOS as `bun:sqlite` does (R17.2), and its "100%" is against Node v26.3.0's 18 `test-sqlite-*` files. It lacks what Node added since: binding booleans, and statements' `stat()`, `resetStats()` and `close()` (26.8.0); binding `undefined` as NULL (26.10.0); and the new names (26.11.0). TypeORM maps booleans itself, and only `DatabaseSync` exists on both runtimes. Bun's docs give `bun:sqlite` no stability level.
- **`sql.js`.** 1.15.2 passed the scenario with `location` and `autoSave`, once its folder existed; it doesn't create one. It reads the file once at start, then rewrites all of it in place, with no temporary file and rename, after each commit and each write outside a transaction. A crash mid-write might truncate it **[L]**. Its errors carry no `code`.
  - Two processes each inserted a row into one file. Both reported success, and the last export erased the other's row. Through the `node:sqlite` stand-in, with SQLite's locking and WAL, both rows stayed.
  - Before 1.15.2, `export()` reopened the database, so TypeORM's `foreign_keys = ON` was lost after the first autosave: cascades stopped and orphans were accepted.
- **Decorators.**
  - Node 26.12.1 can't parse a decorator entity: `SyntaxError: Invalid or unexpected token` at `@Entity()`. `--js-decorators` fails the same way, even in plain `.mjs`, and v26.0.0 removed `--experimental-transform-types`. Node's docs say decorators "are not transformed and will result in a parser error", and that Node "will not support decorators until they are supported natively in JavaScript". Type stripping is Stability 2 and prints nothing.
  - Bun 1.4.4 runs the entity when the working directory's tsconfig sets `experimentalDecorators` or `emitDecoratorMetadata` (R6.2). With neither, it compiles TC39 decorators, and TypeORM fails with `undefined is not an object (evaluating 'object.constructor')`.
  - tsc 7.0.2 with `experimentalDecorators` accepts the entity under `erasableSyntaxOnly`, which does flag an `enum`, so type-checking doesn't catch what Node can't run.
- **One connection, overlapping transactions.** Both server drivers give a DataSource one connection and one shared QueryRunner: `ds.createQueryRunner() === ds.createQueryRunner()`. Two `ds.transaction()` calls started in the same tick, the first of them throwing, behaved alike with `better-sqlite3`, the `node:sqlite` stand-in and `sql.js` on both runtimes: the second `BEGIN` failed with `cannot start a transaction within a transaction`, its `ROLLBACK` ended the first transaction, and the first's later `INSERT` autocommitted. The transaction that threw kept its row, and the innocent one failed. Started after the first's `BEGIN`, a second transaction silently nests as a savepoint instead (R17.2). A promise-chain mutex around each `ds.transaction()` gave the right result. Upstream has known this since #1884 (open since 2018); #8668 was closed as stale.
- **Migrations.**
  - `migration:generate` and `migration:create` write `import { MigrationInterface, QueryRunner } from "typeorm"`. Node 26 can't load that (`does not provide an export named 'MigrationInterface'`), Bun can, and `import type` fixes it. tsc with the repo's `verbatimModuleSyntax` flags the line (TS1484).
  - The driver turns foreign keys off around migrations. A failed `runMigrations()`, with `transaction: 'all'` or `'each'`, rolls back without turning them on again, so cascades and foreign-key checks stay off on the shared connection for the rest of the process.
- **TypeScript 7.** `tsc --noEmit` from 7.0.2 and 7.1.0-beta passed the EntitySchema project, both stand-ins included, with the repo's compiler options plus `erasableSyntaxOnly`, and with `skipLibCheck: false`. `better-sqlite3` 13 ships no types, so files that import it need `@types/better-sqlite3` (9.6.0).
- **Install quirks.**
  - TypeORM 1.1.2, and its 2026-10-29 nightly, declare an optional peer `better-sqlite3@^12.0.0`. `npm install typeorm@1.1.2 better-sqlite3@13.0.3` fails with `ERESOLVE`; `"overrides": { "typeorm": { "better-sqlite3": "$better-sqlite3" } }` or `--legacy-peer-deps` each fixes it. `bun add` installs both without a warning.
  - TypeORM always passes `nativeBinding`, as `null` when unset, and v13's platform entrypoints reject the key: `driver: require('better-sqlite3/darwin-arm64')` throws `The "nativeBinding" option is only supported by the default better-sqlite3 entrypoint`. Those entrypoints `require` their prebuild by a fixed path, which is how a bundler or `bun build --compile` can reach the `.node` file. The default entrypoint, which finds the file at run time, works.
  - v13 needs Node-API 10, which Node 26.12.1 and Bun 1.4.4 report. It reportedly segfaults on Node 20, and on Node 22 up to 22.13 **[M]**. Both TypeORM's `engines` and v13's own `>=22` still admit some of those versions.
  - npm 11.20.0, reinstalling from a lockfile, synthesises and runs `node-gyp rebuild` for 13.0.3 despite `gypfile: false` (npm/cli#9837, open). So does `bun install` on Bun 1.4.3, where `better-sqlite3` is a default trusted dependency and `gypfile` was ignored until Bun PR #44968, in 1.4.4. Neither builds anything when a prebuild exists, but both need Python, make and a C++ toolchain. The agent package allows Bun `>=1.4.3`.
  - Open Bun PR #36712 (since 2026-08-01) would resolve `better-sqlite3` on Bun to a built-in shim over `bun:sqlite`. Merged, it would silently swap in `bun:sqlite`'s behaviour: `Uint8Array` BLOBs, dropped trailing statements and another error class.
- **What it means here:**
  - Under D19, every entity is an `EntitySchema`.
  - One driver for both runtimes means `better-sqlite3` 13, outside TypeORM's declared range, or a `node:sqlite` stand-in through an undocumented option (D26).
  - Transactions on a DataSource are safe only if the app serialises them.
- **Sources:** typeorm.io/docs/drivers/sqlite; github.com/typeorm/typeorm releases 1.1.1 and 1.1.2, PRs 12691 and 12971, and issues 1884, 2479, 8668, 9862, 11164, 11236 and 12012; typeorm@1.1.2 `driver/better-sqlite3/`, `driver/sqlite-abstract/`, `driver/sqljs/`, `driver/types/DatabaseType.d.ts`, `migration/MigrationExecutor.js`, `commands/Migration{Generate,Create}Command.js` and `util/Uint8ArrayUtils.js`; better-sqlite3@13.0.3 `binding.gyp` and `lib/{binding,database,darwin-arm64}.js`; github.com/WiseLibs/better-sqlite3 releases v13.0.0, issues 1503 and 1514; github.com/sql-js/sql.js releases v1.15.2; github.com/oven-sh/bun `src/jsc/bindings/BunProcess.cpp` and `src/install/default-trusted-dependencies.txt` at bun-v1.4.4, issues 4290 and 16469, PRs 36712 and 44968; github.com/npm/cli issue 9837; nodejs.org/docs/v26.12.1/api/sqlite.html, /typescript.html and /deprecations.json; github.com/nodejs/node releases v26.13.0; bun.com/docs/runtime/sqlite and /nodejs-compat; bun.com/blog/bun-v1.4.0 and /bun-v1.4.4; a spike on Bun 1.4.4 and Node 26.12.1, macOS arm64.

**R17.2 SQLite for this design: concurrency, locks, refresh and files.** **[H]** Measured on 2026-10-29, mostly between separate processes, with `better-sqlite3` 13.0.3, `node:sqlite`, `bun:sqlite` and TypeORM 1.1.2, on Bun 1.4.4 and Node 26.12.1 (macOS arm64) and in a Debian 13 arm64 container under Docker Desktop 29.9.2; the OAuth runs used only a local mock authorization server.
- **SQLite versions.** `better-sqlite3` 13.0.3 bundles 3.53.4 on both runtimes. Official Node 26.12.1 and 26.13.0 builds vendor 3.54.0. A Node built against a shared SQLite uses that library instead; the spike's Node was one, so its `node:sqlite` results come from 3.54.1. `bun:sqlite` in Bun 1.4.4 links a static 3.53.4 on Linux, and on macOS uses the system library: Apple's 3.54.0, with extension loading compiled out and double-quoted strings accepted as literals. The newest SQLite is 3.54.1 (2026-10-16).
  - FTS5, JSONB, `json_each`, `RETURNING`, `STRICT` tables and `unixepoch('subsec')` worked in every build. `sqlite-vec` 0.1.9 (2026-03-31, with only alphas since) loaded through `better-sqlite3`, through `node:sqlite` only with `allowExtension: true`, and through `bun:sqlite` on Linux but not with macOS's system library.
- **Defaults differ.** `busy_timeout` is 5000 in `better-sqlite3` and in TypeORM's `timeout`, and 0 in `node:sqlite` and `bun:sqlite`. Foreign keys are on in `better-sqlite3`, `node:sqlite` and TypeORM, which sets them, and off in `bun:sqlite`. The journal is DELETE everywhere, TypeORM included unless `enableWAL` is set. A WAL file reopens at `synchronous = NORMAL` with `better-sqlite3` and Apple's build, and FULL with the spike's `node:sqlite`; pragma.html says WAL at NORMAL "might roll back following a power loss or system crash".
- **WAL across processes.** One process held `BEGIN IMMEDIATE` for 3 s. Readers in other processes answered in 0–2 ms from their snapshot. A second writer failed at once at `busy_timeout` 0, after about 1.0–1.1 s at 1000, and at 5000 got the lock when the holder committed, after about 2.4–2.6 s. All four driver and runtime pairs agreed. The errors differ: `better-sqlite3` sets `code` to `SQLITE_BUSY` or `SQLITE_BUSY_SNAPSHOT`, `bun:sqlite` sets `code` and `errno` (5, or 517 for a stale snapshot), and `node:sqlite` sets `code` `ERR_SQLITE_ERROR` with `errcode` 5 or 517.
  - **A rollback journal, for contrast:** a 3 s read transaction held a writer's COMMIT up by about 2.5 s, and that pending commit blocked new readers: at `busy_timeout` 0 they failed at once, and at 5000 they waited about 1.55 s, frozen, then read the new row.
  - **Checkpoint starvation:** while one reader held a snapshot, 10,000 single-row commits grew the WAL to 59.3 MiB, against 3.9 MiB without it. A PASSIVE checkpoint copied 0 frames, and TRUNCATE returned busy after blocking 5.3 s at `busy_timeout` 5000. Once the reader finished, TRUNCATE emptied the WAL.
- **Lock waits freeze the event loop.** All three drivers are synchronous, and SQLite's busy handler sleeps inside the call: a 25–50 ms timer didn't fire during any wait, up to the full `busy_timeout`, and for about 14 s behind a 14 s holder. Node 26's `Database` is the renamed `DatabaseSync`, and "All APIs exposed by this class execute synchronously". TRUNCATE checkpoints and `VACUUM INTO` block the loop too.
- **A deferred `BEGIN` fails a read-then-write at once.** In WAL mode, a deferred transaction that has read and then writes fails in 0–2 ms whatever its `busy_timeout`: with `SQLITE_BUSY_SNAPSHOT` (517) if another connection committed after the read, or `SQLITE_BUSY` (5) if another holds the write lock. lang_transaction.html documents this, and c3ref/busy_handler.html says the handler is skipped where invoking it could deadlock. A deferred transaction whose first statement writes waited for the lock and succeeded.
  - TypeORM 1.1.2 only sends `BEGIN TRANSACTION`, which is deferred, or `SAVEPOINT typeorm_N`; an isolation level only toggles `PRAGMA read_uncommitted`. While another process held the write lock, a `ds.transaction()` that selected and then inserted failed in 0–1 ms with `database is locked` at `timeout` 5000.
  - `repo.save()` sends its SELECT before `BEGIN`, so it waited about 2 s and succeeded, but its read, check and write aren't atomic.
- **TypeORM's one connection: nesting and stray queries** (R17.1).
  - A `ds.transaction()` started after another's `BEGIN` doesn't fail. It becomes `SAVEPOINT typeorm_1` inside the first, and each commit or rollback applies to whichever level is on top. Each call reported its own outcome, but which rows survived depended on the other: B succeeded and lost its row when A rolled back; A succeeded and lost its row when B, still open, failed; and when A failed first, its rollback became `ROLLBACK TO SAVEPOINT`, so B's COMMIT kept A's row and lost B's.
  - Started in the same tick, two transactions meant to succeed both rejected, with `TransactionNotStartedError` and `cannot start a transaction within a transaction`, yet one's row was committed.
  - A plain `ds.query()` from another async task runs inside an open transaction and is rolled back with it. Raw connections of all three drivers leak the same way.
  - A helper that sent `BEGIN IMMEDIATE` through `qr.query()` and called `repo.save()` inside broke the shared QueryRunner for the rest of the process. `save()` opened its own transaction, which threw `cannot start a transaction within a transaction`; the error path's `ROLLBACK` discarded the helper's transaction, and the depth count fell to -1. Every later `ds.transaction()` then failed on `SAVEPOINT typeorm_-1` (`near "-": syntax error`), and later writes ran outside any transaction.

| 4.4 and 4.8 rely on | SQLite | Through TypeORM 1.1.2 |
|---|---|---|
| `FOR UPDATE SKIP LOCKED` claims | no row locks: `FOR UPDATE` is a syntax error. One `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING id` is atomic | the `lock` find options throw |
| the task row's `FOR UPDATE` as the one lock order, and the 40P01 retry | `BEGIN IMMEDIATE` takes the single write lock, so writers can't deadlock; a deferred read-then-write gets `SQLITE_BUSY` or `SQLITE_BUSY_SNAPSHOT` instead | `transaction()` sends only a deferred `BEGIN` |
| `SET LOCAL lock_timeout` for waiters | `busy_timeout`, a synchronous wait | `timeout`, 5000 by default |
| the partial unique index with `ON CONFLICT DO NOTHING RETURNING id` | the same syntax and results; a conflict target must repeat the predicate exactly | `orIgnore()` misreports ids; `.returning()` and `indexPredicate` throw |
| 25P02 after a unique violation, which 4.8's `ON CONFLICT` avoids | a unique violation undoes only its statement; savepoints work | — |
| `jsonb` | JSON text, or JSONB (3.45.0+), a BLOB in SQLite's own format | `json`, `jsonb` and `simple-json` |
| `timestamptz`, `now()` | no date type: text or integers, and `unixepoch('subsec')` (3.42.0+) | `datetime` stores UTC text |
| `text[]`, `<> ALL($configured)` | JSON, and `NOT IN (SELECT value FROM json_each(?))` | `simple-array` is comma-joined |
| `least()`, `greatest()` | multi-argument `min()`, `max()` | — |
| INSERT-only `event`, through roles and grants | no roles; `BEFORE UPDATE` and `BEFORE DELETE` triggers | rebuilding a table drops its triggers |
| `pg_try_advisory_lock` for the one daemon | `BEGIN EXCLUSIVE` held on a separate lock database | — |
| the nightly `pg_dump` | `VACUUM INTO` | — |

- **Claims without SKIP LOCKED.** Four processes worked through 2,000 queued runs, each claim followed by an event insert and a heartbeat update. The single autocommit `UPDATE … RETURNING id` claimed each run exactly once, with 0 errors on every driver, in about 0.3–0.7 s including the 4,000 other writes. `BEGIN IMMEDIATE` claims had 0 errors too. A deferred SELECT-then-UPDATE stayed correct only by retrying whole transactions, hundreds to about 25,000 times a run. Waiting is unfair: the busy handler polls, with no queue, and `BEGIN IMMEDIATE` gave one worker 1,999 or all 2,000 claims in some runs. `bun:sqlite`'s `get()` returns `null` for no row, the others `undefined`.
- **The tick's insert.** Against the partial unique index, `INSERT … ON CONFLICT DO NOTHING RETURNING id` returned `[]` on a conflict, rows outside the predicate never conflicted, and `DO UPDATE` worked, as on Postgres (R10). A conflict target must repeat the predicate exactly: a reordered `IN` list, or `WHERE status = 'queued'`, which implies it, fails with `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`, where Postgres 16.15 accepts both. Both reject a bare `ON CONFLICT (task_id)`.
  - A unique violation fails only its statement: the next one in the same transaction succeeded, and COMMIT kept it.
  - `INSERT OR IGNORE` also skips NOT NULL and CHECK violations, which `ON CONFLICT DO NOTHING` still raises.
- **TypeORM's gaps on SQLite.** `lock: { mode: 'pessimistic_write' }` throws `LockNotSupportedOnGivenDriverError`, with or without `onLocked: 'skip_locked'`, and table locks throw outside the Postgres family. `.returning()` throws `ReturningStatementNotSupportedError`, although SQLite has had RETURNING since 3.35.0. `orUpdate(…, { indexPredicate })` throws, and without the predicate the upsert fails against the partial index. Raw `ds.query('UPDATE … RETURNING id')` works, and `UpdateResult.affected` is right (1 or 0) on `better-sqlite3`, so a claim can also be a QueryBuilder `update()` that sets a claim token, then a read. Every probe gave the same output on Node, on Bun, and on Bun on Linux arm64.
  - `orIgnore()` emits `ON CONFLICT DO NOTHING`, but an ignored insert reports the connection's last insert rowid, an unrelated row's, as its id, and `InsertResult` carries no count. The tick's insert has no reliable TypeORM form.
- **JSON, time and arrays.** TypeORM's `json` is TEXT, written with `JSON.stringify` under a declared type with NUMERIC affinity, so a top-level number was stored as INTEGER. `jsonb` is written through `jsonb(?)` into a BLOB and read through `json()`. Both round-tripped objects, with an empty schema diff, through `better-sqlite3` and the `node:sqlite` stand-in on both runtimes. SQLite's JSONB (3.45.0+) isn't Postgres's format. `simple-array` joins with commas, and breaks on them.
  - `datetime` stores UTC text such as `2026-10-29 10:00:00.123`, `createDate` defaults to `datetime('now')` at second precision, and mixed text formats compare wrongly: `'2026-10-29T10:00:00.000Z' < '2026-10-29 11:00:00'` is false. No driver binds a JS `Date`.
  - SQLite accepts the `\u0000` and lone-surrogate escapes that Postgres's `jsonb` rejects (R10), but all three drivers bind a lone surrogate in a JS string as U+FFFD, and `length()` stops at an embedded NUL.
- **Triggers in place of roles.** SQLite has no roles or grants. `BEFORE UPDATE` and `BEFORE DELETE` triggers with `RAISE(ABORT, …)` blocked an UPDATE, a DELETE and a delete cascading from `run`, with `SQLITE_CONSTRAINT_TRIGGER`.
  - Any connection that can write the file can also `DROP TRIGGER`, even under `node:sqlite`'s default `defensive` mode; turn its own foreign keys off, after which an orphan went in; or replace the file.
  - `INSERT OR REPLACE` with an existing id overwrote an event on every driver, because REPLACE's deletes fire delete triggers only when `recursive_triggers` is on (lang_conflict.html). With `PRAGMA recursive_triggers = ON`, it was blocked.
  - TypeORM rebuilds a table (`temporary_<table>`, copy, drop, rename) for column, unique, check and foreign-key changes, from 12 call sites, and the rebuild dropped both triggers.
- **One daemon without advisory locks.** `BEGIN EXCLUSIVE`, never committed while serving, on a small lock database of its own opened with `busy_timeout` 0: a second daemon got `SQLITE_BUSY` at once, whichever of the three drivers it used, and so did a second connection in the same process. After a SIGKILL the next daemon took the lock at once, since the kernel drops POSIX locks with the process.
- **Two SQLite libraries in one process.** Opening and closing the file through a second library dropped the first one's POSIX locks: `node:sqlite` beside `better-sqlite3` on Node, and `bun:sqlite` beside `better-sqlite3`, either way round, on Bun on Linux. A second daemon then took the "exclusive" lock, and the first daemon's COMMIT failed with `SQLITE_IOERR_DELETE_NOENT`. howtocorrupt.html §2.3: "A close() operation on one connection might unknowingly clear the locks on a different database connection." With Apple's SQLite on macOS the lock survived, for reasons not established **[L]**.
- **Token refresh against a rotating server.** A mock authorization server rotated the refresh token as each request arrived, answered after a set delay, and revoked the grant when a rotated-out token came back, as RFC 9700 §4.14.2 describes. Each client held an expired pair, and a heartbeat process wrote every 200 ms.
  - **Naive, and compare-and-swap** (`UPDATE … WHERE refresh_token = :old` after the call): 4 clients caused one rotation, then reuse detection revoked the grant, so the swap's winner had stored a dead token (`invalid_grant`). RFC 9700: the server "cannot determine which party submitted the invalid refresh token, but it will revoke the active refresh token".
  - **`BEGIN IMMEDIATE` across the call** kept to one rotation while every waiter's `busy_timeout` outlasted the call, and stalled every writer in every process meanwhile. Behind a 14 s call at `busy_timeout` 20 s, the other clients froze for 14.0–14.2 s, and the heartbeat managed 11–15 writes in 16–17 s. Behind a 15 s call at `busy_timeout` 5 s, the other clients and the heartbeat failed with `SQLITE_BUSY` after 5.3–5.4 s, frozen throughout. In the holding process, other writes join the open transaction.
  - **A lease row:** taken by an autocommit `UPDATE` conditional on the refresh token seen and on the lease being free or expired, then the HTTP call outside any transaction, then a write fenced on `lease_owner = :me AND refresh_token = :seen`. One rotation for 4 clients at 1 s and for 3 at 14 s; the others read the new token, and in the 14 s case the heartbeat made 80–85 writes and never waited over 3 ms.
  - **A lock file** (`O_EXCL`, stale by mtime) also gave one rotation, with heartbeat waits of 1–2 ms, but it serialises only the HTTP call: the final write still needed the database's compare on the refresh token.
  - **What defeats every strategy.** A lease shorter than the call (2 s against 4 s) let a second client resend the old token, and the grant was revoked; the fence only stopped the late write. A SIGKILL after the server rotated but before the commit lost the grant under `BEGIN IMMEDIATE`, the lease and the lock file alike, and so did a client timeout under `BEGIN IMMEDIATE`. Only a server-side reuse window recovered it: a 60 s grace in the mock. Auth0's, called leeway in its API and Rotation Overlap Period in its Dashboard, is off by default and admits only the previous token; Okta's grace period defaults to 30 s (0–60 s), and Okta rotates by default only for SPAs **[M]**.
  - **MCP servers are expected to rotate.** "For public clients, authorization servers MUST rotate refresh tokens" is in the 2025-06-18 and 2025-11-25 authorization pages and, since 2026-07-28 split that text into four pages, in its security considerations (R17.4). OAuth 2.1 draft 16 (2026-09-03) §4.3.1 requires rotation or sender-constrained refresh tokens for public clients. On detected reuse, it has the server revoke "the active refresh token as well as the access authorization grant associated with it".
- **Files and permissions.** In WAL mode the database is `db.sqlite`, `-wal` and `-shm`, so its folder must be writable, and a copy of `db.sqlite` alone, taken while open, had no tables. The last connection's clean close checkpoints and removes the other two, but `bun:sqlite` skips that while a `prepare()`d statement is unfinalised, leaving the data in `-wal`. On macOS `bun:sqlite` also left `-wal` and `-shm` behind after a clean close, which `node:sqlite` and `better-sqlite3` removed.
  - Under umask 022 all three files are 0644. Pre-creating an empty `db.sqlite` with `O_EXCL` and mode 0600, or a umask of 077 around the open, gave 0600 for all three on every driver. TypeORM creates the folder with default permissions.
- **Backups.** `VACUUM INTO` copied a live database of about 50 MiB in 110–146 ms while another process wrote about every 2 ms. The copy passed `integrity_check` on every driver, and the event loop was blocked meanwhile. The online `backup()` of `better-sqlite3` and of `node:sqlite` restarted on each write and finished only after the writer stopped (19.2 s and 7.2 s). `bun:sqlite` has no backup API, and its `serialize()` holds the whole database in memory.
- **Docker Desktop on macOS.** With VirtioFS file sharing, the default, a bind mount shows inside a container as a `fakeowner` file system and a named volume as ext4. Process A held `BEGIN IMMEDIATE` for 4 s while B tried it with `busy_timeout` 0, so B should get `SQLITE_BUSY`.
  - **Bind mount, WAL:** B took the lock whenever A had created the `-shm` itself, the normal case, within one container or across two. A's COMMIT then failed with `SQLITE_PROTOCOL`, and its row was lost. With the `-shm` created by a third process that stayed open, B was refused.
  - **Bind mount, rollback journal:** B took the lock when A had created the database file (A's COMMIT then failed with a disk I/O error, 3 of 3, with PHP's SQLite 3.46.1), and was refused when another process had created it.
  - **Host against container,** in either mode: B always took the lock, and A's COMMIT failed (`SQLITE_IOERR_VNODE`, `SQLITE_IOERR_DELETE_NOENT` or `SQLITE_PROTOCOL`).
  - **Named volume:** correct in every run, with Bun's and PHP's SQLite.
  - **The cause is unconfirmed [L].** Docker's settings page recommends named volumes for databases, on performance grounds only. An OpenCode PR says macOS bind mounts "don't reliably propagate mmap or fcntl locks", and a Jellyfin forum thread suggests a volume instead **[M]**. gRPC FUSE and bind mounts on a Linux host weren't tested.
- **Network file systems.** wal.html: "All processes using a database must be on the same host computer; WAL does not work over a network filesystem." useovernet.html says locks "have been known to operate incorrectly for some network filesystems", which "has led to database corruption", and recommends a client/server database when the data is across a network from the application.
- **What it means here:** **[M]**, a judgment on the evidence above.
  - For one user and a handful of scheduled runs on one host, SQLite is enough, and simpler to run: no database server, roles, init script or `pg_dump` service.
  - That holds if transactions are short and serialised within each process, and the data folder is on a local Linux file system.
  - Throughput isn't the constraint, so the settled reason for Postgres, "Concurrent scheduled runs writing at once", doesn't by itself require it at this volume. The costs are concurrency semantics and TypeORM's support.
  - Postgres's advantages that matter here: a role-enforced append-only run log that survives a misbehaving app process; real concurrent transactions within a process, through a pool; access from more than one kernel or host; and TypeORM's lock, `.returning()` and `indexPredicate` APIs as 4.4 and 4.8 use them.
- **Sources:** sqlite.org/wal.html, /lang_transaction.html, /c3ref/busy_handler.html, /howtocorrupt.html, /useovernet.html, /lang_upsert.html, /lang_conflict.html, /jsonb.html, /backup.html, /pragma.html and /chronology.html; nodejs.org/docs/v26.13.0/api/sqlite.html; github.com/nodejs/node `deps/sqlite/sqlite3.h` at v26.12.1 and v26.13.0; better-sqlite3@13.0.3 `deps/download.sh`; typeorm@1.1.2 `driver/better-sqlite3/`, `driver/sqlite-abstract/{AbstractSqliteDriver,AbstractSqliteQueryRunner}.js`, `query-builder/{SelectQueryBuilder,InsertQueryBuilder}.js`, `query-runner/BaseQueryRunner.js` and `driver/DriverUtils.js`; github.com/asg017/sqlite-vec releases; rfc-editor.org/rfc/rfc9700 (§4.14.2); ietf.org/archive/id/draft-ietf-oauth-v2-1-16.txt (§4.3); modelcontextprotocol.io/specification/2025-06-18/basic/authorization, /2025-11-25/basic/authorization, and /2026-07-28/basic/authorization with its security-considerations page; auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation; developer.okta.com/docs/guides/refresh-tokens/main; docs.docker.com/desktop/settings-and-maintenance/settings; an OpenCode PR and a Jellyfin forum thread (community); a spike on Bun 1.4.4 and Node 26.12.1, macOS arm64, in a Debian 13 arm64 container (`php:8.4-fpm-trixie`) under Docker Desktop 29.9.2, and against Postgres 16.15.

**R17.3 The MCP TypeScript SDK, client side.** **[H]** unless marked. Measured on Bun 1.4.4 and Node 26.12.1 on 2026-10-29, with `@modelcontextprotocol/client` 2.4.0 and `@modelcontextprotocol/sdk` 1.32.2: over stdio against the reference server `@modelcontextprotocol/server-everything` 2.1.0, over Streamable HTTP against two public servers, and against a local mock of an authorization server and a protected MCP server.
- **v2 is the stable line, v1 the maintenance line.**
  - **v2** is split into packages. The `@modelcontextprotocol` packages `client`, `server` and `core` are at 2.4.0, `node` at 2.1.2, `express` and `hono` at 2.0.2, and `fastify` at 2.0.1. `client` 2.0.0 shipped on 2026-07-27, and 2.4.0 on 2026-10-23. The README on `main` calls v2 "the stable release line, implementing the 2026-07-28 MCP spec". Its packages are Apache-2.0: "Apache License 2.0 for new contributions, with existing code under MIT". 2.4.0 added `@modelcontextprotocol/client/ext/skills` (`SkillsClient`, SEP-2640), a client for SKILL.md skills served over MCP.
  - **v1** is `@modelcontextprotocol/sdk`, MIT, at 1.32.2 (2026-10-23). Its README, on the `v1.x` branch, calls it "the maintenance line" and says "Support for the 2026-07-28 spec is not planned for v1.x". The README on `main` says it "continues to receive bug fixes and security updates for at least six months after the v2 release (2026-07-27)".
- **Two protocol eras.** Both lines export `LATEST_PROTOCOL_VERSION = "2025-11-25"` and the same five supported versions, back to 2024-10-07. Only v2 also speaks the 2026-07-28 revision, the "modern" era, through an internal constant it doesn't export. The spec's compatibility matrix marks a legacy client against a modern-only server "Fails": "Legacy clients have no fall-forward mechanism". So v1 can't reach such a server.
  - **2026-07-28 is stateless.** It removes `initialize`, sessions and `Mcp-Session-Id`. Every request carries its version and capabilities in `_meta`, and servers MUST implement `server/discover`. `input_required` results (the MRTR pattern) replace the server's `sampling/createMessage`, `elicitation/create` and `roots/list` requests, and `subscriptions/listen` replaces the GET stream and `resources/subscribe`. `ping`, `logging/setLevel`, `roots/list_changed` and SSE resumability are gone, tasks move to an extension, and every result carries a `resultType`.
  - **Its auth rules.** Clients MUST validate a present `iss` against the recorded issuer (RFC 9207); a missing one is rejected only when the authorization server (AS) advertises `authorization_response_iss_parameter_supported: true`. They MUST key stored credentials by issuer. Dynamic Client Registration (DCR) is deprecated in favour of Client ID Metadata Documents (CIMD), but "remains available for backwards compatibility", and a client that uses it must send `application_type`. Roots, Sampling, Logging and HTTP+SSE are deprecated too, and the spec's policy keeps every deprecated feature for at least 12 months.
- **Era negotiation in v2.** With `ClientOptions.versionNegotiation` absent or `'legacy'`, the default, the client runs "the plain 2025 sequence". `{ mode: 'auto' }` probes with `server/discover` and falls back to `initialize`, and `{ mode: { pin: '2026-07-28' } }` never falls back.
  - **Over stdio,** server-everything connected legacy with 16 tools by default, in 140–174 ms, and modern with 22 tools under `auto`, in 144–147 ms. A cached verdict skips the probe. Passed to `connect(transport, { prior })`, a modern one, holding a `getDiscoverResult()` round-tripped through JSON, connected in 1 ms, and a legacy one, `{ kind: 'legacy' }`, went straight to `initialize`. The SDK's stdio transport probes in a short-lived sibling process, so `auto` spawned 2 processes per connect where the default spawned 1. The docs say "Do not default a spawn-per-invocation CLI tool to `'auto'`", adding that a legacy server that never answers unknown pre-`initialize` requests "stalls `connect()` for the full probe timeout before falling back". A custom stdio-shaped transport probes in place, and the docs warn that some servers built on the Rust SDK (rmcp) exit on any request before `initialize`.
  - **Over HTTP,** `auto` connected to Cloudflare's docs server on the modern era and listed its tools in 2 requests, `server/discover` and `tools/list`. DeepWiki answered the probe with 400, and the client fell back to `initialize`. `auto` doesn't always fall back on HTTP: a probe timeout rejects with `SdkError` `REQUEST_TIMEOUT`, a 5xx or an unusable 2xx body with `ERA_NEGOTIATION_FAILED`, and a 401 or 403 surfaces as an auth error.
  - **Cached verdicts.** The `ConnectOptions.prior` JSDoc says "Reuse only within one authorization context", and the docs note that a stale legacy verdict succeeds silently against an upgraded server.
- **Footprint and `zod`.** `client` 2.4.0 depends on `zod` `^4.2.0`, `jose`, `cross-spawn`, `eventsource`, `eventsource-parser`, `pkce-challenge` and `core`. It has no peer dependencies, and declares engines `node >=20`.
  - A client-only install added 13 packages, 18 MB, of which `zod` is 8.1 MB. Under npm and bun, `zod` deduped with the repo's 4.6.7. On Node, importing the client loaded 110 modules and no server framework; the import took 33–47 ms there and 20–22 ms on Bun.
  - The dist bundles `ajv` 8.18.0 (npm's latest is 8.20.0), `ajv-formats` 3.0.1, `fast-uri` 3.1.8, `@cfworker/json-schema` 4.1.1, `content-type` 1.0.5, `fast-deep-equal` and `json-schema-traverse`. `npm audit` reported 0 vulnerabilities, but it can't see bundled code.
  - v1 1.32.2 installed 95 packages (26 MB), including `express` 5, `hono`, `@hono/node-server`, `cors` and `express-rate-limit`, though importing its client loaded neither framework. It takes `zod` `^3.25 || ^4.0`, and it ran with 4.6.7 over stdio and HTTP on both runtimes.
- **Advisories and version floors.**
  - **`fast-uri` 3.1.8,** bundled in 2.4.0's `ajv`, is in the affected range of four advisories published 2026-10-23, all fixed in 3.1.9: GHSA-w74x-v6f9-j3xg and GHSA-wjr9-j795-jxcr (medium), and GHSA-xhq7-xmqj-769h and GHSA-333x-w4r6-6crp (low). That `ajv` validates schemas a server supplies, in `fromJsonSchema` and in `callTool`'s output check. The fix is merged (PR #3108, 2026-10-27; issue #3101) and queued for 2.4.1 in the open release PR #3106; 2.4.1 wasn't on npm on 2026-10-29. v1's tree resolves `fast-uri` 3.1.9 and `ajv` 8.20.0 as ordinary dependencies.
  - **OAuth.** GHSA-6qxp-vccf-f47h (high, 2026-10-06), "OAuth client could send credentials to an authorization server chosen by the MCP server", is fixed in client 2.2.0 and sdk 1.31.0. GHSA-6prh-2h8m-c8cw (medium, 2026-10-20), cross-origin redirects re-sending custom headers and bodies, is fixed in client 2.3.0 and sdk 1.32.0; the default `redirectPolicy: 'same-origin'` is that fix.
- **No client capabilities by default.** `initialize` carried `"capabilities":{}`, and modern requests carry an empty `io.modelcontextprotocol/clientCapabilities` in `_meta`. Registering a `roots/list`, `sampling/createMessage` or `elicitation/create` handler without declaring its capability throws.
  - With none, the legacy server-everything didn't list its elicitation and sampling tools. The modern one listed them, and calling one, or `get-roots-list`, threw `MissingRequiredClientCapabilityError` (-32021) instead of returning `isError`. The spec makes that a MUST, with HTTP status 400.
- **Listing tools.** `listTools()` without a cursor follows `nextCursor` through every page, up to `listMaxPages` (64; more throws `LIST_PAGINATION_EXCEEDED`, and 0 lifts the cap). With `{ cursor }` it returns one page. When the server didn't advertise `tools`, it returns `[]` without a request. v1's `listTools()` returns one page. `listChanged: { tools: { onChanged } }` refetches after `notifications/tools/list_changed`, debounced 300 ms.
- **Calling tools.** `RequestOptions` has `timeout` (60 s by default), `signal`, `onprogress`, `resetTimeoutOnProgress`, `maxTotalTimeout` and `allowInputRequired`, plus the transport's send options. `connect()` takes them too, plus `prior`. A 2 s call with `timeout: 1500`, reset on progress, completed in 2011–2017 ms. `timeout: 500` rejected with `SdkError` `REQUEST_TIMEOUT`.
  - **An abort reports the timeout code.** Aborting at 300 ms rejected at 301–303 ms with `SdkError` `REQUEST_TIMEOUT`, with `String(reason)` in the message, not in `cause`. `error.data` tells the two apart: `{ timeout }` or `{ maxTotalTimeout, totalElapsed }` on a timeout, none on an abort. The `signal` JSDoc says an abort "will cause an `AbortError`", which is wrong.
  - **Cancellation depends on the transport and era.** On stdio, in both eras, and on legacy-era HTTP, a `timeout` or an abort sends `notifications/cancelled`. On modern-era Streamable HTTP the SDK aborts that request's own response stream instead (`hasPerRequestStream`). `initialize` is never cancelled on the wire. Server-side work can keep running either way; server-everything's did.
  - **`maxTotalTimeout` is not a wall-clock cap.** It is checked only when progress arrives while `resetTimeoutOnProgress` is on, and otherwise ignored: with `maxTotalTimeout: 1000` and no reset, a 2 s call completed in about 2015 ms. When it fires, no `notifications/cancelled` goes out.
- **Results and errors.** `CallToolResult` is `{ content, structuredContent?, isError?, _meta? }`. Its content blocks are `text`, `image` and `audio` (base64 plus `mimeType`), `resource_link`, and `resource` (embedded text or a blob); the runs saw all but `audio`. `structuredContent` may be any JSON value.
  - `callTool` validates `structuredContent` with `ajv` against the `outputSchema` that an earlier `listTools()` cached. A missing `structuredContent`, without `isError`, throws `ProtocolError` `InvalidRequest`, and a mismatch `InvalidParams`. With a cold cache nothing is checked.
  - Tool failures, the server's own argument validation included, came back as `isError` results. An unknown tool threw `ProtocolError`, and a missing binary `ENOENT`. A server that exited before `initialize` or died mid-call gave `SdkError` `CONNECTION_CLOSED`, with `onclose` firing once, and every later call `Error: Not connected`. Nothing reconnects: recovery takes a new transport and a new client.
- **Tool definitions.** The SDK's `ToolSchema`, in `@modelcontextprotocol/core`, has `name`, `title`, `description`, `icons`, `inputSchema`, `outputSchema`, `annotations`, `execution.taskSupport` and `_meta`. `inputSchema` is `type: "object"` plus any other keywords, and JSON Schema 2020-12 when it has no `$schema`. `outputSchema` may have any root. `annotations` (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) are untrusted hints. `execution` exists in the 2025-11-25 Tool only: the 2026-07-28 Tool drops it, since tasks moved to an extension.
  - **Seen:** all 16 legacy-era and 22 modern-era server-everything tools have `$schema` 2020-12, a `title` and `annotations`; none has `icons` or `execution`, and 2 have an `outputSchema`. 15 of the 16 legacy-era names contain `-`. DeepWiki's `ask_wiki_question` uses `anyOf`, and its `outputSchema` carries `x-fastmcp-wrap-result`.
  - **Name rules.** The spec says names SHOULD be 1–128 characters from `[A-Za-z0-9_.-]`, case-sensitive and unique only within one server. Aggregating clients SHOULD disambiguate, for example with a server prefix, and SHOULD NOT rely on the serverInfo name for it. The SDK doesn't validate names. Anthropic requires `^[a-zA-Z0-9_-]{1,128}$`, so MCP's `.` is rejected. LM Studio converts names to snake_case (R5.2), and `@mecha-gremlin/core`'s `Tool.name` comment says "Keep it snake_case".
  - **OpenAI [M].** The repo sends Responses tools with `strict: true`. Strict mode accepts `anyOf` below the root, but needs every property required, `additionalProperties: false` on every object, and no `allOf`, `not`, `if`/`then`/`else`, `dependentRequired` or `dependentSchemas`. A schema that fails makes OpenAI reject the whole request, and the agent sends every tool with every call. With `strict` omitted, "Responses requests will attempt to normalize your schema into strict mode when possible, and will fall back to non-strict". The typings make `strict` a required `boolean | null`, so omitting it would likely mean passing `null`; that is untested at runtime **[L]**. The 64-character `[a-zA-Z0-9_-]` name rule is documented for Chat Completions; for Responses it is unverified **[L]**.
- **`fromJsonSchema`.** `fromJsonSchema(schema)` wraps a raw JSON Schema as a Standard Schema plus Standard JSON Schema object (vendor `mcp`), validated by the bundled `ajv`. It validated 2020-12, draft-07, `anyOf` and `$ref`/`$defs` schemas, with messages such as `data/repoName must be string`, and `input({ target: 'draft-07' })` returned the original object.
  - Assigning it to `@mecha-gremlin/core`'s `ToolSchema` under TypeScript 7.0.2, with the repo's options, took two casts. One is `inputSchema` to `JsonSchemaType` (TS2345). The other covers `Target`: the SDK's union ends in `(object & string)` where the repo's copy has `({} & string)` (TS2322). With them, a custom transport and an `OAuthClientProvider` type-checked with 0 errors, `skipLibCheck` on or off.
- **Stdio: spawning.** `StdioClientTransport` spawns through `cross-spawn` with `shell: false`. `stderr` defaults to `'inherit'` and `cwd` to the parent's. Non-JSON stdout lines are skipped, and a read buffer over 10 MB raises `onerror` and closes the transport.
  - **Its environment** is `{ ...getDefaultEnvironment(), ...params.env }`. On POSIX the defaults are `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER`, and a variable set only in the parent didn't reach the child. The defaults are always merged, though the `env` JSDoc says "If not specified, the result of getDefaultEnvironment will be used". A key set to `undefined`, which the type allows only through a cast, removed one on both runtimes, and an empty string blanked one. v1 merges the same way.
- **Stdio: closing.** `close()` ends stdin and waits up to 2 s, sends SIGTERM and waits up to 2 s more, then sends SIGKILL and returns without awaiting the exit. It signals only the direct child. On both runtimes:
  - a server that exits on EOF closed in 3–4 ms, and one still running a cancelled operation in about 2 s, at the SIGTERM;
  - behind `/bin/sh -c 'node … stdio; true'`, close took about 4 s: the shell died, and the grandchild server lived on until its work finished;
  - a custom transport that spawned the server with `detached: true` and killed its process group closed in 4–104 ms, depending on the implementation, with the shell and the grandchild gone.
- **The `Transport` interface.** A transport implements `start()`, `send(message, options?)` and `close()`, which must fire `onclose`. The SDK installs `onmessage`, `onerror` and `onclose`; `sessionId`, `setProtocolVersion`, `setSupportedProtocolVersions` and `hasPerRequestStream` are optional. A transport that exposes a `sessionId` before connecting makes `connect()` skip `initialize`. The client exports `ReadBuffer`, `serializeMessage` and `deserializeMessage` for the framing. `@mecha-gremlin/process` spawns with `stdin: 'ignore'` on its Bun and Node paths, and exposes no stdin.
- **Streamable HTTP.** `StreamableHTTPClientTransport` takes `authProvider`: a `{ token(), onUnauthorized? }` `AuthProvider` or an `OAuthClientProvider`. Headers in `requestInit` yield to the transport's own `Authorization`, `mcp-session-id` and `mcp-protocol-version`. `fetch` replaces the fetch function, and a recording one saw every exchange. `redirectPolicy` defaults to `'same-origin'`, and `reconnectionOptions` to a 1 s initial delay, a 30 s maximum, factor 1.5 and 2 retries. `onInsufficientScope` is `'reauthorize'` by default, or `'throw'`, and `maxStepUpRetries` defaults to 1. The other options are `reconnectionScheduler`, `sessionId`, `protocolVersion` and `skipIssuerMetadataValidation`.
  - `terminateSession()` sends a DELETE only when a session id exists, and tolerates 405. `SSEClientTransport` is still exported but deprecated. Both public servers' `/sse` endpoints returned 410, and the SSE transport wasn't tested locally.
- **`OAuthClientProvider`.** Required: the getters `redirectUrl` (`undefined` for non-interactive grants) and `clientMetadata`, and `clientInformation(ctx?)`, `tokens(ctx?)`, `saveTokens(tokens, ctx?)`, `redirectToAuthorization(url)`, `saveCodeVerifier(v)` and `codeVerifier()`.
  - **Optional:** `state()`; `saveClientInformation()`, which DCR needs; `clientMetadataUrl`, for CIMD; `invalidateCredentials(scope)`; `saveDiscoveryState()` and `discoveryState()`; `scopeForRefresh()`, new in 2.4.0; `addClientAuthentication`, `dpop()`, `validateResourceURL()` and `prepareTokenRequest()`; and `saveResourceUrl()` with `resourceUrl()`.
  - **Issuer stamps.** `ctx` is `{ issuer }`, and every saved value carries an issuer stamp the provider must round-trip. A stamp naming another AS reads back as `undefined`: the flow then registers again through DCR or, without `saveClientInformation`, throws `AuthorizationServerMismatchError`. An unstamped value draws a warning and is stamped. The per-request bearer read calls `tokens()` with no `ctx`, so an issuer-keyed provider must return the set it saved last.
- **How `auth()` proceeds,** read in the source and traced alike on both runtimes against the mock:
  1. a 401; then `discoveryState()`, or RFC 9728 protected-resource metadata (PRM), found through `WWW-Authenticate`'s `resource_metadata` or path-aware well-known URLs, and RFC 8414 or OIDC AS metadata, with the issuer checked; then `saveDiscoveryState`;
  2. the scope: `WWW-Authenticate`'s `scope`, else the PRM's `scopes_supported`, else `clientMetadata.scope`;
  3. the client: stored or pre-registered information; else CIMD, when the AS advertises `client_id_metadata_document_supported` and the provider has an https `clientMetadataUrl`; else DCR, which throws without `saveClientInformation`;
  4. a code exchange, after checking `iss`; or a refresh, when a refresh token is stored; or a PKCE S256 authorization URL, `saveCodeVerifier`, `redirectToAuthorization` and the result `'REDIRECT'`, on which the transport throws `UnauthorizedError`.
  - The URL carried `response_type`, `client_id`, `code_challenge`, `code_challenge_method=S256`, `redirect_uri`, `state`, `scope` and `resource`. RFC 8707's `resource` also went on the code exchange and the refresh. From the callback the SDK reads `code`, `iss` and `error*`, never `state`.
  - DCR's body defaults `grant_types` to `authorization_code` and `refresh_token` when `redirectUrl` is set, and derives `application_type` (`native` in the mock run). `token_endpoint_auth_method: 'none'` came from the provider; the SDK sets no default.
- **`offline_access` forces consent.** `auth()` adds it only when the AS advertises it and `clientMetadata.grant_types` itself includes `refresh_token`. DCR's default doesn't count: with `grant_types` unset, the mock run asked for `scope=mcp:read` alone, though the AS advertised `offline_access`. With it set, the scope became `mcp:read offline_access`, and the SDK added `prompt=consent`. Some Entra ID tenants reject that with AADSTS90095 **[M]**. The pending 2.4.1 adds an opt-out: an optional provider member, `skipOfflineAccessConsentPrompt` (PR #2877).
- **Refresh comes only after a 401.** The bearer is the stored `access_token`; outside cross-app access, no client code reads `expires_in`. With a token that expired after 1 s, the next call still went out with it: a 401, a refresh, `saveTokens`, and a retry that succeeded. The transport retries once, and a second 401 becomes `SdkHttpError` `CLIENT_HTTP_AUTHENTICATION`. Calling `auth(provider, { serverUrl })` with a refresh token stored refreshed even while the token was valid. Step-up skips refresh.
- **The SDK treats a transient refresh failure as a reason to re-authorise.** When a refresh fails with an AS 5xx or a non-OAuth error, such as a network `TypeError`, `auth()` only warns. It then calls `state()`, `saveCodeVerifier()` and `redirectToAuthorization()` and returns `'REDIRECT'`. The call throws `UnauthorizedError`, and the tokens stay stored. Reproduced on both runtimes.
- **Invalidation.** On `invalid_client` or `unauthorized_client` the SDK calls `invalidateCredentials('client')` and `('tokens')`, and only `('tokens')` on `invalid_grant` or `invalid_dpop_proof`. It then retries once, which ends in a new redirect; a revoked refresh token went that way in the mock. It never invalidates `'discovery'`, `'verifier'` or `'all'`. If `saveTokens` throws after a refresh, the error propagates (a v2 change), because a rotated refresh token would otherwise be lost.
- **Step-up.** A 403 with `error="insufficient_scope"` made the transport re-authorise with the union of requested and challenged scopes (`mcp:read mcp:admin`). The union exceeded the grant, so it skipped refresh, and the call ended in `UnauthorizedError`. `onInsufficientScope: 'throw'` raises `InsufficientScopeError` instead. By default, one step-up is allowed per request.
- **What the SDK leaves to the caller.** It has no loopback listener, browser opener or URL printer: the hand-off is `redirectToAuthorization(url)`. Two examples fill the gap:
  - `examples/oauth/simpleOAuthClient.ts` opens the browser, starts a fixed `127.0.0.1:8090` listener only after `UnauthorizedError`, keeps credentials in memory, and never checks `state`;
  - in `examples/cli-client/host/auth.ts`, `redirectToAuthorization` only records the URL. The host asks for consent, refuses URLs that are neither https nor loopback, listens on an OS-picked port, opens or prints the URL, checks `state` fail-closed, calls `finishAuth`, and reconnects on a fresh transport.
- **Obligations on the provider.** The upgrade notes say "Keep refresh tokens confidential in storage (SEP-2207) — OS keychain or encrypted-at-rest store, never `localStorage` / plain files / logs". The 2026-07-28 spec itself says clients MUST keep refresh tokens confidential in transit and storage. `discoveryState` must persist as durably as the code verifier: a provider that saves it but returns nothing on the callback leg gets `AuthorizationServerMismatchError`. `finishAuth` should get `iss`, or the whole `URLSearchParams`. A token endpoint off loopback must use https (`InsecureTokenEndpointError`, with no opt-out).
- **Console output.** `console.debug`, for list calls the server has no capability for, goes to stdout on both runtimes, where the agent's log records go. `console.warn`, for OAuth recoveries and unstamped credentials, goes to stderr.
- **Bun and Node behaved the same.** Running the `.ts` scripts directly, Bun 1.4.4 and Node 26.12.1 matched in every run: stdio, both eras, HTTP, the OAuth mock, the process-group transport, and Vitest 5.0.5 with `InMemoryTransport.createLinkedPair()` and `@modelcontextprotocol/server`'s `McpServer`, under `vitest run` and `bunx --bun vitest run`. In the SDK's behaviour, only the ENOENT message differed: `spawn … ENOENT` on Node, `Executable not found in $PATH` on Bun. Separately, Node's strip-only mode rejects TypeScript parameter properties, which the SDK's own examples use.
- **Public servers.** Both are documented as needing no authentication, and neither issued a session id.
  - **DeepWiki,** `mcp.deepwiki.com/mcp` (2.14.3), is legacy-only. It lists `ask_wiki_question`, `read_wiki_contents` and `read_wiki_structure`, though its docs say `ask_question`. It connected in 430–650 ms.
  - **Cloudflare's docs server,** `docs.mcp.cloudflare.com/mcp` (`docs-ai-search` 0.5.0), speaks both eras. It lists `search_cloudflare_documentation` and `migrate_pages_to_workers_guide`, and connected in 25–43 ms under `auto` and 104–158 ms with the legacy handshake.
- **What it means here:**
  - **Stdio servers** need a stdin pipe, which `@mecha-gremlin/process` lacks, and a process-group kill: `close()` alone left a wrapped server running.
  - **The OAuth command** has to supply the loopback listener, the logged URL and the `state` check.
  - **A scheduled run** can reach `auth()`'s interactive branches, after a transient refresh failure too: DCR, a redirect, and `saveCodeVerifier()`, a required member. A verifier saved where the OAuth command keeps its own would overwrite a login in progress.
  - **Plaintext refresh tokens in `db.sqlite`** would break the SDK's storage rule.
  - **MCP tools** need their names mapped for Anthropic and LM Studio, and `strict: true` rules out schemas like server-everything's `echo`, which has no `additionalProperties: false` **[M]**.
- **Sources:** npm registry metadata (2026-10-29); github.com/modelcontextprotocol/typescript-sdk: the READMEs on `main` and `v1.x`, and at v2.4.0 `docs/protocol-versions.md`, `docs/clients/{connect,calling,oauth,server-requests}.md`, `docs/advanced/custom-transports.md`, `skills/mcp-typescript-sdk-upgrade-to-v2/references/{auth,behavioral-changes}.md`, `examples/oauth/simpleOAuthClient.ts` and `examples/cli-client/host/auth.ts`, plus PRs 2877, 3106 and 3108, issue 3101 and the client 2.4.0 release notes; `@modelcontextprotocol/client@2.4.0` `dist/index.d.mts` and the sources in its source maps (`src/client/{auth,client,stdio,streamableHttp,sse}.ts`, `src/fromJsonSchema.ts`, `core-internal/src/shared/{protocol,transport,protocolEras,stdio}.ts`); `@modelcontextprotocol/core@2.4.0` `dist/schemas-DscsoNZN.mjs`; `@modelcontextprotocol/sdk@1.32.2` `dist/esm/{types.js,client/index.js,client/stdio.js}`; github.com/advisories (the six GHSA ids above); modelcontextprotocol.io/specification/2026-07-28/changelog, /basic/versioning, /basic/index, /basic/authorization and /server/tools, and github.com/modelcontextprotocol/modelcontextprotocol `schema/2026-07-28/schema.ts`; platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools; developers.openai.com/api/docs/guides/function-calling and /structured-outputs, github.com/openai/openai-openapi (`FunctionTool`, `FunctionObject`) and `openai@7.45.1` `resources/shared.d.ts`; docs.devin.ai/work-with-devin/deepwiki-mcp; github.com/cloudflare/mcp-server-cloudflare `apps/docs-ai-search/README.md`; this repository's `packages/process/src/spawn.ts`, `packages/core/src/{tools,standard-schema}.ts` and `packages/agent/src/{model/responses-tools,log/log}.ts`; a spike on Bun 1.4.4 and Node 26.12.1, macOS arm64.

**R17.4 MCP authorization, and 27 servers.** **[H]** unless marked. Read on 2026-10-29 in the specification, the RFCs and drafts it cites, vendor docs, and client and server source; a curl survey that day sent each of 29 vendors' remote servers one unauthenticated `initialize` and fetched only public metadata, never calling a registration, authorization or token endpoint.
- **The current revision is 2026-07-28.** `/specification/latest` redirects there. The draft revision's only authorization change puts `[::1]` in place of `localhost` in the client-registration page's example `redirect_uris`, and `127.0.0.1` in its flow diagram (PR #3384, merged 2026-09-22). SEP-3398 (accepted 2026-10-14) moves the next release from December 2026 to late March 2027. Every other SEP file in `seps/` is Final, so no accepted authorization SEP is waiting to land.
- **The rules are for HTTP transports.** Authorization is OPTIONAL. Where it is supported, HTTP transports SHOULD conform to the spec, and "Implementations using an STDIO transport SHOULD NOT follow this specification, and instead retrieve credentials from the environment."
- **What 2026-07-28 changed for authorization:**
  - **CIMD over DCR.** Dynamic Client Registration (DCR, RFC 7591) is deprecated in favour of Client ID Metadata Documents (CIMD), and "remains available for backwards compatibility" (PR #2858, merged 2026-06-04, which also split the authorization text into four pages).
  - **`iss`:** authorization servers (ASes) SHOULD return it (RFC 9207), and clients MUST validate a present `iss` against the recorded issuer before redeeming the code (SEP-2468).
  - **`application_type`:** clients MUST send one in DCR (SEP-837).
  - **Issuer binding:** clients MUST key stored credentials by the AS's `issuer`, MUST NOT reuse them with another AS, and MUST re-register when it changes (SEP-2352). CIMD client IDs carry across ASes.
  - **Refresh tokens:** a new section (SEP-2207) is in the release, though its changelog doesn't list it.
  - **Statelessness:** `initialize` and `Mcp-Session-Id` are gone from the core protocol, but authorization stays an HTTP-transport concern. Every surveyed server still answered an old-style `initialize`, with 401 or 200.
- **Discovery:**
  - **Protected-resource metadata (PRM, RFC 9728).** Clients MUST act on a 401's `WWW-Authenticate` and use its `resource_metadata` URL when present. Otherwise they try `/.well-known/oauth-protected-resource` inserted between host and path, then at the root. The PRM names at least one AS in `authorization_servers`; with several, the client chooses one and keeps separate registration state for each.
  - **The PRM's `resource`** (RFC 9728 §3.3; the MCP pages don't restate the check). Fetched from a `resource_metadata` URL, it MUST be identical to the URL the client requested. Fetched from a URL the client built, it MUST be identical to the identifier the suffix was inserted into, so after the root fallback a bare-origin `resource` is valid. Otherwise the client MUST NOT use the data.
  - **Authorization-server metadata (RFC 8414 or OpenID Connect Discovery).** Clients MUST support both. For an issuer with a path they try `/.well-known/oauth-authorization-server/<path>`, then `/.well-known/openid-configuration/<path>`, then `<path>/.well-known/openid-configuration`; without a path, the OAuth URL, then the OIDC one. The document's `issuer` MUST be identical to the issuer identifier the URL was built from (the PRM's `authorization_servers` entry), not to the URL fetched.
- **Registration, in priority order (SHOULD):** pre-registered client information for that server; CIMD if the AS metadata has `client_id_metadata_document_supported`; DCR if it has `registration_endpoint`; then prompting the user for client information. CIMD is a SHOULD for clients and servers, DCR a MAY. Clients SHOULD support static client credentials, hard-coded or entered by a user who registered an app. With DCR, CLI tools SHOULD send `application_type: "native"`, since OIDC's default `"web"` can conflict with loopback redirects. That rule sits under DCR: CIMD documents carry `application_type` only optionally, as VS Code's, Codex's and MCPJam's do.
- **PKCE:** clients MUST use it, with `S256` "when technically capable", and the OAuth 2.1 draft (-16) forbids `plain`. When the AS metadata lacks `code_challenge_methods_supported`, clients MUST refuse to proceed. All 27 surveyed servers advertise `S256`; Canva, GitLab, Square, Supabase and Webflow also list `plain`.
- **The `resource` parameter (RFC 8707)** MUST be in both the authorization and the token request, "regardless of whether authorization servers support it". It carries the server's canonical URI: lowercase scheme and host, no fragment, and preferably no trailing slash. Tokens go in an `Authorization: Bearer` header on every request, never in the query string, and a client MUST NOT send a server tokens its AS didn't issue. Issue #1614 (open) reports Entra ID v2 checking `resource` against an app's identifier URIs and asks to make it optional; maintainers object that dropping it lets servers impersonate clients **[M]**.
- **Scopes and step-up.** Clients SHOULD request the 401 challenge's `scope`, else all of the PRM's `scopes_supported`, else none, and MUST treat challenged scopes as authoritative for that operation. On a 403 with `error="insufficient_scope"`, a client acting for a user SHOULD re-authorize with the union of earlier and challenged scopes, retrying "no more than a few times". Only 6 of the 25 servers that answered 401 named a scope, so `scopes_supported` is the usual source: 30 entries on Slack, 40 on Atlassian. Square lists 48, but only in its root PRM, not in the path PRM its challenge names. HubSpot's `scopes_supported` is an empty array, which RFC 9728 §3.2 says MUST be omitted.
- **Refresh tokens:**
  - **Client rules.** Under SEP-2207, clients MUST keep refresh tokens confidential in transit and at rest, SHOULD declare the `refresh_token` grant, MAY add `offline_access` when the AS's `scopes_supported` lists it, and MUST NOT assume one will be issued, even by an AS that lists the grant. Servers SHOULD NOT put `offline_access` in a challenge or in PRM `scopes_supported`; Atlassian's PRM lists it anyway. The security page adds that clients and servers "MUST implement secure token storage".
  - **Rotation.** "For public clients, authorization servers MUST rotate refresh tokens as described in OAuth 2.1 Section 4.3.1", a sentence already in 2025-11-25. OAuth 2.1-16 §4.3.1 itself requires rotation or sender-constrained tokens (DPoP or mTLS); MCP's sentence offers only rotation. So a public client should expect a new refresh token on every refresh.
  - **The client keeps only the newest.** When the AS issues a new refresh token, "the client MUST discard the old refresh token and replace it with the new refresh token" (§4.3.2).
  - **Reuse can revoke the grant.** When a rotated-out token comes back, the AS "will revoke the active refresh token as well as the access authorization grant" (§4.3.1). Auth0 "immediately invalidates the refresh token family", and "all subsequent requests will be denied until the user re-authenticates".
  - **One real AS.** `@cloudflare/workers-oauth-provider` 1.2.4 mints a new refresh token on every refresh and keeps exactly one previous token valid. Local runs against its real token endpoint, with an in-memory store, left one caller with a dead token whether or not the two refreshes overlapped. When both read the grant before either wrote, both succeeded; the token from the earlier write then got `invalid_grant`, and the last writer's worked. Run one after the other, a second refresh with the already-rotated token also succeeded, and the first caller's new token then got `invalid_grant`. The failed reuse didn't revoke the grant.
- **`state` and `iss` (RFC 9207).** Clients SHOULD use and verify `state`, and MUST record the chosen AS's validated `issuer` with the PKCE verifier before redirecting. On the callback, a present `iss` MUST equal that issuer by simple string comparison, and a missing one is rejected only when the AS advertises `authorization_response_iss_parameter_supported`. After a mismatch the client MUST NOT act on or display the error parameters. Only 9 of 27 servers advertise support. The other mix-up defence, a distinct redirect URI per AS (RFC 9700 §4.4.2), "is not possible with Client ID Metadata Documents" (SEP-2468). For an AS without `iss` support, Codex adds a per-server callback ID to its redirect path and, with CIMD, serves a document per callback, which a static file can't do.
- **Loopback redirects:**
  - **The RFCs.** Redirects use `http://127.0.0.1:{port}/{path}` or `http://[::1]:{port}/{path}`, and the AS "MUST allow any port to be specified at the time of the request for loopback IP redirect URIs" (RFC 8252 §7.3). `localhost` is "NOT RECOMMENDED" (§8.3), and "Clients SHOULD use loopback IP literals rather than the string localhost" (OAuth 2.1-16 §8.5.4). Matching is exact except for the loopback port (RFC 9700 §2.1, OAuth 2.1-16 §2.3.1). A client should listen on loopback only, open the port only for the request, and try to bind both IPv4 and IPv6 loopback, using whichever is available.
  - **MCP's own sentences** name only `localhost` and exact matching: redirect URIs MUST be registered and be `localhost` or HTTPS, and the AS MUST validate them exactly against the registered values. The IP-literal preference and the port exception come from the RFCs.
  - **The host spelling must match the registration.** Claude Code's docs, on pre-configured credentials: "In v2.1.229, Claude Code sent `http://127.0.0.1:PORT/callback` instead, and servers that exact-match the registered redirect URI rejected the sign-in with a redirect URI mismatch. Claude Code v2.1.231 restored the `localhost` form." Its `--callback-port` fixes the port to match a pre-registered `http://localhost:PORT/callback`. A comment on issue #3223 claims Salesforce rejects `http://127.0.0.1` and accepts `http://localhost:<port>/callback` **[L]**.
  - **One AS's matching.** `@cloudflare/workers-oauth-provider` 1.2.4 ignores the port for `localhost`, `127.0.0.0/8` and `::1`, and matches scheme, host, path and query exactly. A run through its real `parseAuthRequest()` accepted an added or changed port on `localhost`, `127.0.0.1` and `[::1]`. It rejected `localhost` against `127.0.0.1` either way, `127.0.0.2` against `127.0.0.1`, an added trailing slash or query, and a port change on an HTTPS URI. Linear, Notion, Sentry, Cloudflare, PayPal, Intercom, Canva, Webflow and Square probably run the library, some in versions older than 1.2.4 **[M]**: their metadata and challenges have its shape.
- **Client ID Metadata Documents** (draft-ietf-oauth-client-id-metadata-document-02, 2026-07-06; MCP still cites -00):
  - **The URL is the client ID:** `https`, with a path (a bare `/` is NOT RECOMMENDED), no userinfo, dot segments or fragment, and preferably no query. It is compared by simple string comparison, so `https://example.com:443/client` and `https://example.com/client` are different clients. A new URL makes "a brand new client" whose grants and consent may not carry over, and losing the domain lets someone else assume the client's identity.
  - **The document** holds `client_id`, equal to its URL, which is all draft-02 requires; MCP also requires `client_name` and `redirect_uris`. It MUST NOT carry `client_secret`, `client_secret_*` auth methods or private keys, so a public CLI uses `"token_endpoint_auth_method": "none"`.
  - **The AS fetches it.** It accepts only a 200, MUST NOT follow redirects, SHOULD respect cache headers and MUST NOT cache errors. It MUST NOT fetch special-use IP addresses, so the host must be public, and the recommended maximum it reads is 5 KB.
  - **Redirect matching.** §4.2 requires "an exact match, using simple string comparison, of a registered redirect URL", citing RFC 9700, and states no loopback-port exception itself. Port-less loopback entries work only on an AS that applies RFC 8252 §7.3's or RFC 9700 §2.1's exception. An AS may also restrict `redirect_uris`, for example to the document's own origin (§8.1), which rules out loopback ones.
  - **Localhost impersonation.** "Client ID Metadata Documents cannot prevent `localhost` URL impersonation by themselves". ASes SHOULD warn about localhost-only clients, MUST display the redirect hostname, and MAY require attestation or apply domain trust policies; a pull request to one open-source server accepts only 16 listed CIMD URLs **[M]**. SEP-991 leaves the risk unmitigated, as it is with DCR.
  - **Hosting.** goose's document comes from GitHub Pages: 200, `application/json; charset=utf-8`, `max-age=600`. raw.githubusercontent.com serves JSON as `text/plain` with `x-content-type-options: nosniff`, a poor host for an AS that checks for a JSON content type.
  - **Six clients' documents,** re-fetched 2026-10-29: all 200, all with `token_endpoint_auth_method` `none`, 317 to 1,169 bytes, cached from `no-store` to `max-age=3600`.
    - **Port-less loopback URIs,** relying on the any-port rule: Claude Code and Codex list `http://localhost/callback` and `http://127.0.0.1/callback`; goose lists `127.0.0.1` and `[::1]`, with the path `/oauth_callback`.
    - **A fixed port:** VS Code lists `http://127.0.0.1:33418/` (its listener takes a random port when that one is busy) and `https://vscode.dev/redirect`. Cursor pins 8787, and MCPJam 6274 and 5173, each on `localhost` and `127.0.0.1` beside HTTPS callbacks. VS Code's and MCPJam's also list the device-code grant.
- **No device flow in the spec.** The 2026-07-28 and draft authorization pages define only the authorization-code flow with PKCE, and never mention "device" or RFC 8628. SEP-2059, a device flow for stdio servers, was closed unmerged on 2026-01-09, after a spec maintainer called device code "_highly_ phishable" (RFC 8628 §5.4 describes remote phishing). In the MCP ext-auth repository, issue #18 (device code) has been open since 2026-02-24 with no maintainer reply, and the two stable extensions, client credentials (SEP-1046, machine to machine) and enterprise-managed authorization (SEP-990), give no user-delegated flow without a browser.
  - **VS Code** tries its loopback flow first when not remote, then its `vscode.dev` redirect, and device code last, only when the AS advertises `device_authorization_endpoint`.
  - **Claude Code** has no device flow. Without a browser, or with `--no-browser`, `claude mcp login` prints the authorization URL, and the user pastes the full redirect URL back at the prompt, which needs an interactive terminal (`ssh -t`). The code in that URL is useless without the client's PKCE verifier. `claude -p` and Agent SDK runs can't run the sign-in flow: "complete the sign-in from an interactive session first."
  - **SSH local forwarding** (`ssh -L PORT:127.0.0.1:PORT`) carries the real redirect to a listener on the remote machine, if the port is known in advance **[K]**.
- **The survey: 34 endpoints from 29 vendors.** Three servers needed no auth (Cloudflare's docs server, DeepWiki, Microsoft Learn). The counts take one primary OAuth endpoint per vendor, leaving out Atlassian v1 and PayPal's `/http` and sandbox endpoints: 27 in all. An independent GET-only re-probe got the same registration, refresh-token and device-flow counts, and found no registration endpoint hidden in OIDC metadata for the five that offer neither. No PRM or AS document advertises DPoP.

| Capability | Servers, of 27 |
|---|---|
| DCR (`registration_endpoint`) | 22 (81%) |
| CIMD (`client_id_metadata_document_supported: true`) | 11 (41%) |
| Both | 11 (41%): every CIMD server also offers DCR |
| Neither, so a pre-registered client is needed | 5 (19%): Asana, Box, GitHub, HubSpot, Slack |
| Refresh tokens (`refresh_token` in `grant_types_supported`) | 26 (96%); Airtable omits `grant_types_supported` |
| Public clients (`none` in `token_endpoint_auth_methods_supported`) | 17 (63%) |
| `iss` (`authorization_response_iss_parameter_supported: true`) | 9 (33%) |
| Device flow (`device_authorization_endpoint`) | 4 (15%): GitHub, Hugging Face, Vercel, Context7 |

- **Client allowlists.** Three servers that advertise registration restrict which clients may connect. Vercel MCP "only supports AI clients that have been reviewed and approved by Vercel"; at Figma, "Only clients listed in the Figma MCP catalog, such as VS Code, Cursor, and Claude Code, can connect"; and "Square maintains an allowlist of MCP clients". That leaves roughly 19 of 27 (70%) plausibly open to a new open-source client **[M]**; no registration was attempted. Canva's access page describes only Developer Portal client credentials, though `mcp.canva.com` advertises DCR and CIMD; whether it takes unknown clients is unverified.
- **Atlassian's domain allowlist.** Organisation admins edit which client domains may connect over OAuth. The default list includes `localhost` and `127.0.0.1`: "You can keep these to support local tools, or remove them". Removing them would block a local client in that organisation despite DCR and CIMD.
- **Anonymous 200 with OAuth.** Hugging Face and Context7 answered an anonymous `initialize` with 200 yet publish OAuth metadata, so a client that signs in only after a 401 never does there. Context7's PRM lists two ASes, and only the first, on Clerk, offers CIMD and device flow.
- **PRM locations that 404.** All 25 servers that answered 401 sent `resource_metadata`. The root PRM URL returned 404 on Atlassian v2, Cloudflare API, GitHub, Sentry, Supabase and Zapier, and the path-inserted one on Slack, so only the header's URL worked everywhere. Atlassian's v1 endpoint, which moves to v2 on 2027-03-01, has no PRM at all, and PayPal's documented `/http` endpoint returned 404 while `/mcp` worked. 11 of the 27 ASes sit on a different origin from their server, and the 5 issuers with a path all answered at the first RFC 8414 URL.
- **Strict validation would reject 4 servers.** Airtable's and Slack's PRM `resource` is the bare origin of a `/mcp` URL, and Vercel's and Box's add a trailing slash to the configured URL; all four were reached through `resource_metadata`. Box's AS `issuer` also lacks the trailing slash of its PRM entry. `@modelcontextprotocol/client` 2.4.0 accepted all 27 when the captured metadata was replayed offline, through a same-origin path-prefix rule and one-trailing-slash tolerances for `resource` and `issuer`.
- **Static tokens [M].** Most vendors also document a static bearer credential for non-interactive use: Linear, Notion (Business and Enterprise), Stripe, GitHub, Supabase, GitLab, Neon, Airtable, Intercom, monday, Zapier, Cloudflare, Atlassian and PayPal. Sentry, Miro, Vercel, Figma, Slack, Square, Box, HubSpot, Canva and Webflow document OAuth only.
  - **Stripe is dropping untagged keys [H].** "Starting in December, Stripe MCP will stop accepting full-access secret keys and restricted API keys without the Agent tag". Users are to move to agent API keys or OAuth by 2026-11-30, and an unsupported key will get a 401 with an OAuth discovery challenge.
- **Hugging Face: CIMD without public clients.** It advertises CIMD, but its `token_endpoint_auth_methods_supported` holds only `client_secret_basic` and `client_secret_post`. A CIMD can't carry a secret, so a public CIMD client may be refused at its token endpoint. Codex uses CIMD only when the AS lists `none`, falling back to DCR; the TypeScript SDK doesn't check. The other DCR servers without `none` (Figma, GitLab, Supabase, and Miro's RFC 8414 document) list the same two methods, so they likely issue client secrets **[M]**: inferred, not tested.
- **GitLab's unadvertised device flow.** GitLab documents RFC 8628 at `/oauth/authorize_device`, generally available since GitLab 17.9 and polled with the standard grant URN. Its AS metadata lists only a non-standard `device_code` grant and no `device_authorization_endpoint`, so a client driven by metadata can't find it.
- **GitHub** offers neither DCR nor CIMD: "Each MCP host application needs to configure a GitHub App or OAuth App". Such an app can use the device endpoint GitHub advertises once device flow is enabled in its settings, and "The client_secret is not needed for the device flow". The other four need an app too: Slack takes only "apps published in the Slack Marketplace and internal apps", Box a client ID and secret generated when an admin adds the integration, Asana a client ID and secret from its integration guide, and HubSpot a user-created MCP auth app **[M]**.
- **The TypeScript SDK** (`@modelcontextprotocol/client` 2.4.0, 2026-10-23) implements nearly the whole client side: discovery, the choice of a stored client, CIMD or DCR, issuer-stamped tokens and client information, `iss` checks, `resource`, scope selection with `offline_access`, and step-up. Its `OAuthClientProvider` must persist the discovery state and the code verifier across the callback, and `redirectToAuthorization(url)` is where a client can print the URL. It refreshes only after a 401, with no expiry tracking. It departs from the spec in at least two places: it proceeds when `code_challenge_methods_supported` is absent, and accepts a PRM `resource` that only prefix-matches. `auth()` sends the PRM's `resource` string verbatim, but the exported `selectResourceURL()` returns a normalised `URL`, whose `href` turns Airtable's `https://mcp.airtable.com` into `https://mcp.airtable.com/`.
- **What it means here:**
  - CIMD alone reaches 11 of 27 servers on paper. DCR, with any client secret it returns stored under the issuer, and a user-registered client cover the rest, apart from the allowlists.
  - Refreshes need serialising per credential, with each rotated token saved before use: on an AS that revokes on reuse, a race forces a new browser login.
  - The client must send the redirect URI exactly as registered, host spelling included; only a loopback port can vary, and only on an AS that allows it.
  - A CIMD needs a stable HTTPS URL the project controls. GitHub Pages serves JSON as JSON, raw.githubusercontent.com as `text/plain`.
  - An unattended run can't open a browser: it needs a static token, or a login done beforehand, for example by printed URL and pasted redirect.
- **Sources:** modelcontextprotocol.io/specification/2026-07-28/basic/authorization and its authorization-server-discovery, client-registration and security-considerations pages, /specification/2026-07-28/changelog, /specification/draft and /specification/2025-11-25/basic/authorization (spec repository at 84d8457, 2026-10-29); github.com/modelcontextprotocol/modelcontextprotocol PRs 2059, 2858 and 3384, issues 1614 and 3223, and SEPs 991, 2207, 2468 and 3398; github.com/modelcontextprotocol/ext-auth `specification/stable/` and issue 18; rfc-editor.org RFCs 7591, 7636, 8252, 8414, 8628, 8707, 9207, 9700 and 9728; ietf.org/archive/id/draft-ietf-oauth-v2-1-16.txt and /draft-ietf-oauth-client-id-metadata-document-02.txt; auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation; code.claude.com/docs/en/mcp; github.com/openai/codex `codex-rs/rmcp-client/src/oauth_client_registration.rs` and `oauth_callback.rs`; github.com/microsoft/vscode `src/vs/workbench/api/node/extHostAuthentication.ts` and `loopbackServer.ts`; github.com/koala73/worldmonitor PR 9280; the client metadata documents at vscode.dev/oauth/client-metadata.json, claude.ai/oauth/claude-code-client-metadata, chatgpt.com/oauth/codex/client.json, goose-docs.ai/oauth/client-metadata.json, cursor.com/oauth/mcp-client.json and www.mcpjam.com/.well-known/oauth/client-metadata.json; vendor docs, among them vercel.com/docs/agent-resources/vercel-mcp, developers.figma.com/docs/figma-mcp-server/remote-server-installation, developer.squareup.com/docs/mcp, canva.dev/docs/apps/mcp/access, support.atlassian.com/security-and-access-policies/docs/available-atlassian-rovo-mcp-server-domains, docs.stripe.com/mcp, docs.gitlab.com/api/oauth2, github.com/github/github-mcp-server, docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps and docs.slack.dev/ai/mcp-server; @modelcontextprotocol/client@2.4.0 `dist/public-CvV4ZHkX.mjs` and `dist/index.d.mts`; @cloudflare/workers-oauth-provider@1.2.4 `dist/oauth-provider.js`; the curl survey and its GET-only re-probe, 2026-10-29; and a spike on Node 26.12.1, macOS arm64: offline replays of the captured metadata through the SDK, a redirect-matching run and a token-endpoint race.

**R17.5 MCP clients in twelve harnesses.** **[H]** unless marked. Read on 2026-10-29: each open-source harness's source at its default-branch HEAD, with the load-bearing lines checked again at the release named below; Claude Code 2.1.312 from its docs and from the bundle in its Linux x64 npm package; Cursor CLI and Amp from their docs alone; not re-checked by an independent fact-check.

| Harness | Login command | Headless fallback | Token store | Tool name |
|---|---|---|---|---|
| Codex CLI 0.165.0 | `codex mcp login <name>` | `--no-browser`: paste the redirected URL, raced against the callback | OS keyring, else `~/.codex/.credentials.json` (0600) | `mcp__<s>__<t>`, `[A-Za-z0-9_]`, at most 128, SHA-1 suffix |
| Claude Code 2.1.312 | `claude mcp login <name>`, `/mcp` | paste the redirected URL, when no browser is found or with `--no-browser` | macOS Keychain, else `~/.claude/.credentials.json` (0600) | `mcp__<s>__<t>`, `[A-Za-z0-9_-]`, no cap found |
| Gemini CLI 0.66.0 | only `/mcp auth`, in the TUI | none | `~/.gemini/mcp-oauth-tokens.json`, plaintext (0600) | `mcp_<s>_<t>`, keeps `.` and `:`, at most 63 |
| opencode 2.2.1 | `opencode mcp auth [name]`, `/mcps` | none | a `credential` table in SQLite (`opencode.db`, 0600) | `<s>_<t>`, `[A-Za-z0-9_-]`, no cap |
| Goose 1.57.0 | none: inline, on a 401 | none | keyring, or `secrets.yaml` | `<key>__<t>`, only the key sanitised, no cap |
| Crush 0.98.2 | none: a TUI dialog | no paste; with a remote client, that client opens the URL | `~/.local/share/crush/crush.json` (0600) | `mcp_<s>_<t>`, unsanitised, no cap |
| VS Code 1.144.0 | none: a prompt on a 401 | `vscode.dev` bounces to its URI handler; device code | `SecretStorage` (OS keychain) | `mcp_<s≤13>[n]_<t>`, sliced to 64 |
| Zed 1.26.2 | none: on demand | — | keychain | the bare `<t>`, `[A-Za-z0-9_-]`, prefixed only on a clash, at most 64 |
| pi 1.4.0 | `pi mcp login <server>`, `/mcp login` | paste the redirected URL | `~/.pi/agent/mcp-auth.json` (0600) | `mcp__<s>__<t>`, `[A-Za-z0-9_]`, at most 64, SHA-256 suffix |

- **One login flow.** Codex, Claude Code, opencode and pi each have a login command that runs the authorization code flow with PKCE against a short-lived loopback listener, prints the authorization URL and tries to open a browser. Cursor CLI (`agent mcp login <id>`) and Amp (`amp mcp oauth login <server>`) do the same, by their docs **[M]**. Gemini CLI, Crush, VS Code and Zed have no login command in the shell, and Goose authorises inline when a connection gets a 401.
  - **Codex** prints "Authorize `{server_name}` by opening this URL in your browser:" and the URL, then "(Browser launch failed; please copy the URL above manually.)" if the browser doesn't launch. `codex mcp add` starts the flow as soon as it detects OAuth. Logins work only for Streamable HTTP servers, as Crush's OAuth works only for `type: http`. When the provider rejects the discovered scopes, the login retries once without them.
  - **opencode's** CLI has its server run the flow, logs the URL, and opens a browser only when stdin and stdout are TTYs. It POSTs an `initialize` to read the scope and the resource-metadata URL from the 401's `WWW-Authenticate`, and replaces an old credential only once the new one is stored.
  - **Gemini CLI** asks for consent before it opens the browser, prints the URL in case the browser doesn't open, and validates `iss`. **Goose** prints the URL to stderr, and re-authorises with the union of scopes on a 403 `insufficient_scope`.
- **The headless fallback is pasting the redirected URL.** Codex (`--no-browser`), Claude Code and pi take the full URL from the browser's address bar at the terminal, the path that works over SSH. opencode, Goose, Gemini CLI and Crush have no paste path, and Gemini's docs say its OAuth "will not work" headless, over SSH without X11 forwarding, or in containers without a browser.
  - **Codex** reads the paste from hidden terminal input or a stdin line, and races it against the HTTP callback. It rejects a URL that differs from the prepared redirect URI (scheme, host, port, path, configured query parameters), carries a fragment or userinfo, exceeds 64 KiB, or has a mismatched `iss`.
  - **Claude Code** prompts for the paste when it detects no local browser, as over SSH or on Linux without a display server, or with `--no-browser`. The prompt needs an interactive terminal, so `ssh -t`.
  - **VS Code** bounces through `https://vscode.dev/redirect` to its `vscode://` URI handler, which reaches the local client from remote and SSH windows, and uses the device flow when the authorization server advertises `device_authorization_endpoint`.
- **Redirect URIs.** `http://127.0.0.1:<port>/callback` in Codex, opencode, pi and Zed; `http://localhost:<port>/callback` in Claude Code and Crush; `http://127.0.0.1:<port>/oauth_callback` in Goose; `http://localhost:<port>/oauth/callback` in Gemini CLI; and `http://127.0.0.1:33418/` or `https://vscode.dev/redirect` in VS Code.
  - **Ports** are ephemeral by default, with an override: Codex's `mcp_oauth_callback_port` or a server's `callback_port`, Claude Code's `--callback-port`, opencode's `callback_port`, pi's `callbackPort`, `GOOSE_OAUTH_CALLBACK_PORT`, and Gemini CLI's `OAUTH_CALLBACK_PORT` or the port of its `redirectUri`. Codex (`mcp_oauth_callback_url`), opencode (`redirect_uri`) and pi (`callbackUrl`) also take a whole callback URL. Fixed ports: Crush takes `oauth_callback_port` or the first free one of 40704–40713, VS Code 33418 "so the redirect URI does not change" (random on a conflict), and Cursor `localhost:8787` and Amp `localhost:8976` **[M]**.
  - **Some servers match exactly.** Claude Code v2.1.229 sent `http://127.0.0.1:PORT/callback`, and servers that exact-match the registered URI rejected the sign-in until v2.1.231 restored `localhost`. opencode's docs say servers accept any loopback port for its CIMD redirects, as RFC 8252 requires, so `callback_port` works with CIMD and a custom `redirect_uri` doesn't.
  - **Per-server paths.** Without issuer binding (`iss`) from the authorization server, Codex appends an id to the path (`/callback/<id>`), and with CIMD uses a matching per-id document; pi does both when it uses CIMD.
  - **Waits.** Callbacks wait 300 s in Codex and Goose, and 5 minutes in Gemini CLI.
- **Where a callback listener binds,** measured on Node 26.12.1 and Bun 1.4.4 alike: on port 0, a server given no host bound `::`, every interface; one given `localhost` bound `::1` alone; and one given `127.0.0.1` bound IPv4 loopback.
  - So a callback started without a host can be reached from other machines, and a browser that resolves `localhost` to 127.0.0.1 can't reach one bound to `localhost`. RFC 8252 §7.3 recommends the loopback IP literal **[K]**.
  - Gemini CLI's callback passes no host; Codex, opencode, Goose and VS Code pass `127.0.0.1`. Codex binds `0.0.0.0` when `mcp_oauth_callback_url` names a non-loopback host, though its config comment says it still binds 127.0.0.1.
- **Registration: a configured client, then CIMD, then DCR.** Codex, Claude Code, opencode and Goose keep that order, as does Amp by its docs **[M]**. Codex's login also takes `--oauth-client-registration auto|cimd|dcr`. Zed starts at CIMD. VS Code tries a stored registration, CIMD and DCR, then asks the user for a client ID and secret. pi takes a static client or DCR, with CIMD as an opt-in (`clientRegistration: "cimd"`). Gemini CLI and Crush take a configured client or DCR, and have no CIMD.
  - **Each vendor hosts its own CIMD document:** `https://chatgpt.com/oauth/codex/client.json`, `https://claude.ai/oauth/claude-code-client-metadata`, `https://opencode.ai/oauth/opencode/client.json`, `https://goose-docs.ai/oauth/client-metadata.json`, `https://zed.dev/oauth/client-metadata.json` and `https://pi.dev/oauth/client.json`. VS Code's is set only in Microsoft's product build, not in the open-source `product.json`. Goose's can be replaced with `GOOSE_MCP_OAUTH_CLIENT_METADATA_URL`.
  - **When CIMD is offered.** Codex and opencode need the authorization server to advertise `client_id_metadata_document_supported` and `none` among its token endpoint auth methods, and a loopback `/callback` redirect. Claude Code needs `client_id_metadata_document_supported` too, and withholds its document unless the redirect is the document's loopback `/callback`.
  - **Registering.** Gemini CLI and VS Code register with `token_endpoint_auth_method: "none"`. VS Code adds `application_type: "native"` and four redirect URIs: `https://insiders.vscode.dev/redirect`, `https://vscode.dev/redirect`, `http://127.0.0.1/` and `http://127.0.0.1:33418/`. Cursor registers as "a public client with no client secret" **[M]**. pi's docs set `clientName: "Claude Code"` for Figma, which "only accept[s] registrations from known clients". Claude Code takes a pre-registered client's secret at a masked prompt, or from `MCP_CLIENT_SECRET` in CI.
  - **The specification (2026-07-28)** deprecates DCR in favour of CIMD, and keeps it for backwards compatibility (PR #2858). Clients MUST validate a present `iss` before redeeming the code (SEP-2468), MUST send an appropriate `application_type` in DCR (SEP-837), and MUST key persisted client credentials by issuer and re-register when the authorization server changes (SEP-2352). CIMD needs an HTTPS document that the client's vendor controls, and every client ID observed is a URL on the vendor's own domain, so a self-hosted app can't use another vendor's.
- **Token stores.** Codex picks its store with `mcp_oauth_credentials_store = auto|file|keyring` (keyring service "Codex MCP Credentials", the file opened `O_NOFOLLOW`), and keys an entry by server name and a hash of its URL; pi keys by server name and URL. Claude Code's plaintext fallback carries the warning "Warning: Storing credentials in plaintext." Gemini CLI uses the keychain, or an encrypted file, only with `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true`. Crush writes atomically, by temporary file and rename, under an in-process mutex and a cross-process `flock`. Goose keeps all its secrets in one keyring entry, or in `secrets.yaml` with `GOOSE_DISABLE_KEYRING`. Removing a server in Claude Code deletes its tokens and registration but "doesn't revoke the tokens at the authorization server". Amp keeps tokens in "Amp's secret storage" **[M]**. Cursor documents neither its store nor its tool names **[L]**.
- **opencode keeps MCP credentials in SQLite, the closest precedent for `db.sqlite`.** Its v2 `credential` table holds `id`, `integration_id`, `label`, a JSON `value`, `connector_id`, `method_id`, `active` and timestamps. An MCP login's `value` is `{type: "oauth", methodID, access, refresh, expires, metadata: {serverUrl, tokenType, scope, issuer, client}}`, the DCR client included.
  - The file is `opencode.db` in the data directory (`OPENCODE_DB` overrides it). `restrictToOwner` creates it 0600 and chmods its `-wal` and `-shm` files to 0600.
  - An `imports` entry in its package.json, `"#sqlite": {bun, node, workerd}`, picks `bun:sqlite` or `node:sqlite`'s `DatabaseSync` by runtime.
- **Careful clients serialise refreshes,** because refresh tokens rotate.
  - **Codex** refreshes 30 s before expiry, in an owned task under a cross-process lock. It checks the refresh token's issuer, and persists the rotated token before exposing it, restoring the old one if that fails ("fail-closed policy").
  - **pi** refreshes 30 s before expiry or after a 401, serialised across processes by `proper-lockfile` (stale after 20 s, wait 25 s), with a 15 s timeout on requests to the authorization server.
  - **opencode** lets concurrent refreshes of one (URL, `client_id`, refresh token) share a request: "Refresh tokens rotate, so concurrent refreshes of the same token share one request or the second gets invalid_grant". It single-flights per credential, takes a file lock `credential-refresh:<id>` against other processes, and deletes a row only "while it still holds ours", the refresh token it presented.
  - **Crush's** source warns that an unserialised second refresh "would reuse an already-rotated refresh token and trip the provider's reuse detection, revoking the whole token family". A `savingTokenSource` saves each refresh.
- **What a failed refresh does.** Codex maps a rejected refresh token to `AuthorizationRequired`, and at startup reports "The {server} MCP server requires OAuth reauthentication. Run `codex mcp login {server}`."; on a timeout or a transient error it keeps the credential for a later serialised retry. Gemini CLI, which refreshes within 5 minutes of expiry, deletes the stored credentials on any refresh error. Goose clears them and falls back to a browser flow. VS Code, also refreshing within 5 minutes, drops the token, so the server asks for sign-in again. Claude Code refreshes after a 401, reconnects and retries the request once. When that fails, the user signs in again through `/mcp` or `claude mcp login` **[M]**.
- **Background connections never start a browser flow** in pi, Crush and opencode; they report that a login is needed. Crush's startup connections fail with `ErrInteractiveAuthRequired`, which puts the server in a needs-auth state. An opencode connection without a stored login never registers a client or redirects, but ends in `needs_auth`.
  - **pi's layering is the closest precedent for the split asked for here.** The header of its `extensions/mcp/oauth.ts`: "Connections never start a browser flow on their own. They send the stored access token and, after a 401, try the stored refresh token. When that is not possible they fail with `McpOAuthAuthorizationRequiredError`, and the user signs in through `/mcp`", or with `pi mcp login`. A running session picks up new credentials on its next turn.
- **Provider limits on tool names.**
  - **Anthropic Messages:** `name` must match `^[a-zA-Z0-9_-]{1,128}$` (define-tools docs); `@anthropic-ai/sdk` 1.3.0's type comment states no limit. The limit used to be 64. pi, Zed and VS Code still cap at 64, and Gemini CLI at 63, citing the Gemini API.
  - **OpenAI [M]:** Chat Completions function names take at most 64 characters of `[a-zA-Z0-9_-]`, as `openai` 7.45.1's `resources/shared.d.ts` also says. In Responses, functions inside a `namespace` tool take 1–128 characters matching `^[a-zA-Z0-9_-]+$`, and `function_call_output`'s `namespace` at most 64. The top-level `FunctionTool.name`, the shape the agent sends today, has no stated constraint; Codex caps its names at 128. Read in the OpenAPI spec 2.3.0, not tested live.
  - **MCP 2026-07-28:** tool names SHOULD be 1–128 characters of `[A-Za-z0-9_.-]`, case-sensitive and unique within a server. Clients that aggregate servers SHOULD disambiguate, for example with a server prefix, and SHOULD NOT rely on `serverInfo.name`. Anthropic's pattern and OpenAI's Chat Completions and namespace patterns exclude `.`, and mapping it can make two names collide (`a.b`, `a_b`).
- **Names beyond the table.** Codex sends each server as a Responses `namespace` tool named `mcp__<server>__`. A collision gets `_` and 12 hex digits of a SHA-1 of the raw identity, an overflow is truncated with that hash, a duplicate of the same raw identity is skipped, and raw names are kept for `tools/call`. pi adds `_` and 8 hex digits of a SHA-256 on overflow or collision, and rejects server names that differ only in `-` and `_`. VS Code numbers colliding server prefixes. In opencode a later registration silently replaces an earlier tool of the same name, and in Zed the last tool wins when a prefix doesn't fit. Goose maps models' manglings back (`developer.shell`, `functions.developer__shell`), and Claude Code names plugin servers' tools `mcp__plugin_<plugin>_<server>__<tool>`.
- **Schemas.** Codex sends MCP functions with `strict: false`, inserts `properties: {}` when a schema lacks it, and lowers schemas to a supported subset. VS Code drops a tool whose input schema fails draft-07 validation, with a warning, and fills in a missing description (`<empty>`) or `properties` (`{}`). OpenAI's strict mode accepts a schema only when every object has `additionalProperties: false` and every property is required, which typical MCP schemas don't meet; the agent's own Responses tools are `strict: true`.
- **Per-server allow and deny lists are near-universal:** Codex `enabled_tools`, then `disabled_tools`; Gemini CLI `includeTools` and `excludeTools`, exclude winning; Crush `enabled_tools` and `disabled_tools`; Goose `available_tools`; opencode `permissions` rules (`allow`, `deny`, `ask`) on `<server>_<tool>` globs; pi `toolExposure` patterns, including `hidden`, and `--tools`/`--exclude-tools`; Claude Code permission rules on `mcp__<server>__*`, plus managed `allowedMcpServers` and `deniedMcpServers`. Zed enables tools per profile. Amp sets Allow, Ask First or Disabled for remote tools **[M]**.
- **Timeouts.** Codex: 30 s to start and 300 s per call in code, where its docs still say 10 s and 60 s; a `required` server that fails to start fails the startup, and optional ones share a 1 s grace. Claude Code: `MCP_TIMEOUT` to start, and about 28 hours per call unless a server's `timeout` or `MCP_TOOL_TIMEOUT` is set. opencode: 30 s to start, 30 s for the catalog and 12 hours per call. Gemini CLI 600 s per call; Goose 300 s; Crush 10 s, or 30 s with OAuth; pi 60 s per request, reset by progress notifications. The specification says clients SHOULD implement timeouts for tool calls.
- **Results.** Codex and VS Code give the model `structuredContent`, as JSON text, in place of the text blocks when it is present, and opencode makes it the tool's output; Gemini CLI ignores it. The specification says a tool that returns structured content SHOULD also return it serialised in a `TextContent` block, and that clients SHOULD validate tool results and pass tool execution errors (`isError: true`) to the model.
  - **Media and resources.** Codex sends images as `input_image` data URLs, or as placeholder text when the model has no image input, and serialises embedded resources and resource links as JSON. VS Code withholds parts whose `audience` is only the user, resizes images, and inlines linked images. Crush keeps at most one image and one audio payload.
  - **Errors.** opencode turns `isError` into a tool failure, and pi reports it as an error for direct calls. Crush never reads `isError`, so a tool's error reaches the model as ordinary text.
- **Output caps.** Codex truncates every function output by the model's policy, 10,000 bytes for an unknown model, and `tool_output_token_limit` overrides it. Claude Code warns above 10,000 tokens, caps at 25,000 (`MAX_MCP_OUTPUT_TOKENS`), and saves larger results, and text over 50,000 characters, to a file that the result names. pi cuts text over 20 KB out of the middle around a "…N chars truncated…" marker, and keeps the full text in a temporary file. Gemini CLI truncates at 40,000 characters or 4 × the remaining context tokens, whichever is less, and saves the full output to a file.
- **`tools/list_changed`** is handled mid-session by Codex, Claude Code, Gemini CLI, opencode, Goose, Crush, VS Code and pi. Codex bumps a revision that invalidates its cached catalog; Gemini CLI listens even when a server doesn't declare the capability; opencode reloads after a 100 ms debounce; pi adds new tools and makes withdrawn ones unreachable. Claude Code refetches only the tool list in `-p` and the Agent SDK, and keeps the previous lists when a refresh fails. Crush skips it for "sessionless" servers, which reject the `subscriptions/listen` stream its go-sdk opens.
- **Most clients still default to the legacy handshake,** though MCP 2026-07-28 removes `initialize` and sessions and replaces the GET stream with `subscriptions/listen`. Codex defaults to `Legacy` (2025-06-18), with 2026-07-28 as an opt-in; opencode's `protocol` defaults to `legacy`, with `auto` and `2026-07-28` as options; VS Code's `LATEST_PROTOCOL_VERSION` is `2025-11-25`; Gemini CLI pins `@modelcontextprotocol/sdk` 1.23.0. Goose tries `server/discover` and retries with 2025-11-25, and Claude Code 2.1.312 carries both eras.
- **Unattended approval.**
  - **`codex exec`** forces `approval_policy: never`. In the default `auto` mode a tool needs approval when it is marked `destructiveHint: true`, and otherwise unless it is marked `readOnlyHint: true`, or both `destructiveHint` and `openWorldHint` false. Under `exec` such a call is denied with "MCP tool call requires approval, but approval policy is never", unless the server or tool is set to `approve` or the sandbox has full disk write access. A server's `default_tools_approval_mode`, or a tool's `approval_mode`, can also be `prompt` (always ask) or `writes` (ask unless read-only).
  - **Permissive modes.** `crush run` approves every permission request in the session. Claude Code's `-p` loads project `.mcp.json` servers without asking, and relies on permission rules. Gemini CLI's per-server `trust: true` bypasses all confirmations. Cursor asks before using MCP tools by default, and its `--approve-mcps` approves MCP servers in print mode **[M]**. Goose sets its approval mode with `GOOSE_MODE` **[K]**.
  - **Annotations.** VS Code skips confirmation only for `readOnlyHint` tools and for stdio servers it runs in its sandbox, shows "Note that MCP servers or malicious conversation content may attempt to misuse '{0}' through tools." for the rest, and has the user review an `openWorldHint` tool's result before the model sees it. The specification says clients "MUST consider tool annotations to be untrusted unless they come from trusted servers", and that "there SHOULD always be a human in the loop with the ability to deny tool invocations".
- **stdio environments.** Codex builds one from an allowlist (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `USER`, `__CF_USER_TEXT_ENCODING`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `TZ`), plus the names in `env_vars`, custom-CA variables and `env`. Gemini CLI drops from the process environment the names that match secret-like patterns (`TOKEN`, `SECRET`, `KEY`, `AUTH`, `CREDENTIAL`…) and the values that look like secrets (private keys, URL credentials, service tokens, JWTs), and starts stdio servers only in a trusted folder. VS Code and opencode pass the full environment. Goose inherits it, but forbids 31 hijack-prone keys (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS`…) in configured `envs`. Claude Code inherits it and adds `CLAUDE_PROJECT_DIR` **[K]**.
- **Prompt-injection measures are light.** Gemini CLI wraps MCP text in `<untrusted_context>` tags, escaping any closing tag inside. Goose has an opt-in scanner of tool requests (`SECURITY_PROMPT_ENABLED`, off by default). Claude Code warns that "Servers that fetch external content can expose you to prompt injection risk", and asks before using project servers in interactive sessions. Amp requires `amp mcp approve` for workspace servers **[M]**.
- **Deferred tool definitions.** Claude Code defers MCP tool definitions behind tool search by default (`ENABLE_TOOL_SEARCH`). pi's default exposure, `codemode`, makes tools callable only from code-mode scripts, with `deferred` (through `tool_search`), `direct` and `hidden` as alternatives. opencode turns Code Mode on by default, and Codex supports deferred namespaces with `tool_search`. The Responses API offers `defer_loading` and `tool_search`, but "Only `gpt-5.4` and later models support `tool_search`".
- **SDKs.** opencode uses `@modelcontextprotocol/client` 2.3.1, negotiating legacy or 2026-07-28 per server; Gemini CLI `@modelcontextprotocol/sdk` 1.23.0; Codex `rmcp` 3.5.1 and Goose `rmcp` 3.4.1; Crush a pre-release of the official Go SDK. VS Code, Zed and pi have their own clients, and pi's `@earendil-works/pi-mcp` depends only on `cross-spawn`. smolagents 1.26.0, a Python library, wraps `mcpadapt`, with stdio and Streamable HTTP and no OAuth flow. The latest TypeScript packages are `@modelcontextprotocol/sdk` 1.32.2, and `@modelcontextprotocol/client` and `@modelcontextprotocol/core` 2.4.0, all published 2026-10-23.
- **Sources:**
  - Specifications and API references, fetched 2026-10-29: modelcontextprotocol.io/specification/2026-07-28/server/tools and /changelog; platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools; github.com/openai/openai-openapi `openapi.yaml` (master, info.version 2.3.0); developers.openai.com/api/docs/guides/function-calling and /api/reference/resources/responses/methods/create; `openai@7.45.1` `resources/shared.d.ts` and `resources/responses/responses.d.ts`; `@anthropic-ai/sdk@1.3.0` `resources/messages/messages.d.ts`.
  - Harness docs: code.claude.com/docs/en/mcp; learn.chatgpt.com/docs/extend/mcp?surface=cli; cursor.com/docs/cli/mcp and cursor.com/docs/context/mcp; ampcode.com/docs/customize/mcp; code.visualstudio.com/docs/copilot/customization/mcp-servers; and in the repositories, gemini-cli `docs/tools/mcp-server.md`, opencode `services/www/src/docs/content/mcp-servers.mdx`, goose `documentation/docs/getting-started/using-extensions.md` and `documentation/docs/guides/environment-variables.md`, and pi-mono `packages/coding-agent/docs/mcp.md`.
  - Source: github.com/openai/codex `codex-rs/{rmcp-client,cli,codex-mcp,tools,protocol,core,config,models-manager,exec}` and `codex-rs/Cargo.lock`; github.com/google-gemini/gemini-cli `packages/core/src/{mcp,tools,utils,services,config,scheduler}`, `packages/core/package.json` and `packages/cli/src/ui/commands/mcpCommand.ts`; github.com/anomalyco/opencode `packages/core/src/{mcp,credential,database,tool}`, `packages/core/package.json`, `packages/schema/src/mcp.ts` and `packages/cli/src`; github.com/aaif-goose/goose `crates/goose/src/{oauth,agents,config,security}` and `Cargo.lock`; github.com/charmbracelet/crush `internal/{oauth/mcp,config,agent/tools,app}` and `go.mod`; github.com/microsoft/vscode `src/vs/base/common/oauth.ts`, `src/vs/workbench/api`, `src/vs/workbench/services/authentication`, `src/vs/workbench/contrib/mcp` and `src/vs/platform/mcp`; github.com/zed-industries/zed `crates/context_server/src/oauth.rs` and `crates/agent/src/thread.rs`; github.com/badlogic/pi-mono `packages/coding-agent/src/{extensions/mcp,core/auth-storage.ts}` and `packages/mcp/package.json`; github.com/huggingface/smolagents `src/smolagents/mcp_client.py`; `@anthropic-ai/claude-code-linux-x64@2.1.312` `claude` (the bundle's strings); npm registry metadata for `@modelcontextprotocol/sdk`, `/client` and `/core`; this repository's `packages/agent/src/model/responses-tools.ts`.
  - The listener test: a spike on Bun 1.4.4 and Node 26.12.1, macOS arm64.

**R17.6 Linux, this repository's checks, upstream and speed (S6).** **[H]** unless marked. Measured on 2026-10-29 for D26: in Docker on Linux (the official Bun and Node images on Debian 13 and Alpine 3.24, a copy of CI's setup on Ubuntu 24.04, AlmaLinux 8 and 9, and Debian 11; amd64 under Rosetta, and arm64), in a throwaway clone of this repository, and on macOS arm64. Independent checkers re-ran each result, and their corrections are folded in.
- **Both paths pass on mainstream Linux.** The R17.1 scenario passed with `better-sqlite3` 13.0.3 and with the `node:sqlite` stand-in on Debian 13, Alpine 3.24, Ubuntu 24.04 and AlmaLinux 9, on amd64 and arm64, under Bun 1.4.4 and Node 26.13.0, the first Node 26 LTS (2026-10-28), and under Vitest 5.0.5 on both runtimes. In the copy of CI (ubuntu:24.04, the Node and Bun archives that setup-node and setup-bun fetch, and no toolchain), `bun install --frozen-lockfile` ran no script and reached only the npm registry, checked on a network with no other way out.
- **`better-sqlite3` 13's limits on Linux.**
  - Its glibc prebuilds need glibc 2.34 and `GLIBCXX_3.4.29`, where Node 26 needs glibc 2.28 and Bun 2.17. Below that floor the install succeeds, and `initialize()` throws `ERR_DLOPEN_FAILED`: AlmaLinux 8 (2.28) and Debian 11 (2.31) failed on both runtimes, and AlmaLinux 9 (2.34) passed. Its musl prebuilds load on Alpine on both runtimes.
  - Prebuilds exist for x64 and arm64 only. On ppc64le and s390x a source build works on Node, and Bun refuses it by its file name.
  - The floor follows the GitHub runner image the project builds on, ubuntu-22.04; a move to 24.04 would raise it to about glibc 2.39 **[M]**.
  - Node 26's bundled npm, 11.20 (and 11.21.1), runs a synthesised `node-gyp rebuild` on `npm ci` and on clean reinstalls, which fails without Python; npm 12.2.1, a `deny-scripts` entry or `--ignore-scripts` avoid it. Bun 1.4.3 fails the same way, and it ignores `engines.bun`, so raising that floor to `>=1.4.4` only documents it.
  - In an npm workspace, npm wouldn't fail: it would put 12.11.1 at the root for TypeORM's `^12` peer, which can't load on Bun. A root override, `"better-sqlite3": "^13.0.3"`, prevents that. This repository can't be installed with npm today, because of `workspace:*`.
- **The stand-in has no native part.** It passed everywhere Bun or Node 26 ran, ppc64le, s390x, glibc 2.28 and Bun 1.4.3 included. Its SQLite is the runtime's: 3.54.0 on official Node 26.13.0, 3.53.4 on Bun on Linux, and Apple's 3.54.0 on macOS Bun, where `better-sqlite3` runs 3.53.4 everywhere.
- **Against this repository's checks.** A `packages/store` in a clone held one EntitySchema, a migration and a store serialised by a mutex, and both branches passed format, lint, CSpell, `tsc`, both test runs and Stryker, on macOS and on Linux.
  - **`better-sqlite3` 13** needed one 5-line `.oxlintrc.json` entry allowing TypeORM's `DataSource` and `QueryRunner` past `prefer-readonly-parameter-types`, and nothing for Vitest, Stryker or tsconfig. Bun's isolated install links it as TypeORM's peer despite `^12`, with no warning, and its hoisting fallback finds it too. Its 36 mutants were all killed by 13 tests.
  - **The stand-in** reached 100% too, after lint fixes: braces, readonly types, and no type assertions. Cut to TypeORM's contract it is 54 lines of code, whose 55 mutants took 15 tests of its own; the fuller copy needed 27.
  - **The allowlist grows with use.** The rule also rejects `EntityManager`, `Repository`, `EntitySchema`, `QueryFailedError` and other TypeORM types, whichever the driver.
  - **Under load, Stryker scored static mutants that no test killed as Timeout,** which counts as detected **[M]**: those in module-level literals such as an EntitySchema. A 100% score therefore proves less for such literals than for code.
- **More stand-in hazards** (R17.1 has the others):
  - `node:sqlite` takes an object in the first parameter slot as named parameters, and shifts the rest. A Date first, through raw `ds.query()`, wrote shifted columns, where `better-sqlite3` throws; one guard closes it. Node binds an `ArrayBuffer` as a BLOB since 26.8.0, and Bun's copy still doesn't.
  - Without a copy, blob columns come back as plain `Uint8Array`, so Buffer-only calls fail silently: `toString('base64')` gave `104,101,…`.
  - After `enableWAL`, `synchronous` is FULL under the stand-in on Linux and NORMAL on macOS Bun, and `better-sqlite3` is NORMAL everywhere. The cache sizes differ too, so the stand-in needs its pragmas pinned.
- **Upstream won't move soon.**
  - TypeORM #12971, putting v13 in the peer range, has no approval that counts, and its fork's CI has never run; master's ruleset needs a maintainer before it can merge. #12691, a `bun-sqlite` type, has no approval.
  - Bun's #36712 is a stale bot PR that conflicts with main. Written for `better-sqlite3` 12, it would add the package to Bun's hard-coded overrides, which beat an installed package, so a bare `require` would get a `bun:sqlite` shim. Passing the module by its absolute path as `driver` sidesteps that, and ran on both runtimes.
  - `better-sqlite3` has had no release since 13.0.3 (2026-08-05). Its #1527 reports that on Linux under Node the first `new Database()` calls `process.report.getReport()`, which blocked for 9–40 s with sockets open and slow reverse DNS **[M]**.
  - `node:sqlite` stays at Stability 1.2 in Node 26 LTS, and Bun's copy still lacks Node 26.8–26.11's changes.
- **Speed doesn't decide it.** Through TypeORM the two were within noise on both runtimes: warm medians within 0.85–1.21 of each other, and a replication reversed Bun's order. TypeORM inlines numbers into its SQL and so re-prepares nearly every statement, which costs 7–26 times the driver's own work. The differences that held: `better-sqlite3` reopens more slowly through TypeORM, its statements' finalisers blocked the event loop for 52–135 ms after 20,000 statements were collected, and it used 23–39 MB more memory. It adds 2 packages and 27.7 MB to `node_modules`, and `bun audit` finds nothing either way.
- **What it means here:**
  - Neither Linux nor speed decides D26. The cost against this repository's checks and one SQLite build everywhere favour `better-sqlite3` 13; portability favours the stand-in.
  - With `better-sqlite3` 13, the Docker image needs glibc 2.34 or musl, on x64 or arm64, and the database should open before any network connection.
- **Sources:** github.com/WiseLibs/better-sqlite3 `.github/workflows/build.yml` at v13.0.3 and v12.11.1, PR 1349, and issues 1503, 1514 and 1527; github.com/typeorm/typeorm PRs 12691 and 12971, issues 11164 and 11236, and master's ruleset; github.com/oven-sh/bun PRs 36712 and 45646; github.com/npm/cli issue 9837; github.com/nodejs/node PRs 62001, 62015 and 62061, and issue 54307; bun.com/docs/pm/isolated-installs; github.com/actions/runner-images; a spike in Docker on Linux, in a clone of this repository, and on Bun 1.4.4 and Node 26.12.1 and 26.13.0, macOS arm64.

## R18. The MCP client's design: configuration, catalogs and a stdio transport

Researched on 2026-10-29 for the design in 4.12: how clients configure MCP servers, what real servers' tool lists look like, and a stdio transport on this repository's own process spawning. The measurements ran on Bun 1.4.4 and Node 26.12.1 on macOS arm64, some again in Linux containers, against well-known servers that need no credentials and against fake ones. An independent checker re-ran each topic's main results and criticised its proposal, and the corrections are folded in.

**R18.1 Configuring MCP servers.** **[H]** unless marked. Read and measured on 2026-10-29: the snippets in 39 install documents from well-known publishers of MCP servers; the configuration code or docs of 13 clients, Claude Desktop's, Cursor's and pi's from their docs alone, Claude Code's from its docs and 2.1.312 bundle, and Copilot CLI's through VS Code's port of its rules; the SEP-2633 draft; and a prototype loader and runtime probes on Bun 1.4.4 and Node 26.12.1. An independent re-check's corrections are folded in.
- **The common format is Claude Code's `mcpServers` map.** It maps each server's name to `{command, args, env}` for stdio, or to `{type, url, headers}` for Streamable HTTP. Claude Desktop (stdio only; remote servers are connectors in its UI), Cursor, Gemini CLI, Copilot CLI, Cline, pi, VS Code's workspace-root `.mcp.json` and SEP-2633 share its top level and its stdio fields, while remote entries diverge. SEP-2633 calls it "the most widely used and the most compatible", and adds: "while its shape was most consistent with other clients, it still would have broken almost all of them in some way". VS Code's root `.mcp.json` also takes a bare map without `mcpServers`, and trailing commas.
  - **In vendors' install docs.** The code blocks of 39 documents (the READMEs of 24 well-known servers and the 15 per-client guides of GitHub's server) hold 169 server entries. 111 of them (85 distinct) are under `mcpServers`, 33 under VS Code's `servers` (12 from GitHub's guide for other Copilot IDEs: Visual Studio, JetBrains, Eclipse, Xcode), 9 under VS Code's older `mcp.servers`, 10 under a top-level `mcp` (8 of them opencode's), and 6, in 4 documents, under Zed's `context_servers`. A stricter parse, without indented blocks and two blocks that end in a trailing comma, finds 107 `mcpServers` entries of 163, in 26 of the 31 documents with a parsable snippet. Without GitHub's guides, `mcpServers` holds 78 of 114 (68%). Codex's TOML `[mcp_servers.<name>]` and Goose's YAML `extensions` fall outside the count. opencode v1 lists servers directly under `mcp` and v2 under `mcp.servers`, each with program and arguments in one `command` array.
  - **Server names.** Of the snippets' 31 distinct names, 26 use only lowercase letters, `-` and `_`, 3 have capitals (`MongoDB`, `Playwright`, `notionApi`), and 2 have dots (`awslabs.aws-iac-mcp-server`, `awslabs.aws-documentation-mcp-server`); those two are the only ones over 24 characters. Claude Code accepts `^[A-Za-z0-9_-]+$` and Codex `^[a-zA-Z0-9_:@/.-]+$`. Tool names built from them are in R17.5.
- **A typeless `url` has no agreed transport.** Of the 107 `mcpServers` entries in the stricter parse, 94 are stdio, and 85 of those have no `type` (8 say `stdio`, 1 `local`). Of the 13 remote ones, 9 come from GitHub's guides. 3 have no `url` (`serverUrl` twice, for Windsurf and Antigravity, and Gemini CLI's deprecated `httpUrl`), 4 have a `url` and no `type`, and the rest say `http` (3), `streamable-http` (2) or `streamableHttp` (1, Cline's spelling).
  - **Given a `url` without `type`,** Claude Code skips the entry (`has a "url" but no "type"; add "type": "http" (or "sse" / "ws") to this entry`). pi and Codex use Streamable HTTP. Gemini CLI and VS Code try Streamable HTTP, then SSE. Cline uses legacy SSE ("when type is not specified, it will default to sse"), and Cursor's docs don't say. SEP-2633 requires `type` (`stdio`, `sse` or `streamable-http`) and doesn't allow the other transport's fields, which Codex refuses too ("{field} is not supported for {transport}").
- **Variable references differ in syntax, scope and failure** (table below). Even `${VAR:-default}` means two things: bash, `/bin/sh`, zsh and Crush take the default for an empty variable, while Claude Code, Gemini CLI and VS Code's `mcpServers` files take it only for an unset one, as the shell's `${VAR-default}` does.
  - **Claude Code** tries a fallback environment before it keeps the text. In a remote server's `url` and `headers` it reads its own credentials such as `ANTHROPIC_API_KEY`, cloud-provider credentials, `HTTPS_PROXY` and `NPM_TOKEN` as empty, and ignores a `:-default` on them. A `url` that expands to empty is an error, and a value with surrounding whitespace is reported.
  - **Codex, Crush and Goose.** Codex's bearer variable fails when unset or empty, though a whitespace-only value passes. An unset or blank `env_http_headers` variable silently drops its header, and an invalid header name or value is only logged. Crush drops a header that resolves to `""`. Goose reads `env_keys` from the environment or its secret store, and fails on a missing one.
  - **Bare `$VAR`** stays literal in Claude Code and VS Code, and opencode's docs say "Shell expressions such as `$NAME` are not expanded". Vendors' `mcpServers` entries use `${VAR}` in 4 entries, bare `$VAR` in 4 and `${env:…}` in none, and no snippet has `$$`, which Claude Code keeps as two characters. `.vscode/mcp.json` keeps `servers`, `${env:VAR}` and `${input:id}` prompts; Copilot's global file refuses inputs ("Use environment variable references instead"). pi's `env` and `headers` take `${VAR}` or a whole-value `!command`.

| Client | Syntax | Expanded in | Unset | Empty |
|---|---|---|---|---|
| Claude Code | `${VAR}`, `${VAR:-d}` | `command`, `args`, `env`, `url`, `headers` | text kept, warning | `""` |
| VS Code `.mcp.json`, Copilot | `${VAR}`, `${VAR:-d}` | as above | text kept | `""` |
| Cursor | `${env:VAR}`, editor variables | as above | undocumented | undocumented |
| Gemini CLI | `$VAR`, `${VAR}`, `${VAR:-d}` | the whole file, then `env` and `headers` again | text kept; `""` in `env`, `headers` | `""` |
| Codex | variable names, no `${…}` | `bearer_token_env_var`, `env_http_headers`, `env_vars` | bearer: error; header: dropped | the same |
| opencode | `{env:VAR}`, `{file:path}` | the raw text, before parsing | `""` | `""` |
| Goose | `env_keys`; `$VAR`, `${VAR}` | `headers`, `uri`, `cwd`, …, from the entry's own variables | `env_keys`: error; text kept | — |
| Crush | shell syntax, `$(command)` included | `command`, `args`, `env`, `url`, `headers` | `""`; `${VAR:?msg}` errors | `""` |
| Zed, by its docs; Claude Desktop **[M]** | none | — | — | — |

- **`timeout` has no common unit.** It is milliseconds in Claude Code (per tool call; "Values below 1000 are ignored"), Gemini CLI and opencode (v1's `timeout`, v2's `timeout {startup, catalog, execution}`). It is seconds in Goose, Crush, Zed, pi and Cline, and Playwright's README writes `"timeout": 30` in its Cline section. Codex puts the unit in the name: `startup_timeout_sec` (legacy `startup_timeout_ms`) and `tool_timeout_sec`. Defaults and per-server tool lists are in R17.5.
  - **Above 2^31−1 ms, `setTimeout` fires at once.** 2^31 ms fired after 1–15 ms on both runtimes, as did 2^32+5000 and `Infinity`, while 2147483647 and 1000.7 were still pending after 300 ms. Node warns that "2147483648 does not fit into a 32-bit signed integer"; Bun writes its `TimeoutOverflowWarning` to stderr, not through `process.emitWarning`. `AbortSignal.timeout(2**31)` aborted after 1 ms on Node, and hadn't after 300 ms on Bun.
- **Clients load files with unknown fields, and none refuses a run with every problem listed.**
  - **Unknown fields.** Codex ignores them unless `--strict-config` is given, which reports the first ("unknown configuration field `<path>`"). opencode (`onExcessProperty: "ignore"`), Goose, Crush, Zed and VS Code at runtime ignore them, and Claude Code drops them silently, as read in its minified bundle's schemas, not run **[M]**. Gemini CLI's schema is strict, but violations become one warning and the file loads. VS Code refuses other fields only when it installs a server into `.mcp.json`.
  - **Invalid entries and files.** Claude Code lists every bad entry together ("N MCP servers skipped due to invalid config:") and connects the rest. Given `--mcp-config`, it exits on file-level issues, listing them all ("--mcp-config validation failed (N errors)"), but still only skips bad entries. pi reports and skips invalid entries, and `pi mcp list` exits 1 on them. opencode drops the whole document after a logged warning, and Codex fails the whole configuration on its first bad entry. Gemini CLI skips, with a warning, a system settings file that isn't owned by root or is writable by group or others, checking parent directories and symlinks too.
  - **Off switches.** The switch is `enabled` in Codex, Zed, Goose, opencode v1 and pi, and `disabled` in Crush, opencode v2 and Cline-, Roo-, Windsurf- and Kiro-style snippets: 8 snippet entries have `disabled`, and 6 `enabled`.
- **Vendors' snippets carry literal secrets, and clients accept them.** Credential-named `env` values are literals or placeholders 30 times and references 12 times, and `Authorization` headers 9 and 6. Some snippets put a secret in the arguments, such as MongoDB's `--apiClientSecret` and connection string, which `ps` shows to every local user **[K]**. Codex refuses only its `bearer_token` field ("bearer_token is not supported"): it accepts literal `env` values and `http_headers` ("static values"), and writes `oauth.client_secret` into `config.toml` itself.
  - **Credential words.** Matching whole words (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PAT`, `AUTH`, `CREDENTIAL`, `COOKIE` and their variants), after splitting names at `-`, `_`, `.` and lower-to-upper case changes, flagged all 8 credential names in the snippets and none of the 13 others. `GITHUB_OAUTH_CALLBACK_PORT` passes, though a substring match on AUTH flags it. The rule also flagged `PRIVATE_KEY_PATH`, `MAX_TOKENS=4096`, `AUTH_TYPE=none`, `--max-tokens 4096` and `--auth=none`. Two secrets under other names, Notion's `OPENAPI_MCP_HEADERS` (JSON with an inline `Bearer`) and MongoDB's `MDB_MCP_CONNECTION_STRING` (a password in the URL), were caught only by rules on values.
- **`JSON.parse` keeps the last of two equal keys silently** on both runtimes, nested ones too. A UTF-8 BOM read through `fs.readFileSync` fails it on both; `Bun.file().json()` accepts one.
  - **Its messages differ and quote the file.** Bun's carry no position ("JSON Parse error: Property name must be a string literal") and quote a whole unquoted token (`Unexpected identifier "<token>"`). Node's give position, line and column only for "Expected …" and "Bad control character" errors. An unexpected token, such as an unquoted value, single quotes or a BOM, gets about 10 characters of excerpt and no position.
- **Lookups by name reach `Object.prototype`.** On both runtimes `process.env` inherits `constructor`, `toString`, `__proto__`, `hasOwnProperty` and `valueOf`. So a lookup like the agent's `read()` in `config.ts`, `env[name]?.trim()`, throws a `TypeError` for `${constructor}` or `${toString}` instead of reporting them unset. In the prototype, `k in schema.shape` let fields named `constructor` or `toString` through unreported.
- **Header values.** Both runtimes refuse NUL, CR, LF and any code point above U+00FF when a `Headers` object is built, accept other C0 controls and 0x7F–0xFF, and trim surrounding whitespace. Node's message prints the value (`Headers.append: "Bearer a\nb" is an invalid header value.`); Bun's names only the header ("Header 'Authorization' has invalid value").
  - **The SDK's own headers.** `@modelcontextprotocol/client` 2.4.0 keeps per-request headers from overriding `authorization`, `dpop`, `content-type`, `mcp-protocol-version`, `mcp-method`, `mcp-name` and `mcp-session-id`. On modern-era requests it derives `Mcp-Method`, `Mcp-Name` and `Mcp-Param-{Name}` (SEP-2243) from the message, and servers cross-check them against the body (400, -32020). How `requestInit` headers yield is in R17.3.
  - **Headers select tools.** GitHub's remote server takes `X-MCP-Toolsets`, `X-MCP-Tools` and `X-MCP-Readonly` ("Enables only "read" tools"), and URL paths such as `/readonly` and `/x/{toolset}` select tools too. Its docs say unknown toolsets "are silently ignored without error". One server thus lists different tools under different headers and URLs.
- **User info in a URL goes out on Bun and into the error on Node.** Bun 1.4.4's `fetch` sent `user:secret@` to a loopback server as an `Authorization: Basic` header. Node's refused the URL and printed it, password included ("Request cannot be constructed from a URL that includes credentials: …").
  - **Ports and proxies.** Node's `fetch` refuses the fetch standard's bad ports ("fetch failed (cause: bad port)" for 6000, 5060, 6666 and 10080), and Bun connects to them. Bun's `fetch` honours `HTTP_PROXY` by default, and sent an `http://` request's `Authorization: Bearer` header to a loopback proxy; Node 26.12.1 does so only with `NODE_USE_ENV_PROXY=1`. Bun does it for a loopback target too: with `NO_PROXY` empty, requests to `http://127.0.0.1:…` and `http://localhost:…` went to the proxy, header included (checked on 2026-10-30).
  - **Error text.** Bun's `fetch` errors carry the full URL, query string included, in `error.path`, which `util.inspect` and `console.error(err)` print. Node's say "fetch failed".
- **A stdio server's working directory steers what runs.** In a directory whose `.npmrc` set `registry=http://127.0.0.1:9/planted-registry/`, `npx -y <pkg>` requested the package from that registry. The agent's file tools refuse only `.env*` names in `WORK_DIR`, so they can write a `.npmrc` there. Codex, Gemini CLI, VS Code, Copilot CLI, opencode, Goose and pi take a per-server `cwd`; Claude Code has none, SEP-2633 asks "Should we support `cwd` in stdio configs?", and the SDK's stdio transport defaults to the parent's (R17.3).
  - **`PATH` and spawn errors.** Both runtimes resolve a bare `command` against the `PATH` in the child's environment, and a `.` entry in the child's `cwd`. Node also treats an empty entry, from a leading, trailing or doubled `:`, as the child's `cwd`; Bun doesn't. So a check against the agent's own `PATH` and `cwd` can pass a file other than the one the spawn runs. Both runtimes' spawn errors print an argument or `env` value that holds a NUL in full ("must be a string without null bytes. Received '…'").
- **Bun's `.env` expands `$`.** Its loader expands `$NAME` and `${NAME}` in values, single-quoted ones too: `'ab$HOME'` became `ab` and the home directory, `'pa$$w0rd$x'` became `pa$`, and `\$` became `$`. Node's `--env-file` keeps all of these as written. No spelling of a secret that contains `$` reads the same on both runtimes, and the README doesn't say so.
- **SEP-2633, "Standard Client-Side Configuration Format - mcp.json",** is an open draft PR. Its newest commit, `6f108877fd`, is from 2026-04-22, and its activity on 2026-10-21 was a comment. It specifies `mcp.json`, "a JSON file (and explicitly not a JSONC file)", with `mcpServers`, names matching `^[a-zA-Z0-9_\[\]-]+$`, `title` (at most 100 characters), `description` (500) and, for remote servers, `oauth {clientId, scopes, redirectUri}`, which "should not" sit beside an `Authorization` header. pi has a `description` too, which lists the server in pi's system prompt and ranks its tools in tool search.
  - **Interpolation.** "All string values support secret value interpolation": `${env:NAME}`, or a pipe chain such as `${env:X | value:Foo}`, where "the first element to resolve to a non-empty value is used", with the schemes `env`, `value`, `input` and `op`. "Non-secret values should use literals."
  - **Pinning.** "MCP server entries using stdio SHOULD pin packages to specific versions": npm `@scope/package@0.6.2`, not `@latest`; PyPI `package==0.5.0`; OCI `image:1.0.2`, not `image:latest`.
- **A strict loader refuses 36 of 82 vendor entries.** A prototype (zod 4.6.7, about 700 lines) takes the `mcpServers` shape with only `${NAME}` and `${env:NAME}` references, and refuses unknown fields, `timeout`, bare `$`, dotted names and literal secrets. It ran each of the 82 distinct vendor `mcpServers` entries with fake variables and stub commands on `PATH`.
  - **The tally.** 46 loaded unchanged, and 23 failed only on literal or placeholder secrets (`"<YOUR_TOKEN>"`, `"YOUR_API_KEY"`, `"sk-..."`, `mongodb+srv://username:password@…`). 13 failed on format, with 14 problems: `timeout` ×3, bare `$VAR` ×3, dotted names ×2, `type` `local` or `streamableHttp` ×2, `httpUrl` or `serverUrl` ×2, and a `/path/to/binary` placeholder ×2.
  - **Its reporting.** It reported 19 problems from one broken file in one pass, with the same output on both runtimes except where it forwarded a JSON syntax error's message. Its duplicate-key scan returned early, hiding the file's other problems. Its refusal of `${TOKEN:-<literal>}`, as an unsupported default, echoed the whole template, literal included, because the reference check ran before the secret guard.
- **What it means here:**
  - **Pasted entries** mostly fit the `mcpServers` shape, but many carry literal or placeholder secrets. A typeless `url`, `timeout` and `${VAR:-d}` on an empty variable mean different things to different clients.
  - **Messages** from `JSON.parse`, `Headers`, `fetch` and `spawn` can carry file text or resolved secrets, and most differ between Bun and Node.
  - **A stdio server's `cwd` and `PATH`** decide which program and which registry it uses, and the model's file tools can write in `WORK_DIR`.
  - **Names read from a file** reach `Object.prototype` unless they are looked up as own properties.
- **Sources:** code.claude.com/docs/en/mcp; modelcontextprotocol.io/docs/develop/connect-local-servers and /connect-remote-servers; cursor.com/docs/context/mcp; code.visualstudio.com/docs/copilot/reference/mcp-configuration; learn.chatgpt.com/docs/extend/mcp?surface=cli; github.com/modelcontextprotocol/modelcontextprotocol/pull/2633, with `seps/2633-standard-client-mcp-json-configuration.md` at 6f108877fd; source at HEAD on 2026-10-29: github.com/openai/codex `codex-rs/config/src/{mcp_types,mcp_types_tests,strict_config}.rs`, `codex-rs/cli/src/main.rs`, `codex-rs/rmcp-client/src/utils.rs` and `codex-rs/codex-mcp/src/rmcp_client.rs`; github.com/google-gemini/gemini-cli `packages/cli/src/config/settings.ts`, `packages/cli/src/utils/envVarResolver.ts`, `packages/core/src/utils/{envExpansion,security}.ts`, `packages/core/src/tools/mcp-client.ts` and `docs/tools/mcp-server.md`; github.com/anomalyco/opencode `packages/schema/src/mcp.ts`, `packages/core/src/{config.ts,config/variable.ts,v1/config/mcp.ts}` and `services/www/src/docs/content/mcp-servers.mdx`; github.com/aaif-goose/goose `crates/goose/src/agents/extension.rs`; github.com/charmbracelet/crush `internal/config/{config,resolve}.go`; github.com/zed-industries/zed `crates/settings_content/src/project.rs` and `docs/src/ai/mcp.md`; github.com/microsoft/vscode `src/vs/platform/mcp/common/{envVarResolution,mcpWorkspaceConfiguration,mcpCopilotConfiguration,mcpCopilotGlobalConfiguration}.ts`, `src/vs/workbench/contrib/mcp/common/mcpEnvironmentVariableExpansion.ts` and `src/vs/platform/agentPlugins/common/pluginParsers.ts`; github.com/badlogic/pi-mono `packages/coding-agent/docs/mcp.md`; github.com/cline/cline `apps/vscode/src/services/mcp/{schemas,constants,timeout}.ts`; `@anthropic-ai/claude-code-linux-x64@2.1.312` `claude` (the bundle's strings); `@modelcontextprotocol/client@2.4.0` `dist/{index,src-CeKsbNLO}.mjs`; the install READMEs of 24 servers, among them seven in modelcontextprotocol/servers, microsoft/playwright-mcp and upstash/context7, and github/github-mcp-server's `docs/installation-guides/` and remote-server guide, fetched 2026-10-29; this repository's `packages/agent/src/config/config.ts`, `packages/agent/src/tools/fence.ts` and `README.md`; a spike on Bun 1.4.4 and Node 26.12.1, macOS arm64.

**R18.2 What real servers' tool lists look like.** **[H]** unless marked. Measured on 2026-10-29 on Node 26.12.1 and Bun 1.4.4 with `@modelcontextprotocol/client` 2.4.0, through a proxy that recorded the wire JSON: the tool lists of 15 servers that answer without credentials and of Microsoft's Azure MCP server, and calls to read-only tools. An independent check re-listed every catalog 30–40 minutes later and probed the SDK further, and its corrections are folded in.
- **15 servers, 128 tools.** Over stdio from npm: server-everything 16, filesystem 14, memory 9, sequential-thinking 1, Playwright 25, Chrome DevTools 32 and Context7 2; from PyPI, through uv 0.13.5's `uvx`: fetch 1, git 12 and time 2. Over Streamable HTTP: DeepWiki 3, Cloudflare's docs 2, Microsoft Learn 3, Context7 2 and Hugging Face 4. Every catalog was anonymous, and Hugging Face's README says the catalog a token sees is configured per account (Tools and Spaces, at huggingface.co/settings/mcp).
- **Names are almost all in `[a-z0-9_]` already.** In the 128, the only other character is `-`, in 19 names: 15 of server-everything's 16, and Context7's `resolve-library-id` and `query-docs` on both endpoints. None has a dot, an uppercase letter, camelCase, `__`, a leading digit or a separator at either end. Of all 980 listings (the 128, 91 under four configuration variants and 761 in Azure's three modes), 86 contain a hyphen, and none contains another character outside the set. Azure's 67 hyphenated listings are 46 distinct names, all in `--mode all`, 21 of them listed again under `--read-only`.
  - **Lengths.** The longest of the 128 is `search_cloudflare_documentation`, at 31 characters. Three Azure `--mode all` names tie at 48, the longest of all, among them `azurebackup_vault_privateendpoint_approve-reject`.
  - **Mapped as C18 proposes,** to `mcp__<server>__<tool>` in `[a-z0-9_]`, the 128 reach 53 characters at most, in `mcp__cloudflare_docs__search_cloudflare_documentation`. Nothing collides within or across servers, whether case is lowered, snake-cased or kept; without the prefix, Context7's two endpoints would collide on both tools. The server names follow the READMEs where they suggest one. Cloudflare's suggests none, so `cloudflare-docs` is the spike's own; Microsoft's mostly uses `microsoft-learn`, but also `mslearn` and `Microsoft Learn`.
  - **Whether a name passes C18's 64-character cap depends on the server name.** Under a server name of up to 26 characters, none of the 176 distinct non-Azure tool names passes 64, variants included; under 30, 7 do. Of the distinct Azure names, 3, 18, 58 and 200 pass 64 under server names of 10, 15, 20 and 30 characters, so `--mode all` fits only under a name of 9 characters or fewer. Under `azure-mcp-server`, the name its README uses, no namespace-mode tool passes 64 and 24 `--mode all` tools do, with proxy tools or without; with `--read-only`, 10 of 249 do.
  - **The SDK checks no names (R17.3).** Through a fake transport, `listTools()` passed duplicates, `naïve tool name`, `x.y`, `a/b`, a 200-character name, an empty name, and pairs that collide once mapped: `good_tool` with `good-tool`, and `getUser` with `get_user`. `isSpecType.Tool` accepts the empty name and `a b` too. The empty name maps to `mcp__<server>__`, and a server name with `__` or a trailing separator blurs the boundary: `a-` gives `mcp__a___tool`.
- **13 of the 128 schemas are strict-ready as sent:** 7 of Chrome DevTools', 5 of Playwright's and Hugging Face's `hf_fs`, all using only keywords that OpenAI's structured-outputs guide names. In Azure, 38 of 761 listings are. That applies the guide's rules; nothing was sent to the API.
  - **The guide, beyond R17.3's rules,** limits types to string, number, boolean, integer, object, array, enum and `anyOf`, with an object at the root, not `anyOf`, and formats to `date-time`, `time`, `date`, `duration`, `email`, `hostname`, `ipv4`, `ipv6` and `uuid`. It supports `pattern`, `multipleOf`, `minimum`, `maximum`, the exclusive bounds, `minItems` and `maxItems`; it names `minLength` and `maxLength` only as unsupported for fine-tuned models, and `oneOf`, `default` and `title` not at all. Its limits are 5,000 properties, 10 levels of nesting, 1,000 enum values, 120,000 characters over all property names, definition names, enum values and const values, and 15,000 characters for a string enum of more than 250 values.
  - **What fails:** 71 tools have an optional property, and 71 an object without `additionalProperties: false`. 5 have `default: null` (3 of git's, and 2 of Microsoft Learn's on `type: "string"`), 2 have `format: "uri"`, and Playwright's `browser_drop` has an open map, `additionalProperties: {type: "string"}` with `propertyNames`.
  - **A mechanical rewrite,** closing every object, requiring every property as nullable, and dropping `default: null` and unlisted formats, would make 127 of the 128 strict, and all 761 Azure listings; only `browser_drop` resists. The model would then send `null` for every option it skips, which a server validating with zod's `.optional()` refuses. `openai-python`'s own `_ensure_strict_json_schema` requires every property without adding `null` and strips `default: None`, but keeps `title`, `format` and other defaults, which suggests strict mode accepts them **[M]**.
  - **`strict` on Responses.** Beyond the normalisation R17.3 quotes, the function-calling guide says "To opt out of strict mode in Responses and keep non-strict, best-effort function calling, explicitly set `strict: false`", and that covers top-level function tools. It doesn't describe `null`, which the types allow. Left unset or `null`, Responses would likely normalise the 127 schemas that can be made strict **[L]**.
- **The schemas are plain.** None of the 980 uses `allOf`, `oneOf`, `not`, `if`/`then`/`else`, `dependentRequired`, `dependentSchemas`, `patternProperties`, `$ref`, `$defs`, `definitions`, `prefixItems`, `unevaluated*` or a root `anyOf`. None has an object without `properties`, an array without `items`, a boolean subschema, tuple-form `items`, a boolean exclusive bound or a nested `$schema`. Nesting reaches 2 levels (Azure 3), and a tool has at most 11 properties (Azure 51). Keywords, by the number of the 128 tools using each: `type` and `properties` 128, `$schema` 107, `required` 104, `description` 98, `additionalProperties` 59, `default` 30, `items` 27, `enum` 24, `maximum` 16, `minimum` and `title` 15, `minItems` 7, `anyOf` 5, `exclusiveMinimum` 4, `maxItems` 3, `minLength`, `maxLength` and `format` 2, and `propertyNames` and `x-mcp-header` 1.
  - **Oddities:** `x-mcp-header: "Region"` in server-everything's `get-header-params`; `x-fastmcp-wrap-result` (R17.3) and `_meta._fastmcp` in DeepWiki; `"type": ["boolean", "string"]` and `maximum: 9007199254740991` in sequential-thinking; 137 type arrays such as `["integer", "null"]` and property names such as `start-time` in Azure's `--mode all`; and a `title` on every property in the pydantic servers.
  - **Dialects.** 107 of the 128 declare `$schema` 2020-12: every TypeScript-SDK server, Hugging Face, Cloudflare and Context7. 21 declare none (the pydantic servers fetch, git and time, FastMCP-based DeepWiki, and Microsoft Learn), and no Azure listing does. No keyword specific to 2020-12 occurs, so `toolJsonSchema`, which drops the root `$schema`, leaves nothing dialect-specific behind.
  - **`fromJsonSchema` compiled all 980** with the SDK's bundled `ajv`, the oddities included. It inserts no defaults, coerces nothing and enforces `format: "uri"`. An unknown format only prints `unknown format "…" ignored` to stderr, twice per schema and outside the agent's logger; none of the 980 has one. `jsonSchema.input()` hands back the server's own object (R17.3), the same reference in 980 of 980, whatever its `target`, and `toolJsonSchema` copies only the top level, so editing a nested part of the sent schema edits the server's object too.
- **Definitions are the cost: 21,877 tokens for the 15 servers,** against 692 for the agent's own tools with `write` and `edit`, or 821 with `apply_patch`, as `toFunctionTool` sends them. Chrome DevTools alone is 7–9 times that.
  - **Counted** with `js-tiktoken` 1.0.21's `o200k_base` over compact JSON, each tool as the repo would send it to Responses: the mapped `name`, `description`, `parameters` without `$schema`, and `strict: false`. `openai-harmony`'s `o200k_harmony` gave identical counts. Claude's tokenizer differs **[K]**, so the counts are relative sizes, not bills.
  - **Per server:** Chrome DevTools 6,090, Playwright 3,639, Hugging Face 1,907, filesystem 1,613, server-everything 1,601, git 1,315, Context7 1,053 and 1,055 on its two endpoints, memory 922, sequential-thinking 864, Microsoft Learn 768, and 240–285 for each of the rest. A tool costs 38–1,108 tokens (median 127, p90 305), `hf_fs` the most. The raw `tools/list` JSON, which also carries output schemas, annotations and titles, is 135,815 bytes, or 30,951 tokens.
  - **Server flags move a catalog by an order of magnitude.** Playwright lists 25 tools (3,639 tokens) by default and 72 (7,999) with every `--caps` capability. Chrome DevTools lists 32 (6,090), and 3 (206) with `--slim`. Azure MCP, run with `--disable-proxy-tools`, lists 69 (14,283) in its default namespace mode, 443 (136,600; 730 KB in one page) with `--mode all`, and 249 (70,650) with `--read-only` as well, exactly the `--mode all` tools marked `readOnlyHint: true`.
  - **Harmony renders less.** For gpt-oss, `openai-harmony` 0.0.8 renders the 15 servers' tools in 17,302 tokens, 0.79 of the JSON count, and Azure's `--mode all` in 110,968 (0.81), partly by dropping detail: `anyOf` becomes `any`, `minimum` and `maximum` vanish, an open map becomes `{}`, and `title` and `default` become comments. Whether LM Studio's own gpt-oss template does the same is unchecked **[L]**.
- **Descriptions, instructions and annotations.** Descriptions run from 14 to 3,324 characters (median 80, p90 384); 5 pass 1,000, and 7 of the 128 use MUST, IMPORTANT, NEVER, ALWAYS, "Do not" or "Don't". 14 descriptions, and the instructions of DeepWiki, server-everything, Hugging Face and Microsoft Learn, name sibling tools by their raw names. The model sees those tools prefixed, and two that server-everything names with their hyphens mapped too. 6 of the 15 servers send instructions, of 126–831 tokens, and Azure sends 483. 125 of the 128 tools carry annotations (64 `readOnlyHint: true`, 25 `destructiveHint: true`), 51 a `title` and 36 an `outputSchema`; none has `icons` or `execution`.
- **Catalogs are stable between runs, not across configurations or hosts.** 57 comparisons of a server's `tools/list` across five runs over about 23 minutes, on Node and Bun, were byte-identical, order included. The independent re-listing 30–40 minutes later matched all 22 catalogs (15 servers, 4 variants, 3 Azure modes), the 5 remote ones included. Nothing was compared across days. Context7's stdio 4.4.4 and remote 4.4.3 serve identical tools. `mcp-server-time` writes its local timezone, the host's unless `--local-timezone` sets one, into two descriptions, so its catalog differs per host and tells the model provider the host's timezone. A remote server's catalog can change whenever its operator deploys, beyond a version pin's reach **[K]**.
  - **`listTools()` keeps the wire content,** but reorders `inputSchema`'s keys (`type`, `properties`, `required` first), the same way every time, and drops Chrome DevTools' non-standard annotation keys, `category` and `conditions`. No server paginated, not even Azure at 443 tools, and 9 of the 15 advertise `tools.listChanged`.
  - **Eras.** Under `versionNegotiation: { mode: 'auto' }`, 11 of the 15 negotiated 2026-07-28. Playwright, Chrome DevTools and DeepWiki stayed on 2025-11-25, and Microsoft Learn on 2025-06-18. Only server-everything's catalog changed with the era, by design (R17.3).
- **Results are mostly text.** All 26 successful calls returned a text block. Images, resource links, embedded resources and content `annotations` (`audience: ["user"]`) came only from server-everything's demos, and no server sent audio. The browser servers weren't called: their source attaches screenshots as image blocks after a text block, and Playwright's `--image-responses allow|omit|only` controls that. A `resource_link`'s `mimeType` is optional, and the SDK accepts it missing.
  - **`structuredContent` repeats the text.** 12 of the 26 results carried it, always beside a text block, which in 11 equals it: compact or 2-space JSON, or the value of its only field (`result` in DeepWiki, `content` in filesystem). Cloudflare's text renders the same hits as XML-like markup, without their scores. The duplication doubles the payload: 64 KB for Cloudflare's 31 KB of text, and 1.04 MB for DeepWiki's 509 KB. An empty directory came back as a text block `""` beside `structuredContent: {content: ""}`.
  - **Sizes and times.** Most calls returned 24 to 4,000 bytes of text. Documentation tools returned 14–31 KB (3,757–7,406 tokens), up to Cloudflare's 31,066 B, 95% of `read`'s 32 KiB cap. DeepWiki's `read_wiki_contents` returned 508,772 B (121,753 tokens). Flattened as C18 proposes, only that one passes 32 KiB; a 10 KiB cap would cut 5 of the 26, and a 20 KiB cap 4. Calls took 3 ms to 17.4 s: Cloudflare's search 3.0 s, DeepWiki's `ask_wiki_question` 10.6 s and fetch's `fetch` of example.com 17.4 s, the rest under 1.6 s.
  - **`isError` is a hint.** 7 of 8 deliberate failures came back with `isError: true` and one text block: two invalid inputs, a path outside the allowed directory, an unknown timezone, a repository outside `--repository`, and an unknown DeepWiki repository and Context7 library. Microsoft Learn returned a page it couldn't fetch as a success: "The provided URL points to a page that could not be retrieved (possibly a 404 or network error)." An unknown tool is JSON-RPC `-32602`, thrown as `ProtocolError`. On success, TypeScript-SDK servers omit `isError`, and the Python and FastMCP servers send `false`.
- **One malformed item loses a whole list or result.** Through a fake transport, each single defect made `listTools()` throw `SdkError` `INVALID_RESULT` and lose the valid tool beside it: an `inputSchema` missing, without `type` or with `type: "string"`; `properties` as an array; `required` as a string; a non-boolean `readOnlyHint`; a numeric `description`; an `outputSchema` without `type: "object"`; no `name`. Unknown tool and annotation keys are dropped silently. Node and Bun behaved alike.
  - **`callTool()` does the same with a result.** A `video` block, a text block without `text`, an image without `mimeType` or a non-boolean `isError` each threw `SdkError` `INVALID_RESULT` on both runtimes, losing the text beside it. So through `callTool()`, no block of an unknown type reaches the caller.
  - **Loose requests pass both.** `client.request({ method: 'tools/list', params: {} }, z.looseObject({ tools: z.array(z.unknown()), nextCursor: z.string().optional() }))` returned the raw page, and a loose `tools/call` the raw result. `isSpecType.Tool` and `isSpecType.ContentBlock` check one item at a time, and `specTypeSchemas.Tool['~standard'].validate` gives issue paths such as `inputSchema.type`.
  - **Three paths turn on the output-schema check.** With a cold cache, `callTool()` checks no `structuredContent` (R17.3). The `listChanged` option's default `autoRefresh` calls `listTools()` on `notifications/tools/list_changed`, after which a mismatched `structuredContent` threw `ProtocolError` `-32602`, "Structured content does not match the tool's output schema", on Node and Bun; with `autoRefresh: false`, the cache stayed cold. In the source, a header mismatch in the modern era makes `callTool()` evict the list, call `listTools()` and retry once. A `toolDefinition` passed to `callTool()`, which modern-era `x-mcp-header` mirroring reads, has its `outputSchema` compiled for that call.
- **One bad schema can fail every model request.** Anthropic answered `tools.68.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`, which blocked all conversations (anthropics/claude-code issue #56174, 2026-05-05); OpenAI, through LiteLLM, refused "Invalid schema for function … object schema missing properties" (mark3labs/mcphost PR #90, 2025-06-26); and several clients report "array schema missing items" **[M]**. `isSpecType.Tool` accepts a root `anyOf` beside `type: "object"`. None of the 980 schemas has root composition, an object without `properties` or an array without `items`, so the sample can't show this. Beyond the `properties: {}` R17.5 records, Codex's `sanitize_json_schema` adds `items: {"type": "string"}` where an array has none, infers missing types, turns a boolean schema into `{"type": "string"}`, and turns `const` into a one-value `enum`. Adding `properties: {}` or `items: {}` doesn't change what a schema accepts **[K]**.
- **Start-up.** Started directly, Node stdio servers connected in 0.13–1.34 s, the Python ones through a warm `uvx` in 0.78–3.07 s, Azure MCP (.NET) in 1.4–2.7 s and the remote ones in 0.07–0.96 s; `tools/list` took 2–516 ms. Through `npx -y` or `uvx`, connecting and listing took 0.8–7.8 s with a populated cache, varying from run to run, and 1.9–4.7 s with an empty one; a first `uvx … --help` that also downloaded CPython took 13.1 s. The `auto` era's probe process (R17.3) raised fetch's connect and list from 1.6 s to about 4.0 s. Each start was measured alone, none in parallel.
  - **Shutdown.** After stdin EOF, Node servers exited in 6–9 ms, Python ones in 104–136 ms, and Azure MCP in about 5 s, longer than the 2 s `close()` waits before SIGTERM (R17.3).
  - **Azure's proxy tools.** Started as its README starts it, `npx -y @azure/mcp@latest server start`, without `--disable-proxy-tools`, Azure MCP 4.0.0-beta.4 lists 73 tools in namespace mode, adding documentation, azd, foundry and arm, and 446 with `--mode all`, 3 more of them Microsoft Learn's. In `--mode all`, its `tools/list` then connects to 4 proxied servers (the `azd` CLI, `mcp.ai.azure.com`, `mcp.management.azure.com` and Microsoft Learn) and runs Azure's credential chain, including an interactive-browser broker attempt on macOS. That listing took 29.5 s, then timed out at 120 s, then took 5.5 s. No credential was used.
- **Gaps.** GitHub's MCP server, a common token server, wasn't in the sample, and no schema had `$ref` or `$defs`, which pydantic's nested models produce **[K]**. No provider request was made, so whether providers take `x-*` keys and `default: null` on a string without strict mode is untested. LM Studio wasn't exercised, and its bundled worker is obfuscated, so whether its snake_case conversion (R5.2) keeps `__` and digits, as in `context7`, can't be read from it (Q18).
- **What it means here:**
  - **One bad tool or block** costs a whole server's list, or a whole result, through `listTools()` and `callTool()`; loose requests with per-item checks keep the rest.
  - **MCP tools need an explicit `strict: false`:** left unset, Responses would likely make the 127 convertible schemas strict, and the model would then send nulls that servers refuse.
  - **Definitions, not names, set the cost:** 206 to 136,600 tokens a server, by its flags, against 692–821 for the built-in tools.
  - **A start-up deadline has to cover `tools/list`:** `npx` and `uvx` starts reached 7.8 s, a first `uvx` 13 s, and Azure's proxied listing timed out at 120 s.
- **Sources:** npm registry and PyPI metadata (2026-10-29); the servers as installed: `@modelcontextprotocol/server-everything@2.1.0`, `@modelcontextprotocol/server-filesystem@2.1.0`, `@modelcontextprotocol/server-memory@2.0.1`, `@modelcontextprotocol/server-sequential-thinking@2.0.0`, `@playwright/mcp@0.0.83` (README, and its `playwright-core` `lib/coreBundle.js`), `chrome-devtools-mcp@1.12.0` (README, `build/src/McpResponse.js`), `@upstash/context7-mcp@4.4.4`, `@azure/mcp@4.0.0-beta.4` (`README.md`, `azmcp server start --help`), and `mcp-server-fetch`, `mcp-server-git` and `mcp-server-time` 2026.10.28 from PyPI; the endpoints mcp.deepwiki.com/mcp (DeepWiki 2.14.3), docs.mcp.cloudflare.com/mcp (`docs-ai-search` 0.5.0), learn.microsoft.com/api/mcp (1.0.0), mcp.context7.com/mcp (4.4.3) and huggingface.co/mcp (0.4.31); the READMEs of github.com/MicrosoftDocs/mcp, github.com/cloudflare/mcp-server-cloudflare, github.com/evalstate/hf-mcp-server and github.com/modelcontextprotocol/servers (fetch, git, time); developers.openai.com/api/docs/guides/structured-outputs and /function-calling; github.com/openai/openai-python `src/openai/lib/_pydantic.py`; `openai@7.45.1` `resources/responses/responses.d.ts`; `@modelcontextprotocol/client@2.4.0` `dist/index-*.d.mts` and `dist/public-CvV4ZHkX.mjs`, and `@modelcontextprotocol/core@2.4.0` `dist/schemas-DscsoNZN.mjs`; `js-tiktoken@1.0.21` and `openai-harmony` 0.0.8; github.com/anthropics/claude-code issue #56174, github.com/mark3labs/mcphost PR #90 and github.com/openai/codex `codex-rs/tools/src/json_schema.rs`; this repository's `packages/core/src/tools.ts`, `packages/agent/src/model/responses-tools.ts` and `packages/agent/src/tools/read.ts`; a spike on Bun 1.4.4 and Node 26.12.1, macOS arm64.

**R18.3 A stdio transport on the repo's process spawning.** **[H]** unless marked. Measured on 2026-10-29 on Bun 1.4.4 and Node 26.12.1, macOS arm64, with a prototype stdin pipe for `@mecha-gremlin/process` and an MCP `Transport` over it for `@modelcontextprotocol/client` 2.4.0, running `@modelcontextprotocol/server-everything` 2.1.0, `@playwright/mcp` 0.0.83 and fake servers on the host; an independent check re-ran the main results, and the process tests, pipe probes and fake-server cases on Linux arm64 too, in Docker with a copy of CI's setup (Ubuntu 24.04, Node 26.13.0, Bun 1.4.4), and its corrections are folded in.
- **The runtimes' raw stdin APIs disagree,** on macOS and Linux alike. `Writable.toWeb(child.stdin)` doesn't even them out: on Bun it has no backpressure, and took all 16 MiB before the child read; on Node a write after the exit rejects with `AbortError` `ABORT_ERR`, not EPIPE.
  - **Node's `child.stdin`** applies backpressure. The first write after the child closes its stdin calls back with EPIPE, and later ones with `ERR_STREAM_DESTROYED`. Node destroys the stream when the child exits: a write then fails with `ERR_STREAM_DESTROYED`, and `end(cb)` never calls back.
  - **Bun's `FileSink`** (`Bun.spawn` with `stdin: 'pipe'`) took 512 KiB before the child read on macOS, and 192 KiB on Linux. When the child has closed its stdin, `write()` doesn't throw: a 16 B write returned 16 and the next `flush()` threw EPIPE synchronously, and a 256 KiB write returned a Promise that rejected with EPIPE, unhandled unless awaited. After the exit, a write returns `true`, `flush()` gives `undefined`, and the data is dropped.
  - **Bun's `node:child_process`** applies backpressure through the write callback: 512 KiB was taken before the read on macOS and 192 KiB on Linux, `write()` returned `true` or `false`, and `'drain'` fired 248–253 times. Unlike Node, it calls that callback synchronously, before `write()` returns. After the child closes its stdin, writes call back without an error, no `'error'` event fires, and the data is dropped. After the exit the stream is destroyed, as on Node.
- **A small sink per runtime gives one contract.** The prototype wrapped each primitive in a `WritableStream` of its own.
  - **Over `child.stdin`,** in `spawnWithNode`, a write resolves in `child.stdin.write`'s callback and rejects with an EPIPE-coded error on any error. Close resolves at once on a destroyed stream, and abort calls `destroy()`. The sink applies backpressure on Bun too. A permanent `'error'` listener stays on `child.stdin`: with it renamed, an EPIPE went unhandled, in 2 tests on Node and 1 on Bun.
  - **Over the FileSink,** in `spawnWithBun`, a write awaits `sink.write()` and then `sink.flush()`. Once `exitCode` or `signalCode` is set, it fails with EPIPE before writing, because the FileSink drops later writes silently. Close and abort call `sink.end()`. Only the `code` is common: Bun's own error reads `EPIPE: broken pipe, write`, the sinks' own `write EPIPE`.
  - **After the leader exits,** a background child that kept the pipe on fd 3 got what was written before the exit and nothing after, on both runtimes, macOS and Linux. Without a redirection, a background job of `sh -c` gets `/dev/null` as its stdin anyway (POSIX, without job control), and on dash, Ubuntu's `/bin/sh`, even `<&0` doesn't undo that.
- **A required, typed `stdin`.** In the prototype, `stdin: 'ignore' | 'pipe'` is required, like `detached`. `Subprocess<'pipe'>['stdin']` is a `WritableStream<Uint8Array>` and `Subprocess<'ignore'>['stdin']` is `undefined`, through objects keyed by mode (`BUN_STDIN` over `Bun.SpawnOptions.WritableToIO<Stdin>`, and `NODE_SPAWN`), with no casts and no unreachable checks. TypeScript 7.0.2 and the repo's type-aware oxlint 1.90.0, with warnings denied, exit 0 over the package, its tests and the transport, and a planted cast failed `typescript/no-unsafe-type-assertion`. A missing `stdin` is TS2741, `'inherit'` is an error, a union mode gives the union, and a fake `Spawner` that only returns `err()` needs no cast.
- **The spec change.** The prototype's delta to `process-spawning` added a requirement, "Writing to a process's stdin", with nine scenarios: a write resolves once the pipe has taken the chunk; closing gives end-of-file and resolves even after the exit; aborting closes the pipe at once; after an exit, by a signal too, or once the process has closed its stdin, every write fails with an error whose `code` is `EPIPE`, and never outside its own promise; and an idle pipe doesn't keep the caller running after `unref()` once both output streams are cancelled. It changed two requirements: the call and the subprocess gained `stdin`, and "The process gets only what the caller gives it" covered both modes. The existing callers, `exec/run.ts`, `exec/sweep.ts` and the tests, needed only `stdin: 'ignore'`. The process tests passed on both runtimes, on macOS and, in 3 of 3 runs, on Linux.
  - **One scenario can't hold for `spawnWithNode` on Bun:** "A process that closed its stdin", because Bun's `node:child_process` drops those writes without an error. "A write waits while the pipe is full" passes there: 524288 B were taken in the first 800 ms on macOS, against the scenario's 1 MiB limit, and it passed 3 of 3 runs on macOS and 3 of 3 on Linux. So that one scenario is the exception to the spec's rule that every scenario holds for `spawnWithNode` on both runtimes; only tests use that combination.
- **The 100% mutation bar holds.** Stryker 10.1.1 under Bun scored the prototype's `spawn.ts` at 100% with the repo's own Vitest config, its signal guard and 5 s test timeout included: 93 killed and 0 survived on macOS, and 77 killed, 16 timed out and 0 survived on Linux. Each time, the one runtime error was the mutant that renames the `'error'` listener. Getting there removed a dead `error === undefined` check and the pipe mode's `stdio` option: without one, Node gives three pipes, and Stryker found `'pipe'`, `['pipe', 'pipe', 'pipe']` and `[]` equivalent.
- **`ReadBuffer` needs a `Buffer`, on both runtimes.** Bun's streams and Node's `Readable.toWeb(child.stdout)`, which `spawnWithNode` returns, both yield plain `Uint8Array` chunks. `ReadBuffer.append` keeps the first chunk as it is and passes later ones through `Buffer.concat`, so no message in the first chunk is found until a second chunk arrives. That is a stall until the server writes again, and in the handshake, where the `initialize` reply is usually the server's only output, a `REQUEST_TIMEOUT`. Wrapping each chunk as `Buffer.from(buffer, byteOffset, byteLength)` fixed it. Three concurrent 5 MiB results then arrived intact on both runtimes, macOS and Linux, in about 0.5 s, or 1.2–4.9 s under load, and a 2 MiB request arrived intact on macOS. A server that answered with `writeSync` and exited at once lost no result of 100 B, 200 KiB or 2 MiB, in 15 of 15 runs each, on both runtimes.
- **Broken servers fail with a cause, except one,** on macOS and Linux alike. A server that exited at start-up with code 3 ended `connect()` with `CONNECTION_CLOSED` in 23–53 ms, with its own message in the stderr tail. One that never answered gave `REQUEST_TIMEOUT` at its 2 s timeout, and its close took about 0.9 s, ending in SIGTERM. One that ignored end-of-file and SIGTERM took 2.8–2.9 s to close, ending in SIGKILL. One SIGKILLed mid-call rejected the call in 4–19 ms. A missing program, and a call after such a kill, failed as in R17.3: with the runtime's message, and with `Not connected`.
  - As with the SDK's own transport (R17.3), text lines on stdout were skipped, and an 11 MiB line ended the connection. JSON that isn't JSON-RPC reached `onerror` as a `ZodError`, and the session went on. A server that wrote only non-JSON lines ended in a bare `REQUEST_TIMEOUT`, with no error reported.
- **Times move with load,** so they describe the machine more than the transport. The ranges, in ms, cover both runtimes on a 10-core macOS arm64 machine; the check ran at load averages of about 5 and of 14–36. A cold `npx` cache took 8269 ms to connect.

| Case | Spike | Check, load about 5 | Check, load 14–36 |
|---|---|---|---|
| server-everything: connect | 329–407 | 142–187 | 380–1626 |
| server-everything: close on end-of-file | 6–18 | 3–7 | 8–19 |
| Playwright MCP: connect | 445–716 | 202–217 | 746–4615 |
| Playwright MCP: first `browser_snapshot` | 954–2302 | 371–565 | 1726–4132 |
| Playwright MCP: close on end-of-file, browser open | 81–399 | 36–45 | 117–757 |
| `npx -y` server-everything, warm cache: connect | 1542–3399 | 493–1009 | 1261–4052 |

- **Start-up under one deadline.** Three servers connected in parallel under one `AbortSignal.timeout(3000)`, with a timeout on each request too, were ready in 477–511 ms. With a hung server added, the result came after about 4.0 s: the deadline, then that server's close, here its 1 s end-of-file wait before SIGTERM. At the prototype's limits a close takes at worst 1 s of end-of-file wait, 2 s of SIGTERM grace, a `ps` listing, which the prototype left unbounded and the sweep allows 10 s, and 2 s after the SIGKILL.
- **The stdio binding's order.** MCP 2026-07-28's stdio binding says the client SHOULD close the server's stdin, wait for it to exit, and if it doesn't exit in time, terminate it, which on POSIX "typically escalates from `SIGTERM` to `SIGKILL`"; servers SHOULD exit promptly on end-of-file. 2025-11-25's lifecycle orders shutdown the same way. The binding also says "If the server process exits unexpectedly, the client SHOULD restart it." Nothing in the SDK restarts a server (R17.3), and under 2025-11-25 initialization MUST be the first interaction between client and server, so a fresh process needs a new handshake.
- **The prototype's close** kept that order, and moved to each next step only while the leader's `exited` hadn't resolved. It ended stdin with `writer.close()`, unawaited, because a write held by a full pipe would hold the close until the process ends. It waited up to `eofWaitMs` (1000 ms), then sent SIGTERM to the group and waited up to `graceMs` (2000 ms). It then took one `ps` listing, sent SIGKILL to the group and to the groups the server's descendants lead, picked as `sweep.ts`'s `escalation()` picks them (never 1 or below, never the agent's own), and waited up to `graceMs` again. Last, whatever had happened, it sent one more SIGKILL to the group, then cancelled and awaited the readers. After a clean exit, that last SIGKILL aims at a group id that may already be free for reuse, a very small window **[K]**.
  - When `initialize` fails or times out, the client calls `void this.close()` and rethrows (`_legacyHandshake` in `client.ts`), so a close is under way that nobody awaits. The prototype's `close()` returned one promise to every caller, so awaiting `transport.close()` waited for that same close.
- **The group signal reaches wrapped servers.** Behind `sh -c '…; true'`, a server with work pending, or one that ignored end-of-file, closed in 1002–1012 ms, the end-of-file wait and then SIGTERM to the group, on both runtimes, macOS and Linux. Neither the shell nor the server was left, though in 2 runs `ps` still listed one of the two right after the close. The SDK's own transport took about 4 s there, and left the server running until its work finished (R17.3). An `npx -y` tree, `npm exec` and its node server, was gone 7–33 ms after end-of-file.
- **A wrapper leader cuts the server's shutdown short.** The shell dies at once on SIGTERM, so `exited` resolves, and the last SIGKILL to the group reaches the real server mid-cleanup. On both runtimes:
  - A fake server ignored end-of-file, and on SIGTERM spent 300 ms cleaning up before it killed a child that led its own group. Started directly, its close took 1305–1322 ms, it exited 0, and the child went too, in 12 of 12 runs; behind `sh -c '…; true'`, close took 1001–1009 ms, and the child survived, in 12 of 12. That held on macOS and Linux.
  - Playwright MCP behind `sh -c`, its server SIGSTOPped with the browser open, closed in 1017 ms and left 4 of 9 processes alive, Chrome's main process and 3 helpers. The leader exited within SIGTERM's grace, so the descendant listing never ran. `sweep.ts` takes its one listing before any signal.
- **Playwright's Chrome survives a SIGKILL of the server's group.** Chrome leads its own group and hides its environment from `ps`, as under playwright-cli (R12.8). About 300 ms after a SIGKILL to the server's group with the browser open, 4 of 7 browser processes were left, the main one reparented to pid 1 and none showing the run's ID; all 4 were alive 15 s later, on both runtimes. Neither the group kill nor the run-ID sweep reaches them. All of this is from macOS; Chromium's tree on Linux, which a linux/arm64 container needs (R12.4), is unmeasured.
  - **An abrupt death of the server,** such as an OOM kill or an outside kill, leaves Chrome the same way, since the server's group held only the server: the shutdown that follows finds that group empty.
  - **The escalation** cleared a SIGSTOPped server's tree, started directly, 0 of 8 left, in 3.10–3.18 s at limits of 1000 and 2000 ms, or 1.05 s at 500 and 500. SIGTERM to the group with the browser open closed Playwright gracefully in 84–104 ms, started directly or through `npx`, with nothing left. In one cold spike run Playwright outlasted a 1 s end-of-file wait, and SIGTERM then closed it gracefully, 2544 ms in all.
- **The sweep and the escalation depend on `ps`.** On macOS, `ps eww` showed `GREMLIN_RUN_ID` for the node server processes, but not for `/bin/sh`, for `npm exec`, which retitles itself, or for Chrome, so the run-ID sweep sees part of each tree. The official `oven/bun:1.4.4` and `node:26.13.0-slim` images, both Debian 13, ship no `ps`, and Alpine's BusyBox `ps` lacks the BSD-style `ax` syntax. There the sweep fails, and the prototype's descendant listing returns nothing, without an error. The sweep also refuses to act above 32 matches (`MAX_MATCHES`), and servers carry the run's ID; in every run here, none was left by sweep time.
- **macOS reports EPERM for a zombie-only group.** While the group's only member is an unreaped zombie, `kill(-pgid, 0)` and `kill(-pgid, 'SIGTERM')` fail with EPERM, though `kill(pid, 0)` succeeds, and once it is reaped they fail with ESRCH, on both runtimes; a member that launchd reaps shows a brief EPERM window too. On Linux such a group accepts the signal, so CI never sees it. `sweep.ts`'s `signalProcess` skips EPERM like ESRCH. The repo's `spawn.test.ts` cleanup treats only ESRCH as gone: without the repo's signal guard it failed with `kill EPERM` in 1 of 6 runs on Node, and with it in 0 of 6, since the guard's synchronous `ps` before every signal gives launchd time to reap.
- **Stderr has to be drained, for a different reason on each runtime.** Under `spawnWithNode`, a synchronous writer (`head -c 1048576 /dev/zero >&2`) blocked until stderr was read, on macOS and Linux; a Node-based server logging 1 MiB didn't, because Node buffers its pipe writes. Under `Bun.spawn` even the synchronous writer went on: Bun reads unread stderr into a buffer of its own, so the agent's memory grows instead, without bound.
  - **The tail lags stdout.** A server that logged 1 MiB to stderr before answering connected in 366–541 ms, and an 8 KiB tail kept its last log line. But when `connect()` resolved, that line was missing in 3 of 3 Node runs and 1 of 3 Bun runs, and in a Node run on Linux. It was there 200 ms later, and always after `close()`, which awaits both readers. A server that exited at once had its last stderr lines in the tail by the rejection, in 15 of 15 runs at each of three sizes up to 200 KiB, on both runtimes.
  - **What it holds.** Per session, server-everything wrote a 35-character banner, through `npx` too, and Playwright nothing. A cold `npx` cache, and the first run on a warm one, added npm's own deprecation warning: 346 characters with the banner. It is the server's and its launcher's own text, and a server can print a token there. The 2026-07-28 binding says the client "MAY capture, forward, or ignore the server's `stderr` output and SHOULD NOT assume `stderr` output indicates error conditions".
- **A SIGKILLed agent's servers exit on end-of-file.** With the agent SIGKILLed while it held three servers, 11 processes with Chrome among them, all were gone within 138 ms on Node and 310 ms on Bun, because each server's stdin reached end-of-file. Another server got end-of-file the same way while a detached shell command started after it lived on, since the command inherits no pipe end; that held on both runtimes, macOS and Linux. A server that ignores end-of-file would outlive such an agent, since no close and no sweep run then **[L]**.
- **The SDK has no logger hook.** `ClientOptions` is `ProtocolOptions` (`supportedProtocolVersions`, `enforceStrictCapabilities`, `debouncedNotificationMethods`) plus `capabilities`, `jsonSchemaValidator`, `versionNegotiation`, `inputRequired`, `listChanged`, `listMaxPages`, and the response cache's `responseCacheStore`, `cachePartition` and `defaultCacheTtlMs`; none takes a logger. On the client path, `console.debug` runs in `listTools`, `listPrompts`, `listResources` and `listResourceTemplates` when the server lacks the capability and strict capabilities are off: the stdout lines of R17.3. `console.warn` runs for a tool dropped over an invalid `x-mcp-header` declaration, on the modern era and on transports the SDK doesn't see as stdio; once for a zod fallback that zod 4.2 and later never reach (the repo has 4.6.7); and in five OAuth paths. The opt-in `withLogging()` fetch middleware's default logger writes with `console.log`, and with `console.error` for failures.
- **Strict capabilities keep it quiet.** With `enforceStrictCapabilities: true`, `listTools()` against a server without tools threw `SdkError` `CAPABILITY_NOT_SUPPORTED` and printed nothing, on both runtimes. Lists, calls, progress and timeouts still worked against server-everything. Calling `listTools()` only when `getServerCapabilities()?.tools` is set printed nothing either. Short of patching globals, only clients in a `worker_threads` Worker created with `stdout: true` and `stderr: true` would capture output that a later release adds **[K]**.
- **The SDK classifies a transport by its shape.** One with both `pid` and `stderr` counts as stdio (`'stderr' in transport && 'pid' in transport`), which skips the `x-mcp-header` filter and its warning. `'auto'` probes such a custom transport in place (R17.3). It chose modern against server-everything and legacy against a server answering -32601, and failed with `ERA_NEGOTIATION_FAILED` against one that exits on the probe, since the connection had closed.
- **The shell's environment would configure Playwright MCP.** `commandEnv` sets playwright-cli's `PLAYWRIGHT_MCP_IDLE_TIMEOUT` (R12.2) to 15 minutes, and `PLAYWRIGHT_CLI_SESSION`. `@playwright/mcp` 0.0.83 reads the first as its own idle timeout too, among the 47 `PLAYWRIGHT_MCP_*` variables its `playwright-core` dependency reads; its README names 53. An environment of `commandEnv`'s copied and fixed variables without those two, plus the server's own and then `GREMLIN_RUN_ID`, reached a server as exactly those names and `__CF_USER_TEXT_ENCODING`, which macOS adds itself. A server's own `GREMLIN_RUN_ID` didn't replace the run's, and a stand-in secret in the agent's environment didn't pass.
- **What it means here:**
  - **One stdin contract** fits both runtimes at the 100% bar, short of one scenario for `spawnWithNode` on Bun.
  - **Cleanup can't rest on the leader's exit or on the sweep:** behind a wrapper leader processes outlived the close, nothing reaches Chrome after an abrupt server death, and the sweep never sees it.
  - **In the official Docker images,** neither the escalation nor the sweep can list processes.
  - **The stderr tail is complete only after `close()`,** and strict capabilities or a capability check keep the SDK's `console.debug` off stdout.
- **Sources:** modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio (its `stderr` rules, Shutdown and Unexpected Termination) and /basic/transports, and modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle and /basic/transports; `@modelcontextprotocol/client@2.4.0`: the sources in its source maps (`src/client/{client,stdio,versionNegotiation,probeClassifier,middleware,auth,authExtensions}.ts`, `core-internal/src/shared/{stdio,transport,protocol}.ts` and `core-internal/src/util/standardSchema.ts`), `dist/src-CeKsbNLO.mjs` and `dist/client-BTIWJvaF.d.mts`; `@playwright/mcp@0.0.83` `README.md` and `playwright-core@1.64.0-alpha-1790635538000` `lib/coreBundle.js`; `bun-types@1.4.4` `bun.d.ts` and `s3.d.ts`; the `oven/bun:1.4.4` and `node:26.13.0-slim` Docker images, and BusyBox `ps` on Alpine; this repository's `packages/process/src/spawn.ts`, `packages/process/test/spawn.test.ts`, `test/signal-guard.ts`, `openspec/specs/process-spawning/spec.md` and `packages/agent/src/exec/{env,run,sweep}.ts`; a spike on Bun 1.4.4 and Node 26.12.1, macOS arm64, and Linux arm64 in Docker.

## R19. How a run takes its task

Measured on 2026-11-01 on Bun 1.4.4, macOS arm64, for C19: what reaches the agent when a task goes through the shell and `bun run`, and where `bun run` starts a script. **[H]** unless marked.

- **A file's text arrives intact as one quoted argument.** `bun run <script> "$(cat task.md)"` gave the script one argument equal to the file, with its quotes, `$HOME`, backticks, `$(…)`, `!` and `*`, less the trailing newline, which command substitution drops. Unquoted, the shell splits the text into words **[K]**, and the agent joins its arguments with single spaces, so the lines are lost.
- **Arguments have a size limit.** `getconf ARG_MAX` gives 1 MiB on macOS, for the arguments and the environment together. Linux also limits each argument to 32 pages, 128 KiB with 4 KiB pages **[K]**.
- **`bun run` starts a script in its package's root.** Run from a subdirectory, the script's working directory was the directory of the `package.json` that defines it, and Bun set no `INIT_CWD`. npm starts scripts there too, but sets `INIT_CWD` to the directory the command was typed in **[K]**. The agent resolves `WORK_DIR` against its working directory, so under `bun run` a relative path starts from the repository's root, wherever the command was typed.
- **Flags and stdin pass through.** `--task 'Say hi' --help` after the script's name reached the script as those three arguments, and text piped into `bun run` reached the script's stdin whole.
- **Sources:** a scratch package on Bun 1.4.4, macOS arm64; `getconf ARG_MAX`; `execve(2)` on Linux's per-argument limit, `MAX_ARG_STRLEN`; npm's `run-script` documentation on `INIT_CWD`; this repository's `packages/agent/src/main/args.ts` and `packages/agent/src/config/config.ts`.

## R20. The file tools' fence: where it came from, and what it stops

Researched on 2026-11-01 for C20, from this repository's code, specs and archived changes, and measured on macOS 27 with Bun 1.4.4. **[H]** unless marked.

**R20.1 How the fence grew.**
- **2026-10-13, `tool-call-loop`.** `read_file` was the model's only tool, so its confinement was a boundary: "Confining it to the working directory and refusing `.env` files limits what a model steered by a file's contents could read."
- **2026-10-16, `skills-and-shell`.** The shell arrived, on the host (D18). Every run now offers it, whatever the settings (`main.ts`), so from then on the fence bounded the file tools alone (C12).
- **2026-10-22, `file-write-tools`.** `write`, `edit` and `apply_patch` shared a write fence, which also kept the skill directories read-only. Its proposal said what the fence was for: "It turns the model's mistakes into clear errors; it is not a boundary."
- **2026-10-30, `add-persistence`.** Both fences refused the data folder, which matters when it sits inside the working directory, and the configuration refused a `DATA_DIR` that is or contains `WORK_DIR`, where the file tools could have touched nothing. The tokens are stored as they come: "The file's mode and the fence protect them (D32)."
- **2026-11-01, `read-task-file`.** A task file fails when the file tools would refuse it by its name or its place: an `.env` file, or a file in the data folder.

**R20.2 What each rule stops, with a shell in every run.** The shell runs `bash -c` as the user and reaches anything the user's account can (C12).

| Rule | Through the shell | What it stops otherwise |
|---|---|---|
| **Inside `WORK_DIR`**, as written and with links resolved, and for `read` also inside the skill directories | `cat path`, `cat > path` | mistaken paths, which mostly fail anyway (R20.3) |
| **No `.env*` name**, on `read` | `cat .env` | secrets reaching the provider by accident, through the tool the preamble names for reading. The log keeps only a result's size |
| **No `.env*` name**, on `write`, `edit` and `apply_patch` | `cp .env.example .env` | nothing leaks through a write. The rule also refuses `.env.example` and the like, which projects usually commit with placeholder values **[K]** |
| **Outside the data folder** | `sqlite3 db.sqlite`, `rm` | little: its files are binary (R20.4), and nothing writes there by mistake |

The tools' other refusals don't depend on where a file is: a directory; a whole replacement over 32 KiB, which could drop what the model hasn't read; a binary file; invalid UTF-8 or a file over 10 MiB, for `edit` and `apply_patch`; and a patch that doesn't apply whole.

**R20.3 Mistaken paths mostly fail anyway, and the fence pushes deliberate ones into the shell.**
- **On macOS, paths from container habits fail on their own.** The system volume is mounted sealed and read-only, and `/home` links to `/System/Volumes/Data/home`, where the automounter's `auto_home` map is mounted. `mkdir /workspace-…` failed with "Read-only file system", and `mkdir /home/…` with "Operation not supported".
- **What the fence refuses reliably is a write the task means:** a note in the home directory, a dotfile, another repository, a scratch file in `/tmp`. A model can still make it through the shell, as `cat <<'EOF' > path`, without the 32 KiB check, and the run's log then holds the path inside a heredoc in a `shell` call's command, where a `write` call would have logged it as an argument of its own.
- **Taking the fence off writes alone would make the tools disagree.** `write` could create `/tmp/out.txt`, and `read` would refuse it. `edit`, whose description says to read the file first, could change a file that `read` won't show.

**R20.4 The data folder's files are binary.** In a database that Bun's SQLite made in WAL mode, `db.sqlite`, `db.sqlite-wal` and `db.sqlite-shm` each had a NUL byte in its first 8 KiB, which is `read`'s test for a binary file. `read` refuses them without the data-folder rule.

**R20.5 No file tool expands `~`.** `path.resolve('/work', '~/notes.md')` gives `/work/~/notes.md`, so `write` with `~/notes.md` creates a directory named `~` inside the working directory, with the fence or without it. The shell expands `~`, so a model may expect the tools to.

**R20.6 What leans on the fence, and what doesn't.**
- **Leans on it:** the configuration's rule that `DATA_DIR` must not be or contain `WORK_DIR`, whose message gives the fence as its reason; the `agent` spec's "a task file the file tools refuse", and C19's "What the file tools refuse stays refused"; C12's note that the tool-loop design keeps the `.env` refusal "only until the workspace container exists"; D28's "the file tools refusing it as they refuse `.env` files"; and D32's "behind the fence".
- **Doesn't:** the stdio servers' run directory (D36), which must lie outside `WORK_DIR` and `DATA_DIR` so that npm finds no `.npmrc` that a repository brought there or a tool wrote (R18.1); and the shell's environment, built from scratch (C12, Q15), which keeps the agent's settings and `.env`'s out of what commands inherit and print.

**Sources:** this repository's `packages/agent/src/tools/{fence,read,write,edit,apply-patch}.ts`, `main/{main,args}.ts`, `config/config.ts`, `mcp/run-directory.ts` and `exec/env.ts`; the specs `read-tool`, `write-tool`, `edit-tool`, `apply-patch-tool` and `agent`; the archived changes `tool-call-loop`, `skills-and-shell`, `file-write-tools`, `add-persistence` and `read-task-file`; `mount` and `mkdir` on macOS 27; a scratch database under Bun 1.4.4.

## R21. How a run chooses its MCP servers, and where a task's choice could live

Researched on 2026-11-05 for C21, from this repository's code and README, and from the Brief itself. **[H]** unless marked.

**R21.1 What a run connects now.**
- **Every enabled server, for every run.** `main.ts` lists the store's servers and connects each one whose `disabled` flag is off: "A server's own flag alone decides whether it starts." The flag is the only switch, and `bun run mcp disable <name>` turns a server off for every run.
- **All of their tools.** The connected servers' tools follow the built-in ones, sorted by name, and stay fixed for the session (4.12). A server's `includeTools` and `excludeTools` narrow its tools for every run alike (D34).
- **One failure fails the run.** A server that can't start, answer, or list a tool that `includeTools` names fails the run before the first model call. The error offers one fix, the global one: "To run without it: bun run mcp disable <name>." (D33)
- **The task says nothing about servers.** A task file's text, frontmatter included, goes to the model verbatim, and nothing else reads it (D40).

**R21.2 What every server for every task costs.**
- **Every task depends on every server.** A one-line question that needs one server fails when an unrelated server's login is spent or a stdio server won't start, and disabling the broken server takes it from the tasks that do need it.
- **Tokens.** The 15 servers measured cost about 21,900 tokens of tool definitions, against about 700 for the built-in tools (4.12, Q21). LM Studio's default context has been 8k since 0.4.16 (R5.5).
- **The model's choices.** Part 1: "too many tools degrade the model's choices".
- **Start-up.** Every server connects before the first model call, within its `startupTimeoutMs`, and a stdio server starts its processes first: for `@playwright/mcp`, a browser.

**R21.3 Where the Brief already puts a task's choices.**
- **Part 1, component 3:** "A task gets the relevant subset, not every skill, because too many tools degrade the model's choices."
- **4.7:** "the `skills:` list in TASK.md frontmatter names the subset for that task. `gremlin apply` rejects unknown names." `SKILLS_PATH` says where skills live, and the frontmatter which of them a task gets.
- **C6** lists TASK.md's frontmatter: the schedule, time zone, model profile, skills, budgets, overlap and catch-up. Until TASK.md exists, the model and the step limit come from the environment: `.env` for every run, or a variable on the command line for one, which overrides `.env` (README).
- **C6, since 2026-11-01:** "Reading TASK.md's frontmatter would change only what a file that opens with a `---` block means." D40 sends that block verbatim, so that notes with tags in their frontmatter run as they are.
- **4.1 and 4.8** draw one daemon, `gremlin serve`, with the agent loop inside it, whose workers claim and run every task's queued runs. `gremlin run <task>` queues a run by hand.

**R21.4 Three places a choice could live.**

| | A list in the task file's frontmatter | An environment variable | A flag |
|---|---|---|---|
| **For example** | `mcp: [docs, github]` | `MCP_SERVERS=docs,github` | `--mcp docs --mcp github` |
| **Kept with** | the task, beside the text that relies on the servers | whatever starts the run | whatever starts the run |
| **Set once** | yes | only on the command line: `.env` is every run's, so a list there narrows every task, which `disable` can already do | no, on every run |
| **Inline tasks (`-p`)** | not unless the same rule reads inline text | yes | yes |
| **D40** | a `---` block gains a meaning | unchanged | unchanged |
| **M1** | TASK.md reads the same key, and `gremlin apply` can reject unknown names, as 4.7 does for skills | one daemon runs every task, so its environment can't differ by task. A value per task would come from the task's definition anyway | only `gremlin run <task>`; a scheduled run has no command line |

**R21.5 The seam in the code.**
- **The task is read first.** `readTask` (`main/args.ts`) runs before the store opens, so that its problems are reported with the configuration's. A list's YAML and its shape could be checked there.
- **Names are checked once the store opens.** The filter in `main.ts` runs after the servers are listed and still before any network request, as D33 requires. `createMcpServers` takes the rows to connect, and needn't change.
- **The parsers exist.** `splitFrontmatter` (`core/src/skills.ts`) and `parseYaml` (`@mecha-gremlin/yaml`) read SKILL.md's frontmatter. `splitFrontmatter` refuses a text without frontmatter, which a task file may be, with a message about SKILL.md.

**Sources:** this repository's `packages/agent/src/main/{main,args}.ts`, `mcp/{servers,resolve}.ts` and `config/config.ts`; `packages/core/src/skills.ts`; `packages/yaml/src/parse.ts`; `packages/store/src/mcp-server.ts`; the README; Part 1, C6, 4.1, 4.7, 4.8, 4.12, D33, D34, D40 and Q21.

## R22. How other harnesses let a task or an agent choose its MCP servers

Read on 2026-11-05 for C21, from each harness's docs and, where named, its source. None was run, and no independent fact-check re-read them. **[H]** unless marked. Goose, Crush and pi rest on search summaries and one issue, so they are **[M]** unless marked, and Cursor's and Amp's docs carry no versions.

**R22.1 What a definition file can choose.**

| Harness | File | What it chooses | Without it | A name that matches nothing |
|---|---|---|---|---|
| Claude Code 2.1.318 | a sub-agent, `.claude/agents/*.md` | `mcpServers`: a string that "reuses an already-configured server", or an inline entry that connects for the sub-agent alone. `tools` and `disallowedTools`, with `mcp__<server>__*` | every tool, MCP included | `tools` that resolve to nothing refuse the launch: "would be spawned with zero tools — refusing". A server that a policy blocks is skipped "with a warning naming the blocked servers". A name no server has isn't documented |
| VS Code, Copilot chat | `.prompt.md`, `.agent.md` | `tools`, with `<server>/*` or `<server>/<tool>` | the tools picker's choice | "it is ignored", and the editor hints "It is likely to be a missing MCP server" |
| GitHub Copilot coding agent | `.github/agents/*.agent.md` | `tools`, with `server/*`, where `[]` means none; `mcp-servers` adds inline servers | every tool | "All unrecognized tool names are ignored" |
| Gemini CLI 0.67.0 | a sub-agent, `.gemini/agents/*.md` | `tools`, with `mcp_<server>_*`; `mcp_servers`, inline and the sub-agent's own, with no way to name a configured server | every tool of the session | skipped silently |
| Codex CLI 0.166.0 | a custom agent, in TOML | nothing: an agent's `mcp_servers` "don't override the parent configuration" | — | — |
| opencode 1.19.5 | an agent, in Markdown | `permission` globs, or the deprecated `tools`, over `<server>_<tool>` names. Servers connect for every agent | every server and tool | matches nothing, silently **[M]** |
| Goose 1.57.0 | a recipe, in YAML | `extensions`, each a whole inline configuration: "only the listed extensions are available" **[M]** | the user's extensions **[M]** | not found |
| Amp | a skill | `mcpServers` in its frontmatter, inline, whose tools stay hidden until the skill loads | — | — |
| Zed 1.27.0 | an agent profile, in settings | each server's tools by name, or all of them. Servers start whatever the profile | the Write profile offers every server, and Ask and Minimal none | not consulted **[M]** |

Cursor CLI's sub-agents "inherit all tools from the parent, including MCP tools", pi's core has no agents, and Crush's per-agent list is internal **[M]**.

**R22.2 What a run's flags and variables can choose.**
- **Flags choose for one run.** Claude Code's `--mcp-config` with `--strict-mcp-config`: "Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations". Gemini CLI's `--allowed-mcp-server-names a,b` keeps the configured servers it names, ignores names it doesn't know, and replaces the settings' lists. Codex turns off one server at a time with `-c mcp_servers.<name>.enabled=false`, or layers a profile with `--profile`. pi has `--no-mcp`, and `--tools 'mcp__<server>__*'` **[M]**. Goose's `--with-extension` adds a server **[M]**, and opencode's `--agent` picks an agent.
- **No harness chooses servers one by one through an environment variable.** The variables that exist turn MCP off, as Claude Code's `CLAUDE_CODE_SAFE_MODE` does, or claude.ai's connectors alone; move the configuration, as `CODEX_HOME`, `GEMINI_CLI_HOME`, `COPILOT_HOME` and pi's `PI_CODING_AGENT_DIR` **[M]** do; or carry a whole configuration, as opencode's `OPENCODE_CONFIG_CONTENT` does **[M]**.
- **Settings hold standing lists:** Gemini CLI's `mcp.allowed` and `mcp.excluded`, Claude Code's approved and rejected project servers, and its managed `allowedMcpServers` and `deniedMcpServers`, which "aren't a registry".

**R22.3 A server that fails to start.**
- **Every harness but Codex carries on without it,** with a status or a warning for the user. Claude Code's `claude -p` "continues without the server's tools". Gemini CLI logs it and hints "MCP issues detected. Run /mcp list for status." opencode logs "server unavailable". pi reports failures once start-up is over **[M]**. Goose 1.56.0's `goose run` printed "Failed to start extension … HTTP 401 Unauthorized", went on and exited with 0, and the open issue asks for a failing exit "when the explicitly requested extension cannot start" (#13119).
- **Codex lets a server require it.** `required` is false by default, and "When `true`, `codex exec` exits with an error if this MCP server fails to initialize." A server that isn't required gets a warning, "MCP startup incomplete (failed: …)", and the session goes on.
- **No harness has a `required` or optional flag for a task or an agent.** Gemini CLI's admin `requiredConfig` keeps a server configured, not started.
- **Only Claude Code tells the model,** and only with tool search on, its default: it "tells Claude which server failed and its connection error". Without tool search, it "doesn't report failed server connections to Claude".

**R22.4 Frontmatter in definition files.**
- **The body is the prompt.** Claude Code's and Gemini CLI's sub-agents ("The body becomes the system prompt"), opencode's agents and GitHub's custom agents strip the frontmatter. None was found that sends it to the model.
- **Unknown keys are mostly ignored:** silently by Claude Code, which names them in its debug log since 2.1.296, and by Codex's skills; passed on as provider options by opencode; marked with a hint in VS Code's editor. Gemini CLI's sub-agents are the exception: "Unrecognized key(s) in object", and the file isn't loaded.
- **Frontmatter that isn't valid YAML** skips a Claude Code sub-agent, with an error only in the debug log, and loads a Claude Code skill "with empty metadata". It rejects a Gemini CLI sub-agent with "YAML frontmatter parsing failed", shown while the other agents load. opencode retries once after rewriting values with unquoted colons ("Other coding agents accept unquoted colons…"), then skips the file without a log.

**Sources:** Claude Code's docs at code.claude.com (`cli-reference`, `sub-agents`, `errors`, `skills`, `mcp`, `managed-mcp`, `env-vars`, `agent-sdk/mcp` and `agent-sdk/typescript`), at changelog head 2.1.318; VS Code's docs (`copilot/customization/prompt-files`, `agents/reference/custom-agent-file-reference`, `agents/run/tools`, `agents/run/manage-mcp-servers` and `copilot/customization/mcp-servers`), updated 2026-11-04, and `promptValidator.ts`; GitHub's `copilot/reference/custom-agents-configuration` and `extend-coding-agent-with-mcp`; Gemini CLI 0.67.0's docs and its `config.ts`, `mcp-client-manager.ts`, `local-executor.ts`, `agentLoader.ts` and `registry.ts`; Codex `rust-v0.166.0`'s `config/src/mcp_types.rs`, `codex-mcp/src/`, `agent-roles/src/` and `skills/src/parser.rs`, and OpenAI's Codex docs; opencode `v1.19.5`'s `packages/core/src/v1/config/agent.ts` and `packages/opencode/src/{mcp,permission,config}/`, and opencode.ai's docs; Cursor's `cli/mcp`, `cli/reference/permissions` and `context/subagents` docs; Amp's `customize/mcp`, `customize/skills` and `manual/plugin-api` docs; Zed 1.27.0's `ai/agent-profiles` and `ai/mcp` docs, `agent_profile.rs`, `context_server_store.rs` and `assets/settings/default.json`; Goose's recipe reference and issue #13119; Crush's README and pull requests #2800 and #3355; pi's `mcp` and `cli` docs.

## R23. What a task file's frontmatter holds, and how the parsers read it

Measured on 2026-11-05 for D45, D47 and D48, with this repository's `parseYamlWithBun`, through `Bun.YAML` on Bun 1.4.4, and `parseYamlWithPackage`, through the `yaml` package, which agreed on every case. **[H]** unless marked.

**R23.1 What both parsers make of frontmatter that notes hold.**

| Frontmatter | Both parsers give |
|---|---|
| `tags: [work]` | a mapping, `{"tags": ["work"]}` |
| `date: 2026-11-05` | the text `"2026-11-05"`, not a date |
| `related: [[Other note]]`, a wiki link left unquoted | a list inside a list |
| `title: Meeting: Q3 plan` | an error: a colon and a space in a plain value |
| `author: @someone` | an error: a plain value can't start with `@` |
| an indent made with a tab | an error |
| the same key twice | the last value |
| nothing between the two `---` lines | `null` |
| a sentence, as when a file opens with a horizontal rule | the sentence, as text |

- **Notes do hold frontmatter that isn't valid YAML.** opencode retries such a file once after rewriting values with unquoted colons, since "Other coding agents accept unquoted colons" (R22.4).

**R23.2 What they make of an `mcp` key.**
- `mcp: [docs, github]`, and the same list written one item a line, give a list of names, and `mcp: []` an empty one.
- `mcp: docs` gives the text `"docs"`, `mcp:` gives `null`, and `mcp: [1, 2]` a list of numbers.

**R23.3 Where the block sits now.**
- **The task is trimmed first.** The trim removes a byte-order mark and blank lines, so a block counts when `---` is the trimmed text's first line (the archived change `read-task-file`).
- **`splitFrontmatter` wants `---` alone on its line,** opening and closing the block, and refuses a text without one, with a message about SKILL.md (R21.5).
- **The `agent` spec pins D40** in its scenario "Frontmatter is part of the task": a file holding `---\ntags: [work]\n---\nSay hi\n` reaches the model as `---\ntags: [work]\n---\nSay hi`.
- **Elsewhere the body is the prompt.** Every harness surveyed strips a definition file's frontmatter, and most ignore the keys they don't know (R22.4).

**Sources:** a scratch script calling `packages/yaml/src/parse.ts` on Bun 1.4.4; `packages/core/src/skills.ts`; the `agent` spec; the archived change `read-task-file`'s design; R22.4.

## R24. What letting a task go without a server would take

Researched on 2026-11-05 for C22, from this repository's code and the Brief, with R23's probe. **[H]** unless marked.

**R24.1 Where a run fails now.**
- **Before any network request,** a reference that can't resolve, an entry that fails its checks again, or a login that has to be given again fails the run: `prepare` in `mcp/servers.ts` gathers every server's problems, and one is enough (D33).
- **While connecting,** `connect` waits for every server, and one failure closes them all and fails the run with each failed server's message (`collect`, in the same file).
- **Mid-session,** a server that dies isn't restarted. Its calls fail for the rest of the run, naming it, and the model sees those failures as tool outcomes (Q23).

**R24.2 What a task can do about a missing source.** A task can be written to report a source it couldn't check, as a daily summary does when one of its sources is down. Under D33, a source whose server can't start ends the run before the model sees anything, so such a task never gets to say so.

**R24.3 What it would take.**
- **Keeping failures apart.** `prepare` and `connect` would set an optional server's problems aside from the others', close that server alone, and go on with the rest.
- **Telling the model.** `main.ts` builds the developer item from the preamble and the skills catalog. A line naming each left-out server and its reason would go there, and a run whose servers all start would send what it sends now, for the prompt cache.
- **Redacting.** The reason would be the start-up failure's, already redacted of the server's resolved values, without its stderr lines.
- **A marker.** Server names match `^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$` (4.12), so no name holds a `?`. Both parsers keep `github?` as it is, in a list on one line or one item a line, and a separate key, such as `optional_mcp: [github]`, parses too.
- **A slow server isn't a missing one.** A server that answers slowly in a run's first minutes needs a longer `--startup-timeout`, not a marker.
- **Elsewhere,** no harness has an optional flag for a task or an agent. Codex makes a server required by its own setting, off by default, and only Claude Code tells the model which server failed (R22.3).

**Sources:** this repository's `packages/agent/src/mcp/servers.ts` and `packages/agent/src/main/main.ts`; 4.12; R23's probe, extended to `?` markers; R22.3.

## R25. A light scheduler: native cron, `Bun.cron` and in-process timekeeping

Researched on 2026-11-08 for C23, asked for as a lightweight scheduler that hooks into native cron and falls back to a library where there is none. Four research agents read `Bun.cron`'s source, the native schedulers' man pages and source, and in-process cron libraries; probed Linux cron in throwaway containers; measured start-up and idle costs on Bun 1.4.4 and Node 26.13.0; and surveyed other harnesses and container cron runners. No job was registered on the development Mac, so launchd's behaviour comes from its documentation and source. Four independent checkers re-checked all 138 findings: 117 hold, 21 hold partly, and none failed. Their corrections and 34 additions are folded in. A completeness critic then read the Brief's own scheduler design and probed this repository's code; its findings, in R25.5, weren't re-checked. Each subsection states its default confidence.

**R25.1 `Bun.cron`: OS-level jobs, the in-process form and parse.** **[H]** unless marked. Read on 2026-11-08 in the source of Bun 1.4.4 (2026-10-22), the newest release, and in its docs, typings, release posts, issues and PRs. `main` at 2596ac5d3 (2026-11-07) has only refactors of `cron.rs` since 1.4.4. Probes ran with Bun 1.4.4 and Node 26.13.0 on an Apple-silicon Mac on macOS 27, under moderate load, and in arm64 Linux containers under Docker Engine 29.9.2: the official Bun and Node images on Debian 13 and Alpine 3.24, and Debian 13 with Debian cron 3.0pl1-197. No job was loaded into launchd and nothing ran on Windows, so those two backends come from the source, man pages and Microsoft's docs. An independent check re-ran most probes, and its corrections are folded in.
- **Releases.** Bun 1.3.11 (2026-03-18, PR #26999) brought the OS-level form, `Bun.cron.parse` and `Bun.cron.remove`. 1.3.12 (2026-04-10, PR #28701) brought the in-process `Bun.cron(schedule, handler)`, "Scheduled in UTC". 1.4.0 (2026-08-20) was the first release built from the Rust rewrite (PR #30412). It made parse and the in-process form read local time, with a `{ tz }` option (PR #35122), made parse refuse a `from` outside the `Date` range (PR #29282), and let fake timers drive `Bun.cron` (PR #33623). Since then only internals and tests have changed: PRs #40024 and #40135 (1.4.1), #42297 (1.4.3, which stops the search at the end of the `Date` range), and #45809 and #46128 (1.4.4). The OS-level command strings are the same in 1.3.11's Zig source as in 1.4.4's Rust.
- **What this changes in R8 (2026-10-11).** R8's API, in-process semantics and syntax still hold. Everything here on the OS-level form, the timer and parse's rules is new. One correction: R8's "runs never overlap" doesn't hold when the handler returns a thenable that isn't a native promise (below). Additions: a module with no default export can export `scheduled` by name, the in-process job also has `Symbol.dispose`, and parse refuses `@reboot` and descending ranges as well as a seconds field. R8 dates 1.3.12 to 2026-04-09, the day its GitHub release was created. It was published on 2026-04-10.

| Bun 1.4.4's `Bun.cron(path, schedule, title)` | Linux and other Unix: crontab | macOS: launchd | Windows: Task Scheduler |
|---|---|---|---|
| **Registers with** | `crontab -l`, a filter, then `crontab <tmpfile>` | a plist in `~/Library/LaunchAgents`, then `launchctl bootout` and `bootstrap` in `gui/<uid>` | `schtasks /create /xml <tmp> /tn bun-cron-<title> /np /f` |
| **Writes** | `# bun-cron: <title>`, then `<sched> '<bun>' run --cron-title=<title> --cron-period='<sched>' '<module>'` | `Label`, `ProgramArguments`, `StartCalendarInterval`, `StandardOutPath` and `StandardErrorPath`, and no other key | an S4U logon at `LeastPrivilege`, `IgnoreNew`, `StartWhenAvailable`, and the same command |
| **The schedule** | numeric lists: `*/15 9-17 * * 1-5` becomes `0,15,30,45 9,10,…,17 * * 1,2,…,5` | one dict per combination, uncapped: 1, 4 and 540 for `0 7 * * *`, `*/15 * * * *` and `*/5 9-17 * * 1-5` | one trigger with a repetition, or up to 48 triggers |
| **Working directory** | `$HOME` | `/` **[M]** | System32 **[M]** |
| **`.env` loaded from** | `$HOME/.env` | `/.env` **[M]** | the working directory **[M]** |
| **`PATH`** | `/usr/bin:/bin` | `/usr/bin:/bin:/usr/sbin:/sbin`, launchd's default | not established |
| **Output** | mailed, or discarded with no mail server | appended to `/tmp/bun.cron.<title>.stdout.log` and `.stderr.log`, never rotated | not captured **[M]** |
| **Fires missed while asleep** | cron's own rules (R25.2) | coalesced into one run on wake **[M]** | `StartWhenAvailable` |
| **A run still going at the next fire** | another process starts **[K]** | no second instance **[K]** | `IgnoreNew` |

The Linux column's working directory, `.env`, `PATH` and output are Debian cron's, the only cron probed.

- **A job runs a module, not a command.** Each OS runs `<bun> run --cron-title=<title> --cron-period=<sched> <module>`. Bun then evaluates a wrapper, `const mod = await import(path); const scheduled = (mod.default || mod).scheduled;`, followed by `await scheduled({ cron, type: "scheduled", scheduledTime: Date.now() })`.
  - So a module with no default export can export `scheduled` by name, though the docs ask for a default export. `this` is `undefined`. `scheduledTime` is the start time, as the docs say ("Date.now() at invocation"), not "when the job was scheduled to run", as the typings say. A throw or a rejection exits with 1, and `process.exit(3)` with 3. A module without the function exits with 1: "error: Module does not export default.scheduled()". Bun doesn't time a run out.
  - The controller doesn't carry the title, but `process.execArgv` does: `["--cron-title=probe","--cron-period=*/5 * * * *"]`. `process.argv` holds only the `bun` path. Bun writes no other argument, so an entry can't name a task file. Arguments added by hand after the module path do reach `process.argv`.
- **The entry pins the binary that registered it.** Bun writes the canonical path of the registering `bun`: `/proc/self/exe` on Linux, and `current_exe()` with links resolved on macOS and Windows. With `/usr/local/bin/bun` a link to `/opt/bun/1.4.4/bin/bun`, the crontab line named `'/opt/bun/1.4.4/bin/bun'`. Version managers and Homebrew make `bun` a link into a versioned folder **[K]**. With such an install, removing that version breaks the entries until they are registered again. The module path is made absolute against the calling file's folder, not the working directory. The title must match `[A-Za-z0-9_-]+`. The module path may not hold `'`, `%`, a newline or a carriage return, and the `bun` path may not hold `'` or `%`.
- **The crontab cycle,** on every OS but macOS and Windows. `crontab -l` runs with stderr ignored, and any exit 1 counts as "no crontab". The filter drops every empty line, and each line equal to `# bun-cron: <title>` (ignoring spaces and tabs around it) together with the line after it. The rest and Bun's two lines go into a temp file, created `O_EXCL` with mode 0600, which `crontab <tmpfile>` installs.
  - Starting from a hand-written crontab, the first rewrite kept `MAILTO`, the comments, the jobs and a line of spaces, and deleted every blank line. Registering a title again moves its entry to the end. `remove()` takes out just its two lines. It rewrites the crontab even when the title isn't there, and removing the last entry leaves an empty crontab rather than calling `crontab -r`. `remove('fake')` deleted a hand-written job under a hand-written `# bun-cron: fake` line.
  - The line and `--cron-period` carry the normalised schedule, and so does `controller.cron`: `@daily` was installed as `0 0 * * *`. No call lists the jobs or returns the registered string. A sync therefore has to read the entries back and normalise its own side.
- **Crontab edits are unserialised and fail open.** Six registrations at once in one process all resolved, and only one entry survived, a different one in each of two runs. Two processes registering at once both succeeded, and only one entry landed. With the spool file unreadable, `crontab -l` printed "fopen: Permission denied" and exited 1. A registration then installed a crontab holding only its own entry, and `remove()` installed an empty one. PR #41651 (2026-09-06) serialises the edits, fails closed and filters only Bun's lines. It is mergeable and hasn't moved since. Its description: "the rewrite installs a crontab with only the bun entry and every existing job is gone".
- **A cron job runs in `$HOME` with five variables.** With Debian cron running, a `* * * * *` job fired on time, in `$HOME`. Its environment was exactly `HOME`, `LOGNAME`, `PATH=/usr/bin:/bin`, `PWD` and `SHELL=/bin/sh`, plus what Bun loaded from `$HOME/.env`. The `.env` beside the module was ignored. Running the installed line by hand under `env -i` with those variables did the same. Run from the module's folder, it loaded that folder's `.env`. This bears out R9's background bullet on cron in containers as far as the environment and output go, for Debian cron. PR #29147 would run jobs in the folder they were registered from. It has been open since 2026-04-11 and conflicts with `main`. R25.5 covers what a scheduled run needs from this repository.
- **The working directory's `.env` wins.** Bun loads it before the module runs. `process.loadEnvFile(<project>/.env)` then leaves those variables alone, as Node 26.13.0's does. Both return `undefined`, keep values already set, and throw `ENOENT` for a missing file. Children spawned in the project's folder also inherit the earlier values, whether they are Bun or `node --env-file-if-exists=.env`. Under cron, a `~/.env` therefore overrides the project's settings. Assigning what `util.parseEnv` returns, or spawning with an environment built from scratch, puts the project's values first.
- **A cron job's output is lost.** Debian cron mails a job's stdout and stderr. With no mail server it discards them, logging "(CRON) info (No MTA installed, discarding output)". At its default `-L 1`, it logs a job's start, its CMD line, but not its end or failure: END lines need `-L 2`, and failed jobs `-L 4` (cron(8)). Without a mail server, a failing job leaves no other trace (Q1). Bun's docs say "On Linux, cron output goes to the system log", which isn't so under Debian cron.
- **Containers.** The Debian-based official images have no `crontab`, `cron` or `crond`: `oven/bun:latest` (1.4.4 on Debian 13), `oven/bun:slim`, `node:latest` and `node:slim`. In `oven/bun:latest`, `Bun.cron` and `Bun.cron.remove` reject at once with `Error "crontab not found in PATH"`. These images have no `pgrep` or `ps` either, so a check for a running daemon has to read `/proc` (Q24, R18.3).
  - The Alpine variants, `oven/bun:alpine` (Alpine 3.24, Bun 1.4.4) and `node:alpine`, are musl images, which D26 allows. They have BusyBox's `crontab` and `crond`, but no `crond` running. In `oven/bun:alpine`, registration and removal succeeded and rewrote `/var/spool/cron/crontabs/root`.
  - On Debian 13 with the `cron` package and no daemon running, registration succeeded silently, even for a user with no crontab yet. Bun never checks for a daemon.
  - So a success doesn't mean jobs will fire, and a rejection doesn't mean the host has no scheduler. Arch installs no cron by default and uses systemd timers (ArchWiki), which `Bun.cron` never writes (R25.2).
- **macOS: a plist in the GUI domain.** Bun writes `~/Library/LaunchAgents/bun.cron.<title>.plist` with mode 0644, truncating it in place. It then runs `/bin/launchctl bootout gui/<uid>/bun.cron.<title>`, ignoring any failure, and `/bin/launchctl bootstrap gui/<uid> <plist>`. `remove()` boots the job out and deletes the file.
  - A failed bootstrap leaves the plist on disk. Since bootout comes first, a failed re-registration leaves the old job unloaded and the new plist in place. On POSIX Bun ignores the scheduler's stderr, so a failed `crontab` or `launchctl` reads only "Process exited with code N". The typings promise the stderr in the error.
  - launchctl(1) says "A user-login domain is created when the user logs in at the GUI", and calls `gui/<uid>` "Another form of the login specifier". So jobs run only while their user is logged in at the GUI, and a plist left behind loads at the next login **[M]**. Registering with no GUI session, as over SSH on a headless Mac, probably fails at `bootstrap` **[K]**.
- **What the plist leaves out:** `WorkingDirectory`, `EnvironmentVariables`, `RunAtLoad`, `AbandonProcessGroup`, `ProcessType`, `KeepAlive` and `Umask`. launchd.plist(5) gives the defaults.
  - **Throttling.** Without `ProcessType`, "the system will apply light resource limits to the job, throttling its CPU usage and I/O bandwidth".
  - **The process group dies with the job.** "When a job dies, launchd kills any remaining processes with the same process group ID as the job." A job that starts agent runs and then exits loses them, MCP servers included, unless it spawns them in a new session. `detached: true` does that through `setsid()`, both in `Bun.spawn` (R8) and in Node. This wasn't reproduced **[M]**.
  - **Working directory and `PATH`.** Users report `/` as the working directory (#28238) **[M]**. The `PATH` is launchd's default, `/usr/bin:/bin:/usr/sbin:/sbin`, as `launchctl print` shows it for a GUI-domain job.
  - **Logs.** `/tmp` is `/private/tmp`, world-writable with the sticky bit. Without `Umask`, launchd creates the logs with its default umask **[M]**; their mode wasn't observed. PR #29144 warns: "another local user can pre-create a symlink at that path before the job first runs; launchd will then open and append through the symlink as the registering user (CWE-59 / CWE-377)". It moves the logs to `~/Library/Logs/bun/cron/` and conflicts with `main`. Issue #28298 has been open since 2026-03-20.
- **The calendar is a Cartesian product.** `StartCalendarInterval` comes from the normalised expression. A `*` field is left out ("Missing arguments are considered to be wildcard"). Each other field becomes a list, with one dict per combination and no cap. With both day fields restricted, Bun writes Day dicts without Weekday, then Weekday dicts without Day. Its comment says "launchd ANDs keys within a single dict". launchd.plist(5) says "If both Day and Weekday are specificed, then the job will be started if either one matches the current date."
  - Bun's code, ported and run, gives an empty dict for `* * * * *`, one dict for `0 7 * * *`, two for `0 0 15 * FRI`, four for `*/15 * * * *`, and 540 for `*/5 9-17 * * 1-5`, in a plist of about 103 KB that `plutil -lint` accepts. `1-59 1-23 2-31 2-12 1-6` gives 537,372, about 129 MB. PR #29148 caps the product at 256 and conflicts with `main`. How launchd copes with hundreds of dicts wasn't tested.
  - On sleep, launchd.plist(5) says: "launchd will start the job the next time the computer wakes up. If multiple intervals transpire before the computer is woken, those events will be coalesced into one event upon wake from sleep." This wasn't observed **[M]**.
- **Windows,** from the source and Microsoft's docs. An evenly spaced schedule, `* * * * *` included, gets one `CalendarTrigger` with a repetition. Any other schedule gets one trigger per hour and minute, doubled when both day fields are restricted. More than 48 fail: "requires too many triggers for Windows Task Scheduler (max 48)". Settings Bun leaves out take the schema's defaults, so the task doesn't start on battery and stops when the machine switches to battery. A repeating task registered mid-day stays idle until the next midnight (#34195; Bun's bot "Reproduced on Windows Server 2019"). Its fix, PR #34199, was closed as stale on 2026-09-13. #31430 reports S4U logon refused on managed machines: "error: ERROR: Access is denied." PR #28283 says the working directory is System32 **[M]**.
- **What a cron-mode start costs.** On the Mac, in two sets of 9 runs, Bun's cron mode with an empty `scheduled()` took a median 6–8 ms wall, 5–6 ms CPU and 12 MiB maximum RSS. `node --env-file-if-exists=.env` with an empty module took 83–126 ms wall, 82–125 ms CPU and 39 MiB. At one start a minute, that is 7–9 s of CPU a day on Bun and 2–3 min on Node. On Bun, imports can cost more than the runtime does. Importing `typeorm` 1.1.2 alone, before any database connection, took about 44 ms CPU and 35 MiB on Bun, and 145 ms CPU and 64 MiB on Node, over 7 runs. That is about 1 and 3.5 min of CPU a day (R25.3, R26.3).
- **The in-process form, in brief** (R26.1 covers clocks). Each job keeps one timer on `CLOCK_MONOTONIC`, armed for the next wall-clock fire minus the current wall-clock time. The timer is recomputed only after a fire settles, from the later of now and the last target, and never re-checked in between.
  - In Debian, with libfaketime 0.9.10 stepping only the wall clock, a +30 s step made the pending fire 30 s late. A −30 s step made it 30 s early, and the intended minute then passed without a fire.
  - `CLOCK_MONOTONIC` stops during a Linux suspend. So a 07:00 fire on a machine suspended from 06:00 to 18:00 comes at about 19:00. On macOS it keeps counting through sleep, so the fire comes once after wake, at a time not measured. Either way one fire comes late, and any later ones due in the gap are lost. This is inferred from the code and man pages **[M]**.
  - Fires landed 5–7 ms after the minute, with `this` set to the job and no arguments. Without a listener, a throw or a rejection exits with 1. With `process.on` listeners, the job fires again (R8, 4.8). A 65 s run begun at 14:33:00 settled at 14:34:05, and the next fire was 14:35:00. So a fire due during a run is skipped, like C6's `overlap: skip`. A returned thenable that isn't a native promise isn't awaited: Bun never called its `then()`, and the job fired again a minute later. PR #45843 (open) names `Bun.$` and `Bun.SQL` among such values. `.unref()` lets the process exit.
  - Node 26.13.0 has nothing like it. Across the exports of its 67 built-in modules, two levels deep, `/cron|schedul/i` matches only `globalAgent.scheduling` in `http` and `https`, `cluster.schedulingPolicy`, a `perf_hooks` GC constant and `timers/promises.scheduler` (D19).
- **Parse's rules.** Since 1.4.0 parse reads local time unless given `{ tz }` (R8, Q11). The day-of-month or day-of-week OR applies only when neither field is a literal `*`. Weekday 7 is Sunday. `N/step` runs from N to the end of the field (`5/15` gives :05, :20, :35 and :50), and steps go up to 127. Month and day names ignore case and may be spelled out (`jan,FEBRUARY`). The nicknames are `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight` and `@hourly`. Parse refuses `@reboot` ("unrecognized field syntax") and a sixth field ("seconds are not supported"). It also refuses descending ranges such as `MON-SUN` and `FRI-MON` ("range must be ascending"). Debian cron 3.0pl1-197 accepted those ranges, and `@reboot` too.
  - The result is the first minute strictly after `from`: from 00:00:30, `* * * * *` gives 00:01. The search runs to 8 years past the start year, where 1.3.11's ran 1,500 days, and then returns `null`. `0 0 29 2 *` from 2096-03-01 gives 2104-02-29, and `0 0 30 2 *` gives `null`.
- **DST, in America/New_York,** using the code that the in-process form also uses. On 2027-03-14, `30 2 * * *` gave 07:30Z, which is 03:30 EDT. `* 2 * * *` and `*/15 2 * * *` each gave 07:00Z once, then nothing until the next day. On 2027-11-07, `30 1 * * *` gave only the first 01:30, and `0 * * * *` gave both 01:00s. `*/30 1 * * *` gave only the first hour's 01:00 and 01:30. croner 10.0.1 also ran fixed times once and moved a job in the gap an hour late. But it skipped the repeated hour for interval jobs (R10), which 4.8 pins, while Bun runs hourly jobs in both copies. PR #40402 (open) reports wrong results where the gap isn't a whole hour: "In Australia/Lord_Howe (30 minute gap) 0 * * * * fires at 02:30".
- **Where parse and Vixie cron differ,** from cronie's source at master cb49729da (2026-11-05) and Debian's patches.
  - **Day fields.** Vixie counts a day field that starts with `*`, such as `*/2`, as unrestricted (cronie's `entry.c`: `if (ch == '*') e->flags |= DOM_STAR;`). For `0 0 */2 * MON`, cronie fires only on Mondays that fall on odd days. Bun fires on odd days or Mondays (11-09, 11-11, 11-13, 11-15). The crontab Bun writes follows Bun's reading, since `*/2` is installed as `1,3,5,…,31`.
  - **Fall-back.** Vixie treats a job as a wildcard job when its minute or hour field starts with `*`, so it runs `*/30 1 * * *` in both 01:xx hours. Bun runs only the first.
  - **Spring-forward.** After a forward change of up to 3 hours, cronie and Debian cron run skipped fixed-time jobs soon after the change: about 03:00, where Bun says 03:30. They don't run wildcard jobs for the lost hour: `* 2 * * *` doesn't run, where Bun fires once. Debian's patch: "Clock changes of more than 3 hours are considered to be corrections to the clock, and the new time is used immediately." Here an OS-level job follows its daemon, not parse (R25.2).
- **The installed job can disagree with parse.** Bun writes `*` for a field whose values fill its range. So `0 0 1-31 * MON` is installed as `0 0 * * 1`, Mondays only, while parse and the in-process form fire daily (11-09, 11-10, 11-11). The same rule installs `0 0 * * 0-6` as `0 0 * * *`, where it changes nothing. PR #29143, open since 2026-04-10 and mergeable, reports a case: for `0 0 15 * 0-6`, parse "correctly predicts the job fires every day", while "the OS-registered job fired only on the 15th".
- **croner 11.0.0** (2026-10-26) gave the same next dates as parse in four day-field cases, with its default `domAndDow: false`: `0 0 */2 * MON`, `0 0 1-31 * MON`, `0 0 15 * FRI` and `0 0 * * 7` **[M]**. No other case was compared. On the first, croner too differs from Vixie cron. Parse exists only on Bun (D12, R25.3).
- **Issues and PRs.** Open issues: #28238 (run the job in the script's folder; 2026-03-18), #28295 (`file://` paths), #28297 (`RunAtLoad`), #28298 (logs in `/tmp`), #29447 (seconds; 7 reactions), #31430 (a logon other than S4U) and #34195 (the Windows midnight delay). Closed: #7004, the request for a built-in cron (completed 2026-04-03; 78 reactions), and #28239, a default-exported function ("We decided against this API").
  - Of the open PRs, #41651 (crontab safety) and #29143 (normalisation) are mergeable. #29136 (ranges ending in `SUN`), #29144 (logs), #29146 (`file://` URLs), #29147 (working directory) and #29148 (the dict cap) conflict with `main`. None of the six April PRs, #29136 to #29148, has moved since 2026-05-30. Also open:
    - #37660 (a refactor) and #39342 (tests and leftover crontab entries);
    - #40402 (DST gaps) and #45843 (thenables);
    - #46504: since 1.4.0, a path byte that isn't UTF-8 is written as U+FFFD, and "the installed crontab line exits 127" **[M]**;
    - #47623 (docs), #47818 (runtime plugins in cron mode), and #48108 and #48149 (fake timers).

    Closed unmerged: #28283, #28296, #28299, #34199 and #36894.
- **On npm,** no credible general-purpose library registers jobs through each OS's own scheduler on both Linux and macOS. The nearest, `crontab` 1.4.2 (2021-05-07; 1,302 downloads in the week to 2026-11-07), edits the user crontab and fails closed, but on macOS it reaches cron, which skips jobs while the Mac sleeps; `cronbee` 0.6.1 and `launchd` 0.1.0 have under 100 downloads a week each. Agent plugins: R25.4.
- **Open:**
  - when the in-process timer fires after a Mac sleeps, and the delay after a Linux suspend (R26.1);
  - launchd with hundreds of dicts, its coalescing, its single instance and the GUI-domain limit;
  - the mode of launchd's logs without `Umask`, and whether writing a plist raises macOS's "Background Items Added" notice, so that switching the background item off silently stops the job **[K]**;
  - everything on Windows;
  - cronie, BusyBox `crond` and systemd-cron, which may differ from Debian cron in how `crontab -l` reports a missing crontab, where output goes and how clock changes are handled;
  - whether cron starts a second process while a long `* * * * *` run is still going;
  - when #41651, #29147 and #29144 land.
- **Sources:** github.com/oven-sh/bun at bun-v1.4.4: src/runtime/api/cron.rs, src/runtime/api/cron_parser.rs, src/runtime/cli/run_command.rs and Arguments.rs, src/bun_core/util.rs, src/runtime/timer/mod.rs, packages/bun-types/bun.d.ts, docs/runtime/cron.mdx, test/js/bun/cron/cron.test.ts; github.com/oven-sh/bun at bun-v1.3.11: src/bun.js/api/cron.zig; main at 2596ac5d3 (2026-11-07); github.com/oven-sh/bun releases bun-v1.3.11, bun-v1.3.12 and bun-v1.4.4; bun.com/blog/bun-v1.3.11, bun.com/blog/bun-v1.3.12, bun.com/1.4; oven-sh/bun pull requests #26999, #28701, #30412, #35122, #29282, #33623, #40024, #40135, #42297, #45809, #46128, #41651, #29136, #29143, #29144, #29146, #29147, #29148, #37660, #39342, #40402, #45843, #46504, #47623, #47818, #48108 and #48149, and the closed #28283, #28296, #28299, #34199 and #36894; oven-sh/bun issues #7004, #28238, #28239, #28295, #28297, #28298, #29447, #31430 and #34195; github.com/cronie-crond/cronie src/entry.c and src/cron.c at master cb49729da (latest release 1.7.2); salsa.debian.org/debian/cron debian/patches/features/Better-timeskip-handling.patch; manpages.debian.org/trixie/cron/cron.8.en.html; macOS 27 man pages: launchd.plist(5), launchctl(1), launchd(8), cron(8) and clock_gettime(3); man7.org/linux/man-pages/man2/clock_gettime.2.html; learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-settingstype-complextype; wiki.archlinux.org/title/Cron; nodejs.org/dist/index.json (Node 26.13.0); npmjs.com/package/crontab, /cronbee, /launchd, /croner and /typeorm; github.com/dachev/node-crontab lib/index.js; api.npmjs.org download counts for 2026-11-01 to 2026-11-07; Docker images oven/bun:latest, :slim and :alpine (Bun 1.4.4), node:latest, :slim and :alpine (Node 26.13.0), and debian:trixie-slim with cron 3.0pl1-197 and libfaketime 0.9.10; a spike on Bun 1.4.4 and Node 26.13.0, macOS 27 arm64, and arm64 Linux containers under Docker Engine 29.9.2; this Brief's R8, R9, R10, 4.8 and D26.

**R25.2 The native schedulers: cron, systemd timers and launchd.** **[H]** unless marked. Researched on 2026-11-08 for C23. Linux cron ran in throwaway containers of Debian 13 (cron 3.0pl1-197), Ubuntu 26.04.1 (3.0pl1-200ubuntu1), Fedora 45 (cronie 1.7.2-17.fc45) and Alpine 3.24 (BusyBox 1.37.0). CentOS Stream 10 and the official Node v26.13.0 and Bun 1.4.4 images were inspected too. DST was faked through libfaketime on tzdata 2026f. systemd was read at v262.2, and its calendars were computed with `systemd-analyze` 257.13. launchd and Apple's cron weren't run. They were read in macOS 27.2's man pages, in Apple's open-source cron-52 and in launchd-842.92.1, the last open-source launchd (OS X 10.9 era), and a macOS 27.2 Mac was inspected read-only. An independent checker re-ran most of the container probes and re-read the sources, and its corrections are folded in.
- **Where Linux cron runs.** Debian 13 installs its Vixie-derived cron at Priority important, and Ubuntu 26.04 at standard, through `ubuntu-standard`. Fedora 45 Server gets cronie through the `standard` comps group. Workstation's environment doesn't require that group, so Workstation may lack cronie **[M]**. CentOS Stream 10 has cronie in `@core`. Arch installs no cron, since "the base system uses systemd timers instead". Alpine's BusyBox crond is in the base system, and `setup-alpine` enables it.
  - **Not in the images.** `debian`, `ubuntu`, `fedora`, `centos:stream10`, `node:latest`, `node:slim`, `oven/bun:latest` and `oven/bun:slim` have no `cron`, `crond`, `crontab` or `systemctl`. `node:slim` and `oven/bun:latest` ship no `ps` either (Q24). `alpine`, `node:alpine` and `oven/bun:alpine` have `crond` and `crontab` as BusyBox applets, but nothing starts crond. `better-sqlite3` loads in the Node and Bun ones (D26, R17.6). All eleven images have `flock`.
  - **WSL2.** Only the Ubuntu that `wsl --install` installs runs systemd by default. Other distributions "may still use the WSL init", and there cron and user timers run only if something starts them. "systemd services will NOT keep your WSL instance alive". An idle distribution shuts down after `instanceIdleTimeout`, 15000 ms by default (`-1` turns it off). The docs don't define idle, so it is an inference that a schedule inside WSL fires only while something outside keeps the instance up **[M]**.
- **What a cron job starts with.** Debian and Ubuntu set `HOME`, `LOGNAME`, `SHELL=/bin/sh` and `PATH=/usr/bin:/bin`. There is no `USER`, `TZ` or profile, and no `LANG` unless `/etc/default/locale` sets one. cronie adds `USER` and sets `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, or keeps crond's own under `-P`. Both run `pam_env`, so `/etc/environment` reaches jobs but a container's variables don't. BusyBox crond passes its own environment on, the container's variables included, and sets `LOGNAME`, `USER`, `HOME` and `SHELL` over it. All three start a job in `$HOME`. From there, Bun's `.env` loading and Node's `--env-file-if-exists=.env` (R14) miss the repository's `.env`.
- **Output without a mail server.** Debian and Ubuntu cron throw it away and log "(CRON) info (No MTA installed, discarding output)". If cronie finds no `/usr/sbin/sendmail` at start, it sends each output line to syslog as `CMDOUT`, which is the journal on systemd hosts. BusyBox crond without `MAILTO` lets a job write to crond's own stdout and stderr, which reach `docker logs` when `crond -f` is PID 1.
  - Debian 13's cron "Recommends: default-mta | mail-transport-agent". So `apt-get install cron` also brings `exim4-daemon-light`, and output is mailed to a local mailbox. Installed without Recommends, or as part of the base system, it has no MTA. Ubuntu 26.04's cron recommends nothing.
- **Time zones.** Only cronie reads a table's `CRON_TZ=`. With `CRON_TZ=Asia/Tokyo` and `19 23 * * *` on a UTC clock, cronie fired at 14:19 UTC, and Debian didn't. Debian runs every table in the daemon's zone. A `TZ=` line "will affect only the commands executed in the crontab, not the execution of the crontab tasks themselves". BusyBox crond has no zone handling at all. So only cronie can fire in a zone other than the daemon's, which C6's per-task `tz` would need (Q11).
- **DST,** faked in Europe/Berlin at real speed. On spring forward (2027-03-28), Debian cron and cronie ran a 02:30 job in the first minute after the jump, and BusyBox never ran it. On fall back (2026-10-25), Debian cron and cronie didn't repeat a 02:01 job, while wildcard jobs ran on through the repeated hour. BusyBox ran the 02:01 job again at 02:01 CET.
  - Debian's cron(8) documents this, and treats changes over 3 hours as "corrections to the clock". cronie's crontab(5) says skipped times "will never match" and repeated times run twice, but its daemon and its own cron(8) disagree. croner 10.0.1 runs a gap job an hour late, and a repeated-hour fixed-time job once (R10).
- **Fires missed while asleep.** Debian cron and cronie share code that treats a wake like a forward clock jump. After a gap of up to 5 minutes, every missed minute runs, 10 s apart. After a gap of up to 3 hours, each missed fixed-time job runs once, and the wildcard jobs once. After a longer gap, "jump virtual time" drops everything missed. BusyBox runs each job missed in a gap of up to an hour once. Past an hour it logs "time disparity of %ld minutes detected" and runs nothing. Apple's archive page says cron jobs "do not execute" while the Mac sleeps. Its cron-52 source runs each missed minute when at most 600 s late, and otherwise resyncs and drops them. Only the clock-jump code path was reproduced, through the faked DST jump, so the suspend case is **[M]** (clocks across sleep: R26.1).
  - **While off,** every cron loses its fires. anacron catches up only system jobs whose period is a number of days, and it "records the date (excludes the hour)". Fedora's `cronie-anacron` runs it hourly from `/etc/cron.hourly/0anacron`, with `START_HOURS_RANGE=3-22` and `RANDOM_DELAY=45`. Debian's and Ubuntu's desktop metapackages add anacron. It doesn't cover user crontabs.
- **Overlap.** A `sleep 100` job set to run every minute had two instances alive at once under Debian cron and cronie, which start a new one at every fire. BusyBox skipped the line while its last instance was still running, logged "process already running", and dropped the fire. That is C6's `overlap: skip`, per line.
- **`crontab`.** `crontab -` or `crontab <file>` replaces the whole table. The `crontab` of cronie, Debian and Apple writes a temp file and renames it into the spool with `rename()`. None of them takes a lock, so two concurrent `crontab -l | … | crontab -` cycles would lose an update **[M]**, inferred from the source. On Debian, cronie and macOS 27.2, `crontab -l` without a table prints `no crontab for <user>` and exits 1. BusyBox's exits 1 too, with "can't open".
  - Tools mark their own block with comments. whenever v1.1.4 (2026-10-21) puts its jobs between `# Begin Whenever generated tasks for: <identifier>` and a matching `# End` line, and treats a failing `crontab -l` as an empty table. Ansible's cron module puts `#Ansible: <name>` above each job (`Bun.cron`'s marker: R25.1).
  - BusyBox's `crontab` isn't setuid on Alpine. A non-root user gets "crontab: must be suid to work properly" unless `busybox-suid` is installed. Root can install a table with `crontab -u <user> <file>`. `cron.allow` and `cron.deny` only control the command. Debian and Ubuntu ship neither, so anyone may use it. cronie admits only root when both are missing, so Fedora ships an empty `cron.deny`.
- **Cron in a container.** Nothing starts the daemon. It has to run in the foreground as PID 1 or under a supervisor (`cron -f`, `crond -n`, `crond -f`), as root. Under Debian cron and cronie, jobs get none of the container's environment beyond `/etc/environment`, and output never reaches `docker logs`. Debian throws the output away, or mails it into the container's `/var/mail`. cronie's `crond -n` writes nothing to its own stdout or stderr, and sends output to a syslog the container doesn't have. BusyBox crond passes the environment through, prints output to `docker logs` and won't overlap a line. So 4.8's "Cron inside containers is awkward" (R9) holds for Debian cron and cronie, and for BusyBox only in needing PID 1 or a supervisor (container cron runners: R25.4).
- **Lock tools.** On Linux, every image probed has `flock(1)`, from util-linux or BusyBox. macOS 27.2 has no `flock(1)`. Its `lockf(1)` uses "BSD-style locking ... as described in flock(2)". With `-t 0` it "will fail unless it can acquire the lock immediately" and exits with `EX_TEMPFAIL` (75). `shlock(1)` "is deprecated". A lock that the started process takes itself would work under every scheduler alike **[M]**. R17.2's `BEGIN EXCLUSIVE` on a lock database, or its lease row, are examples.
- **systemd's calendar.** `OnCalendar=` has `..` ranges, `/` steps, lists, `~` for counting days back from the end of a month (`*-*~01 09:00` gave 2026-11-30), seconds and an IANA zone suffix (`*-*-* 09:00 Asia/Tokyo`). A weekday and a date in one expression must both match. `Mon *-*-01 09:00` elapses only on Mondays that fall on the 1st (2027-02-01, 2027-03-01, 2027-11-01). cron fires when either day field matches, if both are restricted: cronie's crontab(5) runs `30 4 1,15 * 5` "on the 1st and 15th of each month, plus every Friday". So `0 9 1 * 1` needs two `OnCalendar=` lines. In Europe/Berlin, `*-*-* 02:30` skips 2027-03-28. On 2026-10-25 it fires once, at the first 02:30.
- **systemd's missed fires.** A calendar timer that elapses during sleep fires at resume, even without `Persistent=`. Several elapses in one sleep "will only result in a single service activation". `Persistent=true`, off by default, stores the last trigger time on disk. A timer that "would have been triggered at least once during the time when the timer was inactive" then fires once when it next starts, after a power-off too. `systemctl clean --what=state` removes the stored time. `WakeSystem=` is "generally only available in the system service manager".
- **Accuracy and overlap.** `AccuracySec=` defaults to 1 min, so a timer fires up to a minute late, at a host-specific point. `RandomizedDelaySec=` defaults to 0. A service still running when its timer elapses "is not restarted, but simply left running. There is no concept of spawning new service instances". The timer then triggers "immediately ... once the service finishes running", as D16's coalescing `queue` would. `DeferReactivation=yes` stops that re-run. It came in v257: Debian 13 (257.13), CentOS Stream 10 (257) and Ubuntu 26.04 (259.9) have it.
- **Linger.** User timers run only while the user's manager runs: from first login until 10 s after the last session ends (`UserStopDelaySec=10`). With linger, "a user manager is spawned for the user at boot and kept around after logouts". systemd's polkit policy lets users turn on linger for themselves (`set-self-linger`: `allow_any`, `allow_inactive` and `allow_active` are all yes), but only while polkitd runs. Without polkitd, logind refuses `loginctl enable-linger` from an unprivileged user ("Polkit found to be unavailable", `-EACCES`). `polkitd` is Priority optional on Debian 13 (126-2) and Ubuntu 26.04 (127-2ubuntu1), and Debian's standard task with `openssh-server` doesn't install it. On such hosts, linger needs root. Fedora 45's and CentOS Stream 10's `server-product` groups include polkit. No user manager runs in the images (no `systemctl`), on Alpine, which uses OpenRC **[K]**, or in WSL without systemd.
- **systemd's processes and output.** A user service starts in `$HOME` unless `WorkingDirectory=` is set. The system manager's `PATH` is a fixed `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin`, and "In case of the user manager, a different path may be configured by the distribution". Output goes to the journal by default. `systemd-run --user --on-calendar=` makes a transient timer and service under `$XDG_RUNTIME_DIR/systemd/transient`. Both are gone after a reboot.
  - Under the default `KillMode=control-group`, "all remaining processes in the control group of this unit will be killed on unit stop", including children that called `setsid`. A `oneshot` service stops when its main process exits. Runs that the service started survive only as their own units (`systemd-run --user`), or under `KillMode=process`, which systemd marks "not recommended!". Otherwise the service has to wait for them, which delays the next elapse.
- **`launchctl`.** The current subcommands are `bootstrap`, `bootout`, `kickstart` (`-k` kills a running instance first), `print` and `enable`/`disable`. `print`'s output "is NOT API in any sense at all", and `enable` and `disable` persist across boots. The legacy `load` and `unload` "will only return a non-zero exit code due to improper usage". An agent's plist must be owned by the user loading it, and must "disallow group and world writes". Agents in `gui/<uid>` are "loaded only when a user has logged in at the GUI", and they end at logout **[K]**.
- **launchd's schedule.** `StartCalendarInterval` takes a dictionary of integers, or an array of them: `Minute`, `Hour`, `Day`, `Weekday` ("0 and 7 are Sunday") and `Month`. A missing key is a wildcard. With both `Day` and `Weekday` set, the job starts "if either one matches", as in cron. There are no ranges, steps or lists, so `*/5 9-17 * * 1-5` becomes 12 × 9 × 5 = 540 dictionaries (`Bun.cron` expands them the same way: R25.1). `StartInterval`, in seconds, misses a fire that falls during sleep, "due to shortcomings in kqueue(3)", and one that falls during a run.
- **Sleep and power-off.** For a calendar job, "launchd will start the job the next time the computer wakes up. If multiple intervals transpire before the computer is woken, those events will be coalesced into one event". A fire missed while the Mac is off is lost: "the job does not execute until the next designated time occurs". launchd-842 stores nothing on disk, and computes the next fire from `time(NULL)` when a job loads.
  - **DarkWake [M].** "launchd doesn't guarantee anything about the power state of the system when it starts your job based on StartCalendarInterval" (Apple DTS, forums thread 815034, February 2026). The thread's original poster, not Apple, reports the following on macOS 12, 15 and 26. With the lid open in sleep, "launchd runs your job, it may still get suspended until a full wake". With the lid closed, "your job does not run in any way until the lid is opened".
- **One instance.** "Launchd does not run multiple instances of the same job", an Apple engineer wrote on launchd-dev in 2007 **[M]**. In launchd-842, a calendar or interval fire during a run sets `start_pending`, and the job starts once more when the running instance exits, as D16's `queue` would. Today's man page says interval fires during a run are "missed". What closed-source launchd now does with a calendar fire during a run is unverified **[L]**.
- **What a launchd job starts with.** Its default `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`. At spawn, launchd adds `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `XPC_SERVICE_NAME` (the label), `XPC_FLAGS` and `OSLogRateLimit=64`, plus `SSH_AUTH_SOCK` in the GUI domain. There is no `LANG`. `EnvironmentVariables` in the plist adds string values. `launchctl config user path` sets `PATH` for every service in a domain, after a reboot. Without `WorkingDirectory`, a job runs in `/`. Without `StandardOutPath` and `StandardErrorPath`, its output goes to `/dev/null`.
- **Process group, limits and throttling.** "When a job dies, launchd kills any remaining processes with the same process group ID as the job". launchd-842 sends them SIGTERM. Setting `AbandonProcessGroup` to true turns this off. A child in its own process group is spared: one started with `setsid`, or with `detached: true` from `Bun.spawn` (R8) or Node **[K]**.
  - Without `ProcessType`, "the system will apply light resource limits to the job, throttling its CPU usage and I/O bandwidth". By default, jobs "will not be spawned more than once every 10 seconds" (`ThrottleInterval`). `KeepAlive` "implicitly implies RunAtLoad".
  - `UserName` "is only applicable for services that are loaded into the privileged system domain". So a LaunchDaemon, which needs admin rights to install, is the one documented way to start anything at boot on a Mac where nobody logs in. That includes a resident scheduler. Apple's cron is such a daemon, already installed (below).
- **launchd and DST [L].** Neither man page mentions DST. launchd-842 computed each fire in local time with `mktime()` and `tm_isdst = -1`, then armed it as an absolute time. With macOS 27.2's libc, that logic runs a 02:30 job at 03:30 CEST on 2027-03-28. On 2026-10-25 it runs the job once, at the first 02:30. A time-zone change takes effect only after the next fire. Whether today's launchd does the same is unverified.
- **Background Task Management (BTM).** Apple's guide lists `~/Library/LaunchAgents` among the locations it covers, and says "Every app that supports a LoginItem, LaunchAgent, or LaunchDaemon has a corresponding switch" in System Settings > General > Login Items & Extensions. The section is called "App Background Activity" on macOS 26 and 27, and "Allow in the Background" on 13–15. The list shows what is "allowed to run", not what is running (Apple DTS, thread 717609). `sfltool dumpbtm` prints BTM's state.
  - A plist without `AssociatedBundleIdentifiers` is listed under "the organization name in the app's signing certificate". If the executable isn't signed, it is listed under "the executable name from the Program or ProgramArguments key". Bun 1.4.4's macOS binary has a Developer ID signature (team `7FRXF46ZSN`). A plist that runs `bun` would therefore likely be listed under that certificate's name, not as `bun` **[M]**. It is untested whether an ad-hoc-signed `node` counts as unsigned, and whether plists that run the same executable share one switch **[L]**.
  - Only third parties describe two points: whether bootstrapping a plist posts "Background Items Added", and whether switching an item off stops a running agent. They say BTM puts a switched-off item on launchd's disabled list **[M]**.
- **Apple's cron, behind BTM.** Since macOS 15 (cron-50, 2024-09-24), Apple's cron asks BTM before each job (`btm_get_enablement_status_for_subsystem_and_uid(btm_subsystem_cron, …)`). It runs the job only if cron is enabled, and runs nothing if the call fails. cron-45.120.1 (2024-05-29) has no such call. The switch is called "Legacy Background Tasks". An Apple engineer wrote that "This toggle is meant to control whether cron jobs will be able to run" (thread 756671, June 2024). On macOS 27.2, the `cronBTMCheck` feature flag is marked `FeatureComplete`. The switch's default state is undocumented. One user saw it appear switched on when an app installed a LaunchDaemon on macOS 15 **[M]**.
  - macOS 27.2 still ships `/usr/sbin/cron` and a setuid `/usr/bin/crontab`, but Apple's archive page says cron "has been deprecated in favor of launchd". launchd starts cron only when `/etc/crontab` exists or `/usr/lib/cron/tabs` holds a table. Jobs get `SHELL=/bin/sh` and `PATH=/usr/bin:/bin`, and start in `$HOME`. The launchd plist doesn't pass `-s`, so cron's "special handling" of a change in the time zone's GMT offset is off. Output goes to the local mailbox **[M]**.
- **TCC.** launchd.plist(5) says launchd's jobs "are subject to macOS user privacy protections. Specifying privacy sensitive files and folders in a launchd plist may not have the desired effect, and may prevent the job from running." A bare executable that launchd starts, such as `bun`, `node` or `/usr/sbin/cron`, gets no permission prompt, and its access to `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive fails with "Operation not permitted" **[M]**. This rests on a 2023 blog post about Sonoma and on anecdotes.
  - Full Disk Access "has only ever been 'fully' supported for bundled executables" (Apple DTS, thread 806187, November 2025). That thread is about `sshd-keygen-wrapper`. Its bug, where granted bare executables don't show in the list (FB20662270), is shown for 26.1 and the 26.2 release candidate. A user reported it resolved in 26.3 beta 1, and DTS replied "That gels with my expectations", but the report may have meant a similar Accessibility issue. No source found says anything about macOS 27.

| | Debian, Ubuntu cron | cronie | BusyBox crond | Apple's cron | systemd user timer | launchd agent |
|---|---|---|---|---|---|---|
| **By default** | Debian, Ubuntu; in no image | Fedora Server, CentOS Stream 10; in no image | Alpine, where `setup-alpine` enables it; the Alpine images, not started | every Mac, behind a BTM switch since 15 | systemd hosts, from login or with linger; in no image | every Mac, from GUI login |
| **Schedule** | 5 fields, either day field; no zones | 5 fields, either day field; `CRON_TZ=` | 5 fields; no zones | 5 fields; `@AppleNotOnBattery` | `OnCalendar=`, seconds, a zone; weekday and date must both match | integer dictionaries, either day key; no ranges, steps or lists |
| **Environment; directory** | `PATH=/usr/bin:/bin`, `/etc/environment`; `$HOME` | as Debian, plus `USER` and `sbin` in `PATH`; `$HOME` | crond's own; `$HOME` | `PATH=/usr/bin:/bin`; `$HOME` | the user manager's; `$HOME` | `PATH=/usr/bin:/bin:/usr/sbin:/sbin`; `/` |
| **Output** | mailed, or discarded without an MTA | mailed, or syslog without sendmail | crond's stdout and stderr | local mail **[M]** | journal | `/dev/null` unless set |
| **Missed in sleep** | ≤ 5 min: each minute; ≤ 3 h: once; longer: dropped **[M]** | as Debian **[M]** | ≤ 1 h: once; longer: dropped **[M]** | ≤ 10 min: each minute; longer: dropped **[M]** | once at resume | once at wake, perhaps in DarkWake **[M]** |
| **Missed while off** | lost | lost | lost | lost | once with `Persistent=true` | lost |
| **Overlap** | a new instance | a new instance | fire dropped | a new instance **[M]** | never; one re-run after, unless `DeferReactivation=yes` | never **[M]**; launchd-842 re-ran once after |
| **DST, Europe/Berlin** | gap job at the jump; repeated hour once | as Debian | gap job never; repeated hour twice | special handling off | gap time skipped; repeated time once | undocumented; by old source, gap job an hour late **[L]** |
| **Processes left when it ends** | left alone **[M]** | left alone **[M]** | left alone **[M]** | left alone **[M]** | killed with the cgroup | the group gets SIGTERM |
| **Install** | `crontab -`, the whole table | as Debian | as root, or with `busybox-suid` | as Debian; BTM switch on | `.timer` and `.service` in `~/.config/systemd/user`, `daemon-reload`, `enable --now` | a plist, `launchctl bootstrap gui/<uid>` |

- **What a native entry has to supply [M].** This is a judgement on the evidence above, for D6's "cron/systemd invoking a CLI" (R25.5):
  - the runtime by absolute path (D19), a `cd` or `WorkingDirectory` into the repository so that `.env` loads, and somewhere for output to go. No scheduler loads a profile or `.env`, and none delivers output to anyone (Q1). On a Mac, the repository and the log files have to sit outside the folders TCC protects.
  - a lock under Debian cron, cronie and Apple's cron, which start a new instance at every fire. A lock that the process takes itself covers systemd and launchd as well.
  - its own record of when it last ran, because no native scheduler reports what it missed. systemd and launchd coalesce a sleep into one fire. The crons drop long gaps, and Debian's, cronie's and Apple's replay short ones minute by minute. launchd may start a job in DarkWake and suspend it. 4.8's `missed` rule already compares `next_run_at` with `last_tick_at`.
  - for runs that outlive the entry: their own process group, or `AbandonProcessGroup`, under launchd; their own unit, or `KillMode=process`, under systemd.
- **Open:** what current launchd does with a calendar fire during a run, and at DST; how BTM labels and groups plists that run `bun` or `node`, whether bootstrapping one posts "Background Items Added", and whether switching it off stops a running agent; the default state of "Legacy Background Tasks", and whether installing a crontab adds it or posts a notification; Full Disk Access and TCC prompts for bare executables on 26.3 and later, and on 27; how Debian cron and cronie behave after a real suspend; whether Ubuntu's WSL image has cron, and whether a running scheduler counts as activity there; whether anything pulls cronie into Fedora Workstation 45, or `polkitd` into Ubuntu Server; where Apple's cron mails output, and how it handles overlap.
- **Sources:** throwaway containers, 2026-11-08: `debian:latest` (13), `ubuntu:latest` (26.04.1), `fedora:latest` (45), `quay.io/centos/centos:stream10`, `alpine:latest` (3.24), `node:latest`, `node:slim`, `node:alpine`, `oven/bun:latest`, `oven/bun:slim` and `oven/bun:alpine`; `apt-cache show`, `apt-cache policy`, `apt-get install -s`, `tasksel --task-packages standard`, `dnf group info`, `dnf environment info` and `dnf repoquery`; libfaketime 0.9.10, 0.9.12 and 0.9.13 on tzdata 2026f; `systemd-analyze calendar` from systemd 257.13-1~deb13u1; sources.debian.org/data/main/c/cron/3.0pl1-197/ (`cron.c`, `crontab.c`, `crontab.1`, `crontab.5`), and cron(8) and `/etc/pam.d/cron` from the package; `/etc/pam.d/cron` from Ubuntu's cron 3.0pl1-200ubuntu1; github.com/cronie-crond/cronie at master cb49729 (2026-11-05; release 1.7.2): `src/{cron,crontab,do_command,entry,misc}.c`, `src/pathnames.h`, `man/{cron.8,crontab.1,crontab.5,anacron.8}`; git.busybox.net/busybox at master d03670c (2026-11-08): `miscutils/crond.c`; gitlab.alpinelinux.org/alpine/alpine-conf `setup-alpine.in`; wiki.archlinux.org/title/Cron; learn.microsoft.com/en-us/windows/wsl/systemd (updated 2026-06-02) and /wsl-config (updated 2026-10-16); github.com/systemd/systemd at v262.2: `man/{systemd.time,systemd.timer,systemd-run,systemd.unit,systemd.exec,systemd.kill,systemd.service,loginctl}.xml`, `src/login/{org.freedesktop.login1.policy,logind.conf.in,logind-dbus.c}`, `src/shared/bus-polkit.c`; macOS 27.2: launchctl(1), launchd.plist(5), crontab(1), crontab(5), cron(8), lockf(1), shlock(1); `/System/Library/LaunchDaemons/com.vix.cron.plist`; `/System/Library/FeatureFlags/Domain/cronBTMToggle.plist`; github.com/apple-oss-distributions/cron tags cron-45.120.1, cron-50 and cron-52: `cron/{cron.c,job.c,do_command.c,cron.h,pathnames.h}`, `crontab/crontab.c`; github.com/apple-oss-distributions/launchd launchd-842.92.1 `src/core.c`; developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html (updated 2016-09-13); developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos; developer.apple.com/forums/thread/717609, /756671, /806187 (FB20662270) and /815034; support.apple.com/guide/mac-help/mtusr003/mac; support.apple.com/guide/deployment/depdca572563/web; lists.macosforge.org/pipermail/launchd-dev/2007-December/000105.html, through web.archive.org; github.com/javan/whenever v1.1.4 `lib/whenever/command_line.rb`; github.com/ansible/ansible devel `lib/ansible/modules/cron.py`; community: oliviagallucci.github.io/og-apple-security (a Background Task Management write-up), nunn-blog.pages.dev/2023/11/28/tcc-launchd-woes, and an HN post (item 47847257); read-only inspection of a macOS 27.2 Mac: `launchctl print`, `ps -E` (variable names only), `lsof -d cwd`, `crontab -l`, `codesign -dv` on Bun 1.4.4's binary, and `mktime` through Python.

**R25.3 In-process cron libraries, and what a scheduler process costs.** Read, run and measured on 2026-11-08: croner 11.0.0's source, docs and release notes, compared with 10.0.1 and the dev build 11.0.1-dev.2; `Bun.cron.parse` in Bun 1.4.4; nine npm alternatives; and two throwaway minute-walking matchers. The probes ran on Bun 1.4.4 and Node 26.13.0, both on an Apple-silicon Mac under other load and in the official Debian 13 images on Linux arm64 under Docker Desktop. An independent check re-ran them, and where both runs timed the same thing, the figure is a range. **[H]** unless marked.
- **croner 11.0.0 (2026-10-26) is npm's `latest`.** `dev` has 11.0.1-dev.2 (2026-11-04), whose publication set the registry's `modified` date. No 11.0.1 was out on 2026-11-08. R8 and R10 record 10.0.1 (2026-02-01). 11.0.0 is 186,776 B unpacked in 8 files and 200 KB installed. Its ESM bundle is 31,117 B (9,478 B gzipped), it has no dependencies or install scripts, its licence is MIT, and `engines` says node >=18.0. CI runs Node 18, 20, 22, 24 and 26, Deno 2.x and the latest Bun, and runs Node and Deno again under `TZ: America/New_York`. In the week from 2026-11-01 it had 14.77 M downloads. It has 2,615 stars, 7 open issues and PRs, and a last push on 2026-11-08, and it publishes through npm's trusted publishing (OIDC) with provenance.
- **What 11.0.0 changed.**
  - **Breaking:** the DST rules below, which leave §4.3.1 of the Open Cron Pattern Specification (OCPS) 1.4 to follow croner-rust (the release says "aligned with croner-rust and Vixie cron"). `startAt` is inclusive, except with `interval`. With `dayOffset`, `nextRun()` and its relatives return actual run times. `previousRun()` gives when the last run started, where 10.x gave when it finished.
  - **Fixed:** a forward clock step could skip a run silently (#388, #393); after a backward step the timer and the target disagreed (#417); timers were re-armed with negative delays through the fall-back hour (#399); "`0 0 ? * MON` ran every day instead of every Monday" (#392); patterns that can never match "now return `null` and an empty list" instead of throwing.
- **Construction.** `new Cron(pattern, fnOrOptions?, optionsOrFn?)` takes a pattern or a `Date`, with the options and the callback in either order. Given a callback, it schedules at once. Without one, it only calculates and arms no timer. The options, with their defaults:
  - `name`, which must be unique, lists the job in the exported `scheduledJobs`. `paused`, `kill` and `unref` are false. `catch` and `protect` are each false, `true` or a function.
  - `maxRuns` is Infinity, and `interval` is 0, the minimum seconds between runs. `startAt` is inclusive and `stopAt` exclusive.
  - `timezone` takes an IANA zone, and `utcOffset` takes minutes (±870); a job can't have both.
  - `domAndDow` is false, which means OR. A `+` on the day of week asks for AND in one pattern, and `legacyMode` is the deprecated opposite of `domAndDow`.
  - `dayOffset` is 0, `mode` is `auto` or a part count such as `5-part` or `6-or-7-parts`, and there is `context`. `alternativeWeekdays` is false (Quartz numbering, 1 = Sunday), `sloppyRanges` false, and `allowPast` false; `allowPast` is new in 11 (#349).
  - **A bad zone fails late.** The constructor accepts `timezone: 'Mars/Base'`, and the first `nextRun()` throws "TypeError CronDate: Failed to convert date to timezone 'Mars/Base'". `Bun.cron.parse` throws at once: "Bun.cron: unknown time zone 'Mars/Base'" (C6, Q11).
- **Methods.** `nextRun(prev?)` gives the first run strictly after `prev`, without milliseconds. There are `nextRuns(n, prev?)`, and `previousRuns(n, ref?)`, most recent first. `enumerate(start?)` is new in 11 (#365): it returns a `CronIterator` with `next`, `peek` and `reset`, and `start` itself is excluded. Then `match(date)` and `msToNext(prev?)`. `previousRun()` gives the last actual run's start and takes no date; `previousRuns(1, date)` does that. The rest are `stop`, `pause`, `resume`, `schedule(fn)`, `trigger`, `runsLeft` and getters for the job's state. The other signatures in `croner.d.ts` are 10.0.1's, and 11 adds type exports.
  - **`match()` ignores the DST rules.** For `30 2 * * *` in New York, `nextRun` from 06:59Z on 2026-03-08 gives 07:00Z (03:00 EDT), yet `match(07:00Z)` is false. For `30 1 * * *`, `match` is true at 01:30 EST on 2026-11-01, yet `nextRun` passes that time and gives 2026-11-02T06:30Z.
- **Syntax.**
  - A pattern has 5, 6 or 7 fields, with seconds first and the year (1–9999) last, and takes `* , - /`. `?` stands for `*` in every field.
  - The day of month takes `L`, `LW` and `nW`, the nearest weekday within the month. The day of week takes `nL`, `#1`–`#5` and `#L`.
  - Names are three letters, in any case. Both 0 and 7 mean Sunday, in ranges such as `5-7` too. The nicknames are `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight` and `@hourly`.
  - By default it is strict. These throw: `5/15` ("stepping with numeric prefix ('5/15') is not allowed"), `*/100`, full names (`Monday` gives "(1day) contains illegal characters"), descending ranges (`FRI-MON`) and `@reboot`.
  - `0 0 30 2 *` gives null, and `0 0 29 2 *` gives 2028-02-29. The docs claim compliance with OCPS 1.0–1.4, "with one documented deviation in the recommended DST handling".
- **DST rules.**
  - **A fixed-time job** has one value each in seconds, minutes and hours. In a fall-back overlap it runs once, at the first pass. In a spring-forward gap it runs "at the first valid time after the gap, on the same day".
  - **An interval job** has a list, range, step or wildcard in one of those fields. It runs "on both occurrences" of a repeated time, and it skips times that don't exist.
  - **Reproduced,** with the same output on Bun and Node:
    - New York `30 2 * * *` ran at 03:00 EDT on 2026-03-08, where 10.0.1 gave 03:30. London `30 1 * * *` ran at 02:00 BST on 2026-03-29.
    - New York `*/15 2 * * *` had no run that day, where 10.0.1 ran once at 03:00.
    - On 2026-11-01 in New York, an hourly job ran at 01:00 EDT, 01:00 EST and 02:00 EST, where 10.0.1 skipped 01:00 EST. `0 1,2 * * *` gave the same three runs, and `30 1 * * *` ran once, at 01:30 EDT.
    - Lord Howe's 30-minute shifts are handled.
  - **This changes 4.8,** which pins 10.0.1's behaviour with tests (R10). Fixed-time jobs still run once in a fall-back hour. But interval jobs now run both passes of the repeated hour. In a spring-forward gap, a fixed-time job now runs at the gap's end instead of an hour late, and an interval job skips its slots.
  - **It may change again.** PR #439, merged into `dev` on 2026-11-04, adds `fixedTimeRule: "no-wildcard"`: "Vixie cron treats a job as wild only when its minute or hour field starts with `*`, so the docs were wrong to say DST handling is 'the same as Vixie cron'".
- **Timers and clock jumps.** Each job has its own `setTimeout`, capped at 30 s ("we'll never wait more than 30 seconds between each trigger"). Each time it wakes, croner compares `new Date()` with its target, then either runs the job or arms the timer again. A negative delay becomes 0, or 1 s while paused. A resident daily job armed 2 timers in 33 s. In probes with a `Date` that moved only the wall clock, both runtimes behaved alike:
  - **A forward jump** runs a passed slot once, late, when the armed timer expires. A daily 03:00 job jumped from 02:59:45 to 04:59:45 fired at 05:00:00, then gave the next day's 03:00. Armed 2 minutes before its slot, it fired when the timer next expired, 30.0 s after arming. An every-10-s job jumped 1 h, past 360 slots, ran once, then kept its cadence.
  - **A backward step replays.** After a 30 s step back, the slots at 14:02:50 and 14:03:00 ran a second time.
  - **Across a real sleep,** on macOS Node's libuv reads `mach_continuous_time()`, which keeps counting through sleep, as macOS's `CLOCK_MONOTONIC` does: it "will continue to increment while the system is asleep". On Linux libuv reads `CLOCK_MONOTONIC`, which stops during suspend. `CLOCK_BOOTTIME` doesn't: it "also includes any time that the system is suspended". Either way, the 30 s cap should bound the lateness after a wake **[M]**. No real sleep was tested, and R26.1 covers when the wait returns after one.
- **Errors and overlap.** The scheduler doesn't await the callback. Without `catch`, a callback that throws becomes an unhandled rejection, and the process exits with code 1 on both runtimes. With `catch: fn`, the function gets each error and the job keeps running. `catch: true` swallows errors without a trace. `protect` drops a fire that comes while the last run is busy, calls `protect` if it is a function, and queues nothing. That is 4.8's `skip`, not D16's `queue`. With neither option, runs overlap: an every-second job started runs 2 and 3 before run 1 had ended.
- **A window check: `nextRun(A) <= B`.** Only a run sets the state that `nextRun` reads. So for a job built without a callback, `nextRun(A)` depends only on the pattern, the options and `A`. Whether a fire fell in (A, B] is then `next = nextRun(A); next !== null && next <= B`, across DST too.
  - Two independent minute-walking matchers each agreed with it in 2,000 of 2,000 random windows of 1–181 minutes around the 2026 transitions, on both runtimes. The windows were in New York and Budapest, and the second matcher added Lord Howe. The second also agreed in 72 of 72 three-day lists of fires.
  - `startAt`, `stopAt`, `maxRuns`, `dayOffset` and `interval` change the answer, and the February bug can hide a fire.
  - Per call, `nextRun` took 9–160 µs, whether or not the `Cron` was built in the same call. A never-matching `0 0 31 2 *` took 0.4–2.6 ms, and `Bun.cron.parse` 1–2 µs. Load moved these figures by 2–3×. All are negligible next to a process start.
- **The February bug,** in 11.0.0 and 10.0.1. It hits patterns that restrict both day fields, so that OR applies. The forward search walks days up to 31 without checking the month's length (PR #437: "`_findMatch` walks the day pattern up to index 31 without checking the month length"). So 29–31 February, days that don't exist, become 1–3 March. One of them can match the weekday before the search reaches the real date.
  - `0 0 1 * 2` means the 1st or a Tuesday. After 2026-02-27 it gives 03-03, 03-10 and 03-17, which skips Sunday 03-01. 11.0.1-dev.2 and `Bun.cron.parse` give 03-01 first. `match()` is true for 03-01, yet the scheduler and `nextRun` both miss it.
  - A scan of 70 such patterns, started from every day of 2026–2028, made 76,860 calls. 94 differed from the dev build, and in each one a fire on 1 or 2 March was skipped, coming from late February. In a 30-day month the 31st that doesn't exist is the real 1st, so nothing is skipped.
  - The fix, PR #437, was merged into `dev` on 2026-11-04 and is in 11.0.1-dev.2. No stable release has it.
- **`Bun.cron.parse` against croner 11.**
  - **Syntax (R25.1).** Bun takes exactly 5 fields or a nickname. It reads `5/15` as 5 to the maximum (:05, :20, :35, :50), accepts steps up to 127 (`*/100` is minute 0) and full names, and returns null when nothing matches within 8 years. It rejects `?`, `L`, `W`, `#`, `+`, seconds, years, descending ranges and `@reboot`. croner rejects `5/15`, `*/100` and full names. So what both accept is 5 fields of `* , - /` with ascending ranges, steps on `*` or a range that fit the field, three-letter names, and the nicknames except `@reboot`.
  - **Both read the day fields alike.** They apply OR only when neither day field is the literal `*`. Bun tests `fields[2] == b"*"`, and croner tests after turning `?` into `*`. cronie 1.7.2, like Vixie cron, looks only at a field's first character (`if (ch == '*') e->flags |= DOM_STAR;`) and applies AND when either day field starts with `*`. So `0 0 */2 * 1` fires on every odd date and every Monday under croner and Bun, but only on Mondays with an odd date under cronie (R25.2). `0 0 */2 * 1`, `0 0 1 * MON` and `0 0 1-7 * 1` gave the same fires under croner and Bun.
  - **DST: 8 of 15 cases at the 2026 transitions differ.**
    - In a spring-forward gap, Bun fires a time "shifted forward by the gap", where croner moves it to the gap's end. For a multi-minute pattern in the gap, "only the first match fires" in Bun, and croner fires none.
    - In a fall-back, Bun repeats a pattern only when its whole minute or hour field is `*` (`if self.minutes == ALL_MINUTES || self.hours == ALL_HOURS`). croner repeats any list, range or step.
    - In the gap, croner against Bun: New York `30 2 * * *` 03:00 against 03:30; London `30 1 * * *` 02:00 against 02:30; Budapest `30 2 * * *` 03:00 against 03:30; Lord Howe `15 2 * * *` 02:30 against 02:45; New York `*/15 2 * * *` no run against 03:00. In New York's and Budapest's gaps, Bun gives what croner 10.0.1 gave (above, and R10).
    - In the overlap, croner adds a run at 01:00 EST to New York's `0 1,2 * * *`. It runs `*/15 1 * * *` 8 times where Bun runs it 4 times in New York, and 6 times against 4 in Lord Howe.
    - The same on both: hourly, `*/20`, `*/30`, `30 1 * * *` in an overlap, and `0 2 * * *` in New York's gap (03:00).
  - **So the runtimes would disagree** if Bun used `Bun.cron.parse` and Node used croner. One expression would fire at different times at DST transitions, and on 1 or 2 March while croner's bug stands (D12, D19).
- **Clock jumps, compared.** After a backward step, croner's scheduler runs slots again. `Bun.cron` arms one monotonic timer with no cap and doesn't read the wall clock again. After a jump it fires once, off by the size of the jump, and after a backward step it stays silent until the wall clock passes its old target (R25.1). A check of (`lastTick`, now] with a saved `lastTick` merges a forward jump's missed fires into one run, and runs nothing twice after a backward step. But suppose `lastTick` was saved while the clock ran ahead, as when NTP steps back a wrong clock at boot. Then every task stays silent until the wall clock catches up **[M]**.
- **The alternatives** on 2026-11-08, with `Bun.cron` and a matcher of our own for comparison:

| Library | Version (date) | Downloads, week of 2026-11-01 | Installed, packages | Bun in CI | Zones | Overlap | After a sleep or clock jump |
|---|---|---|---|---|---|---|---|
| croner | 11.0.0 (2026-10-26) | 14.8 M | 200 KB, 1 | yes, beside Node and Deno | `timezone`, `utcOffset` | `protect` drops the fire | runs once within 30 s of a jump, missed fires merged; a backward step runs slots again |
| `Bun.cron`, in-process | Bun 1.4.4 (2026-10-22) | — | built in | Bun only | `{ tz }`, since 1.4.0 | waits for the handler to settle | one monotonic timer, no cap: fires once, off by the jump |
| node-cron | 4.6.0 (2026-07-05) | 6.6 M | 360 KB, 1 | no; node >=20 | `timezone` | `noOverlap` skips | over 1 s late: logged as `execution:missed`, not run |
| cron (kelektiv) | 4.4.0 (2025-12-09) | 9.5 M | 4,952 KB, 3 (luxon 3.7.2) | no | `timeZone` (luxon), `utcOffset` | `waitForCompletion` skips | one timer of up to 2^31−1 ms: fires once, when it expires |
| node-schedule | 2.1.2 (2026-10-24) | 4.8 M | 4,760 KB, 5 (cron-parser 4.9.0, luxon) | no | `rule.tz` | none | not checked |
| toad-scheduler | 4.2.0 (2026-09-05) | 169 k | 364 KB, 2 (croner 10.0.1) | no | through croner 10 | `preventOverrun` | as croner 10 |
| bree | 9.2.9 (2026-02-17) | 49 k | 1,992 KB, 27 | no | `timezone` (later.js) | a worker thread per job | not checked |
| cron-parser, a parser only | 5.10.4 (2026-11-06) | 32.5 M | 4,812 KB, 2 (luxon) | no | `tz` | — | — |
| cron-schedule | 6.0.0 (2025-11-24) | 3.0 M | 136 KB, 1 | no | none: the process zone | — | its interval scheduler runs a missed task once, on the next tick |
| cronosjs | 1.7.1 (2021-04-01) | 104 k | 332 KB, 1 | not checked | yes | — | not checked |
| cronbake | 0.4.0 (2025-12-08) | 2.7 k | 144 KB, 1 | Bun only | not checked | `overrunProtection` | not checked |
| A matcher of our own | — | — | 0 | both runtimes | `Intl` | the tick decides | the window (`lastTick`, now] decides |

- **croner alone tests on both runtimes.** The workflow files of croner and of every alternative but cronosjs were searched for the word `bun` or `setup-bun`.
  - croner has a `bun_ci` job. cronbake has a "Test Bun" job that runs `bun test`, and no Node job. node-cron, cron, node-schedule, bree, toad-scheduler, cron-parser and cron-schedule mention neither.
  - So of the libraries checked, only croner has no dependencies, takes IANA zones, and tests on both runtimes (D19).
  - cron, node-schedule and cron-parser bring in luxon (4,568 KB), so each installs at 4.8–5.0 MB, about 25 times croner. cron 5.0.0-beta.2 (2026-08-28, on the `beta` tag) still depends on luxon ~3.7.0.
  - toad-scheduler 4.2.0 depends on `croner: ^10.0.1`, so it keeps 10's DST rules.
- **node-cron and cron handle a late fire in opposite ways.**
  - node-cron 4.6.0 caps its timer at 24 h. A beat later than `missedExecutionTolerance` (1,000 ms by default) logs the slot as `execution:missed` and doesn't run it, so a fire due during a sleep is skipped. Its README: "Across a daylight-saving fall-back the repeated hour runs once, so a sub-hourly schedule (for example `*/15`) can pause for up to the length of the DST shift". Given a file path in place of a function, it runs the job through `child_process.fork`.
  - cron 4.4.0 arms one `setTimeout` of up to 2,147,483,647 ms, about 24.8 days, so after a sleep it fires once when that expires, as `Bun.cron` does. Its 250 ms `threshold` only decides whether to run or skip a deadline already missed when the job starts.
- **The rest.** bree runs each job in a worker thread. cron-schedule has no zone option and builds `Date`s in the process zone. cronbake is Bun-first, with 66 stars. node-schedule has 173 open issues and PRs, and bree had no push after 2026-02-17. cronosjs's last release is from 2021, though its repository was pushed on 2025-11-19. croner, node-cron, cron, toad-scheduler, cron-parser and cron-schedule were all pushed between 2026-11-01 and 2026-11-08. The job queues (pg-boss, graphile-worker, agenda, sidequest, liteque, bunqueue) need a database server or are whole queue frameworks.
- **A matcher of our own is small.** A prototype has 87 lines that aren't blank or comments (5.3 KB), and a second, written separately to check it, has 75 (3.4 KB). In the project's style, with blank lines around blocks and no ternary returns, it would run to about 150–200 lines, plus a test suite **[M]**.
  - **What each covers:** 5 fields with `*`, lists, ranges and steps (`N/step` included); names; 7 as Sunday; nicknames; the literal-`*` OR rule; wall-clock matching in an IANA zone through `Intl.DateTimeFormat`; croner 11's DST rules; and a walk over the real minutes of (A, B]. That walk never builds a day that doesn't exist, so neither has the February bug.
  - **How they did.** The prototype agreed with croner 11.0.0 in 150 of 150 three-day windows (4 zones including Lord Howe, 15 patterns, the 2026 transitions) on both runtimes, and with `Bun.cron.parse` in 128 of 150. The second agreed with croner in 2,000 of 2,000 windows and 72 of 72 three-day lists. A 1-minute window took 3–14 µs, and an 8-hour catch-up window 0.6–3.0 ms.
  - **Traps,** each of which has caught an existing implementation:
    - the OR test: a literal `*` (croner, Bun), or a leading `*` (Vixie, cronie);
    - days past a month's end that don't exist (croner);
    - the DST policy: which jobs count as fixed-time, the gap's end or a shift by the gap, one pass or both, 30-minute shifts, and a gap that crosses midnight (croner requires the same day);
    - syntax edges: full names, `N/step`, steps larger than the field, descending ranges, `?`, `L`, `W` and `#`;
    - patterns that never match, which need a limit on the search (Bun stops at 8 years);
    - ICU's start-up cost, below.
  - **Zone data comes from each runtime's ICU.**
    - On macOS, Bun 1.4.4 uses the system's `libicucore` (78.1), so its zone rules arrive with OS updates. The host's Node, the build that links shared libraries (below), uses ICU 79.1 with tz 2026e.
    - In the official images, both runtimes report ICU 78.3, and Node reports tz 2026e.
    - Both runtimes on the host, and Node in its image, knew America/Coyhaique, a zone added in tzdata 2025b.
    - So on one host, a change in zone rules can reach the two runtimes at different times (Q11).
- **What a process costs.** The figures are medians of 10 starts.
  - On the host, after 2 warm-ups. An earlier run under heavier load gave about twice these medians.
  - In `oven/bun:latest` (1.4.4) and `node:slim` (26.13.0), with the files copied in. Min and max stayed within about 10% of the median.
  - On the host, `node --version` takes 75–76 ms, against 3.5–3.6 ms for `bun --version`. The host's Node is a build that links far more shared libraries than the official binary, whose `ldd node` in `node:slim` lists 9 entries.
- **Node 26 strips TypeScript, and a `.ts` entry pays for that on every start.** `process.features.typescript` is `'strip'` (R14).
  - The same code took about 26–27 ms and 20–25 MB more as `.ts` than as `.js` or `.mjs`. In the image, an empty script took 36.8 ms against 10.5 ms. On the host, a file holding only JavaScript took 109.7 ms and 63.1 MB as `.ts`, against 82.8 ms and 38.2 MB as `.js`, and `--no-strip-types` brought the `.ts` file back to about 80 ms.
  - A plain `.js` or `.mjs` entry, or a prebuilt bundle, doesn't pay it. On Bun the extension made no difference (1.8 ms against 1.9).
  - The official Node binary starts plain JavaScript in about 10.5 ms.

| Median wall time | Bun, image | Node, image: `.mjs` / `.ts` | Bun, host | Node, host: `.mjs` / `.ts` |
|---|---|---|---|---|
| An empty script | 1.9 ms | 10.5 / 36.8–37.7 ms | 6.4–7.3 ms | 83.0 / 109.9–112.0 ms |
| croner and one `nextRun` | 9.1–9.5 ms | 19.3 / 46.6–49.0 ms | 10.2–11.7 ms | 93.4 / 121.9–124.8 ms |
| `bun:sqlite` or `node:sqlite` | 2.5–2.6 ms | 11.5 / 41.2 ms | 7.4–8.3 ms | 84.0 / 114.2 ms |
| better-sqlite3 | 6.5–6.9 ms | 14.5 / 42.8 ms | 10.4–12.3 ms | — / 118.3 ms |
| TypeORM over better-sqlite3, `:memory:` | 68.4–68.8 ms | 59.8 / 90.4 ms | 48.1–53.6 ms | 133.5 / 168.5 ms |
| The tick, below | 10.0–10.4 ms | 36.6 / 65.2–67.5 ms | 12.7–14.2 ms | 109.0 / 136.1–143.3 ms |
| The agent's imports, below | — | — | 113.4–123.6 ms | — / 287.2–306.7 ms |

- **ICU is most of croner's start-up.** These are image figures, with plain JavaScript on Node.
  - Importing croner cost 1.5–1.9 ms.
  - One `Intl.DateTimeFormat` with a `timeZone`, without croner, cost 3.9 ms on Bun and 7.3 ms on Node.
  - croner with a `timezone` took 9.5 ms on Bun and 19.3 ms on Node in all.
  - Without a zone, croner still took 7.8 ms on Bun, about 4 ms of it setting up ICU for local time.
  - Any matcher that handles zones pays the same.
- **Opening SQLite costs little. Loading TypeORM doesn't.** Compared with an empty script, `bun:sqlite` and `node:sqlite` added 1–4 ms, better-sqlite3 4–6 ms, and TypeORM over better-sqlite3 42–67 ms. In the image, TypeORM started sooner on Node, with plain JavaScript, than on Bun. Read through a bind mount instead of copied in, TypeORM's start roughly doubled: 125.5–146.8 ms on Bun, and 138.7 ms (`.mjs`) or 198.8 ms (`.ts`) on Node.
- **The tick** read the frontmatter of 10 task files (`Bun.YAML`, or `yaml` 2.9.1 on Node). It asked croner whether each task had fired since the last tick (`nextRun(lastTick) <= now`), then wrote a JSON state file.
  - On the host, on Bun, it used 12.4–13.7 ms of CPU and peaked at 23.4–24.2 MB. On Node it used 115 ms and 59 MB as `.mjs`, or 149–158 ms and 83 MB as `.ts`.
  - At 1,440 ticks a day, that is 18–20 s of CPU a day on Bun. On the host's Node it is 2.8 min (`.mjs`) or 3.6–3.8 min (`.ts`). CPU wasn't measured in the images.
  - **Inside the agent's entry point,** a tick would also load the agent's imports. These are the 17 modules `main.ts` imports (TypeORM, the SDKs, MCP), loaded without running them, since importing `main.ts` itself runs a task. On Bun they took 175–191 ms of CPU and 71–73 MB; on Node, with a `.ts` entry, 399–438 ms and 134–151 MB. That is 4.2–4.6 and 9.6–10.5 min of CPU a day.
- **A resident process's RSS.**
  - In the images (VmRSS 3–33 s after start), Bun took 13.7–13.8 MB idle, 24.3–25.9 MB with one croner job, and 17.8–18.1 MB with one `Bun.cron` job. With croner and TypeORM over better-sqlite3 held open, it took 51.8–53.9 MB.
  - Node took 42.4, 52.2 and 84.2 MB for idle, croner, and croner with TypeORM, with plain JavaScript. As `.ts` it took about 19–20 MB more: 61.9–66.5, 71.6–76.6 and 97.5–103.2 MB.
  - On the host (`ps` RSS), Bun held 8.7–11.2 MB idle, 17.3–19.1 with croner, 10.9–12.4 with `Bun.cron` and 29.5–41.8 with croner and TypeORM. Node, with `.ts` entries, held 40–59, 52–71 and 52–96 MB for idle, croner, and croner with TypeORM.
  - On the host, one `Intl.DateTimeFormat` with a `timeZone` added 2.4 MB to idle Bun and 9.9 MB to idle Node.
  - Idle CPU was negligible (R26.3 measures a whole daemon).
- **A resident scheduler still needs saved state** (D6). Neither croner's scheduler nor `Bun.cron` remembers fires missed while the process was down, as 4.8 says of `Bun.cron` timers. So catch-up needs a saved last tick and the window check above, as 4.8's `next_run_at` and `last_tick_at` provide.
  - launchd.plist(5) says: "By default on OS X Mavericks version 10.9 and later, timers created by launchd jobs are coalesced". So a resident scheduler that launchd starts may fire later than its timers ask, whether they are croner's or `Bun.cron`'s **[M]**. `LegacyTimers` opts out, but "may have no effect if the job's ProcessType is not set to Interactive". The delay wasn't measured.
  - A heartbeat's own fire missed during sleep runs once at wake under `StartCalendarInterval`, and is lost under `StartInterval` (R25.2).
- **Images.** These images have no `cron`, `crond` or `crontab`: `oven/bun:latest` and `:slim` (1.4.4), `node:slim` (26.13.0) and the full `node:latest`, all on Debian 13. The Alpine variants have BusyBox `crond` and `crontab` applets, which nothing starts (R9, R25.2).
  - better-sqlite3 13.0.3's npm package ships prebuilt binaries for glibc and musl Linux on arm64 and x64, for macOS and for Windows (R17.1). So an Alpine image has a musl build to load, and R17.6 found that it loads there on both runtimes (D26).
  - Installed with `--ignore-scripts`, better-sqlite3 opened `:memory:` in `node:slim` and `oven/bun:latest`.
- **Open:**
  - how late croner's 30 s check, a tick loop and `Bun.cron`'s timer with no cap fire after a real macOS sleep or Linux suspend (R26.1);
  - how much launchd's timer coalescing delays a resident scheduler;
  - when croner 11.0.1 will ship #437 and #439;
  - the official Node binary's CPU per tick;
  - how node-schedule, bree, cronosjs and cronbake behave after a sleep or a clock jump.
- **Sources:** github.com/Hexagon/croner: release 11.0.0, which cites #349, #365, #388, #392, #393, #399 and #417; `src/{croner,options,pattern,date,utils}.ts`, `docs/src/usage/pattern.md`, `docs/src/migration.md` and `.github/workflows/test.yml` at the 11.0.0 tag; PRs #437 and #439; registry.npmjs.org/croner (dist-tags, times); npm croner@10.0.1, @11.0.0 and @11.0.1-dev.2 `dist/croner.d.ts`; api.npmjs.org/downloads/point/2026-11-01:2026-11-07; github.com/oven-sh/bun at bun-v1.4.4: `src/runtime/api/cron_parser.rs`, `src/runtime/api/cron.rs`, `src/bun_core/util.rs`, `docs/runtime/cron.mdx`; PR #35122; github.com/cronie-crond/cronie at cronie-1.7.2: `src/entry.c`, `src/cron.c`; github.com/libuv/libuv `src/unix/darwin.c` at v1.52.1 and v1.53.0, `src/unix/linux.c` at v1.52.1; macOS clock_gettime(3) and launchd.plist(5); man7.org/linux/man-pages/man2/clock_gettime.2.html; npm node-cron@4.6.0 `dist/{_shared,node-cron}.js`, `dist/node-cron.d.ts` and README; cron@4.4.0 `dist/job.js` and cron@5.0.0-beta.2; cron-schedule@6.0.0 `dist/cron.js` and README; node-schedule@2.1.2 and bree@9.2.9 READMEs; toad-scheduler@4.2.0, cron-parser@5.10.4, cronosjs@1.7.1 and cronbake@0.4.0 package metadata; each library's repository metadata and `.github/workflows` through the GitHub API, including github.com/chaqchase/cronbake `.github/workflows/ci.yml`; better-sqlite3@13.0.3 `prebuilds/`; a differential test of croner 11.0.0, 10.0.1 and 11.0.1-dev.2 against `Bun.cron.parse` and two minute-walking matchers; a month-end scan of 76,860 `nextRun` calls; clock-jump probes with a `Date` that moves only the wall clock, and with libfaketime in `oven/bun` 1.4.4; start-up, tick and RSS benchmarks, `process.versions`, `otool -L` and `ldd`, on Bun 1.4.4 and Node 26.13.0, on an Apple-silicon Mac and in `oven/bun:latest` and `node:slim` (arm64) under Docker Desktop; `command -v` probes for cron there and in `oven/bun:slim`, `node:latest` and the Alpine variants; the Brief: R8, R9, R10, R14, R17.1, R17.6, 4.8, C6, D6, D12, D16, D19, D26, Q11.

**R25.4 How other harnesses and container cron runners schedule.** Read on 2026-11-08 from each tool's docs and, where named, its source at the tag given. Probes ran supercronic, Debian's and BusyBox's cron and the official Bun and Node images, and timed `docker stop`, in containers under Docker Desktop on an Apple-silicon Mac. An independent fact-checker re-read the sources, apart from Jules's and Aider's docs and a third-party Codex reader, and re-ran the probes. **[H]** unless marked.

| Harness | Schedule declared in | What keeps time | A fire missed while asleep or down | Still running at the next fire | Time zone |
|---|---|---|---|---|---|
| OpenClaw 2026.11.1 (2026-11-05) | its CLI; a shared SQLite state database | the Gateway process, which "must be running"; each wait capped at 60 s; croner 10.0.1, 5 or 6 fields | one coalesced catch-up by default; `cron.skipMissedJobs: true` skips | not runnable, so the slot is dropped; 8 runs at once at most | `--tz`, else the host's |
| Hermes Agent v0.23.0 (2026-11-05) | its CLI; `~/.hermes/cron/jobs.json` | a 60 s tick in its gateway; `hermes cron tick` from a crontab, but without agent jobs | late within a grace; past it, one catch-up run or a logged skip | dropped; no cap on parallel runs unless `cron.max_parallel_jobs` is set | the job's IANA zone, else the profile's |
| Goose v1.57.0 (2026-10-28) | `goose schedule`; `schedule.json` and a copy of the recipe | tokio-cron-scheduler 0.15 in the goose process | once, if the process is up; nothing kept across a restart | not checked, so fires can overlap; only `run_now` refuses | local, fixed as a UTC offset when registered |
| Claude Code session (`/loop`, `CronCreate`) | the session | a check every second; fires only between turns | once when idle; a `--resume`d task skips its misses | waits for the turn, then fires once | local |
| Claude Code Desktop 1.1.5368 or later | the app; the prompt in `~/.claude/scheduled-tasks/<task-name>/SKILL.md`, the schedule elsewhere | the app, every minute while open, plus a fixed delay of a few minutes | skipped while asleep; on start or wake, one catch-up for the latest miss within 7 days | skipped, also while other scheduled tasks run | local |
| Claude Code cloud routines (`/schedule`) | the claude.ai account | Anthropic's cloud, at most hourly | runs whatever the laptop does; on-the-hour runs "can start several minutes late" | not documented | bare 5-field cron in UTC unless `CRON_TZ=`; presets local |
| Codex, in the ChatGPT desktop app | the app; one `automation.toml` per task **[M]** | the app; for a local project, it must be running on a machine that's on | not documented | not documented | not documented |
| Cline CLI 3.0.74 (2026-10-26) | `cline schedule create`, or an SDK `*.cron.md` file; SQLite | its hub process; the SDK's runner polls every 15 s | "one overdue catch-up on startup, then advance" | queued: `--max-parallel` defaults to 1, and due runs "wait their turn" | local, or the spec's `timezone` |
| opencode core v2.2.6 (2026-11-06) | a session's schedules, behind `experimental.schedules` (PR #59401); SQLite | a loop that re-reads them at least every 30 s, under a 60 s leader lease | a due cron slot fires once, then the first slot after now; `every` keeps its phase and skips | recorded as skipped | per schedule, else config, else local |
| opencode-tasks 1.0.0 (plugin, 2026-10-15) | `~/.config/opencode/tasks/*.md`, with `schedule:` in the frontmatter | one launchd agent or systemd user timer, every 60 s | due while the last slot is later than the last completed run's start | skipped silently; the slot then fires once the run completes **[M]** | local |
| opencode-scheduler 1.3.0 (plugin, 2026-02-17) | a tool call, written out as one launchd plist or systemd timer per job | the OS: crontab as a fallback, Task Scheduler on Windows | the backend's rule; crontab has none | skipped by its own Perl supervisor, but not on Windows | the OS's local time **[K]** |

Goose's row, apart from what keeps time, comes from reading its code **[M]**. Cursor, Devin, Jules and Aider are in the last harness bullet.

- **What the harnesses that catch up share.** Each stores a next or last fire and re-reads it on a short loop. OpenClaw caps every wait at 60 s, Hermes ticks every 60 s, Cline polls every 15 s, and opencode core re-reads at least every 30 s, "so clock jumps and missed doorbells are caught". 4.8's tick, every 15 s over `next_run_at`, has the same shape (D6). Among the local harnesses, a resident process keeps time in all but the two opencode plugins. The evidence shows this convergence, not whether the OS or a resident process should start the check.
  - **Restarts lose fires; sleep needn't.** Runners without stored state lose fires missed across a restart: Goose **[M]**, supercronic, ofelia and go-crond. A live process can still catch a sleep. OpenClaw runs its catch-up when it sees the clock jump forward, and croner 11.0.0 clamps its `setTimeout` to 30 s and compares `new Date()` with the target. Bun 1.4.4's in-process `Bun.cron` arms one timer for the whole delay on `CLOCK_MONOTONIC`, which stops during a Linux suspend. A suspend during the wait should therefore delay the fire by as long, inferred, not run **[M]** (R25.1, R26.1).
  - **Locks and leases keep ticks and claims apart:** Hermes's `fcntl.flock`, opencode core's leader lease row, Cline's 90 s claim lease with due runs created under `BEGIN IMMEDIATE`, and Hermes's 300 s fire-claim lease, refreshed every 60 s. R17.2 measured SQLite's equivalents: `BEGIN EXCLUSIVE` on a lock database, and single-statement claims.
- **Hermes's external tick doesn't run agents.** `hermes cron tick` runs one pass "for a system crontab or other external scheduler", behind a `fcntl.flock` on `~/.hermes/cron/.tick.lock`; `tick()` returns 0 at once if the lock is held. But agent jobs "execute inside the gateway, and a tick never starts one". With no gateway up they are skipped, and only `no_agent` script jobs run from a bare tick. A hosted gateway can swap its ticker for Chronos, which arms "exactly one managed one-shot per job" and is called back by webhook, so an idle gateway can "scale to zero". Without Chronos, the built-in ticker runs.
  - **Missed fires:** each occurrence runs at most once, since `next_run_at` advances before dispatch. A fire within a grace of half the period, clamped to 2 min–2 h, runs late. Past the grace, the backlog collapses into one catch-up run, booked as one "missed ×N" row. Under `cron.catch_up_missed: false`, or a job's `--catch-up off`, it is skipped with a logged reason. An explicit `--grace-minutes` (0–1440) turns a miss past it into a skip, 0 meaning never catch up, unless the job also has `--catch-up on`. One-shots more than 120 s late are retired.
  - **Runs:** by default, an agent run is killed after 600 s without activity, host sleep not counted, and a pre-run script after 3,600 s. Each run's output goes to `~/.hermes/cron/output/{job_id}/{timestamp}.md`.
- **OpenClaw 2026.11.1.**
  - **Catch-up:** when the Gateway comes up, up to 5 overdue jobs start at once, and the rest follow 5 s apart. Missed agent turns wait 2 min, plus 5 s per place in the queue. The same bounded catch-up runs when a live Gateway sees a forward clock jump, as on waking. A run cut short by a crash is recorded as interrupted, with delivery Unknown, and never replayed, "at the cost of possibly missing an occurrence"; 4.5 re-arms such a fire for `catch_up: once` tasks.
  - **Limits:** the cap of 8 concurrent runs is hard-coded (2026.5.7's docs still showed `maxConcurrentRuns: 1`). Watchdogs of 60 min bound agent turns, 10 min commands and 5 min scripts, unless `--timeout-seconds` is set. Recurring expressions with minute 0 and a wildcard hour, such as `0 * * * *`, are staggered by up to 5 min unless `--exact` is given; a daily `0 9 * * *` isn't.
  - **Definitions and state:** 2026.5.7 kept definitions in `~/.openclaw/cron/jobs.json` and runtime state in `jobs-state.json`: "If you track cron definitions in git, track `jobs.json` and gitignore `jobs-state.json`." It noticed an edit by comparing the schedule fields with the pending slot, and "Pure formatting or key-order-only rewrites preserve the pending slot." By 2026.11.1, jobs, run history and "quarantined malformed jobs" live in the shared SQLite state database, and `cron.store` is retired.
- **Goose dropped Temporal.** PR #5226, merged 2025-10-29 and first shipped in v1.13.0 (2025-11-06), deleted `temporal_scheduler.rs` (1,378 lines) and the Go `temporal-service` (14 files, 2,924 lines): "For desktop, default scheduler is fine, and this avoids a much more complex build tool chain and dependencies." Since then, "The built-in scheduler runs within the goose process and requires no external services." In its code **[M]**, a fire checks only `paused`, and tokio-cron-scheduler 0.15.1 spawns each activation without waiting for it. It polls every 500 ms, fires a past-due job once and computes the next fire from now.
- **The one OS heartbeat found: opencode-tasks 1.0.0.** Its installer writes a launchd agent (`StartInterval` 60, `RunAtLoad`) or a systemd user timer (`OnBootSec=60`, `OnUnitActiveSec=60`, `AccuracySec=1s`) over a `Type=oneshot` service with `KillMode=process`. Each `--run-once` tick starts detached workers and marks a worker whose PID has died as failed. The unit carries a sanitised `PATH` and `HOME` and "a stable Bun executable", and the README says "Re-run `--install` after upgrading" (R25.5). The repository has 7 GitHub stars and was created on 2026-03-31; opencode-scheduler has 517.
  - **Its due rule retries every minute.** A task is due when its last slot is later than the start of its last *completed* run. A failed, timed-out or crashed run leaves the slot due, so the next tick spawns the task again, every 60 s until a run completes. A task that never completed counts only if the slot is within 24 h, which daily or more frequent schedules always meet. By the same rule, a slot that passes during a run fires once after it completes, inferred, not run **[M]**. 4.8 advances `next_run_at` when it queues a run, so a failed run doesn't fire again. Two kinds of run get their fire back: a deferred run, once its limit domain's block lifts (4.8), and an abandoned run of a `catch_up: once` task, through the boot sweep (4.5).
  - **Two systemd traps:** systemd.kill(5), in systemd 262, calls `KillMode=process` "(not recommended!)", since it "allows processes to escape the service manager's lifecycle and resource management". And on a machine without a login session, a user timer runs only with lingering enabled, through `loginctl enable-linger`, which opencode-tasks doesn't mention (R25.2).
- **One OS entry per job: opencode-scheduler 1.3.0.** It writes a launchd plist, or a systemd user `.service` and `.timer`, for each job, and falls back to crontab, with "no missed-run catch-up". On Windows it uses Task Scheduler and refuses month-and-weekday combinations, and "Complex cron schedules may be expanded into multiple Windows tasks". Skipping a run while the last is active, and the optional timeout (SIGTERM, then SIGKILL), take its own Perl `supervisor.pl` and lock files, and "Windows scheduled runs currently do **not** use the supervisor pipeline". Bun's OS-level `Bun.cron(path, schedule, title)` writes such entries itself, on Bun only (R25.1, R8, D19).
- **Cline's SDK keeps the schedule in the task file.** At repository tag v4.1.26, specs are `*.cron.md` files in `~/.cline/cron/`, with `schedule`, `timezone`, `mode`, `timeoutSeconds`, `maxParallel` and `enabled` in the frontmatter and the prompt as the body. A one-time task is a `.md` file without the `.cron` infix or a `schedule`. A recursive `fs.watch`, debounced 250 ms per path, feeds a reconciler. It upserts each file into SQLite with its content hash, mtime and parse status, `valid` or `invalid`, and resets `next_run_at` when the expression or zone changes. The runner computes each next fire from now and "writes a markdown report per completion/failure". The CLI runs schedules in its hub, which starts on demand: "Scheduled agents persist across process restarts", and "a scheduled run approves its own tool calls".
- **Claude Code.** Desktop leaves lateness to the prompt: "A task scheduled for 9am might run at 11pm if your computer was asleep all day. If timing matters, add guardrails to the prompt itself." Its "Keep computer awake" setting prevents idle sleep, but "Closing the laptop lid still puts it to sleep" (R25.5). In a session, a recurring task starts each run late by up to half its interval, at most 30 min, unless it runs every five minutes. One-shots set for :00 or :30 can run up to 90 s early. Recurring tasks expire after 7 days, and a session holds 50 at most. Cloud routines allow an account 100 runs an hour, and runs over the limit wait.
- **Codex, Cursor, Devin, Jules and Aider.** Codex's scheduled tasks take a preset or an RFC 5545 RRULE, such as `RRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0`, not cron. On local projects they need the machine "powered on and the ChatGPT desktop app running", and they run with `approval_policy = "never"` where the organisation's policy allows. Results go to a "Scheduled" view that "acts as your inbox", with an unread indicator. A task's file, `$CODEX_HOME/automations/<automation_id>/automation.toml`, holds the RRULE, the prompt, `status` and `kind` **[M]**. Cursor's scheduled triggers "may run with a delay but will not start before the indicated time". Devin's Automations take an RRULE and a zone per schedule, start a run for every fire by default, and allow 50 runs an hour; an optional queue has concurrency and depth limits and drops events when full. Jules has daily or weekly presets and shows the last and next run. Aider has no scheduler: it is a one-shot `aider --message …` for an external cron, as mecha-gremlin is today. That was read at v0.86.0; the newest is 0.86.2, on PyPI since 2026-02-12.
- **The official images carry no cron, except Alpine's BusyBox.** `oven/bun:latest` and `:slim` (Bun 1.4.4) and `node:slim` and `node:latest` (Node 26.13.0) are Debian 13 images. None has `cron`, `crond`, `crontab`, `anacron` or `systemctl`. `oven/bun:alpine` and `node:alpine` (Alpine 3.24.3 and 3.24.4) ship BusyBox 1.37.0 with `/usr/sbin/crond` and `/usr/bin/crontab`; they are musl builds, which D26 allows **[K]**. `node:slim` and `oven/bun:latest` run in UTC unless `TZ` is set. The images were built on 2026-10-22 (Bun) and 2026-11-05 (Node).
- **Debian's cron strips the environment; BusyBox's crond keeps it.** R9 says jobs lose the container's environment and their output, and 4.8 cites it against cron. That holds for Debian's cron, not for BusyBox's in the foreground.
  - Debian 13's `cron` 3.0pl1-197 gave a job `PROBE_VAR=[] PATH=/usr/bin:/bin SHELL=/bin/sh PWD=/root`: none of the container's environment. Output the job didn't redirect never reached the container's output in 75 s.
  - BusyBox's `crond -f -d 8` sets only `LOGNAME`, `USER`, `HOME`, `SHELL` and `PATH`, so a job inherits the rest, and job output reached the container's stdout. Without `-f`, it daemonises with stdio on `/dev/null`. A line whose previous run is still going is skipped: "process already running".
- **supercronic v0.2.51 (2026-10-21), a cron built for containers.** Its timers, DST parsing and footprint are in R26.2.
  - Jobs inherit the container's environment plus the crontab's `KEY=value` lines. `SHELL` and `CRON_TZ` lines are honoured, and `USER` only draws a warning. By default its whole log, job output included, goes to stderr: `channel=stdout` names the job's stream, and only `-split-logs` puts info lines on stdout. `docker logs` shows both streams.
  - A slot that comes due mid-run logs "not starting: job is still running since …", then "job took too long to run". The next run is the first slot after now, so the missed slot never runs; `-overlapping` allows duplicates. Fires missed while it was stopped never run.
  - On SIGTERM it stops scheduling, logs "waiting for jobs to finish" and exits 0 once they end. It doesn't pass the signal on, so a job that outlasts the container's stop grace is SIGKILLed with it. SIGUSR2 reloads the crontab once jobs drain, `-inotify` reloads on a change, and as PID 1 it reaps zombies.
- **ofelia, go-crond and yacron.** ofelia (0.4.0-beta.5, 2026-06-07; netresearch's fork 1.1.0, 2026-11-02) takes jobs from an INI file or from Docker labels, `ofelia.<JOB_TYPE>.<JOB_NAME>.<PARAM>`. It allows overlap unless `no-overlap`, which skips, and reports by mail, Slack or a saved file, each with an only-on-error switch. go-crond 26.10.0 (2026-10-21) reads system and user crontabs and run-parts folders, keeps the environment and logs to stdout and stderr. It builds robfig/cron v3 without `SkipIfStillRunning`, so runs can overlap. Neither catches up. yacron 0.19.0 (2023-03-11, still the newest) copies the Kubernetes `concurrencyPolicy` into YAML, where `Forbid` means "skipping next run if previous hasn't finished yet". It reads times in UTC unless `utc: false` or `timezone:` is set, reports through `onFailure`, `onSuccess` and `onPermanentFailure` by mail, Sentry or shell, and retries with exponential backoff. By default it fails a job that writes anything to stderr.
- **The Kubernetes CronJob (v1.37.2, 2026-10-28) is the reference vocabulary.**
  - `concurrencyPolicy` is `Allow` (the default), `Forbid` or `Replace`. `Forbid` defers and coalesces rather than drops: "a new Job can be created once the previous Job completes". The controller then starts one Job for the most recent unmet slot, unless `startingDeadlineSeconds` has passed.
  - Only the most recent missed schedule starts, and over 100 misses record a `TooManyMissedTimes` warning but still start it. An unset `startingDeadlineSeconds` means no deadline. The controller checks every 10 s, so values under 10 s may never schedule. By default it keeps 3 successful Jobs and 1 failed. `.spec.timeZone` has been stable since 1.27, and `CRON_TZ` or `TZ` inside the schedule is "not officially supported". Since "two Jobs might be created, or no Job might be created", Jobs "should be _idempotent_".
- **The `schedule` trigger of GitHub Actions is best effort.** Runs can be delayed under load, "High load times include the start of every hour", and "some queued jobs may be dropped". The shortest interval is 5 minutes, and runs use the default branch's latest commit. Times are UTC unless an IANA `timezone:` is given, documented on 2026-03-19 (#60290) and not for GHES. In a spring-forward gap, "a 2:30 AM schedule advances to 3:00 AM". A public repository's schedules turn off after 60 days without activity.
- **Docker's stop grace is the engine's unless the container sets one.** Docker documents 10 s for Linux containers before the SIGKILL. On the probe engine, a PID 1 that ignored SIGTERM was killed after 3.11–3.13 s, with exit 137. A raw Engine API stop with no timeout took as long, so the daemon chose the grace. `docker stop -t 6` took 6.13 s, and a container created with `--stop-timeout 5` 5.13 s. In moby `docker-v29.9.2` the Linux default is 10 s, the daemon's `default-stop-timeout` changes it, and a container's own `StopTimeout` overrides both. So a drain has a known budget only when the container sets `stop_grace_period` or `--stop-timeout`. How long the agent's own cleanup takes is in R25.5.
- **Overlap and catch-up, mapped to 4.8.** Two kinds of skip need telling apart: one drops the slot, the other defers it and fires once when the run ends. The same word, `Forbid`, defers in Kubernetes and drops in yacron, and 4.8's `queue` is the deferring kind (D16). Among single-host tools, dropping is the commonest overlap default and one run for the latest miss the commonest catch-up; only cron replays every miss, after short jumps.

| | Behaviour | The default in | An option in | 4.8 and C6 |
|---|---|---|---|---|
| **Overlap** | allow: another run starts beside it | Kubernetes, yacron, ofelia, go-crond, Devin; Vixie cron **[K]**; in effect, Goose **[M]** | supercronic's `-overlapping` | — |
| | skip, dropping the slot: the next run is the next slot after now | supercronic, BusyBox crond, OpenClaw, Hermes, Claude Code Desktop, opencode core, opencode-scheduler; launchd's `StartInterval` and systemd timers (R25.2); in-process `Bun.cron` (R8) | ofelia's `no-overlap`, yacron's `Forbid` | `overlap: skip` |
| | defer: the slot fires once when the run ends, and later slots coalesce | Claude Code's session; opencode-tasks **[M]** | `Forbid` in Kubernetes, within `startingDeadlineSeconds` | `overlap: queue` (D16) |
| | queue: each due run waits its turn | Cline (`--max-parallel` 1) | Devin, with a depth limit, dropping events when full | D16's other option, a depth-1 queue |
| | replace: the running one is cancelled | — | Kubernetes, yacron | — |
| **Catch-up** | none | supercronic, ofelia, go-crond; Goose after a restart **[M]**; Claude Code's session after `--resume`; cron after a jump of over 3 h, BusyBox crond after one of over 1 h (R25.2) | — | — |
| | once, for the latest miss | Kubernetes, OpenClaw, Hermes past its default grace, Claude Code Desktop, Cline, opencode core, opencode-tasks (again every minute until a run completes); BusyBox crond after a jump of under 1 h, launchd calendar jobs after sleep, with power-off undocumented, and `Persistent=true` timers (R25.2) | — | `catch_up: once`, the default |
| | every miss | only cron: each missed minute after a jump of up to 5 min, and each missed fixed-time job after one of up to 3 h (R25.2) | — | — |
| | a grace to run late in, or a deadline past which a miss is dropped | Hermes: half the period, 2 min–2 h; Claude Code Desktop: 7 days; opencode-tasks: 24 h, for a task that never completed | `startingDeadlineSeconds` in Kubernetes; Hermes's `--grace-minutes` | `catch_up_grace`, a few minutes |
| | skip | — | OpenClaw's `cron.skipMissedJobs`; Hermes's `cron.catch_up_missed: false` and `--catch-up off` | `catch_up: skip` |

- **Failure reporting, from light to heavy** (Q1).
  - **Records:** supercronic logs each start, skip and outcome with the job's fields. Hermes books passed-over slots as one "missed ×N" row, Claude Code Desktop gives each skipped run's reason, and opencode core marks a fire more than 60 s late. Hermes keeps a Markdown file per run, Cline a report, OpenClaw 7 days of history (the newest 2,000 rows per job), and Kubernetes 3 successful Jobs and 1 failed.
  - **A check for a watchdog:** `hermes cron doctor` "exits `1` while any finding stands", for `hermes cron doctor || alert`.
  - **Only on error:** ofelia's `mail-only-on-error`, `slack-only-on-error` and `save-only-on-error`; Devin's legacy default, "On failure only"; yacron's `onFailure`.
  - **After repeated failures:** OpenClaw alerts after 2 consecutive failures of a job with a delivery route, with a 1 h cooldown and one alert per incident. Its recurring jobs back off 30 s, 60 s, 5 min, 15 min, then 60 min, and are disabled after 10 consecutive execution failures or 3 schedule-computation errors. 4.8 doubles a backoff per limit domain and alerts once when it blocks and once when it recovers. Devin's legacy sessions show an `Error` status after consecutive failures, and a Claude Code routine turns off "After 72 hours without a connection".
  - **From the agent:** Hermes's `[SILENT]` suppresses delivery, and `[CRON_FAILURE]` on the first line declares a failure; OpenClaw has `NO_REPLY`. OpenClaw's scheduler "does not infer execution failure from assistant prose", and a routine's outcomes "say how the session ended, not whether Claude completed the work".
- **Keeping the schedule beside the job.**
  - **Where:** frontmatter with the prompt as the body, and state in SQLite, in Cline's SDK and opencode-tasks, the nearest to C6's TASK.md. Codex keeps one TOML file per task **[M]**. OpenClaw 2026.5.7 kept definitions for git apart from state, then moved both into SQLite. Claude Code Desktop keeps the schedule apart from the prompt, and Goose a copy of the recipe that ignores later edits **[M]**.
  - **Edits and broken files:** Cline watches the folder, stores a content hash and mtime, and resets `next_run_at` when the expression or zone changes. OpenClaw 2026.5.7 kept the pending slot through "Pure formatting or key-order-only rewrites". Cline marks a broken file `invalid` and OpenClaw quarantines it, and the other jobs run on. C6's `apply` recomputes `next_run_at` when the schedule, zone or `enabled` changes.
- **Time zones.** Desktop tools default to local time: Claude Code's session and Desktop, Cline, opencode-tasks and, from its code, Goose **[M]**. A bare cron expression in Claude Code's cloud routines, yacron and GitHub Actions defaults to UTC, and the official images run in UTC. OpenClaw, Hermes, opencode core, Cline's SDK, Devin, Kubernetes and GitHub take a zone per job. Devin moved from times "stored as UTC internally" to a zone per schedule that holds "including across daylight saving changes". A tick started by the host's scheduler runs in the host's zone, and a loop in an official image in UTC (R25.2), so a schedule without a zone would fire at different instants in the two. 4.8 already refuses the process zone (Q11).
- **The same cron string, different schedules.**
  - **Day of month with day of week:** OR, as in Vixie cron, in Claude Code and, by default, croner (OpenClaw: "croner matches when **either** field matches"). AND in Cline's own parser, and in Goose through tokio-cron-scheduler's `.dom_and_dow(true)`.
  - **Six fields:** a leading seconds field in croner, OpenClaw and Goose, which puts a `0` seconds field before a 5-field expression. A trailing year field in supercronic, which also takes 7 fields (seconds and a year), 5, and shorthands such as `@hourly`. `Bun.cron` takes 5 fields only (R8).
  - **A zone in the string:** `CRON_TZ=` works in supercronic and Claude Code's cloud routines. Kubernetes calls it "not officially supported", and GitHub takes a `timezone:` key.
  - **DST:** croner 11.0.0 (2026-10-26) flips two of the three croner 10.0.1 behaviours that 4.8 pins, and now differs from `Bun.cron` in spring-forward gaps (R25.3, R10, D12).
- **Open:** what Codex does with a fire missed while asleep, an overlapping run and time zones, and what Claude Code's cloud routines, Cursor and Jules do with an overlapping run, which their docs don't say; Goose's overlap, catch-up and DST behaviour, read in code only; how opencode-tasks treats a slot that passes during a run, inferred from its due rule; launchd's catch-up after a power-off (R25.2); the probe engine's stop-timeout setting, inside Docker Desktop's VM; Codex's `automation.toml` fields, seen only through an OpenAI plugin's docs and a third-party reader; whether Aider 0.86.2 still has no scheduler; how late in-process `Bun.cron` fires after a suspend (R26.1).
- **Sources:** github.com/openclaw/openclaw `v2026.11.1`: `docs/automation/cron-jobs/{how-it-works,schedules,managing-jobs,delivery}.md`, `src/cron/service/{timer-execution-timeout,timer-runnable,jobs-scheduling}.ts`, `src/cron/store/scheduler-actor.worker.ts`, `src/config/cron-limits.ts`, `package.json`; cdn.jsdelivr.net/npm/openclaw@2026.5.7/docs/automation/cron-jobs.md; github.com/NousResearch/hermes-agent `v0.23.0`: `website/docs/developer-guide/cron-internals.md`, `website/docs/user-guide/features/cron.md`, `cron/scheduler.py`; github.com/aaif-goose/goose PR #5226, and `v1.57.0` `crates/goose/src/scheduler/{full,common}.rs`, `crates/goose/Cargo.toml`, `crates/goose-cli/src/commands/schedule.rs`; github.com/mvniekerk/tokio-cron-scheduler `v0.15.1` `src/scheduler.rs`, `src/job/{mod,runner}.rs`; code.claude.com/docs/en/scheduled-tasks.md, /desktop-scheduled-tasks.md and /routines.md, fetched 2026-11-08; developers.openai.com/codex/app/automations.md, fetched 2026-11-08; github.com/openai/plugins `plugins/data-analytics/skills/create-data-context/references/automation.md`; github.com/agentscope-ai/QwenPaw `src/qwenpaw/portability/providers/codex_schedule_reader.py`; an OpenAI community thread (community.openai.com topic 1391015); docs.cline.bot/cli/scheduling.md; github.com/cline/cline releases `cli-v3.0.74` and `v4.1.26`, and at `v4.1.26`: `sdk/examples/cron/`, `sdk/packages/core/src/cron/` (`cron-watcher.ts`, `specs/cron-reconciler.ts`, `cron-runner.ts`, `cron-materializer.ts`, `store/sqlite-cron-store.ts`, `schedule/scheduler.ts`); github.com/anomalyco/opencode `v2.2.6` `packages/core/src/schedule.ts`, PR #59401; github.com/jdormit/opencode-tasks README, `src/cli.ts`, `src/lib/{cron,db,installer}.ts` (npm 1.0.0); github.com/different-ai/opencode-scheduler README (npm 1.3.0); the GitHub API for both repositories' stars and dates; cursor.com/docs/cloud-agent/automations.md; docs.devin.ai/product-guides/scheduled-sessions.md and /automations.md; jules.google/docs/scheduled-tasks; github.com/Aider-AI/aider `aider/website/docs/scripting.md`, a code search for `cron` and `schedule`, and releases (`v0.86.0`); pypi.org/project/aider-chat (0.86.2); github.com/aptible/supercronic `v0.2.51` `main.go`, `cron/cron.go`, `crontab/crontab.go`, README; github.com/mirror/busybox `miscutils/crond.c`, `libbb/vfork_daemon_rexec.c`; github.com/mcuadros/ofelia README and `middlewares/overlap.go`, and its `v0.4.0-beta.5` release; github.com/netresearch/ofelia `v1.1.0`; github.com/webdevops/go-crond `26.10.0` `runner.go` and README; github.com/gjcarneiro/yacron README; pypi.org/project/yacron (0.19.0); kubernetes.io/docs/concepts/workloads/controllers/cron-jobs (github.com/kubernetes/website `content/en/docs/concepts/workloads/controllers/cron-jobs.md`, revised 2026-10-31); github.com/kubernetes/kubernetes `v1.37.2` `pkg/controller/cronjob/{utils,cronjob_controllerv2}.go`; github.com/github/docs `data/reusables/actions/{schedule-delay,scheduled-workflows-disabled}.md`, `data/reusables/repositories/actions-scheduled-workflow-example.md`, PR #60290; docs.docker.com/reference/cli/docker/container/stop; github.com/moby/moby `docker-v29.9.2` `daemon/stop.go`, `daemon/config/config_linux.go`; freedesktop.org/software/systemd/man/latest/systemd.timer.html, /systemd.kill.html and /loginctl.html (systemd 262); macOS launchd.plist(5); man7.org/linux/man-pages/man2/clock_gettime.2.html; github.com/cronie-crond/cronie `cronie-1.7.2` `src/cron.c`; salsa.debian.org/debian/cron `debian/patches/features/Better-timeskip-handling.patch`; github.com/Hexagon/croner releases `11.0.0`; npmjs.com/package/croner (11.0.0, `dist/croner.js`); github.com/Hexagon/croner-rust README; bun.com/docs/runtime/cron; github.com/oven-sh/bun `bun-v1.4.4` `src/runtime/api/cron.rs`, `src/bun_core/util.rs`; probes on 2026-11-08 under Docker Desktop on an Apple-silicon Mac: supercronic and BusyBox `crond` in `alpine:latest`, Debian's `cron` in `debian:latest`, `oven/bun:{latest,slim,alpine}` and `node:{slim,latest,alpine}` for binaries and zones, and `docker stop` timings; this Brief's 4.5, 4.8, C6, D6, D12, D16, D19, D26, Q1, Q11, R8, R9, R10 and R17.2.

**R25.5 What scheduled runs need from this repository.** Read and probed on 2026-11-08 by the completeness critic. It covered the Brief's scheduler design, this repository's code and README, and ran scratch probes on Bun 1.4.4 and Node 26.13.0, the newest stable releases that day, on an Apple-silicon Mac (macOS 27.2) and in the official Bun and Node images under Docker Desktop (arm64). No independent checker re-checked its findings. **[H]** unless marked, keeping the critic's own labels.
- **Runs started together fail on a fresh or migrating data folder.** `openStore` runs `runMigrations({ transaction: 'all' })` on every open, and each migration is a plain `CREATE TABLE`. Processes started together, opening the real store on one scratch data folder per trial, gave:

| Data folder | Bun 1.4.4 | Node 26.13.0 |
|---|---|---|
| fresh | 3, 2 and 3 of 4 failed, in 3 trials | 1 of 8 failed |
| one migration pending (its table and `migrations` row removed) | 3 of 4 failed in each of 3 trials; the fourth applied it | 0 of 8 failed |
| fully migrated | none of 12 failed (6 processes, 2 trials) | — |

- **What failed.** On fresh folders: `database is locked` after 7 ms, despite the store's 2 s busy timeout (`BUSY_TIMEOUT_MS`), and `table "migrations" already exists`. With the migration pending: `table "mcp_server" already exists`. Once on Node: `table "credential" already exists`. Node's slower start spread its processes out, which is luck of timing, not safety. The instant `database is locked` is probably several connections switching a new file to WAL at once, where SQLite skips the busy handler to avoid a deadlock (R17.2) **[M]**. A tick will often start several runs in one second, since slots such as 09:00 are common. This bites on a fresh install and after any update that ships a migration. The fixes proposed are to migrate once before starting runs, at install and in a tick about to start some, or to retry on these two errors.
- **A tick that starts a run and exits loses the run or its output.** `@mecha-gremlin/process` always pipes stdout and stderr. Its comment says "unread pipes keep either runtime running, unref() or not". In the probe, a stand-in tick used the wrapper to spawn a detached writer, with stdin ignored, that logged through `console.log` every 100 ms. The tick then either exited at once or cancelled both streams and returned. In all 8 combinations of tick runtime, run runtime and exit style, the tick was gone in 27–139 ms. A Bun run went on and wrote its 20 records into nothing. A Node run died at its second record with exit code 1. Writing straight into a pipe with no reader, Node printed `Error: write EPIPE` and Bun carried on. Detached runs therefore need the wrapper to send output to a file descriptor, or each run to open its own log.
  - **A tick that stays to read the pipes** holds up every schedule under launchd's `StartInterval` and under a systemd oneshot, since neither starts a job that is still running. launchd.plist(5): "If the job is running during an interval firing, that interval firing will likewise be missed". systemd.timer(5), systemd 262: an active unit "is not restarted, but simply left running".
- **A scheduler's bare environment,** probed under `env -i` with only `HOME`, `PATH=/usr/bin:/bin` and `SHELL=/bin/sh`.
  - **`.env` can't set `PATH`.** A `PATH=` line in `.env` changed nothing on either runtime. Any variable already set beat its `.env` value, under Bun's autoload and Node's `--env-file-if-exists` alike. So `PATH` has to come from the entry or the tick. Cron and launchd set no `LANG` either (R25.2). Both variables reach past the agent: the shell tool copies `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and `LC_ALL` into every command the model runs (`exec/env.ts`). A stdio MCP server's command is looked up on its `PATH`, which the README warns about: "Under a scheduler, `PATH` is short". The same rule lets a tick override any `.env` setting for one run by setting it in that run's environment, such as `LOG_FORMAT=json` or a `WORK_DIR` per task.
  - **The working directory.** `bun --cwd=<repo> <entry>`, started from another folder, ran in the repository and loaded its `.env`, not the starting folder's. `--no-env-file --env-file=<abs>` loads exactly one file, where autoload also reads `.env.local` and a file for `NODE_ENV` (README). Node has no `--cwd` flag, so for Node the entry sets the folder: `cd` in the crontab line, `WorkingDirectory` in the plist, or the spawn's `cwd`. `WORK_DIR`, `DATA_DIR`, `SKILLS_PATH` and the task's path all resolve against it.
  - **`bun run` is unsafe there.** It puts a temporary shim folder first on `PATH`. With no Node on `PATH`, `node` in a script is then Bun itself. A script shaped like the README's `agent:node`, `node --env-file-if-exists=.env …`, ran on "bun 1.4.4" and loaded no `.env`. `bun run` didn't pass its own `.env` to a shell script either. So the README's `bun run agent:node`, started from a scheduler's `PATH` that has no Node, runs on Bun and without `.env`.
  - **`process.execPath` names the real binary,** not the link on `PATH`. Under a package manager that keeps a folder per version, the path names one version, which the manager's cleanup deletes after an upgrade, so an entry that records it stops working. Bun's official installer puts the binary itself in `~/.bun/bin`.
- **No deadline bounds a whole run.** Each limit counts model calls, as `MAX_STEPS` does, or bounds one wait: 120 s per shell command, and the 30 s to start and 2 min per tool call that `bun run mcp add` gives a server by default. Under skip-while-running, one hung run holds its task until it ends, so the scheduler has to enforce a deadline.
  - **Exit codes:** 0 for an answer, 1 for every failure, and 129, 130 or 143 for SIGHUP, SIGINT or SIGTERM. Code 1 covers configuration, task, store, MCP and model failures, and a required server that needs `bun run mcp login` again; an optional one is left out (D49). Without reading the records, a scheduler can't tell "needs a login", which no retry fixes, from "model unreachable".
  - **Cleanup after SIGTERM.** The agent ignores further signals while it cleans up. MCP servers close in parallel, each in "at most about 16 seconds" (`mcp/stdio.ts`: up to 10 s to list descendants, then three 2 s waits). Then the shell kills a running command's group and waits up to 1 s for its pipes. The sweep then takes up to 10 s to list processes, plus a 2 s grace. That makes about 28 s in all, or 29 with a command running, worked out from the constants, not measured. Docker's documented stop grace is 10 s, and the probe engine under Docker Desktop gave about 3 s (R25.4). A loop's container therefore needs a `stop_grace_period` of at least 30 s. The loop must also pass SIGTERM on to runs it started detached, since `docker stop` signals only the container's main process.
- **The agent's `ps` listing fails in five of six official images (Q24).** The sweep and the MCP close both list processes with `ps axeww -o pid=,ppid=,pgid=,command=`, and the sweep finds a run's processes by the run ID in their environment. The images were pulled between 2026-10-22 and 2026-11-06.
  - `oven/bun:latest`, `oven/bun:slim` and `node:slim` have no `ps`.
  - `oven/bun:alpine` and `node:alpine` have BusyBox's `ps`, which fails with "bad -o argument 'command'" and exit code 1.
  - Only `node:latest`, the full Debian image with procps, runs the command and shows environments. Q24 says the official images ship no `ps`; this one does.
  - **The sweep runs at the end of every run,** so in the other five images every run logs `cleanup failed`, and the MCP close finds no descendants to stop (R18.3). An image for the loop needs procps.
- **Run output and records.** The store has two tables, `credential` and `mcp_server`, and nothing records a run. Every record goes to stdout through `console.log`, pretty or JSON by `LOG_FORMAT`. The records hold the task's text (`asking`), each tool call's arguments (`tool call`) and the answer. The store creates `db.sqlite` at 0600, which keeps its `-wal` and `-shm` files private "where a umask of 022 would leave them readable by anyone" (`store.ts`). A file named by launchd's `StandardOutPath`, or by `>> file` in a crontab line, takes the process's umask instead: "permissions reflecting the umask(2) specified by the Umask key, if set" (launchd.plist(5)). So the tick should create each run's log, and its own, at 0600 under `DATA_DIR` before anything writes to it. `LOG_FORMAT=json` goes in the run's environment, where it beats `.env`. A run record (task, slot, PID, start, end, exit code, log path) would be the scheduler's first table, a store migration under D27, and part of an answer to Q1.
- **A late run doesn't know it is late.** Nothing tells a run its slot. The model sees the task and a developer item made of the preamble, the skills catalog and any left-out servers (`main.ts`). Claude Desktop leaves lateness to the prompt: "A task scheduled for 9am might run at 11pm if your computer was asleep all day. If timing matters, add guardrails to the prompt itself." A laptop can also sleep in the middle of a run: Claude Desktop's "Keep computer awake" stops idle sleep, but "Closing the laptop lid still puts it to sleep." On macOS, `caffeinate -i -w <pid>`, or `caffeinate -i` with the run as its command, holds off idle sleep until the run exits. `-s`, against system sleep, is "valid only when system is running on AC power" (caffeinate(8)). A tick could pass a run its slot time, and whether it is catching up, through the run's environment, where a set variable beats `.env`. 4.8 already gives the run after a deferred one "a note on what the deferred run did", a precedent for a note in a run's input.
- **What a tick costs if it opens the full store.** These are whole processes that open the real store (TypeORM, `better-sqlite3` and the migration check) on a migrated database, medians of 7 runs on the Mac under moderate load:
  - On Bun 1.4.4: 52.0 ms wall, 53.5 ms CPU and 42.0 MiB peak, against 5.4 ms, 4.2 ms and 9.2 MiB for an empty script.
  - On Node 26.13.0, a package manager's build, with a `.ts` entry: 171.1 ms, 204.0 ms and 93.9 MiB, against 79.4 ms, 78.4 ms and 38.9 MiB.
  - Once a minute, that is about 77 s of CPU a day on Bun and 4.9 min on Node. R25.3's tick, which reads ten task files and writes a JSON state file, costs about 20 s of CPU a day on Bun.
  - **Why the state can't simply live elsewhere.** The scheduler's tables are store migrations (4.2, D27), so a tick that skips TypeORM to stay light can't create or migrate them. A JSON state file has no exclusion across processes. A split would keep the tick light and also remove the migration race. The tick would decide on a light path: the lock database plus plain `better-sqlite3` reads, at about 10–15 ms on Bun (R25.3). It would open the full store, and migrate, only on a tick that starts runs.
- **A tick can reuse R17.2's lock and claims.** R17.2 measured both across processes, drivers and runtimes.
  - `BEGIN EXCLUSIVE` on a small lock database opened with `busy_timeout` 0 gave a second holder `SQLITE_BUSY` at once on every driver. The lock was free again the moment its holder was killed with SIGKILL.
  - A single autocommit `UPDATE … RETURNING` claimed each of 2,000 runs exactly once across 4 processes.
  - Put together, though not yet run together: a tick that takes the lock and exits quietly when it is busy can't overlap a loop that takes the lock on each pass or holds it. Neither mode needs to detect the other. A claim on each task and slot in one statement rules out a double fire even if two ticks interleave.
  - R17.2's caveats carry over. A lock wait freezes the event loop, since the drivers are synchronous. A deferred read-then-write fails at once, with `SQLITE_BUSY_SNAPSHOT` or `SQLITE_BUSY`, so a claim must be one statement or use `BEGIN IMMEDIATE`.
- **Without a daemon, nothing sweeps dead runs.** 4.8's boot sweep, which turns running runs into abandoned ones, and its in-process semaphores per model profile rely on one long-lived daemon (Q6). A heartbeat's ticks share no memory and have no daemon start. They would have to find dead runs and count running ones across processes. Otherwise a run killed with SIGKILL, or cut off by a reboot, holds its task for good under `skip`. Two ways were named, and neither was tried **[M]**: a per-task lock held by the run or by a small supervisor, which the kernel drops when its holder dies (R17.2), or a check of PID and start time, as opencode-tasks reaps by PID (R25.4).
- **A host heartbeat and a container loop on one tasks folder.** D25 and the README keep Docker's data folder on a named volume, and 4.9 bind-mounts the tasks folder (`${GREMLIN_PRIVATE}/tasks:/config/tasks:ro`). The two therefore have separate databases and share no lock. Reasoned from those decisions, not tested **[M]**: with schedules in the task files' frontmatter, both see every schedule and every task runs twice. With schedules as rows in each data folder, written by D5's `apply` or by commands in D29's style, a task runs only where it was added. Sharing one data folder through a bind mount doesn't help: on Docker Desktop, with host against container, the second writer always took the lock and the first one's commit failed (R17.2).
- **One schedule, two instants (Q11).** Cron and launchd on a host give a job no `TZ` (R25.2), so a native tick runs in the host's zone. The official images run in UTC unless `TZ` is set (R25.4). `0 9 * * *` without a zone therefore fires at 09:00 host time from a heartbeat and at 09:00 UTC from a container loop. 4.8 already says "Never fall back to the process zone, which is UTC in a container", and Q11 is open. A local-time default, which desktop tools use (R25.4), is that process zone.
- **Where schedules could live.** C6 puts the schedule keys in TASK.md's frontmatter, which `gremlin apply` upserts (D5, open). D29 (2026-10-30) made MCP servers "rows in the database, written by a command, in place of a file", a precedent for schedules as rows. 4.2 puts the scheduler's "entities and migrations" in `store` (D27). A run warns about every frontmatter key it doesn't read (D48), so schedule keys would log "frontmatter key ignored" on every manual run until the run reads them. Schedules in frontmatter also need a folder to scan, and no setting names one: a run takes any path.
- **4.8's objections to cron, against one heartbeat entry.** 4.8 rejects "cron or systemd invoking a CLI" on four counts: "Schedules live in the DB, so an external cron would need a synced copy", "Cron inside containers is awkward (R9)", "systemd doesn't exist on macOS", and both break "same artefact". One native entry that runs a short tick each minute meets the first three: the entry holds no schedule, a container runs a loop instead, and macOS has launchd. "Same artefact" still stands. The settled deployment, "Docker / docker compose", rests on it: "Same artefact for my machine and any future client box."
- **Where the Brief deploys, the loop is the main path.** The settled deployment is a container, and nothing native keeps time in the official images (R25.2). There, a loop would be the main path, not the fallback. A native heartbeat would serve the host install that the README documents today, with D18's host shell. The repository has no Dockerfile or compose file yet.
- **A native scheduler can't be detected in advance.** `crontab` takes entries when no daemon runs, as with BusyBox on Alpine or Debian with cron stopped, and macOS cron is gated by Background Task Management, so an entry can be accepted and never fire. `gui/<uid>` exists only with a GUI login, and Arch has no `crontab` (R25.1, R25.2). Watching for a recorded tick within about 90 s of installing is the only check that covers every case **[M]**. It is untested.
- **Testing without touching the host's schedulers.** The repository runs Vitest on Bun and on Node, and Stryker on Bun, whose CI job is allowed 360 minutes. Install and remove code that calls `crontab` or `launchctl` needs an injected command runner, since a test, or a mutant that drops a guard, could otherwise rewrite the developer's crontab or LaunchAgents **[M]**. A tick written as a function of the time, the last tick, the tasks and the running runs needs no fake timers. `Bun.cron`'s in-process timer reads Bun's own clock, which `bun:test`'s fake timers have driven since Bun 1.4.0 (PR #33623, R25.1). Vitest's fake timers replace JavaScript globals only, so they very likely can't drive it **[M]**. That is reasoned, not run.
- **Which checkout owns an installed entry.** **[M]** `.gitignore` lists `.claude/worktrees`, so several checkouts of the code can sit side by side. An entry's identity, whether a crontab marker, a plist label or a `Bun.cron` title, is per user, not per checkout. Installing from a second checkout would silently point the entry at that checkout's code and `.env`, or add a second tick over the same `DATA_DIR`. The lock stops double runs, not the repointing. opencode-scheduler scopes jobs by working directory: "Jobs run from the working directory where you created them" (R25.4). Two fixes were named: keying the entry by the repository's real path, or refusing to install while another checkout owns it.
- **Open:** how current macOS launchd treats a heartbeat agent, which rests only on man pages and launchd-842 source from the OS X 10.9 era **[L]**. That covers the cadence of `StartCalendarInterval {}` against `StartInterval 60`, what happens on wake, whether a `setsid` run outlives the tick without `AbandonProcessGroup`, whether runs inherit the job's "light resource limits", what Background Task Management shows and whether its switch stops ticks, and `bootstrap` without a GUI login. Also unmeasured: how late an in-process loop fires after a real sleep or suspend (R26.1 reads the clocks); a systemd user timer's oneshot tick, its detached runs, linger and polkit, known from documentation only (R25.2); the migration fix; the cleanup time; and the double run across host and container.
- **Sources:** this repository's `packages/store/src/store.ts` and `packages/store/src/migrations/`; `packages/process/src/spawn.ts`; `packages/agent/src/main/{main,args,frontmatter,mcp-args}.ts`, `exec/{env,run,sweep}.ts`, `tools/shell.ts`, `mcp/{stdio,servers,resolve}.ts`, `log/log.ts` and `config/config.ts`; `package.json`, `.gitignore` and `.github/workflows/ci.yml`; the README; `launchd.plist(5)` and `caffeinate(8)` on macOS 27.2; `systemd.timer(5)`, systemd 262; code.claude.com/docs/en/desktop-scheduled-tasks; github.com/different-ai/opencode-scheduler's README; `bun --help` 1.4.4 and `node --help` 26.13.0; npm's `bun` dist-tags; nodejs.org/dist/index.json; github.com/oven-sh/bun PR #33623 (through R25.1); scratch probes on Bun 1.4.4 and Node 26.13.0 on an Apple-silicon Mac, and in `oven/bun:{latest,slim,alpine}` and `node:{latest,slim,alpine}` under Docker Desktop (arm64); Brief Part 1, 4.2, 4.8, 4.9, C6, D5, D18, D25, D27, D29, D48, D49, Q1, Q6, Q11, Q24, R17.2 and R18.3; R25.1–R25.4 and R26.1.

## R26. A scheduler daemon in Rust, TypeScript, or not at all

Researched on 2026-11-08 for C24, after the question whether the scheduler should be written in Rust. Four research agents read the clocks behind Rust's, Go's, Node's and Bun's timers in their source; surveyed existing cron daemons and Rust crates; built the same small daemon in Rust, Bun and Node and measured it in Docker Desktop's Linux VM and on an Apple-silicon Mac under other load; and costed a Rust crate in this repository. Four independent checkers re-checked 99 of the 103 findings: 79 hold, 20 hold partly, and none failed. Their corrections and 35 additions are folded in. Measurements on the shared machine are good to about ±2x, and only their ratios are robust. No machine was slept or suspended and no clock was changed, so lateness after a suspend is derived from source. Each subsection states its default confidence.

**R26.1 Waking at the next fire: clocks across sleep, suspend and clock steps.** **[H]** unless marked. Read and measured on 2026-11-08 for C24, from source: Rust 1.99.1's std, tokio 1.54.1 with mio 1.2.4, Go 1.27.3, libuv 1.53.0 and Node 26.13.0, Bun 1.4.4, Linux 7.3 with man-pages 6.20, Apple's xnu-12377.121.6, libdispatch-1542.100.32 and Libc-1752.120.2, and the crates and schedulers named below. Probes ran on an Apple-silicon Mac under other load (macOS 27.2) and in Docker Desktop 4.98's Linux VM (kernel 7.0.14). No machine was slept or suspended and no clock was set, so behaviour across them comes from source, and is **[M]** where it is derived. An independent checker re-read the sources and re-ran the probes, and its corrections are folded in.
- **A timer armed for the whole delay fires late after a sleep or suspend, in every candidate language [M].** Each runtime blocks in a relative kernel wait on a clock that stops while a Mac sleeps or a Linux machine is suspended (table). Such a timer fires late by about the time asleep, and ignores a wall-clock step made after it was armed. Rust's std and tokio are no exception; only the OSes' own timers, below, do better. This is derived, not reproduced, and croner's and OpenClaw's comments and tokio #3185 support it. It matters on a laptop and in a VM paused with its host. An always-on server doesn't suspend, and its `CLOCK_MONOTONIC` "is affected by frequency adjustments", NTP's, so there only clock steps matter.

| | Clock, macOS / Linux | Relative wait, macOS / Linux | After a sleep or suspend **[M]** |
|---|---|---|---|
| Rust 1.99.1 std | `Instant`: `CLOCK_UPTIME_RAW` / `CLOCK_MONOTONIC` | `thread::sleep`: `nanosleep` / `clock_nanosleep(CLOCK_MONOTONIC)` | late by the time asleep |
| tokio 1.54.1 | `std::time::Instant`, at 1 ms resolution | `kevent` / `epoll_wait` in whole ms, through mio 1.2.4 | late by the time asleep |
| Go 1.27.3, and so supercronic | `mach_absolute_time` / `CLOCK_MONOTONIC` | `kevent` / `epoll_wait` | late by the time asleep |
| Node 26.13.0 | `mach_continuous_time` / `CLOCK_MONOTONIC` or `CLOCK_MONOTONIC_COARSE` | `kevent` / `epoll_pwait` | late by the time asleep, but on macOS any earlier wake of the loop fires it, as its clock counts sleep there |
| Bun 1.4.4 | `CLOCK_MONOTONIC`, which counts sleep on macOS | `kevent64` / `epoll_pwait2` or `epoll_pwait` | as Node |

- **Rust's std.** On Apple targets `sys/time/unix.rs` picks `CLOCK_UPTIME_RAW`, which "is based on `mach_absolute_time`, which is the clock that all timeouts and deadlines are measured against inside the kernel". macOS's `clock_gettime(3)`: it "does not increment while the system is asleep", where `CLOCK_MONOTONIC` "will continue to increment while the system is asleep". Linux's `CLOCK_MONOTONIC` "does not count time that the system is suspended" (`clock_getres(2)`). std: "it is also not specified whether system suspends count as elapsed time or not. The behavior varies across platforms and Rust versions." On a Mac that had slept since boot, `CLOCK_UPTIME_RAW` equalled `mach_absolute_time` and trailed `mach_continuous_time` by the time asleep.
  - Apple's Libc turns `nanosleep` into a relative semaphore wait, whose kernel deadline is `mach_absolute_time()` plus the interval. The unstable `sleep_until` (Rust #113752) is absolute but monotonic too: `clock_nanosleep(…, TIMER_ABSTIME)` on Linux, `mach_wait_until` on Apple. std can't sleep until a `SystemTime`.
- **tokio's and Go's issues for timers that count sleep are open.** tokio #3185, "Provide boottime timers", since 2020-11-27: "time spent in system sleep does not count towards tokio timers." Go #36141: Go "currently mostly uses 'program time', except on Windows", which "stops when the computer is in S3 sleep". Go #24595, for `CLOCK_BOOTTIME`, was withdrawn in 2019.
- **On macOS, Node and Bun count sleep in their due times but not in their waits.** libuv has read `mach_continuous_time` there since PR #2894 (2020), and on the Mac above `process.hrtime.bigint()` matched it. Official Node 26.13.0 builds bundle libuv 1.52.1, whose clock and timer code matches 1.53.0's. Node's timers take only relative delays: "When `delay` is larger than `2147483647` or less than `1` or `NaN`, the `delay` will be set to `1`." Bun 1.4.4, whose own code is now mostly Rust (3,238 `.rs` files under `src/`, no `.zig`), keeps due times on `CLOCK_MONOTONIC`: "Boot-relative on every platform; never compare against wall-clock epoch."
- **macOS's relative waits stop during sleep; one timer doesn't.** XNU makes a `kevent` timeout a deadline by adding it to `mach_absolute_time()` (`clock_absolutetime_interval_to_deadline`), as it does for `nanosleep` and semaphore waits; `mach_continuous_time` is "like mach_absolute_time, but advances during sleep". A relative `EVFILT_TIMER` with `NOTE_MACH_CONTINUOUS_TIME` "continues to tick across sleep", and XNU re-adjusts continuous-time timer calls at wake, but no runtime uses one. libdispatch has an internal clock that counts sleep, but the public `dispatch/time.h` offers only `DISPATCH_TIME_NOW`, on `mach_absolute_time`, and `DISPATCH_WALLTIME_NOW`.
  - The XNU source read, xnu-12377.121.6 (2026-06-17), is the newest published, and a major release behind macOS 27.2's xnu-13432.41.4, so for macOS 27 the kernel's behaviour is inferred. The wall-clock probes below agree with it; the relative waits weren't probed.
- **Linux can wait for a wall-clock time exactly.** `timerfd_create(2)`: with `CLOCK_REALTIME` and `TFD_TIMER_ABSTIME`, "The timer will expire when the value of the timer's clock reaches the value specified"; adding `TFD_TIMER_CANCEL_ON_SET`, a read "will fail with the error ECANCELED" after any "discontinuous change (settimeofday(2), clock_settime(2), or similar)". Re-arming after a change, without a read, returns `ECANCELED` and still re-arms. `CLOCK_REALTIME_ALARM` "will wake the system if it is suspended", but needs `CAP_WAKE_ALARM`; `CLOCK_BOOTTIME` counts suspend but isn't a wall clock.
  - **A resume is a clock set** (Linux 7.3). `timekeeping_resume()` adds the time suspended to `CLOCK_REALTIME` and `CLOCK_BOOTTIME`, then: "Notify timerfd as resume is equivalent to clock_was_set()". Absolute real-time timers are re-evaluated (`retrigger_next_event()`), so a deadline passed while suspended fires at once. A `CANCEL_ON_SET` timerfd is cancelled when the offset between `CLOCK_REALTIME` and `CLOCK_MONOTONIC` has moved, as any suspend moves it, and the read drops its expiry count: "Userspace must reevaluate anyway." Relative timers and epoll timeouts stay on `CLOCK_MONOTONIC` ("POSIX magic: Relative CLOCK_REALTIME timers are not affected by clock modifications").
  - **An absolute `clock_nanosleep` on `CLOCK_REALTIME` is the simplest exact wait.** It follows clock sets ("the new clock value shall be used to determine the time at which a thread blocked on an absolute clock_nanosleep() will wake up"), is re-evaluated at resume, and has no `ECANCELED` to handle, but never says that the clock moved. A timerfd is needed only to learn that, for example to re-plan after a backward step, or to wait inside an event loop.
  - **Probed** with a std-only Rust binary, about 60 lines of FFI into musl, unprivileged in Docker Desktop's VM: the timerfd at +2 s expired once after 2,002–2,005 ms, and the absolute `clock_nanosleep` at +1 s returned after 1,000–1,005 ms. `CLOCK_REALTIME_ALARM` failed with `EPERM`, and worked with `--cap-add WAKE_ALARM`.
- **macOS can too, through kqueue or GCD.** A kqueue `EVFILT_TIMER` with `NOTE_ABSOLUTE` takes a deadline in "the gettimeofday epoch", and with `NOTE_MACH_CONTINUOUS_TIME` keeps ticking across sleep. XNU converts the deadline once, at registration: "If the relationship between MAT and gettimeofday changes, the underlying timer does not update." So a later clock step isn't followed unless the caller re-arms the timer when told of one, as GCD does.
  - **A GCD timer at `dispatch_walltime` follows clock sets.** libdispatch arms wall timers with `NOTE_ABSOLUTE` and `NOTE_MACH_CONTINUOUS_TIME`, asks XNU for `HOST_NOTIFY_CALENDAR_SET`, and re-programs them when it comes ("calendar change may have gone past the wallclock deadline"). XNU sends that notice only on an explicit set; a wake sends only a calendar-change notice. GCD re-arms silently: unlike `CANCEL_ON_SET`, it never tells the caller that the clock moved.
  - **Probed** on macOS 27.2 with std-only FFI: at +2 s, the kqueue timer fired 0.6–5.1 ms after the wall deadline and the GCD timer 1.6–5.1 ms, over four runs each, with neither consistently first.
- **Neither timerfd nor GCD reacts to a time-zone change or DST,** as both count from the UTC epoch, as `Date.now()` and `SystemTime` do **[K]**. systemd watches `/etc/localtime` with inotify for zone changes, and macOS posts `com.apple.system.timezone`. 4.8 gives every task a `tz`, its own or a deployment default (Q11), and croner's DST rules apply (R10).
- **The crates** (R26.2 has the other crates a daemon needs).
  - **Linux:** rustix 1.1.6 (2026-10-27) has safe `timerfd_create` and `timerfd_settime`, with `ABSTIME`, `CANCEL_ON_SET` and `RealtimeAlarm`, and a safe `clock_nanosleep_absolute`, not built for Apple. nix 0.31.3 (2026-05-11) has the timerfd calls behind its `time` feature, but its `TimerFd::wait()` does `if e == Errno::ECANCELED { break; }` and returns `Ok(())`, so an expiry and a clock change look alike. timerfd 1.6.0 (2024-03-21) panics on `ECANCELED` (`panic!("Unexpected read error: {}", e)`), and tokio-timerfd 0.2.0 (2022-01-14) arms only `ClockId::Monotonic`.
  - **macOS:** libc 0.2.191 has `NOTE_ABSOLUTE`, `NOTE_LEEWAY`, `NOTE_MACH_CONTINUOUS_TIME` and `NOTE_MACHTIME`; nix's kqueue flags lack `NOTE_MACH_CONTINUOUS_TIME`. dispatch2 0.3.1 (2026-02-26, from the objc2 project) has `DispatchTime::WALLTIME_NOW`, an `unsafe fn walltime`, and timer sources made by an `unsafe fn new`. dispatch 0.2.0 (2020) and kqueue 1.2.1 have no wall-clock timer. Only the macOS side needs `unsafe`.
- **JavaScript has no wall-clock timer.** Node's documented timers (`setTimeout`, `setInterval`, `setImmediate`, `timers/promises`, `scheduler.wait`) take relative delays, and `Bun.sleep(date)` turns its date into one, once, at the call. Only FFI reaches timerfd, kqueue or GCD **[M]**: Node 26's `node:ffi` warns "FFI is an experimental feature and might change at any time", and Bun has `bun:ffi`; no FFI timer was built.
- **How established schedulers wait.**
  - **systemd v262.2** arms one absolute timerfd per clock, `CLOCK_REALTIME` or, with `WakeSystem=`, `CLOCK_REALTIME_ALARM`. A second, `CANCEL_ON_SET` timerfd armed at `TIME_T_MAX` catches every jump, resumes included, and recalculates every timer ("Time change, recalculating next elapse."). After a backward step it rewinds its last trigger ("the system clock must have been set backwards. So let's rewind our own clock"), so fires between the new time and the old one run again **[K]**. inotify on `/etc/localtime` catches zone changes. Wakeups coalesce within `AccuracySec=`, which "Defaults to 1min". Timers that elapsed during sleep run at resume, and "if a calendar timer elapsed more than once while the system was continuously sleeping the timer will only result in a single service activation" (R25.2).
  - **launchd**, in `launchd.plist(5)`, for `StartCalendarInterval`: "Unlike cron which skips job invocations when the computer is asleep, launchd will start the job the next time the computer wakes up. If multiple intervals transpire before the computer is woken, those events will be coalesced into one event upon wake from sleep." A `StartInterval` firing due during sleep "will be missed due to shortcomings in kqueue(3)". The last open-source launchd, launchd-842.92.1, armed one `NOTE_ABSOLUTE|NOTE_SECONDS` kqueue timer for the earliest calendar event and re-checked it against `time(NULL)` on every IPC request. Today's launchd is closed, so how it waits now is unconfirmed.
  - **cronie 1.7.2** (2024-04-08, still the newest) sleeps to the next minute ("Try to just hit the next minute.") and classifies how far its wall clock moved, in local time (`time(NULL) + GMToff`), where a DST change is a jump: one minute is normal; up to 5 minutes forward runs each missed minute; up to 3 hours forward, as at a DST start, runs wildcard jobs once and fixed-time jobs for each missed minute; up to 3 hours back runs wildcard jobs only; more, either way, jumps to the current minute ("time has changed a *lot*, jump virtual time, and run everything").
  - **busybox crond 1.38.0** sleeps to the next minute, or 10 s while jobs run. A forward gap under an hour runs the jobs due in (t1, t2] once; beyond an hour either way it logs "time disparity of %ld minutes detected" and runs nothing; a backward step runs nothing.
  - **croner 11.0.0** (2026-10-26; R8 has 10.0.1) caps each `setTimeout` at 30 s and fires only once `new Date()` has reached the target, re-arming otherwise: "due to a problem with certain javascript engines not behaving well when the computer is suspended, we'll never wait more than 30 seconds between each trigger" (R25.3).
  - **OpenClaw v2026.11.1** caps its scheduler's timer at 60 s (`MAX_CRON_TIMER_DELAY_MS = 60_000`), re-checks `Date.now()` against the absolute deadline when it fires, and unrefs it: "Native timers alone cannot notice a clock step or suspend on every supported platform." (R25.4)
  - **supercronic v0.2.51** waits on one `time.After(delay)` per job for the whole delay. Given Go's timers, it fires late by any suspend and sees a clock step only at its next iteration **[M]** (R25.4).
- **Inside a container, none of them waits better than a capped loop.** The Debian-based Bun and Node images run neither systemd nor launchd **[K]**. There supercronic waits on one monotonic timer, and cronie and busybox poll each minute (D6, R9).
- **The minimal correct loop is the same in TypeScript and Rust:** `let checked = Date.now(); for (;;) { const next = nextFireAfter(checked); await sleep(Math.max(0, Math.min(CAP, next - Date.now()))); const now = Date.now(); if (now < checked) { checked = now; continue; } if (now < next) continue; runFiresIn(checked, now); checked = now; }`. Rust's, std only, sleeps with `thread::sleep(next.duration_since(SystemTime::now()).unwrap_or_default().min(CAP))` and reads `SystemTime::now()`. croner and OpenClaw use this capped form, and cronie and busybox approximate it at 60 s.
  - After a sleep, suspend or clock step, a fire is late by at most the cap, if the wall clock is right at wake **[M]**. In steady state the last sleep ends at the fire, within 0–5 ms as measured.
  - What is due is decided from the wall clock after every wake, as any design must: a timerfd's `ECANCELED` drops its expiry count, and a capped loop wakes early by design.
  - On a backward step it re-plans from the new time, as systemd does; cronie runs only wildcard jobs then, and busybox nothing. What a missed stretch runs is the catch-up policy: C6's `catch_up` (4.8), against systemd's and launchd's single coalesced run.
  - With this loop, Rust gains nothing in correctness over TypeScript; only the wall-clock timers above, OS by OS, do better.
  - 4.8's tick is such a loop with a 15 s cap, but it runs every 15 s rather than sleeping to the next `next_run_at`, so a fire waits up to 15 s even when nothing slept.
- **Docker Desktop steps its VM's clock every 30 s.** In Docker Desktop 4.98's VM, a read-only `adjtimex` showed `STA_UNSYNC` and a `maxerror` of 16 s: the kernel's NTP discipline is off. A `CANCEL_ON_SET` timerfd armed ten years ahead, as systemd's `time_change_fd()` arms one, got `ECANCELED` every 30 s for 180 s, as the offset between `CLOCK_REALTIME` and `CLOCK_MONOTONIC` moved by +544, −862, +1,314, −5,046, +5,552 and +402 µs. Docker's 2019 post describes an SNTP client that "calls settimeofday to bump the clock" every 30 s, forward only; here two of six steps went back.
  - There the exact timerfd design wakes every 30 s anyway, as often as a 30 s capped loop, and a backward-step rule must tolerate steps of a few milliseconds.
  - A VM frozen while its host sleeps goes through no guest resume **[K]**, so only the stepper puts its wall clock right, and a fire can be late by the cap plus the time to the next step **[M]**. Whether Docker Desktop's VM's monotonic clock stops while the Mac sleeps, and how far its wall clock lags after, weren't measured.
- **What a wakeup costs.** On the Mac, each wakeup slept, read the wall clock and compared five next-fire times, and its cost is the CPU between the first and last wakeup divided by their number. The per-wakeup probes ran one at a time, and the resident ones side by side for 150–180 s. Each figure is a single run under varying load, and repeat runs differed by about a factor of two: read them as good to about that factor.

| On an Apple-silicon Mac, macOS 27.2 | Rust 1.99.1 std | Node 26.13.0 | Bun 1.4.4 |
|---|---|---|---|
| CPU per wakeup at 10 ms, 100 ms and 1 s spacing | 8–17, 12 and 11–15 µs | 40–97, 71–94 and 129–182 µs | 24–43, 133–144 and 632–1,096 µs; 23, 58 and 99 µs with `BUN_GC_TIMER_DISABLE=1` |
| A 10 ms sleep or timer took, on average | 11.8–13.2 ms | 10.9–11.5 ms | 10.9–11.3 ms |
| Resident, 30 s cap: extra CPU per wakeup | about 11 µs | about 99 µs | about 180 µs, noisy |
| Resident: context switches per 30 s-cap wakeup, and with no timer due | about 1; none | about 2–3; none | about 10–12 a second either way; 0.17 a second with `BUN_GC_TIMER_DISABLE=1` and a 30 s cap |
| Resident, no timer due: CPU | 30 µs in 180 s | 1,112 µs in 180 s, mostly a final `console.log` | about 0.17–0.20 ms a second; 0.008 with `BUN_GC_TIMER_DISABLE=1` and a 30 s cap |
| Threads | 1 | 7 | 8, falling to 2 by 147 s |
| A day of 30 s or 60 s caps (2,880 or 1,440 wakeups) | about 32 or 16 ms | about 0.29 or 0.14 s | about 0.5 or 0.26 s, plus the idle GC |

- **The cap costs next to nothing.** A day of 30 s caps costs Node about as much CPU as one Node run's start-up and TypeORM import (about 0.25 s, R26.3), Bun about twice that, and Rust about an eighth. A 60 s cap halves it, and allows a minute's lateness after a wake.
- **Bun's runtime wakes itself.** With no timer due, a resident Bun process kept waking (table), and the same bare loop in Rust and Node didn't. The cause is its idle-GC timer, which "adds a 1 s / 30 s idle `collect_async()` so a process that stops allocating still releases memory": `BUN_GC_TIMER_DISABLE=1` brought Bun to Node's level, and `BUN_IDLE_GC_SECONDS=0`, which stops only the idle full collections, didn't. If the default rate held for a day, it would be about 17 s of CPU, some 30 times a 30 s cap's cost. With the timer off, a Bun process that stops allocating is no longer collected while idle, and the knob is documented only in that comment (R26.3 measures the whole daemon).
- **Apple's guidance.** "If your app has more than one wakeup per second when it should be idle, investigate why". A 30 s cap is about 0.03 wakeups a second; Bun's GC timer, every second in its fast mode, reaches the limit on its own. XNU's default timer slack is an eighth of the time remaining, at most 1 ms, for ordinary threads, and up to 100 ms for background ones. Apple says the default "is usually insufficient to allow multiple timers to fire during a single wakeup". Latency-QoS tiers allow up to 75 ms, and a user-idle heuristic adds to it, so 1 ms is a default, not a ceiling. App Nap is documented for apps only; for a launchd job without `ProcessType`, "the system will apply light resource limits to the job, throttling its CPU usage and I/O bandwidth".
- **What CI can test.** GitHub-hosted Linux and macOS runners are new VMs, and "The Linux and macOS virtual machines both run using passwordless `sudo`", so a job can step the clock (`sudo date -s` on Linux); the single-CPU `ubuntu-slim` runners are containers. Suspend can't be tested there. In Docker Desktop's VM, the `ECANCELED` path runs every 30 s on its own.
- **Open:** behaviour across a real sleep, suspend or clock step, derived above but not reproduced; Bun's idle rate after 3 minutes, and over hours; whether App Nap or launchd's light limits coalesce a command-line daemon's timers, as idle wakeups couldn't be counted on a busy Mac; whether Docker Desktop's VM's monotonic clock stops while the Mac sleeps, and how far its wall clock lags after; how today's launchd waits; macOS 27's kernel source.
- **Sources:** rust-docs 1.99.1: `library/std/src/sys/time/unix.rs`, `library/std/src/time.rs`, `library/std/src/sys/thread/unix.rs` and `library/std/src/thread/functions.rs`; Rust issue 113752; macOS 27.2's `clock_gettime(3)` and `launchd.plist(5)`; the macOS SDK's `mach/mach_time.h`, `dispatch/time.h` and `notify_keys.h`; git.kernel.org/pub/scm/docs/man-pages/man-pages.git at man-pages-6.20: `man/man2/clock_getres.2`, `man/man2/timerfd_create.2` and `man/man2/clock_nanosleep.2`; git.kernel.org torvalds/linux at v7.3: `kernel/time/{timekeeping,hrtimer,sleep_timeout}.c`, `fs/timerfd.c` and `fs/eventpoll.c`; github.com/apple-oss-distributions/xnu at xnu-12377.121.6: `bsd/sys/event.h`, `bsd/kern/{kern_event,kern_sig}.c`, `osfmk/kern/{clock,sync_sema,timer_call,host_notify}.c` and `osfmk/arm/arm_timer.c`, and its tags; github.com/apple-oss-distributions/libdispatch at libdispatch-1542.100.32: `src/event/event_kevent.c`; github.com/apple-oss-distributions/Libc at Libc-1752.120.2: `gen/nanosleep.c`; github.com/apple-oss-distributions/launchd at launchd-842.92.1: `src/core.c`; static.crates.io tokio-1.54.1 (`src/time/clock.rs`, `src/runtime/time/mod.rs`) and mio-1.2.4; github.com/tokio-rs/tokio issue 3185; crates.io: rustix 1.1.6 (`src/thread/clock.rs`, `src/time/timerfd.rs`), nix 0.31.3, timerfd 1.6.0, tokio-timerfd 0.2.0, kqueue 1.2.1, libc 0.2.191, dispatch2 0.3.1 and dispatch 0.2.0; github.com/golang/go at go1.27.3: `src/runtime/{sys_darwin_arm64.s,sys_linux_arm64.s,netpoll_kqueue.go,netpoll_epoll.go}`; issues 36141 and 24595; github.com/aptible/supercronic v0.2.51 `cron/cron.go`; github.com/libuv/libuv v1.53.0 `src/unix/{darwin,linux,kqueue}.c` and PR 2894; github.com/nodejs/node v26.13.0 `doc/api/timers.md` and `deps/uv` (`include/uv/version.h`, `src/unix/darwin.c`); github.com/oven-sh/bun bun-v1.4.4: `src/bun_core/util.rs`, `src/runtime/timer/mod.rs`, `src/jsc/bindings/BunObject.cpp`, `src/jsc/GarbageCollectionController.rs` and `packages/bun-usockets/src/eventing/epoll_kqueue.c`, and the tag's file tree; github.com/systemd/systemd v262.2: `src/core/{timer,manager}.c`, `src/libsystemd/sd-event/sd-event.c`, `src/basic/time-util.c` and `man/systemd.timer.xml`; github.com/cronie-crond/cronie cronie-1.7.2: `src/cron.c` and `src/macros.h`; git.busybox.net/busybox tag 1_38_0: `miscutils/crond.c`; github.com/hexagon/croner 11.0.0 `src/croner.ts`; github.com/openclaw/openclaw v2026.11.1: `src/cron/service/timer-execution-timeout.ts` and `src/cron/store/scheduler-actor.worker.ts`; developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html and /AppNap.html; docker.com/blog/addressing-time-drift-in-docker-desktop-for-mac; docs.github.com/en/actions/reference/runners/github-hosted-runners; std-only Rust and JavaScript probes on Rust 1.99.1, Node 26.13.0 and Bun 1.4.4, on an Apple-silicon Mac (macOS 27.2) and in Docker Desktop 4.98's Linux VM (kernel 7.0.14-linuxkit, `debian:trixie-slim`); 4.8 and C6.

**R26.2 Existing daemons, and the Rust crates a daemon would use.** Run and read on 2026-11-08. supercronic v0.2.51, go-crond 26.10.0, ofelia v1.1.0, the Rust parsers and `tokio-cron-scheduler` ran in Debian 13.7 arm64 containers in Docker Desktop's Linux VM on an Apple-silicon Mac under other load, with Go 1.27.3 and Rust 1.99.1. croner 11.0.0 ran on Bun 1.4.4 and Node 26.13.0 for comparison. fcron 3.4.1, jobber 1.4.4, yacron 0.19.0, dcron 4.5, cronie 1.7.2, `job_scheduler_ng` and `cron_tab` were read, not run. An independent checker re-ran most of the probes, and no real suspend was tested. **[H]** unless marked.
- **supercronic: where it runs.** v0.2.51 (2026-10-21) ships Linux binaries only (386, amd64, arm and arm64), since `build.sh` sets `GOOS="linux"`. Homebrew has no formula (open issue #242, 2026-07-28). Debian packages it, at 0.2.45-1, only in forky and sid. It isn't in trixie, the base of `oven/bun:1.4.4` and `node:slim` (Debian 13.7). The source builds for darwin/arm64 with `CGO_ENABLED=0`, giving a 14.7 MB Mach-O file that wasn't run.
- **How it waits.** Each job has one goroutine and one uncapped timer: `nextRun = expression.Next(nextRun)`, `delay := nextRun.Sub(now)`, `case <-time.After(delay):`. The job then runs without reading the clock again. Go 1.27.3's timers count on `CLOCK_MONOTONIC` on Linux and `mach_absolute_time` on darwin, and both stop during sleep. Go issue #24595 ("use CLOCK_BOOTIME, not CLOCK_MONOTONIC") was withdrawn on 2019-12-13 as "ill advised". So a fire after a suspend is late by the length of the suspend, and a clock step makes a job run early (a backward step) or late (a forward step) by the size of the step **[M]**: read from the code, not observed (R26.1).
- **Missed fires and overlap.** It never catches up and keeps no state. A fire missed while a job ran is logged ("job took too long to run: it should have started 17.011103834s ago") and dropped (`nextRun = now; continue`). Nothing is written to disk, and `@reboot` is unsupported (#30, open since 2018-04-10). Overlap is off by default: a job firing every 3 s that slept 20 s logged "not starting: job is still running since … (3s elapsed)", then (6s elapsed) and so on, at each skipped fire. `-overlapping` allows overlap. That is C6's `overlap: skip`, with nothing like `queue` (D16).
- **Shutdown and reload.** It has no per-run deadline and forwards no SIGTERM. Jobs start in their own process group (`Setpgid: true`). Shutdown and reload (SIGUSR2 or `-inotify`) both log "waiting for jobs to finish" and wait. Sent TERM mid-job, it logged "received terminated, shutting down" and exited 0 only when the job's `sleep 20` ended, unsignalled. Issue #62, asking for forwarding, was closed in 2020, and a 2026-01-30 comment still asks for "a optional command line option to propagate the SIGTERM". As PID 1 it re-executes itself with `-no-reap` as the worker and stays on as a reaper that forwards signals to it. Under `docker stop`, then, a job gets no SIGTERM, only the kill when Docker's grace period ends, 10 s by default **[K]**.
- **Environment, working directory and logs.** Jobs get supercronic's environment plus the crontab's `VAR=value` lines, which form one map for the whole file, so a variable's last value applies to every job. After `FOO=one` and `FOO=two`, a job saw `two`. `SHELL` and `CRON_TZ` are honoured. Commands run through `/bin/sh -c` in supercronic's own directory, so `cd /repo && …` works. `supercronic -test` printed "crontab is valid" for `0 7 * * * cd /repo && bun packages/agent/src/main/main.ts tasks/x.md`. With `-json`, a child's JSON line arrives escaped inside `"msg"`. With `-passthrough-logs` it arrives raw, while supercronic's own lines stay in logfmt. An exit code appears only as text: "error running command: exit status 3". Together with the reaper, this answers R9's complaints about classic cron in containers: the environment, the logs and PID 1.
- **A DST runaway (issue #86).** Its `cronexpr` mishandles jobs in New York's spring-forward gap. From 2027-03-13T12:00, `30 2 * * *` gives 2027-03-14T01:30-05:00. Asked again from 01:31 or 01:59:59, it returns that same instant, which is by then in the past. `*/30 2` and `0 2` stick at 01:00-05:00, and `0 7` is right. A negative delay sets `nextRun = now` and loops. A replay of `cron.go`'s loop against a fake clock (not the binary), with a 120 s job, ran the job once at 01:30 EST, before the gap. It then logged about 168 million warnings until 03:00 EDT, assuming 10 µs per iteration. Issue #86 ("Daylight Savings Issue", open since 2021-03-16) reports a 40 GB log, and a 2024-10-30 comment says "DST issue still exists". In Berlin, its `cronexpr` gave 03:30 CEST for `30 2 * * *`, and put fixed times in the fall-back hour at the second pass. In New York, it gave `30 1 * * *` once, at the EDT pass.
- **Footprint.** The linux-arm64 binary is 13.8 MiB, static and unstripped, so D26's glibc floor doesn't touch it. Idle in `debian:trixie-slim`, it held 12.3-16.0 MB RSS across runs, 3.1-6.8 MB of it anonymous, in 7 threads, with 0 context switches and no CPU in 30 s. As PID 1, the reaper and the worker came to 18.85 MiB in `docker stats` in one run. In another they came to 21.81 MiB, counting a shell started with `docker exec`. The split between the two processes varied (R26.3 compares the runtimes).
- **go-crond 26.10.0** (2026-10-21) ships darwin and Linux binaries (9.2 MB for darwin/arm64) and has `--working-directory` (default `/`). It needs `--allow-unprivileged` to run as non-root, and SIGHUP reloads it. It is built on robfig/cron v3.0.1 (2020) without `SkipIfStillRunning`, so runs overlap, and it doesn't catch up. It sleeps on one uncapped timer but checks the wall clock when the timer fires (`if e.Next.After(now) …`). So a backward clock step can't run a job early, but a suspend still makes it late **[M]**. Idle, it used 13.1 MB RSS and 7 threads, with no context switches in 30 s.
- **fcron 3.4.1** (2026-06-06) can catch up after downtime and after a suspend, with state on disk. `bootrun` runs a missed job once "at fcron's startup (or system's resume after suspend/hibernation) if it should have run during system down time". Without it the job is just rescheduled. `runatreboot` and `runatresume` run a job at every boot or resume. fcron saves state every 1800 s and sleeps until the next job or save. On Linux it also arms a `timerfd` on `CLOCK_REALTIME` with `TFD_TIMER_ABSTIME | TFD_TIMER_CANCEL_ON_SET`, so a clock change or a resume wakes it. It takes the length of a suspend as `CLOCK_BOOTTIME` minus `CLOCK_MONOTONIC`. On other systems, a wake more than 5 s late counts as a resume (`time_diff > 5`).
  - **Against it:** it is a system daemon that runs as root, unless built `--with-run-non-privileged`, which runs every job as one user. It has no per-job kill timeout (`until` only limits how long a job waits for the load average to drop). Neither Homebrew nor Debian packages it. Its readme lists Darwin/MacOS-X beside FreeBSD 4.2, OpenBSD 2.8, Solaris 8 and AIX 4.3.3. That is a historical list, not evidence of current macOS support.
  - **Mail is only its default.** The `stdout` option reads "If fcron is running in the foreground, then also let jobs print to stderr/stdout instead of mailing or discarding it", and `mail(false)` turns mail off. fcron also ANDs day of month with day of week by default (`dayand`), unlike Vixie cron and croner. Any schedule that sets both would silently change meaning.
- **jobber 1.4.4** (2020-06-02) is the only cron daemon among Homebrew core's 8,709 formulae. Its service runs `jobbermaster` with `require_root: True`. It keeps a run log and status and has error policies (Stop, Backoff, Continue). But it drops missed runs and waits on an uncapped Go timer inside a wall-clock loop. Whether it lets runs overlap wasn't checked.
- **yacron 0.19.0** (Python, 2023-03-11) wakes every minute and checks whether each schedule matches the current minute. Minutes missed during a suspend or downtime are lost. It does have `concurrencyPolicy` (Allow, Forbid, Replace), `executionTimeout` with `killTimeout` (default 30), `env_file`, and retries and reports on failure. Schedules are in UTC by default (Q11).
- **dcron 4.5** (2011-05-01) scans every minute. Its crond(8) says: "Forwards time-changes of an hour or less (or if the computer is suspended and resumed again within an hour) will run any missed jobs exactly once." `@daily`-style lines with `ID=` keep timestamps in `/var/spool/cron/cronstamps`, which catch them up after longer downtime, as anacron does. cronie 1.7.2 (2024-04-08) runs missed fixed-time jobs after forward jumps of up to 3 h. It follows Vixie's day rule: AND when either day field starts with `*`, otherwise OR (R25.2).
- **ofelia v1.1.0** (netresearch's fork, 2026-11-02) ships darwin builds and a `local` job type with `dir`, `environment`, `no-overlap` (off by default) and `run-on-startup`. At "Ofelia's fixed 24-hour execution limit" it sends SIGTERM to the process group, then SIGKILL 10 s later. `save-folder` keeps a log and a JSON file for each run. But its daemon won't start without a Docker socket, even with only a `[job-local]` entry and `--docker-events=false --docker-no-poll`: "failed to connect to Docker daemon … dial unix /var/run/docker.sock: connect: no such file or directory". It can't run in mecha-gremlin's container as it is.
- **No established Rust daemon.** The crontab daemons on crates.io have no users:
  - crontab-rs 0.2.0 (2026-09-15), "A cronie/Vixie-compatible cron daemon and crontab utility written in Rust", with 41 downloads, no stars and every push on one day;
  - koku 0.1.1 (2026-07-09), with 283 downloads;
  - flashcron 0.1.0 (2025-12-09), with 48;
  - lxcrond 0.3.0 (2025-04-08), with 3,687 and no repository;
  - crond 0.1.1 (2021).

  The nearest project, moadim-io/daemon (57 stars, v3.13.0 on 2026-11-05), is an app for "scheduling AI-agent routines via UI, REST, and MCP". It is built on `tokio-cron-scheduler` 0.15.1, croner 4, axum 0.8 and rmcp 3.1.2.

| Daemon | Release | On macOS | How it waits | Missed fires | Overlap by default | Per-run deadline | Run records |
|---|---|---|---|---|---|---|---|
| supercronic (Go) | v0.2.51, 2026-10-21 | builds; no binary or formula | an uncapped timer per job, no clock re-read | dropped; late after a suspend **[M]** | skipped, with a warning | none; SIGTERM not forwarded | logs, Prometheus |
| go-crond (Go) | 26.10.0, 2026-10-21 | binaries | an uncapped timer, then a wall-clock check | dropped; late after a suspend **[M]** | allowed | none | logs, Prometheus |
| fcron (C) | 3.4.1, 2026-06-06 | only in an old readme; no formula | until the next job or the 1800 s save; on Linux also a cancel-on-set `timerfd` | `bootrun`: once, at start or resume; state on disk | one at a time (`exesev` allows more) | none | mail by default; stdout in the foreground |
| jobber (Go) | 1.4.4, 2020-06-02 | Homebrew core, as a root service | an uncapped timer in a wall-clock loop | dropped; late after a suspend **[M]** | not checked | none | run log, status, error policies |
| yacron (Python) | 0.19.0, 2023-03-11 | pip | wakes each minute and checks it | lost | allowed | `executionTimeout`, `killTimeout` | failure reports |
| dcron (C) | 4.5, 2011-05-01 | none found | scans each minute | run once after jumps of up to 1 h; `@freq` jobs from stamps | skipped | none | stamp files |
| ofelia, netresearch fork (Go) | v1.1.0, 2026-11-02 | binaries, but it needs a Docker socket | go-cron v0.19.0, a robfig/cron fork | `run-on-startup` only | allowed; `no-overlap` opt-in | a fixed 24 h for `local` jobs | per-run files |

- **What none of them gives as shipped:** catch-up after a suspend or downtime, run records and a per-run deadline, on both macOS and the Debian 13 images.
  - supercronic fits the container best, but it has none of the three, forwards no signal, ships no macOS build and has the DST runaway.
  - fcron can catch up after downtime and after a suspend, but it runs as root, has no per-run deadline, mails by default and is packaged for neither target.
  - dcron catches up after long downtime only for `@freq` jobs, and its last release was in 2011.
  - ofelia needs a Docker socket.
  - go-crond, jobber and yacron each lack two or more of these.

  Outside this comparison, launchd's calendar jobs merge fires missed during sleep into one run on wake (R25.2). As long as schedules live in the database, any crontab is also a copy of them, which is 4.8's first reason against an external cron (D6).
- **What a wrapper can add.** coreutils `timeout` is at `/usr/bin/timeout` in both `oven/bun:1.4.4` and `node:slim`. Neither image has cron or busybox (or `ps`, Q24). A crontab line can bound a run with `timeout`, and a wrapper script can write run records. Neither was tried under supercronic. Only catch-up has no hook: supercronic invokes nothing for a missed fire and has no `@reboot`. Catch-up would need a separate step in the entrypoint, which runs only when the container starts.
- **croner-rust 4.0.3** (2026-11-04) is maintained and widely used. It has 12,471,848 downloads, 5,601,588 of them in the last 90 days, 126 reverse dependencies, 94 stars and 4 open issues. Its dependencies are `derive_builder` and `strum`, with `chrono` (the default), `jiff` and `serde` optional. With `jiff`, the lockfile holds 30 crates, mostly proc-macro build dependencies. It finds the previous fire as well as the next, which catch-up needs. For a daily 07:00 job, from 2026-11-08T12:00 in New York, `find_previous_occurrence` gave 07:00-05:00 that day, and the next fire was 2026-11-09T07:00-05:00. Computing a next fire took 0.4-0.7 µs in a container, against 9-14 µs for croner JS's `nextRun` on the Mac.
- **It agrees with croner JS on common patterns.** croner-rust 4.0.3, with `chrono` or `jiff`, and croner 11.0.0 (2026-10-26) gave the same fire times. croner JS was run on Bun 1.4.4 and Node 26.13.0 (D19). They matched on 20 five-field cases, and again on a second set of 11 that adds #67's London, Los Angeles and New York gap cases. croner is the library D12 chose, and R8 read it at 10.0.1. The DST cases covered gaps and overlaps in New York, Berlin and Lord Howe. Both OR a restricted day of month with a restricted day of week. Both count only a literal `*` as unrestricted (`star_dom = parts.get(3).is_some_and(|&p| p == "*")`; `if (parts[3] == "*")`). So `0 0 */10 * 1` runs every Monday and on days 1, 11, 21 and 31, whereas cronie ANDs it and runs only on Mondays that fall on those days. `0 0 1 * 1` runs on Mondays and on the 1st, and weekdays 0 and 7 both mean Sunday.
- **But not on every pattern: the February bug.** For `0 0 1 * 5` in UTC from 2023-02-27T12:00Z, croner 11.0.0 gives 2023-03-03, 03-10 and 03-17, skipping Wednesday 1 March. croner-rust 4.0.3 and croner 11.0.1-dev.2 give 03-01, 03-03 and 03-10. croner JS's `_findMatch` walks to day 31 whatever the month's length, so "2023-02-31" becomes Friday 2023-03-03. PR #437 ("Do not match weekdays on days past the end of the month") was merged to `dev` on 2026-11-04, but npm's `latest` is still 11.0.0. A scheduler on 11.0.0 would skip such 1st-of-month runs until a release carries the fix.
- **DST: Vixie's rule, but for single values only.** croner 11.0.0's changelog says "DST handling aligned with croner-rust and Vixie cron, deviating from OCPS 1.4 §4.3.1". In New York, `30 2 * * *` on 2027-03-14 ran at 03:00 EDT. `30 1 * * *` on 2027-11-07 ran once, at the EDT pass, and `*/30 1 * * *` ran at both passes. So two of the three croner 10.0.1 behaviours that 4.8 pins in tests have changed (R10). A gap job no longer runs an hour late, and interval jobs no longer skip the repeated hour. But croner treats any list or range in the minute or hour field as an interval: `30 1,2 * * *` ran at 01:30 EDT, 01:30 EST and 02:30 EST in both lines. cronie marks a job as a wildcard job only for a leading `*`, so it would run 01:30 once **[M]**: read, not run. croner's dev commit 87505074a7 (2026-11-04) agrees that "Vixie cron treats them as fixed-time jobs". It adds an unreleased `fixedTimeRule` option.
- **Both lines are young.** croner-rust 4.0.1 (2026-10-02) fixed "@weekly with Quartz weekdays". 4.0.3 fixed "7L (last Sunday) never matching" and #67: 4.0.2 ran a daily job twice when it fell in the hour before a spring-forward gap. London's `0 0 * * *` ran at 00:00 GMT, then again at 02:00 BST. croner JS 11.0.0 doesn't have #67. Its `dev` branch added #437 (2026-11-04) and "Fix @weekly with alternativeWeekdays (#447) (#448)" (2026-11-08). The two agree on common patterns, but each would need pinning and its own DST and day-rule tests.
- **The other parsers.** `cron`, `cronexpr` and `cron-parser` each skip a time in the spring-forward gap and run a time that fall-back repeats twice.
  - `cron` (zslayton) 0.17.0 (2026-06-18) is the most downloaded (29.8 million downloads, 476 reverse dependencies). It requires a seconds field, so `0 7 * * *` fails to parse. It numbers weekdays 1-7 from Sunday and rejects 0. It ANDs the day fields: `0 0 0 1 * 1` gave only Sundays that fall on the 1st. In a fall-back hour its iterator goes back in real time: `0 */30 1 * * *` in New York gave 05:00Z, 06:00Z, 05:30Z, 06:30Z. Issues #13 (optional seconds, open since 2017-02-14), #113 and #141 ("Support OR semantics", 2025-10-05) are open.
  - `cronexpr` 1.7.1 (2026-11-03, `jiff` only) follows Vixie's day rule exactly: for `0 0 */10 * 1` it gives the Mondays that fall on days 1, 11, 21 and 31. It needs the time zone written into the expression.
  - `cron-parser` 0.12.0 (2026-09-24) ANDs the day fields: "Day-of-month and day-of-week use AND semantics when both are restricted". It rejects weekday 7.
  - `saffron` 0.1.0 (2021-02-01) works in UTC only (`next_after` takes `DateTime<Utc>`). It numbers Sunday as 1 and rejects 0.
- **Scheduler crates.**
  - `tokio-cron-scheduler` 0.15.1 (2025-10-28) polls: `tokio::time::sleep(Duration::from_millis(500)).await; let now = Utc::now();`, then compares the time with each job's next tick. So it does check twice a second. Idle, it held 2.2 MB RSS and used 123 context switches and 7.6 ms of CPU in 30 s. It requires a seconds field (`Seconds::Required`), pulls in croner 3.0.1, `chrono-tz` and `uuid`, and has 39 open issues.
  - `job_scheduler_ng` 2.5.0 (2026-07-27) is driven by the caller, who calls `tick()` and may sleep for an uncapped `time_till_next_job()` in between. `tick()` replays missed runs, up to 1,000 a tick. But it supports only `FixedOffset` zones, UTC by default, so a local-time schedule shifts by an hour across DST.
  - `cron_tab` 0.2.14 (2026-06-27) sleeps on one uncapped `crossbeam_channel::after` timer, then compares the wall clock. It parses with `cron` ^0.16.
- **What a Rust daemon would be built from.** Small, current crates cover what it needs **[M]**:
  - croner 4.0.3 with `jiff` 0.2.40 (2026-11-07), for schedules and time zones;
  - std's `Command::current_dir` and `CommandExt::process_group`, for child processes;
  - `libc` 0.2.191 (2026-10-16), to kill a process group and for the timers that keep counting through sleep (R26.1);
  - `signal-hook` 0.4.6 (2026-10-31), for signals;
  - `serde_json` 1.0.154 (2026-10-11), for logs;
  - `rusqlite` 0.41.1 (2026-10-28), if the daemon writes run records itself (R17.2).

  A build from croner, `jiff` and std needed no async runtime. But the prototype covers only the loop: next fire, capped sleep, wall-clock check and `sh -c` spawn (R26.3). The group kill, the deadline, catch-up state and signals are untried. The waiting is left to the daemon: std and tokio sleep on clocks that stop during sleep, so a Rust daemon that sleeps for the whole delay is late after a suspend, as supercronic is (R26.1). `jiff` can read the images' zone files: tzdata 2026c in `oven/bun:1.4.4`, and 2026f in `node:slim`.
- **Open:**
  - No real suspend was tested. Lateness after one is inferred from code and clock sources, for Go, for Rust and for Docker Desktop's Linux VM while the Mac sleeps.
  - supercronic's DST runaway came from its `cronexpr` and a replay of its loop, not from the binary under a changed clock.
  - `timeout` under supercronic and supercronic's darwin build weren't run. fcron, jobber, yacron and dcron weren't run or measured.
  - Whether jobber lets runs overlap, and how ofelia behaves after a suspend, weren't checked.
  - How cronie handles lists in a fall-back hour was read from the source, not run.
- **Sources:** github.com/aptible/supercronic: releases/tag/v0.2.51; `build.sh`, `main.go`, `reaper.go`, `cron/cron.go`, `crontab/crontab.go` and `cronexpr/` at v0.2.51; issues #30, #62, #86 and #242; qa.debian.org/madison.php for supercronic and fcron; formulae.brew.sh/api/formula.json, and /api/formula/ for supercronic, fcron and jobber; github.com/golang/go: `src/runtime/sys_linux_arm64.s` and `src/runtime/sys_darwin_arm64.s` at go1.27.3; issue #24595; github.com/webdevops/go-crond: releases/tag/26.10.0, and `config/opts.go`, `go.mod` and `runner.go` at 26.10.0; github.com/robfig/cron `cron.go` at v3.0.1; github.com/yo8192/fcron at ver3_4_1: `database.c`, `suspend.c`, `fcron.c`, `config.h.in`, `configure.in`, `doc/en/fcrontab.5.sgml` and the readme; fcron.free.fr; github.com/dshearer/jobber `jobberrunner/queue.go` at v1.4.4; github.com/gjcarneiro/yacron `yacron/cron.py` and `yacron/config.py`; pypi.org/project/yacron; github.com/dubiousjim/dcron `crond.8`; github.com/cronie-crond/cronie `src/cron.c` and `src/entry.c` at cronie-1.7.2; github.com/netresearch/ofelia: releases/tag/v1.1.0, `docs/jobs.md` at v1.1.0 and the README; crates.io: croner, cron, cronexpr, cron-parser, saffron, tokio-cron-scheduler, job_scheduler_ng, cron_tab, jiff, libc, signal-hook, serde_json, rusqlite, crontab-rs, koku, flashcron, lxcrond and crond; crates.io/search?q=cron%20daemon; crate sources: `cron` 0.17.0 (`parsing.rs`, `days_of_week.rs`, `schedule.rs`), `job_scheduler_ng` 2.5.0 (`src/lib.rs`) and `cron_tab` 0.2.14 (`cron.rs`); `cron-parser` 0.12.0's README; github.com/moadim-io/daemon `Cargo.toml`; github.com/Hexagon/croner-rust: releases v4.0.1 and v4.0.3, `src/parser.rs` at v4.0.3, issue #67; github.com/Hexagon/croner: `CHANGELOG.md`, `src/pattern.ts`, `src/croner.ts` and `README.md` at 11.0.0; PR #437; commit 87505074a7; `dev` commits for #447 and #448; npmjs.com/package/croner (dist-tags); github.com/zslayton/cron issues #13, #113 and #141; github.com/mvniekerk/tokio-cron-scheduler `src/scheduler.rs` and `src/job/builder.rs` at 0.15.1; github.com/rust-lang/rust `library/std/src/sys/time/unix.rs` and `library/std/src/sys/thread/unix.rs` at 1.99.1; github.com/tokio-rs/tokio issue #3185; launchd.plist(5); probes in Debian 13.7 arm64 containers (`debian:trixie-slim`, `golang` with Go 1.27.3, `rust` with Rust 1.99.1, `oven/bun:1.4.4`, `node:slim` with Node 26.13.0) in Docker Desktop's Linux VM on an Apple-silicon Mac, and croner JS's timings on the Mac itself.

**R26.3 The same daemon in Rust, Bun and Node, measured.** A minimal cron daemon was written four ways and run on 2026-11-08. The Rust builds used Rust 1.99.1 with croner 4.0.3 (2026-11-04), chrono 0.4.45 and tokio 1.54.1. The TypeScript build used croner 11.0.0 (2026-10-26; R8 read 10.0.1) on Bun 1.4.4 and Node 26.13.0. The Linux figures come from Debian 13 arm64 images (glibc 2.41), with the binaries baked in, in Docker Desktop's Linux VM (Engine 29.9.2, kernel 7.0.14-linuxkit). The macOS figures come from an Apple-silicon Mac under other load and memory pressure. An independent fact-check re-ran the soaks, cold starts and builds, and added probes of its own. **[H]** unless marked. Absolute timings and CPU costs carry about a factor-2 uncertainty; the ratios are robust.
- **Four builds, one behaviour.**
  - **The builds:** Rust on the standard library alone; Rust with croner and std threads (an `mpsc` `recv_timeout`, and a waiter thread per child); Rust with croner and tokio's current-thread runtime (`select!` on a channel and a sleep); and TypeScript with croner, the library D12 proposes (`setTimeout` and the child's `exit` event). The TypeScript daemon ran on Bun, and on Node both as TypeScript and as plain JavaScript.
  - **What each did:** it slept until the earliest next fire or 60 s, whichever came first, and checked the wall clock on waking. It started due lines through `/bin/sh -c`, logged a JSON record for each start, skip and exit, and skipped a line whose previous child was still running. It reloaded the crontab when the file's mtime changed.
  - **The test:** each of the ten builds, six in the container and four on macOS, ran for 125 s against 3 lines that fire every minute (`sleep 5`, `/bin/true`, `sleep 90`) and 7 that don't. All started the three lines at :00.002–:00.032 and skipped `sleep 90` at the next minute. That child exited after 90,001–90,018 ms. The std-only next-fire code passed its tests: `0 0 29 2 *` from 2026-11-08 gives 2028-02-29T00:00:00Z.
  - **Not tested:** SIGTERM, reaping children the daemon didn't start, suspend, clock steps and DST (R10, R26.1). The prototypes only skip an overlapping line and fire once to catch up. C6 also has `overlap: queue` (D16) and `catch_up: skip`.
  - **Paths:** macOS has no `/bin/true` (it has `/usr/bin/true`), so a crontab written with Linux paths fails there. That line exited with 127.
- **Capped sleeps.** None of the builds sleeps exactly until the fire. croner's own scheduler re-arms every 30 s (R25.3), and 4.8's drafted tick runs every 15 s. On Linux, a native daemon could sleep until the fire and still notice clock steps and suspends: `timerfd` on `CLOCK_REALTIME` with `TFD_TIMER_ABSTIME` and `TFD_TIMER_CANCEL_ON_SET` does this, through `libc`, `rustix` or `nix` but not std. Node and Bun have no equivalent (R26.1). The 60 s cap cost Rust 0.10–0.39 ms of CPU a minute.
- **Code size.**
  - **Lines,** with the lines that are neither blank nor comments in brackets: Rust with threads 297 (244), Rust with tokio 300 (245), Rust std-only 473 plus 33 lines of tests, TypeScript 158 (117).
  - **Dependencies:** croner 4.0.3 requires `derive_builder` 0.20.2 and `strum` 0.27.2 with its `derive` feature, and both bring in proc macros. `chrono` (its default) and `jiff` are optional features. `Cargo.lock` lists 50 packages for the threads build and 58 for tokio, counting all platforms.
  - **No time zones in std-only:** that build carries its own five-field parser and UTC calendar, with no time zones, though 4.8 requires a time zone for every task, its own or a deployment default (Q11).
  - **A toy crontab:** for 4.8's design, a Rust daemon would also have to re-implement reading TASK.md's frontmatter (C6), access to the store's schema, and the overlap and catch-up policies. A TypeScript daemon can import the repository's YAML, store and process packages (R26.4).
- **On disk.**
  - **Rust:** the Linux arm64 release builds are 667 KB (std-only), 835 KB (threads) and 1,161 KB (tokio). With `opt-level = "s"`, LTO, `codegen-units = 1`, `panic = "abort"` and `strip` they are 398, 464 and 529 KB. The std-only build is 612 KB on macOS (371 KB with that profile). `ldd` lists only `libc.so.6`, `libgcc_s.so.1`, the loader and the vDSO.
  - **TypeScript:** 36 KB (`daemon.ts` 4,777 B, `croner.js` 31,117 B). A `bun build` bundle is 44,026 B (32,793 minified, 10,329 gzipped). It runs on a runtime the agent needs anyway: `bun` is 107 MB in `oven/bun:latest` (89 MB on macOS) and `node` is 150 MB in `node:slim`. `bun build --compile` made a 109 MB standalone daemon.
  - **glibc:** all the images are Debian 13 with glibc 2.41, above D26's 2.34 floor.
  - **Smaller base images:** compressed linux/arm64 sizes from the registry manifests are `debian:trixie-slim` 30.2 MB, `node:slim` 86.1 MB, `oven/bun:latest` 106.0 MB, `oven/bun:slim` 85.3 MB, `oven/bun:distroless` 59.8 MB and `gcr.io/distroless/cc-debian13` 11.0 MB. The last is enough for a dynamically linked Rust binary. In practice the daemon starts Bun or Node runs, so it lives in the agent's image and adds only its own file.
- **Compile times.** These ran in `rust:latest` with 2 CPUs, `cargo -j 2` and the crates already downloaded.
  - **Clean builds:** a release build took 0.6 s for std-only and 4.1–8.8 s with croner. A dev build took 3.2–4.0 s.
  - **Rebuilds after editing a string literal:** dev 0.18–0.77 s, release 0.42–1.9 s. With the sources and `target` on a Docker Desktop bind mount, a rebuild took 4.4–6.2 s.
  - **The settled decisions** give "No compile step" as a reason for TypeScript. For a daemon this size, the step takes seconds.

| Linux container [macOS] | Cold start, median of 20 (ms) | Idle RSS (MiB) | Anonymous (MiB) | Idle CPU (ms a minute) | Context switches a minute |
|---|---|---|---|---|---|
| Rust, std-only | 1.4–1.5 [3.6–6.8] | 1.8 | 0.1 [1.1] | 0.23 [0.06–0.07] | 0.9 [1.2] |
| Rust, croner and threads | 1.6–2.0 | 2.0 | 0.2 | 0.10–0.28 | 0.9–1.0 |
| Rust, croner and tokio | 2.3 | 2.2 | 0.2 | 0.38–0.39 | 3.0–3.2 |
| Bun, TypeScript | 32–34 [22–42] | 28.8–29.4 | 6.8–6.9 [8.7] | 14–16 [3.7–4.2] | about 200 [187] |
| Bun, `BUN_GC_TIMER_DISABLE=1` | — | 29.3–29.4 | 7.7 | 0.75 | 3.7 |
| Node, JavaScript | 37 [101–121] | 53.5–53.7 | 13.7–13.8 [16.3–16.5] | 2.5–3.8 [0.8–1.3] | 8.6–8.8 [18] |
| Node, TypeScript entry | 76–78 [131–150] | 73–75 | 29–30 [27.8] | 4.0 [1.0] | 8.8 |

- **How the table was measured, and how precise it is.** Each range spans the first runs and the fact-check's re-runs.
  - **Setup:** the Rust builds ran in `debian:trixie-slim`, the JavaScript ones in `oven/bun:latest` and `node:slim`. Cold start runs from spawn to the first newline on a pipe. The idle figures cover minutes 1–10, or 1–6 in the re-runs. The timer-off row comes from a single 4-minute run.
  - **CPU:** for Bun, the whole process, read from the container cgroup's `cpu.stat` or from `utime`+`stime`. For Rust and Node, the sum of the live threads' `schedstat`, which agreed with those counters. On macOS, `proc_pid_rusage`, which counts exited threads. On Linux, only the cgroup's counter is enough alone. `utime`+`stime` count 10 ms ticks and read 0 for every Rust build over 10 minutes. Live-thread sums miss threads that exit.
  - **Anonymous:** `RssAnon`. The bracketed macOS figures are `phys_footprint` instead, because memory compression shrank macOS RSS (Rust 2.0 → 1.1 MiB, Node TS 71.8 → 39.9 MiB) while the footprint held steady.
  - **Context switches:** all threads, including those that exited. On macOS, the task-wide count from `proc_pidinfo`. macOS's interrupt-wakeup counter counts timer interrupts, not switches: Bun had 33 interrupt wakeups a minute against 187 switches.
  - **Precision:** in the VM, CPU per wakeup ran 1.7–4 times higher than native macOS, and varied by as much between sessions. macOS cold starts moved by up to 1.9 times.
- **Cold start.**
  - **Reproduced:** the order of the builds, and Node's TypeScript penalty of 30–41 ms.
  - **Bare scripts:** printing one line took 18 ms on Bun and 26–29 ms on Node in the container.
  - **macOS Node:** the host's Node wasn't the official binary, which may explain why a bare script took 95–120 ms to print its line there.
  - **Bind mounts:** started from a Docker Desktop bind mount, the cached Rust binary took a median 3.5 ms, against 1.6 ms when baked into the image. One start took 46 ms, probably a first, uncached access **[M]**.
- **Idle memory** stayed flat over 10 minutes.
  - **Floors:** bare scripts holding one 60 s interval used 19.4–19.5 MiB on Bun (3.6–3.9 anonymous) and 45.8 MiB on Node (10.6). croner, `child_process` and the daemon's code add 8–10 MiB.
  - **File-backed:** most of a JavaScript daemon's RSS is file-backed: 22.0 MiB for Bun, 39.7 MiB for Node.
  - **Node's TypeScript entry** adds about 20 MiB, 15–16 of it anonymous (R14, D19).
  - **`bun --smol`** didn't lower it (29.2–29.6 MiB, 7.5–7.7 anonymous).
- **Idle CPU.** A day of idling in the container costs Rust 0.14–0.56 s of CPU, Node 3.6–7.3 s and Bun 21–22 s, or about 1.1 s with Bun's GC timer off. Natively on macOS it costs Rust 0.08–0.10 s, Node 1.1–1.8 s and Bun 5.3–6.0 s. On default settings in the container, Rust uses roughly 40–150 times less CPU than Bun, and Bun uses 4–6 times as much as Node.
  - **The first run's Bun figures missed exited threads.** Summing the live threads' `schedstat` at fixed times gave Bun 7.2 ms and 38 switches a minute. Polling `/proc/<pid>/task` every 100 ms showed Bun creating 7 new `HeapHelper` threads every 30 s, twice with a `Heap Collector Thread` as well. Each was gone about 10 s later. Over 150 s, 36 of these threads made 397 switches and used 19.2 ms of CPU. That is about 160 switches and 7.7 ms a minute that no fixed-time snapshot sees. The cgroup gave 15.5 ms a minute and `utime`+`stime` 16.0 ms (14.4 from the first run's own ticks). Over 5 minutes, `ns_last_pid` rose from 23 to 93 while `Threads` stayed at 4. On macOS, 64% of Bun's CPU was in threads that had already exited.
  - **The cause is Bun's idle GC timer** (as in R26.1). bun-v1.4.4's `src/jsc/GarbageCollectionController.rs` says "this adds a 1 s / 30 s idle `collect_async()` so a process that stops allocating still releases memory", which "drops to slow after 30 fires without heap growth", and it sets `const SLOW_REPEAT_INTERVAL_MS: i32 = 30_000;`. Each fire wakes the main thread, mimalloc's scavenger and the `HeapHelper` threads. WebKit's `AutomaticThread` shuts those threads down "after a timeout of inactivity", `10_s` by default. A bare Bun script does the same: 14.3 new thread IDs and 20.4 ms of CPU a minute.
  - **`BUN_GC_TIMER_DISABLE=1` removes most of it.** With it, the daemon used 0.75 ms of CPU and made 3.7 switches a minute. That is below Node and within 2–8 times Rust. It started no new threads and held 29.3–29.4 MiB, 7.7 of it anonymous, against 6.9 with the timer on. `src/bun_core/env_var.rs` defines the variable alongside `BUN_GC_TIMER_INTERVAL` and `BUN_IDLE_GC_SECONDS`. None of them was found in Bun's public docs, so they may change. Turning the timer off gives up the idle memory release. JSC's allocation-paced collection still runs.
  - **Node** wakes once a minute as a bare script, using 1.9 ms of CPU a minute. With the daemon loaded it wakes about 8 more times a minute, all on its main thread, for reasons not established. Its 7 threads (4 `V8Worker`, `SignalInspector`, `DelayedTaskScheduler`, main) stayed the same. Bun had 15 threads 3 s after start (7 `HeapHelper`, 3 `JITWorker`, `mi-scavenger`, `JSCWarmUp`, 2 `Bun Pool`, main), which fell to 4 within a minute. Each Rust build idled with 1 thread.
  - **tokio wakes about three times per 60 s sleep.** tokio 1.54.1's timer wheel has 6 levels of 64 slots each (`const NUM_LEVELS: usize = 6;`, `const BITS_PER_LEVEL: usize = 6;`). An entry that isn't due yet when its slot comes up is moved down a level. A 60,000 ms sleep starts in level 2, whose slots are 4,096 ms long.
- **A wakeup's cost** depends more on the platform than on the language.
  - **Rust:** natively on macOS, 32 µs of CPU per wakeup warm, and 58–70 µs after a minute idle. In the VM, 87–108 µs warm and 100–385 µs idle.
  - **JavaScript:** the runtimes cost about 2–3 times as much per wakeup as Rust.
  - **Memory:** thousands of wakeups with a 10 ms cap didn't grow it (Bun 32.1 → 30.3 MiB, Node 55.8 → 55.4 MiB).
  - **chrono:** with croner's default `chrono` 0.4.45, a local-time call runs an `lstat` on `/etc/localtime` whenever its 1 s cache has expired (`Ok(d) if d.as_secs() < 1 => ()`), unless `TZ` is set.
- **A fire.**
  - **Memory:** a running child added 0–0.2 MiB to a Rust daemon's RSS (the std-thread builds start a waiter thread per child), and 0.6–1.6 MiB (0.3–0.5 anonymous) to Bun's and Node's. The `sleep` child itself held 1.4 MiB on Linux and 1.0 MiB on macOS.
  - **CPU:** a fire that started 2 children, skipped 1 and logged 2 exits cost roughly 0.8–1.8 ms in Rust and 2.6–5.1 ms in Node.
  - **Bun's 5.8–6.5 ms isn't reliable.** Live-thread sums drop when a thread exits. The jump across the second fire alone was 7.6 ms. The first fire's 16–32 ms includes the tail of start-up.
- **Memory shared with runs (PSS).**
  - **Sharing:** 5 s after start, with a bare script of the same runtime running beside it, the daemon's PSS fell from 30.0 to 23.2 MiB on Bun (`Shared_Clean` 1.5 → 14.9 MiB). On Node it fell from 52.4 to 35.7 MiB (`Shared_Clean` 1.5 → 34.7 MiB).
  - **Unshared:** what the daemon didn't share came to about 16 MiB on Bun and 19 MiB on Node. That is `Private_Dirty` of 9.8 and 13.7 MiB, mostly anonymous memory that settles to 7–14 MiB by minute 1, plus `Private_Clean` of 6.3 and 5.0 MiB.
  - **A real run:** an agent run touches more of the runtime binary than a bare script does, so it would share more **[M]**.
- **Against one agent run.** Loading the modules the agent's entry point imports, without running them, took 124 ms (191 ms of CPU) and peaked at 73 MB on Bun. On Node it took 307 ms (438 ms of CPU) and peaked at 151 MB. Both were measured on macOS (R25.3).
  - **Memory:** a daemon's RSS is 1.4–2.9% of those peaks for Rust, 20–42% for Bun and 37–107% for Node. Beside another process of the same runtime, a JavaScript daemon keeps 16–19 MiB to itself, against Rust's 2 MiB.
  - **CPU:** at one run an hour, loading the imports takes about 4.6 s of CPU a day on Bun and 10.5 s on Node. A day of idling costs less than that for Rust, for Node, and for Bun with its GC timer off. Bun on default settings costs more.
  - **The difference:** in the container, Rust saves about 21 s of CPU a day over Bun on default settings, about 1 s over Bun with the timer off, and 3–7 s over Node. It saves 27–72 MiB of RSS while idle, or 14–17 MiB beside another process of the same runtime. A fire's own cost is negligible in every build.
  - **In-process runs:** only a TypeScript daemon can run tasks inside its own process, as 4.1 and 4.8 draw `gremlin serve` (D6). That saves each run's start-up and module loading. A Rust daemon has to spawn a JavaScript process for every run. In-process, a run that crashes, leaks or hangs takes the scheduler down with it (R17.2: SQLite lock waits freeze the event loop). 4.8's boot sweep marks runs left `running` by a crash as abandoned.
- **Signals in std Rust.**
  - **What's missing:** Rust 1.99.1's stable std can't receive a signal, and can't send a chosen signal to a child or its process group. `ChildExt::send_signal` and `send_process_group_signal` are "nightly-only experimental API. (unix_send_signal #141975)". So are `kill_process_group` (#156537) and `CommandExt::setsid` (#105376).
  - **What exists:** `CommandExt::process_group` has been stable since 1.64.0. `std::os::unix` has no signal module, and `Child::kill` sends SIGKILL to the direct child only.
  - **What it takes:** handling SIGTERM, or stopping a run's whole process group, needs a crate (`libc`, `nix`, `rustix`, `signal-hook`, or tokio's `signal` feature) or unsafe FFI (R26.2).
  - **TypeScript:** `process.kill(-pid)` signals a process group on both runtimes. `packages/process/src/spawn.ts` says: "process.kill(pid) and, for a group, process.kill(-pid) work the same with either implementation" (R8, R14).
- **PID 1 in a container.**
  - **Docker's `run` reference:** "A process running as PID 1 inside a container is treated specially by Linux: it ignores any signal with the default action. So, the process doesn't terminate on SIGINT or SIGTERM unless it's coded to do so." Its `--init` flag runs `docker-init`, backed by tini, to reap zombie processes.
  - **The prototypes** install no signal handler, so none would stop cleanly as a container's main process, and they reap only their own children. They ran under a probe that was itself PID 1, so neither was exercised.
  - **Without a handler or an init,** `docker stop` waits out its grace period and then sends SIGKILL (R25.4). Bun and Node can handle SIGTERM with `process.on('SIGTERM')`. std-only Rust can't.
  - **4.9's compose file** sets `init: true` on the app and the workspace (R9).
- **Open:** memory over days for the JavaScript daemons, and over hours for Bun with its GC timer off; figures on a native Linux host; cold starts on an unloaded host (a bare Bun script took 18 ms here, and 8.8 ms at best); what wakes Node's main thread the extra 8 times a minute (V8's delayed tasks, such as the memory reducer, are only a guess); the official Node build on macOS; SIGTERM, PID 1 and reaping in a real daemon; and an existing compiled daemon used as-is, which would probably sit close to the Rust builds, a little above them for Go's runtime **[K]** (R26.2).
- **Sources:** scratch prototypes of the four daemons and a probe, built in `rust:latest` and run in `debian:trixie-slim`, `oven/bun:latest` and `node:slim` (linux/arm64) under Docker Desktop (Engine 29.9.2, kernel 7.0.14-linuxkit) and natively on macOS arm64, 2026-11-08; the fact-check's re-runs with its own sampler, a PSS script and a macOS sampler; crates.io API `/api/v1/crates/croner/4.0.3/dependencies`; croner-4.0.3 `Cargo.toml`; the builds' `Cargo.lock`; registry.npmjs.org/croner (11.0.0, 2026-10-26); tokio-1.54.1 (crates.io) `src/runtime/time/wheel/mod.rs` and `level.rs`; chrono-0.4.45 (crates.io) `src/offset/local/unix.rs`; github.com/oven-sh/bun tag `bun-v1.4.4`: `src/jsc/GarbageCollectionController.rs`, `src/bun_core/env_var.rs`; github.com/WebKit/WebKit (main) `Source/WTF/wtf/AutomaticThread.h`; Rust 1.99.1's std docs (rustup `rust-docs`): `std/os/unix/process/trait.ChildExt.html` and `trait.CommandExt.html`; docs.docker.com/reference/cli/docker/container/run/ (PID 1, `--init`); man7.org/linux/man-pages/man2/timerfd_create.2.html (man-pages 6.19); github.com/apple-oss-distributions/xnu (main; latest tag xnu-12377.121.6) `osfmk/kern/sched_prim.c`; registry manifests through `docker buildx imagetools inspect --raw`: `debian:trixie-slim`, `node:slim`, `oven/bun:latest`, `oven/bun:slim`, `oven/bun:distroless`, `gcr.io/distroless/cc-debian13` (linux/arm64); this repository's `packages/process/src/spawn.ts`; the Brief's settled decisions, 4.1, 4.8, 4.9, C6, D12, D16, D26, Q11, R8 and R17.2; R25.3 for croner's 30 s cap and the agent's import costs; R25.4 for `docker stop`.

**R26.4 What Rust would cost in this repository.** **[H]** unless marked. Researched on 2026-11-08 for C24, from this repository's configuration and CI, six projects that pair Rust with JavaScript, GitHub's runner images, and the docs of rustup, cargo-mutants, Stryker, dist, npm and Apple. A prototype daemon was built, linted, tested and mutation-tested in `rust:latest` (Rust 1.99.1) in Docker Desktop's arm64 Linux VM, with 2 CPUs and 2 build jobs, on an Apple-silicon Mac under other load. It has 199 code lines in five tested modules, 122 in `main.rs` and 310 in tests, and uses croner-rust 4.0.3, jiff 0.2.40, saphyr, and rusqlite 0.41.1 with `bundled`. An independent fact-check re-ran the builds, the mutation run and the YAML and cron probes, and its corrections are folded in. Timings varied between runs: mostly by 10–30% in the fact-check's re-runs, though its crate fetch took about four times as long, and up to about twofold between the researcher's two samples. They give orders of magnitude only.
- **Layout: a Cargo workspace beside the Bun workspaces.** Turborepo, Biome, oxc, Rolldown and Rspack keep `Cargo.toml` and `Cargo.lock` at the root, `crates/` beside `packages/`, and a root `rust-toolchain.toml`. Deno has `cli/`, `ext/` and `runtime/`. Four pin an exact stable (oxc `1.99.1`, Rolldown `1.99.0`, Biome `1.98.1`, Deno `1.95.0`) and two pin a nightly (Turborepo `nightly-2026-07-03`, Rspack `nightly-2026-04-16`). All six are Rust-first projects, not TypeScript apps that added one small crate. Here the layout would be `crates/<daemon>/` plus the three root files.
  - **Bun ignores the crate.** Bun 1.4.4 skips, without a message, a directory that matches the workspace glob but has no `package.json`. With only a `Cargo.toml` in `packages/daemon`, `bun install` exited 0 and `bun.lock` left the directory out. Even so, `crates/` keeps `packages/` for the `@mecha-gremlin/*` workspaces. The globs in `tsconfig.json`, `vitest.config.ts` and `stryker.config.mjs` match only `.ts` files.
  - **rustup installs the pin.** `rust-toolchain.toml` pins the channel, components, targets and profile. rustup's book calls such files "suitable to check in to source control. If that's done, `Cargo.lock` should probably be tracked too". Since rustup 1.28.1 (2025-03-05), any `cargo` command installs the pinned toolchain unless `RUSTUP_AUTO_INSTALL` opts out, and rustup 1.29.3 did so here. Developers and CI need rustup, but no install step, though CI pays for a download (below). Stable Rust is 1.99.1 (2026-10-15) and rustup is 1.29.3 (2026-11-02). Stable ships every six weeks, so 1.100.0 is due about 2026-11-12, and keeping to the newest release moves the pin that often.
- **`bun run check` would call cargo through root scripts** **[M]**. This is a design suggestion: `rust:fmt` runs `cargo fmt --all --check`, `rust:lint` runs `cargo clippy --all-targets --locked -- -D warnings`, and `rust:test` runs `cargo test --locked`. They would run after `test:node`, the last of `check`'s six steps. `bun run` starts a script in its package's root (R19).
  - **Other files change too.** `.gitignore` gains `target/`, which CSpell then skips because of `useGitignore: true`. `cspell.json`'s `ignorePaths` gains `Cargo.lock` beside `bun.lock`. The README's Prerequisites, Develop and CI sections change. So does the `dev-checks` spec, whose "`bun run check` and CI SHALL run both scripts" names the two test runs. In Part 1's settled decisions, a crate reverses "No compile step". `check` would need three toolchains: Bun, Node 26 and Rust.
- **CI: the runner images carry Rust, but an exact pin downloads its own.** GitHub's Ubuntu 24.04 image (20261101.360.1), `ubuntu-latest` on x64, lists Rust and Cargo 1.99.1, Rustup 1.29.2 and Rustfmt 1.10.0. It installs them with `--default-toolchain=stable --profile=minimal`, then `rustup component add rustfmt clippy`. The macOS 26 arm64 image (20261026.0455.2), now `macos-latest`, lists Rust 1.99.1, Clippy 0.1.99 and Rustfmt 1.10.0-stable.
  - **rustup matches a toolchain by name, not version.** With only `stable` (1.99.1) installed, a `channel = "1.99.1"` pin printed "the missing active toolchain `1.99.1-aarch64-unknown-linux-gnu` has been auto-installed" after 10.1 s. Pinning `stable` beside an installed 1.99.1 did the same. So on GitHub's images an exact pin downloads its own copy, about 0.5 GB on disk and roughly 10–15 s, on every fresh runner, even when the image's stable is the same release. Pinning `stable` avoids the download but gives up the pin. `dtolnay/rust-toolchain`, a wrapper around `rustup toolchain install … --profile minimal`, is optional beside `rust-toolchain.toml`. Its one release, `v1`, dates from 2022-07-15, so pinning it by SHA, as CI pins its other actions, means pinning a master commit.

| Measure, in `rust:latest` with 2 CPUs and 2 build jobs | Result |
|---|---|
| Cold fetch of the 56 locked crates | 0.9–1.0 s; 3.8 s in the fact-check |
| Cold debug build / `cargo clippy --all-targets -- -D warnings` / the 31 tests | 9.1–16.2 s / 1.6–2.6 s / 0.7–1.2 s |
| Cold release build, thin LTO, `codegen-units=1` | 34.0–75.8 s; a 3,166,696-byte stripped binary; `target/` 367 MB, Cargo's registry 68 MB |
| Debug build / test build and run, after a one-line edit | 0.34–0.48 s / 0.41–0.52 s |
| Toolchain install, minimal profile, with or without clippy and rustfmt | 490–512 MB on disk, in 9–15 s |
| cargo-mutants 27.1.0: build from source / `cargo mutants -j 2` | 92–99 s / 43–54 s: 36 mutants, 31 caught, 5 unviable, exit 0 |

- **CI times are estimates.** CI keeps "No dependency cache, deliberately", so every job builds cold. But it runs on 4-vCPU x64 VMs, where cargo defaults to 4 jobs.
  - **A parallel job adds nothing to the wall time** **[M]**. This is scaled from the table, not run on a runner. Today's Check-and-test job took 92 s on run 42390090206 (main, 2026-11-07), 35 s of it each for `bun run test` and `bun run test:node`. A Rust job would take about 15–30 s, plus about 10 s for the exact pin's download. Appended to the existing job, its steps would add about 20–40 s plus the download. On public repositories, `ubuntu-latest` runners have 4 CPUs and 16 GB, `macos-latest` has "3 (M1)" and 7 GB, and standard runners are "free and unlimited on public repositories".
- **Compiling barely slows the edit-run loop.** Incremental builds take 0.34–0.48 s, so at this size the settled decision's "Instant edit-run loop" reason carries little weight.
- **cargo-mutants is always a 100% gate.** None of the 46 pages of its book at v27.1.0 mentions a score or a threshold. It exits 0 when "Every viable mutant that was tested was caught by a test", 2 when it "Found some mutants that were not covered by tests", and 3 when "Some tests timed out". Unviable mutants, which don't compile, never fail a run. Timeouts do, and the book documents no option that counts them as caught, so a CI step would have to accept exit 3 itself. The default timeout is "5 times the baseline test time, with a minimum of 20 seconds". Stryker, under this repository's `thresholds: { break: 100 }`, counts "Detected: killed + timeout" and leaves compile and runtime errors out of the score. Under load, it counted static mutants that no test killed as Timeout (R17.6) **[M]**.
  - **Its mutants are coarser.** cargo-mutants replaces function bodies and swaps binary operators, inside conditions too (`&&` and `||`, comparisons). It deletes match arms and unary operators such as `!`, replaces match guards with true or false, and mutates struct literal fields. It never replaces any other whole condition, and it has no mutators for literals, regexes or method calls. Stryker has 14 mutator families, among them String Literal, Conditional Expression, Regex and Method Expression.
  - **Same logic, same six tests.** cargo-mutants made 7 mutants of the prototype's crontab parser, and the tests caught all of them. Stryker 10.1.1 made 47 mutants of a TypeScript port, and the tests killed 46. The survivor, `split(/\s+/)` turned into `split(/\s/)`, is an idiom the Rust doesn't use: it calls `split_whitespace()`. The survivor shows a missing multiple-spaces test in the port, not a gap Stryker would find in the Rust.
  - **Across codebases,** the prototype's mutated modules had 0.18 mutants per non-blank, non-comment line (36 over 199). This repository's TypeScript has 0.88 (7,414 over about 8,470). Different code on each side makes "about 5 times" a rough figure. The gap is real, and it comes mostly from the missing literal, whole-condition and method-call mutants **[M]**.
  - **About a minute to run,** against Stryker's 4 h 26 min on that CI run. cargo-mutants 27.1.0 ships binaries only for x86_64 Linux (gnu), macOS and Windows, and `taiki-e/install-action` v2.90.3 (`cfdb7ed4`, 2026-11-08) can fetch them on `ubuntu-latest`. Built from source on arm64, it took 92–99 s.
  - **Skipping a mutant is coarser too.** A `// Stryker disable next-line` comment has no line-level counterpart on stable Rust. `#[mutants::skip]` needs the `mutants` crate as "a regular `dependency` not a `dev-dependency`". With `mutants` 0.0.4 on Rust 1.99.1, it compiled on a function, but not on a statement ("macro attributes on statements are unstable") or an expression ("attributes on expressions are experimental"). The other options are globs and regexes in `.cargo/mutants.toml`, which the prototype used to exclude `src/main.rs`, and `#[mutants::exclude_re]`. That attribute appears only in the Unreleased NEWS and needs `mutants` 0.0.5, which isn't published. Denying warnings in source leads to an "excessive number of mutants being reported as unviable", so `-D warnings` belongs on clippy's command line, not in `#![deny]`. The book also offers `--cap-lints=true` for this.
- **clippy is a strict gate that churns.** On its first run, `-D warnings` refused the prototype for `clippy::type-complexity` on `reap`'s return type, which a `type Ended` alias fixed. Clippy added 8, 7, 5, 3 and 5 lints in 1.99 back to 1.95, so a six-weekly bump can need code changes, as oxlint bumps do now. Only lints in default-enabled groups can fail `-D warnings`, and their share wasn't checked, so these counts are an upper bound.
- **rustfmt and CSpell fit.** rustfmt's defaults, 4 spaces and a width of 100, are close to oxfmt's settings here. On stable, neither enforces this repository's blank-line rules: rustfmt's `blank_lines_lower_bound` and `blank_lines_upper_bound` are "Stable: No". CSpell 10.4.0 bundles `@cspell/dict-rust` 4.1.2, whose `rust` and `rust-crates` dictionaries apply to `.rs` files without any configuration. With this repository's `cspell.json`, the prototype's 784 lines held 4 unknown words (`tzdb`, `saphyr` twice, `rusqlite`).
- **This repository's style rules carry over in part.** No index files becomes no `mod.rs`, which `clippy::mod_module_files` enforces. A crate still needs `main.rs` or `lib.rs`, though, and each parent module declares its children with `mod x;`. For the no-ternary-in-a-return rule, Rust has no `?:`, and the early-`if` form works. `clippy::needless_return`, on by default, makes the value after it a tail expression without `return`. The rule that functions never change their arguments is stronger in Rust, where `&T` is immutable by default. `func-style`, `no-use-before-define` and the type-or-interface rule have no counterpart. Package boundaries, such as no `process` or console in core, would map to `disallowed-methods` and `disallowed-macros` in `clippy.toml`, or to `print_stdout`.
- **Built from source, every user installs Rust and a C compiler.** A minimal toolchain is about 0.5 GB. The Rust book says "You will also need a linker", and "some common Rust packages depend on C code and will need a C compiler". rusqlite's `bundled` feature compiles `sqlite3.c` through `cc`. That brings back the C toolchain the README avoids by requiring Bun 1.4.4: "Bun 1.4.3's install runs node-gyp for better-sqlite3, which fails without Python, make and a C++ toolchain." A cold release build took 34–76 s on 2 cores.
- **Prebuilt binaries need no cross-compiler.** GitHub has native public runners for all four targets: `ubuntu-24.04` (x64), `ubuntu-24.04-arm`, `macos-26` (arm64), and `macos-15-intel` or `macos-26-intel`. musl builds use a rustup target or cargo-zigbuild 0.24.1 (2026-11-04). cargo-zigbuild needs a macOS SDK for Apple targets and can't link glibc statically ("Use a `*-musl` target instead"). cross has had no release since 0.2.5 (2023-02-04), and it can't ship Apple images.
  - **dist** 0.34.0 (2026-11-02), formerly cargo-dist, generates the whole tag-driven `release.yml`. It can pin its actions to commits (`github-action-commits`), and its build cache is off by default. Its npm installer is one package whose `"postinstall": "node ./install.js"` downloads the GitHub Release archive. If postinstall didn't run, the first run downloads it instead. That is the case under Bun, which "does not execute arbitrary lifecycle scripts by default". dist builds no per-platform packages. It signs macOS binaries with a Developer ID certificate but doesn't notarise them: "In the future, this module will also support notarization."
  - **Per-platform npm packages** are how oxlint 1.92.0 (19 packages), `@biomejs/biome` 2.6.6 (10), turbo 2.11.10 (6), esbuild 0.28.2 (26) and typescript 7.0.2 (20) ship. Each platform gets one package with `os`, `cpu` and `libc` fields, and each package is an optional dependency of a wrapper. This repository is `private: true` and unpublished, so that route would mean an npm scope, about 4–6 platform packages a release, and a publish job. Trusted publishing (OIDC) removes the token. It "requires npm CLI version 11.5.1 or later and Node version 22.14.0 or higher".
- **Gatekeeper assesses only browser downloads.** A locally built binary is ad-hoc signed by the linker (`flags=0x20002(adhoc,linker-signed)`, `TeamIdentifier=not set`) and runs. Binaries Bun installs from npm, such as oxlint's addon and tsgolint, carry only `com.apple.provenance`. A curl download has no `com.apple.quarantine`. So Gatekeeper assesses neither. A browser download that isn't Developer ID signed and notarised is blocked. Since macOS Sequoia, "users will no longer be able to Control-click to override Gatekeeper" (Apple, 2024-08-06), and must allow the binary under System Settings > Privacy & Security instead. Notarisation needs the Apple Developer Program's "$99 annual membership". cargo-mutants' own x86_64 macOS binary is "not signed at all".
- **For Docker, a multi-stage build is the simplest channel** **[M]**. It compiles in a `rust` image and copies the binary into the Bun image, with no Gatekeeper, npm packages or release pipeline. It adds a release build to each uncached image build, 34–76 s here. The builder pull is about 0.56–0.6 GB for `rust:latest` (557 MB on arm64, 602 MB on amd64, 2.22 GB unpacked), or about 0.3 GB for `rust:1.99.1-slim-trixie` (287 and 327 MB). `rust:latest` and `oven/bun:1.4.4` are both Debian 13 with glibc 2.41, and a copied binary ran.
- **Binaries built in today's `rust:latest` need glibc 2.39, above D26's 2.34.** Both the prototype and a 6-line std-only program that runs `Command::new("true")` import `pidfd_spawnp` and `pidfd_getpid` at `GLIBC_2.39`. The imports aren't weak, and they come from std's process spawning. Such a binary refused to start on Debian 12 (glibc 2.36), reporting `GLIBC_2.39` not found. By the same version check, it would refuse on Ubuntu 22.04 or RHEL 9 **[M]**. An `aarch64-unknown-linux-musl` build ran on Debian 12, and both builds ran on `oven/bun:1.4.4`. So a builder must not be on a newer Debian than the runtime image. Release binaries for older systems need an older build base, cargo-zigbuild's glibc suffix on `--target`, or musl. `better-sqlite3` 13 alone holds the image to glibc 2.34 or musl (D26, R17.6).
- **Turborepo is the closest precedent: two implementations of one behaviour, side by side.** Vercel ported "about 70k lines of Go to Rust in 15 months" (2024-02-12). Keeping both sides' hashes identical took JSON, then Protocol Buffers, then Cap'n Proto. The work also surfaced "undocumented and untested scenarios" in globbing, file watching and hashing. Vercel's reasons (2023-03-07) were explicit OS control ("Rust's explicitness in this area not only made things simpler for us but also more correct"), team preference, and sharing code with Turbopack, since "we were solving the same problems twice: once in Go and once in Rust".
- **Bun moved from Zig to Rust because of crashes, not speed.** Bun 1.4.0 (2026-08-20): "Bun is now written in Rust - and this is the first release". So the Bun 1.4.4 this repository runs on is a Rust program. "Rewriting Bun in Rust" (2026-07-08): "I was tired of going to sleep worrying about crashes in Bun". The port took "11 days" with "About 64 Claudes at a time", cost "around $165,000 at API pricing", and produced a +1,009,272-line diff. About 4% of the code sits in `unsafe`. The post reported "2% - 5% faster" and binaries about 20% smaller on Linux and Windows. The 1.4.0 notes say "up to 17% smaller" instead, and macOS binaries "about 1 MB larger". By Bun's figures, hello.js on Linux starts in 5.1 ms and peaks at 14.6 MB. On Bun 1.3 the figures are 10.9 ms and 33.0 MB, and on Node 26, 27.2 ms and 44.5 MB. A resident Bun 1.4.4 daemon still holds about 28 MB (R26.3). That the JavaScript engine accounts for it is an untested inference **[L]**.
- **Elsewhere, Rust pays off for CPU-bound work on large inputs, and the language boundary is the cost.** Rolldown is "10~30 times faster than Rollup", and Rspack is "more than 10 times faster than webpack". oxc writes that "The Rust/JS boundary has always been the fundamental problem for native tooling supporting JS plugins". None of them is a mostly idle scheduler. This repository's dev tools already arrive as such binaries through npm: oxlint, oxfmt, Rolldown and lightningcss in Rust, and TypeScript 7 and tsgolint in Go.
- **YAML parity: with default options, no Rust crate tested reads frontmatter as the agent does.** If schedules live in TASK.md's frontmatter (C6), the daemon must read it as `@mecha-gremlin/yaml` does. On 22 cases, `Bun.YAML` and `yaml` 2.9.1 with the agent's options (`logLevel: 'error', uniqueKeys: false, merge: true`) gave the same values (R23). Every parser refused the same 4 invalid inputs, with different messages and columns. serde_yaml is published as `0.9.34+deprecated`, and serde_yml 0.0.13 calls itself "DEPRECATED — unmaintained".

| Frontmatter | `Bun.YAML`, `yaml` 2.9.1 | saphyr 0.3.3, yaml-rust2 0.13.0 | serde-saphyr 2.1.1, defaults | serde-saphyr 2.1.1, configured | serde_norway 0.9.42, serde_yaml 0.9.34 |
|---|---|---|---|---|---|
| `a: 1`, then `a: 2` | `{"a":2}` | error | error | `{"a":2}` | `{"a":2}` |
| a `<<: *b` merge key | merged | `<<` kept as a key | merged | merged | `<<` kept as a key |
| `enabled: yes`, `on`, `country: NO` | strings | strings | `true`, `true`, `false` | strings | strings |
| `mode: 0755` | 755 | 755 | 755.0 | 755.0 | `"0755"` |
| `x: .inf` | Infinity | Infinity | error | Infinity | Infinity |
| Cases that differ from the JS parsers | — | 2 of 22 | 6 of 22 | 1 of 28 | 2 of 22 |

- **Configured, serde-saphyr differs only on `0755`.** The configuration sets `duplicate_keys: DuplicateKeyPolicy::LastWins`, `strict_booleans: true` and `non_finite_float_policy: NonFiniteFloatPolicy::PassThrough`. With these, serde-saphyr 2.1.1 matched both JS parsers on every value of the 22 cases and 6 schedule cases, except `0755`, which it reads as a float and they read as an integer. Read into `struct Front { schedule: Option<String> }`, it gave the agent's schedule in all 6 schedule cases, including a repeated `schedule` (the last one wins) and a repeated `tags`. So a repeated key needn't stop the daemon reading its schedule. Keeping the two sides in step would still take a shared test corpus, like the one `Bun.YAML` and `yaml` have.
- **Unquoted cron patterns fail when they start with `*` or `@`.** In every parser, `schedule: */5 * * * *` starts an alias. `Bun.YAML` gives "Unresolved alias", `yaml` "Unexpected alias at node end", saphyr and yaml-rust2 "found unknown anchor", serde-saphyr "alias references unknown anchor", and serde_norway and serde_yaml "while scanning an alias". `schedule: @daily` is refused too, since a plain value can't start with `@` (R23.1). Patterns that start with a digit parse as strings: `0 9 * * 1-5`, `0 */2 * * *` and `0 0 ? * MON` in both JS parsers, and `0 9 1 1 1` in serde-saphyr. Quoting, as in `schedule: "*/5 * * * *"`, is the safe rule whichever language reads the file.
- **Cron parity: croner-rust and croner 11 schedule the same.** croner 11.0.0 (2026-10-26) says it "follows Vixie cron, as croner-rust does, so that both libraries schedule the same". The fact-check ran croner 11.0.0 on Bun 1.4.4 and Node 26.13.0, and croner-rust 4.0.3 with jiff 0.2.40. Both gave the same next six fires, 126 timestamps, for all 21 valid patterns of 26. The patterns covered the 2026 Europe/Budapest DST changes, America/New_York, `L`, `W`, `#`, `5L`, 29 February, Sunday as 7, OR against `+` AND, `@daily`, `@weekly`, stepped ranges and `?`. The two differ on an impossible date, `0 0 31 2 *`: npm returns no runs, and Rust gives "CronScheduler time search limit exceeded." They also word their refusals of the same 4 patterns differently. Validating with croner in TypeScript (D12) and scheduling in Rust needs next to no parity work for fire times.
  - **Both run the repeated hour's interval jobs, unlike croner 10.0.1.** `0 * * * *` in Europe/Budapest fired at 00:00Z, 01:00Z and 02:00Z on 2026-10-25. croner 10.0.1 skipped that hour (R10, pinned in 4.8). croner-rust also ran `30 2 * * *` once in the repeated hour (00:30Z on 2026-10-25, then 01:30Z on 2026-10-26). On 2026-03-29 it ran the same job at 01:00Z, 03:00 local, the first minute after the gap, where croner 10.0.1 ran it at 03:30 (R10).
- **SQLite parity: two builds would write one file.** If run records go into the store (R17.2), the daemon's SQLite differs from the agent's. rusqlite 0.41.1's tag bundles 3.54.0, and `libsqlite3-sys` 0.39.1 (2026-10-25), which the prototype's lock resolves, bundles 3.54.1. `better-sqlite3` 13.0.3 bundles 3.53.4. Only `better-sqlite3` sets `SQLITE_DQS=0`, `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` and `SQLITE_ENABLE_MATH_FUNCTIONS`. `libsqlite3-sys` sets `DEFAULT_FOREIGN_KEYS=1`, FTS5 and JSON1. So double-quoted strings, `UPDATE … LIMIT` and math functions can behave differently on each side. TypeORM 1.1.2 owns the schema and its `migrations` table. The daemon would hand-write SQL against them, and repeat the store's settings on every connection: WAL and foreign keys, which TypeORM sets, plus a 2000 ms busy timeout, `synchronous = FULL` and `recursive_triggers = ON`. The prototype did, and its test `opens_with_the_agent_settings` passed.
- **A second supply chain.** The minimal daemon builds 45 crates from crates.io. Its `Cargo.lock` holds 56 packages, platform-only ones included. Among them are `derive_builder` 0.20.2 and `darling` 0.20.11 through croner, `syn` 2.0.119 and 3.0.9, `cc` 1.11.1, `jiff` 0.2.40 and `libsqlite3-sys` 0.39.1. Advisories need their own tool, cargo-audit 0.22.2 (2026-06-05) or cargo-deny 0.20.2 (2026-07-09), beside CI's `bun audit`, which only reports (`continue-on-error: true`).
  - **It also needs second copies of shared code.** In TypeScript, the daemon would reuse `@mecha-gremlin/yaml`, `process` and `store`, and the structured logger. In Rust, it has to reimplement them. The prototype starts each run in its own process group with std's `process_group(0)`, but never signals the group. That takes `killpg` from libc or rustix, plus signal handling and a log format compatible with the agent's. The prototype also polls every second while a run is active, to reap it. Avoiding that takes SIGCHLD or pidfd handling.
- **When Rust is the right call, in the researcher's judgment** **[M]**: only when all four of these hold. The scheduler runs where Bun isn't present or wanted, such as a host daemon that starts containerised runs. Tens of MB matter on that host (R26.3). Schedules live in a file only the daemon reads. And the project records a new decision against Part 1's "TypeScript on Bun … No compile step", and accepts, or makes up for, the coarser mutation bar.
  - **Otherwise, Bun is on the host anyway,** since the daemon's job is to start `bun run agent`. D19's "Bun or Node" wouldn't bind a native binary.
  - **Otherwise, the researcher's answer is TypeScript on Bun.** A resident process using croner's next run and a capped sleep reuses the yaml, process and store packages and the logger. It has no parity surface, and it stays within the 100% Stryker bar and the Bun-and-Node test runs.
  - **The fact-check corrects two of the researcher's points.** First, with a crontab-like file as the source of truth, an existing daemon such as supercronic v0.2.51 reads the file with no synced copy. 4.8's "Schedules live in the DB, so an external cron would need a synced copy" covers only schedules held in the database (R26.2). Second, "Parity is the deciding cost" overstates YAML and cron, where a configured serde-saphyr and croner-rust matched the TypeScript side in almost every case tested. What remains is hand-written SQL against TypeORM's schema on a differently compiled SQLite, and a shared test corpus.
- **Open:** CI times on `ubuntu-latest` and `macos-latest`, scaled here from 2-CPU Docker runs. How many of the new clippy lints are on by default. Whether the JavaScript engine accounts for Bun's resident memory. The refusals on Ubuntu 22.04 and RHEL 9, inferred from their glibc versions but not run. croner-rust against croner 11 beyond the 26 patterns tried.
- **Sources:** github.com/vercel/turborepo, /biomejs/biome, /oxc-project/oxc, /rolldown/rolldown, /web-infra-dev/rspack and /denoland/deno: root listings and `rust-toolchain.toml`; github.com/rust-lang/rustup `doc/user-guide/src/overrides.md`, CHANGELOG (1.28.1) and tags (1.29.3); github.com/rust-lang/rust RELEASES.md and release 1.99.1; github.com/actions/runner-images README, `images/ubuntu/Ubuntu2404-Readme.md` (20261101.360.1), `images/ubuntu/scripts/build/install-rust.sh` and `images/macos/macos-26-arm64-Readme.md` (20261026.0455.2); docs.github.com/en/actions/reference/runners/github-hosted-runners; github.com/dtolnay/rust-toolchain `action.yml` at 683b588c, release v1; github.com/sourcefrog/cargo-mutants release v27.1.0, `book/src/{exit-codes,timeouts,mutants,attrs,skip_files,lints}.md` at v27.1.0 and NEWS.md; crates.io/crates/mutants (0.0.4); github.com/taiki-e/install-action `manifests/cargo-mutants.json`, v2.90.3; stryker-mutator.io/docs/mutation-testing-elements/mutant-states-and-metrics/ and /supported-mutators/; github.com/rust-lang/rust-clippy CHANGELOG.md; rust-lang.github.io/rust-clippy/master; github.com/rust-lang/rustfmt Configurations.md; `@cspell/dict-rust` 4.1.2 `cspell-ext.json`; github.com/rust-lang/book `src/ch01-01-installation.md`; github.com/rust-cross/cargo-zigbuild (v0.24.1); github.com/cross-rs/cross (v0.2.5); github.com/axodotdev/cargo-dist v0.34.0: README, `cargo-dist/templates/installer`, `cargo-dist/src/sign/macos.rs`, `book/src/reference/config.md`; axodotdev.github.io/cargo-dist/book/installers/npm.html; bun.com/docs/pm/lifecycle; npmjs.com: oxlint 1.92.0, `@biomejs/biome` 2.6.6, turbo 2.11.10, esbuild 0.28.2, typescript 7.0.2 (`npm view … optionalDependencies`); docs.npmjs.com/trusted-publishers; developer.apple.com/documentation/security/notarizing-macos-software-before-distribution, /documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes, /news/?id=saqachfa and /programs/; hub.docker.com/_/rust; vercel.com/blog/turborepo-migration-go-rust and /blog/finishing-turborepos-migration-from-go-to-rust; bun.com/blog/bun-v1.4.0 and /blog/bun-in-rust; github.com/rolldown/rolldown `docs/guide/introduction.md`; github.com/web-infra-dev/rspack `website/docs/en/guide/start/introduction.mdx`; oxc.rs/blog/2026-03-11-oxlint-js-plugins-alpha; crates.io/crates/saphyr, /yaml-rust2, /serde-saphyr, /serde_norway, /serde_yaml, /serde_yml, /croner, /jiff, /rusqlite, /cargo-audit and /cargo-deny; github.com/bourumir-wyngs/serde-saphyr `src/de/options.rs` at 2.1.1; github.com/Hexagon/croner-rust; npmjs.com/package/croner (11.0.0); github.com/rusqlite/rusqlite `libsqlite3-sys/build.rs` and `libsqlite3-sys/sqlite3/sqlite3.h` at v0.41.1; static.crates.io libsqlite3-sys 0.39.1; github.com/WiseLibs/better-sqlite3 `docs/compilation.md` at v13.0.3; TypeORM 1.1.2's `MigrationExecutor.js`; github.com/aptible/supercronic v0.2.51: README and `cron/cron.go`; this repository's `package.json`, `cspell.json`, `tsconfig.json`, `vitest.config.ts`, `stryker.config.mjs`, `.oxlintrc.json`, `.oxfmtrc.json`, `.github/workflows/ci.yml` and CI run 42390090206, the README, `openspec/specs/dev-checks/spec.md`, `packages/yaml/src/parse.ts`, `packages/store/src/store.ts` and its first migration, and `bun.lock`; Part 1's settled decisions, 4.8, R10, R17.2, R17.6, R19, R23, R26.2, R26.3, C6, D12, D19 and D26; a prototype crate and probes in `rust:latest` (Rust 1.99.1) under Docker Desktop's arm64 Linux VM, an amd64 container for cargo-mutants' release binary, `debian:bookworm-slim` and `oven/bun:1.4.4` for the glibc test, and Bun 1.4.4 and Node 26.13.0 with Stryker 10.1.1 and Vitest 5.0.5, on an Apple-silicon Mac.

---

# Part 3: Where the brief stands, and challenges

## 3.0 Status of the original brief

**Settled decisions.** The 2026-10-11 assessment below is historical. The runtime was widened by D19, and the one-client and no-Claude decisions were revised by D24 on 2026-10-27.

| Area | Status after research |
|---|---|
| Language/runtime | Holds. Bun 1.4.3 is current (2026-10-10). Watch out: Bun reads the `tsconfig.json` of the directory it's started from (R6.2, C7). It has built-in cron (R8), which bears on D6. **Widened by D19 (2026-10-16):** the server runs on Bun or Node, through two small packages that use Bun's built-ins on Bun (R14). **Reversed for the scheduler by D50 (2026-11-09):** `Bun.cron`'s OS-level form can't serve as the scheduler (R25.1), and the scheduler is a Rust package, leaving the agent on Bun or Node (C24). |
| Database | Holds. Everything the scheduler needs is reachable from TypeORM: `FOR UPDATE SKIP LOCKED`, partial unique indexes, `ON CONFLICT DO NOTHING`, `jsonb` and native `vector` columns (R6.3, R10). **Reversed by D25 (2026-10-29):** SQLite in a data folder replaces Postgres. It carries this app's load, with raw SQL for the claims and a lease for the credential refresh, but has no roles or grants (R17.2, C14). |
| ORM | Holds, with conditions. TypeORM 1.1.2 is healthy, but its CI doesn't run on Bun. Four transpiler gotchas are verified on Bun 1.4.3, and the migration and minify items are [M] (R6.2). See C7 and S1. **On Node and SQLite (2026-10-29):** decorators can't run under Node 26's type stripping, so entities are EntitySchema; TypeORM 1.1.2's SQLite path works on both runtimes (R17.1, C15), through `better-sqlite3` 13 (D26). |
| LLM client | **Revised by D24:** `openai` serves Responses for OpenAI and LM Studio; `@anthropic-ai/sdk` serves Claude's native Messages API. Both live in `agent`, behind the shared loop; `core` has no SDK dependency. The earlier Responses and SIWC research (C1, C2) remains applicable to those providers. |
| Models | **Revised by D24:** Claude is supported through a direct API key, not a Claude subscription. OpenAI and LM Studio remain supported. The earlier SIWC plan-usage findings and their open eligibility questions remain in R1.2 and C2. |
| Deployment and isolation | Holds. On macOS, LM Studio has to run on the host, outside compose (R9). Where the boundary sits: C3. |
| Repo | Holds. Proposal: one `core` package with subpath exports (D10). |

**Known risks.**

| Risk | What the research found | Where it goes |
|---|---|---|
| TypeORM runtime type gap | **Closed:** 1.x throws on `null`/`undefined` in high-level `where` criteria, for find/count/exists since 1.0.0 and for writes since 1.1.0 (R6.1). **Remains open:** QueryBuilder `.where()` silently matches zero rows on `null`; a bare id under a relation key returns an arbitrary row (#12712, R9); entity-instance criteria are unvalidated; `jsonb` payloads are unchecked; partial-index predicates under explicit names aren't diffed (R6.3); Bun's metadata ignores `strictNullChecks` while `emitDecoratorMetadata` is on (R6.2 gotcha 4, moot if D15 turns it off). | C7: pin `typeorm >= 1.1.0`, find-options locks, `{ run: { id } }` filters, `tsc` in CI, integration tests |
| TypeORM on Bun | Works with legacy decorators, but isn't in TypeORM's CI. Four transpiler gotchas verified on 1.4.3, including the cwd-tsconfig rule. Migrations and minify are [M] (R6.2). **2026-10-29:** on SQLite, it works on Bun and Node with EntitySchema and better-sqlite3 13 or a `node:sqlite` stand-in, and one connection per process means serialising all database work (R17.1). | C7, S1, D13, D15, C15, D26 |
| OpenAI compatibility | The premise has shifted. OpenAI's Chat Completions can't call tools on GPT-5.4+ unless reasoning effort is `none` (R2.2). LM Studio serves `/v1/responses` (R5.1), though the LM Studio pass alone would still pick Chat Completions (R5.8). | C1, D1, S2, S3 |
| OpenAI subscription | No ChatGPT plan includes API credits (R1.1). SIWC plan usage (2026-09-29) is official for Plus and Pro; the sources conflict for other plans. It is Responses-only, with constraints, and the docs don't address unattended personal use (R1.2). | C2, D2, S4, Q4, Q9 |
| Scope creep | No research needed. | C10 |

## Challenges

These are **proposals, not decisions**. Each links to a decision in Part 5. "Brief says" quotes or paraphrases Part 1.

### C1. Use the Responses API, not Chat Completions
- **2026-10-27 update:** D24 keeps Responses for OpenAI and LM Studio, but Claude uses its native Messages API. The original single-wire-format proposal and its reasoning below are retained as historical context.
- **Brief says:** "stick to mainstream chat-completions plus tool-calling" (Known risks).
- **Proposal:** make the Responses API the only wire format for every backend. Use it statelessly (`store:false`, replaying the full input including reasoning items) and always streamed.
- **Why:**
  - On OpenAI, Chat Completions can't call tools on GPT-5.4+ unless reasoning effort is `none`, and it can't call tools at all on GPT-6 Astra or GPT-6.1 Sol (R2.2).
  - It also drops reasoning between calls (R2.3), which is exactly what a tool loop needs to keep.
  - SIWC is Responses-only (R1.2).
  - LM Studio serves `/v1/responses` with function tools and client-held history (R5.1), and only that endpoint reports `cached_tokens` (R5.3).
  - So one Responses code path *could* cover every backend, and Chat Completions can't. On LM Studio, S2's first check passes for one model: multi-turn function calls with client-held history (R11). The rest of S2 is pending.
- **Consequences:**
  - **History** becomes a list of Responses *items* stored verbatim: `message`, `function_call`, `function_call_output`, and `reasoning` with `encrypted_content`. `call_id` is the brief's "tagged with its tool-call ID".
  - **Always stream.** SIWC requires it, it keeps long local generations from hitting HTTP timeouts, and token flow helps as a liveness signal; C8 covers the silent stretches.
  - **Reasoning items** are stored from `response.output_item.done`, because the `.added` event's `encrypted_content` may be incomplete (R2.4).
  - **Pin one model per run.** Reasoning is reusable only within one model family, and across families the API silently drops it (R2.4). Switching models happens only between runs.
  - **Preamble placement.** Put the preamble in a `developer`-role first item, not in `instructions` or a `system` item. SIWC rejects `system` items, LM Studio reportedly ignores `instructions` (R5.7), and the initial developer block is an eligible cache breakpoint (R3.1).
- **Consistent with the brief:** it is still the official `openai` SDK and still no provider abstraction, because the SDK covers Responses natively.
- **Risks:** LM Studio's Responses endpoint is less battle-tested. Reported problems: HTTP 500 on unparseable tool calls, and intermittent HTTP 500s on multi-turn tool calls (R5.7). S2 covers both.
- **Decision:** D1.

### C2. OpenAI auth: API key first, SIWC behind a spike
- **Brief says:** "OpenAI subscription for API calls: confirm the auth mechanism and its limits before relying on it." Also: "Claude is out: a Claude subscription can't be used for API calls."
- **Finding:**
  - No ChatGPT plan includes API credits (R1.1).
  - Since 2026-09-29, SIWC plan usage officially lets a ChatGPT plan pay for calls from your own code (R1.2). That makes the Claude/OpenAI asymmetry in the Models row real.
- **Proposal:** model profiles get `auth: api_key | chatgpt`. Build the API-key path first; SIWC is spike S4 and milestone M5.
- **Why SIWC isn't the default yet:**
  - **Eligibility is unclear.** The sources conflict on plans (R1.2). The docs neither cover nor exclude an unattended personal runner (Q9).
  - **Usage is shared.** Runs draw on the same "ChatGPT Work and Codex" pool as your own Codex work. On Plus that includes a shared 5-hour window, and on both Plus and Pro a weekly allowance (Q4).
  - **Hitting a limit must be a first-class outcome.** Before the stream opens it's HTTP 429; mid-stream it's a `response.failed` event; either way it gives no reset time. It sets the run to **`deferred`**, not `failed`, and puts the profile into backoff (4.8). Also document the "use credits after the limit" setting, which can cause charges (R1.2).
  - **Credentials need more than tokens.** Store the *issued* `client_id`, a stable per-host `ext_agent_host_id`, the ID token and the granted scopes as well as the tokens. Refresh tokens rotate on every refresh, and a racing refresh fails with `refresh_token_reused`, which forces a new sign-in. Refreshes are therefore serialised under a row lock, and the rotated token is committed before it is used (4.4).
  - **Client deployments stay on API keys.** A paid client deliverable probably counts as a "paid" app under the interest-form rule, so API keys are the safe default. The reason is commercial, not that the box is remote: self-hosting an open-source app on a remote VM is explicitly covered by the open-source flow.
  - **The login flow needs care in Docker.** The OAuth callback must reach `127.0.0.1:<port>` on the machine running the browser. Two workable routes:
    - `docker compose run --rm -p 127.0.0.1:<P>:<P> app gremlin login --port <P>`, with the listener bound to 0.0.0.0 inside the container;
    - sign in on the host to a file, then `gremlin credentials import`, following the docs' self-hosted VM procedure. The import keeps the app's own stable `ext_agent_host_id`, not the signing machine's.

    Postgres has no published port (4.9), so a host-side login can't write to the DB directly.
  - **Request shape differs.** SIWC needs `stream:true`, omits 15 request fields (including `temperature`, `max_output_tokens`, `max_tool_calls` and `prompt_cache_retention`), and wants function tools in namespaces or `additional_tools` (R1.2). The request builder takes these constraints from the model profile, so they stay config rather than a code path. The namespace rule might be the exception, which S4 checks.
- **Decision:** D2.

### C3. Run the agent's shell in a separate workspace container
- **Brief says:** "Isolation is Docker: the container is the boundary, mounted volumes define what it can touch."
- **Problem:** if the shell runs inside the app container, the boundary encloses the agent *together with* what it shouldn't touch:
  - API keys and OAuth tokens, readable from the environment with `cat /proc/self/environ`;
  - Postgres, including the agent's own run log, which turns "append-only" into an honour system;
  - the scheduler process.
- **Proposal:** a `workspace` container is the agent's world.
  - It has the toolbox image and the mounted volumes, and **no app secrets** (API keys, OAuth tokens, DB credentials). It has no route to the database network.
  - The app talks to it over an internal network through a small exec server: run a command, read a file, write a file.
  - There is still zero permission code. Docker just draws the line in the right place.
- **What the exec server must handle** (R8, R10):
  - kill the process group on timeout;
  - when the direct child exits, wait about 1 s for the pipe to reach EOF, then kill the group and return what was read, since background grandchildren hold the pipe;
  - spawn with stdin closed and prompts disabled: `GIT_TERMINAL_PROMPT=0`, `PAGER=cat`, `GIT_PAGER=cat`, `CI=1`, `DEBIAN_FRONTEND=noninteractive`;
  - enforce a hard output cap by reading the streams itself: keep the head and tail up to N bytes, and read and discard the rest, so `yes` or `tail -f` can't exhaust memory;
  - normalise output so it can be stored: decode UTF-8 with replacement, replace U+0000 with a visible marker, and flag `binary: true` when output is mostly non-text. A second sanitiser in the app covers every other source (C11);
  - put `GREMLIN_RUN_ID` in every command's environment;
  - kill a command's group when the RPC client disconnects;
  - when a run ends, kill every process whose `/proc/<pid>/environ` carries that run's ID, which also catches processes that escaped `kill(-pid)` with `setsid`;
  - on reset at app start, kill every process except PID 1 and the exec server itself.

  Compose's `init: true` reaps orphaned grandchildren. The workspace runs as the host user (`user:` in 4.9), so files the agent writes into bind mounts aren't owned by root on Linux hosts.
- **What it doesn't isolate** (be explicit):
  - **Skill secrets.** Per-skill env (4.7) is injected into exec calls, so it lives in the workspace. Every task shares one workspace container and one uid, so while two runs overlap, either agent can read the other run's environment from `/proc`. Files on shared mounts are readable across tasks too (Q5). Per-task uids would separate them, but that edges toward the non-goal (D17).
  - **Host services.** With internet egress, the workspace can reach `host.docker.internal`, and on Docker Desktop that includes every service bound to 127.0.0.1 on the Mac (R10). That includes LM Studio's model load, unload and download API, which is unauthenticated by default (R5.6). So **always enable LM Studio token auth**, keep the token only in the app's env, and treat other host services as exposed (Q8).
- **Bonuses:**
  - The workspace image is the agent's toolbox: install git, jq, Python and so on without bloating the app image.
  - The run log gets a database role that can only INSERT into it (4.4).
  - Privileged "app tools", written by you and needing secrets, run in the app. Commands written by the model run in the workspace.
- **Cost:** one more image, and a small RPC with the responsibilities listed above.
- **Decision:** D3, and D17 for skill secrets.

### C4. Skills are SKILL.md folders, not typed tools
- **Brief says:** "Self-describing units (JSON Schema plus handler), loaded from a registry … Ideally compatible in spirit with the SKILL.md convention."
- **Finding:** the SKILL.md spec has no typed tools. A skill is instructions plus scripts, and only its name and description are preloaded (R7). OpenAI has adopted the same standard (R4).
- **Proposal:** with shell and `read_file` as base tools, a SKILL.md skill needs **no new tools**.
  - `tools[]` stays small: the base tools, `activate_skill`, and a few app tools. It is **fixed per task definition and frozen for each run**, changing only when the task is edited or a new version is deployed (4.6). Skills grow as a catalog in the preamble instead.
  - That removes the "too many tools degrade the model's choices" problem, and a frozen `tools[]` is what caching wants (R3.4).

| | Runs in | Defined as | Model sees |
|---|---|---|---|
| **Base tools** | workspace | app code: `shell`, `read`, `write` and `edit`, or `apply_patch` in place of those two (D23) | always, in `tools[]` |
| **App tools** | app | TypeScript schema plus handler | per task: only tools that need app secrets or the DB, such as state or notify |
| **Skills** | workspace | SKILL.md folder plus `scripts/` | catalog (name and description) in the preamble; body loaded via `activate_skill` |

- **Activation:**
  - Use `activate_skill(name)`, whose `name` is an enum of the task's skills; the spec allows this (R7). Weak local models follow it more reliably than "read the file at this path", and every activation lands in the run log.
  - The skill body comes back as the tool's output, so it lands in the append-only history rather than the cached preamble.
- **Storage:** on disk. The scripts have to be files in the workspace anyway. The app mounts the same skill trees read-only, at the same paths, to build the catalog (4.9). The DB holds which skills each task uses, plus per-skill env.
- **Left open, not built:** typed skill tools declared in a sidecar file next to SKILL.md, with handlers as workspace scripts. It would be Gremlin's own convention, by analogy with Codex's `agents/openai.yaml`, which holds UI and invocation settings rather than typed tools (R7).
- **Not used:** OpenAI's shell-tool skills, hosted or local (R4). Both need OpenAI's `shell` tool type, which LM Studio lacks, so they would split the code path.
- **Decision:** D4.

### C5. Compaction must be rare, chunky, and cut at turn boundaries
- **Brief says:** "Compaction only touches the middle, so the two don't fight."
- **Finding:**
  - Within a run, the whole append-only history is a cacheable prefix.
  - Compacting the middle invalidates everything after the first compacted item, which is everything except the preamble and the task.
  - OpenAI lists compaction as a cache-breaker (R3.4), and on GPT-5.6+ every rebuild is a write billed at 1.25× (R3.1).
- **Proposal:**
  - **Compact rarely, in large blocks.** One large compaction when the context passes a threshold (say 70%) costs one cache rebuild. A sliding window that trims a little every turn misses the cache every turn, which is the worst case. `planCompaction` returns null until the threshold, then compacts one large block.
  - **Cut only at turn boundaries.** That means after all outputs of one model turn, before the next reasoning, message or call group. Most sources call that unit a step, and keep "turn" for a user's whole exchange (R15.1).
    - The API rejects a `function_call_output` whose `function_call` is missing.
    - Developers also report HTTP 400s for a `function_call` sent without its reasoning item, and for a reasoning item without the item that follows it.
    - So reasoning, call and output are kept or dropped as one unit. S3 tests a replay across a compaction boundary.
  - **Use `tool_choice` to stop tool calls.** A forced final answer uses `tool_choice:"none"` rather than removing tools. OpenAI documents that this keeps the cached prefix (R3.4); S3 measures it. LM Studio's `"none"` removes the tools itself, so the prefix is lost there (R15.3).
- **Decision:** D11.

### C6. Task definitions: DB canonical, authored as TASK.md files
- **Brief says:** "where task definitions live, presumably the DB."
- **Proposal:** the DB is the source of truth, but you author tasks as `TASK.md` files in a private git repo, and `gremlin apply ./tasks` upserts them.
  - **Frontmatter:**
    - schedule, timezone (`tz`), model profile, skills, budgets;
    - `overlap`: `skip` or `queue` (D16);
    - `catch_up`: `once` (the default) or `skip`;
    - `catch_up_grace`, default a few minutes;
    - `max_queue_age`, optional; unset means never skip;
    - `inline` (4.7).

    **Body:** the prompt.
  - **Every run** stores a snapshot of the resolved definition.
  - **`apply` semantics:**
    - It sets `next_run_at` on insert.
    - It recomputes `next_run_at` from now whenever the schedule, time zone or `enabled` changes.
    - It rejects unknown skill names and unknown model profiles.
    - It *disables* a task whose file was removed, so run history survives.
- **Why:**
  - Prompts behave like code: you want diffs, history and your editor.
  - "What did the prompt say at 3am" gets a definite answer.
  - A future client UI can still edit the DB.
  - It mirrors SKILL.md in spirit.
- **Since 2026-11-01:** before task definitions exist, a run takes its task from a Markdown file, frontmatter included (C19, D39, D40). Reading TASK.md's frontmatter would change only what a file that opens with a `---` block means.
- **Since 2026-11-05:** a task file's frontmatter configures the run already: its `mcp` list chooses the servers, and the block is stripped from the prompt (C21, D44, D45).
- **Decision:** D5.

### C7. TypeORM on Bun: proceed with conventions and a fallback ladder
- **Brief says:** verify decorators, `reflect-metadata` and migrations under Bun; have a fallback plan.
- **Proposal: proceed with these conventions.** 1–3 rest on gotchas verified on Bun 1.4.3 **[H]**. 4 and 5 rest on **[M]** sources, so S1 confirms all five.
  1. **Decorator flags where Bun reads them, plus a boot check.**
     - Bun reads only the `tsconfig.json` of the directory it is started from (R6.2). Set the flags in the root `tsconfig.json`, and give `packages/app` its own `tsconfig.json` with `"extends": "../../tsconfig.json"`, or the flags inline.
     - Never take the flags from a package-specifier `extends`. Copy both files into the image.
     - Run the app, its tests and the TypeORM CLI from `packages/app`.
     - Add a boot self-check that fails fast unless TypeORM registered columns for a known entity, which catches TC39 decorators sneaking in.
  2. **Turn `emitDecoratorMetadata` off (D15)**, keeping `experimentalDecorators` on.
     - TypeORM only needs `design:type` for things the conventions make explicit (R6.1). Turning it off removes Bun gotchas 2 and 4 outright.
     - If it stays on, type relations as `Relation<T>` and import `Relation` and other decorated-property types with `import type`.
  3. **Explicit column types.** Every `@Column` gets an explicit `type`, plus `lazy`, `array` or `hstoreType` where relevant, enforced by a lint rule. With metadata off, an untyped column fails at import.
  4. **Migrations under Bun [M]:**
     - `bunx --bun typeorm migration:run -d src/data-source.ts`;
     - `bunx --bun typeorm migration:generate src/migrations/<Name> -d src/data-source.ts` (positional path).

     Both run from `packages/app`.
  5. **Never minify identifiers [M]** (Bun #14888), and name entities and migrations explicitly.
- **Runtime type gap:**
  - **Pin `typeorm >= 1.1.0`**, so writes get the `null`/`undefined` guard too (R6.1).
  - **Write claim queries with find options**, `lock: { mode: "pessimistic_write", onLocked: "skip_locked", tables }`, or `qb.setFindOptions()`, so they keep the guard. QueryBuilder `.where()` silently matches zero rows on `null`. Name the locked table whenever the query joins (R6.3).
  - **The one exception is the scheduler tick's due-task query.** It filters on `profile_state`, which isn't a relation of `task`, so it is QueryBuilder or raw SQL: `… AND NOT EXISTS (SELECT 1 FROM profile_state ps WHERE …) FOR UPDATE OF task SKIP LOCKED` (4.8). A `LEFT JOIN … FOR UPDATE` errors on Postgres ("cannot be applied to the nullable side of an outer join"). Every parameter in it is non-null by construction, and integration tests cover it.
  - **Filter relations as `{ run: { id } }`**, never a bare id (#12712, R9). Run `tsc --noEmit` in CI, because Bun doesn't type-check.
  - **Integration tests** against a real Postgres cover every repository method, especially claims, locks and the `ON CONFLICT` tick.
  - **Index names:** let TypeORM *auto-generate* the partial-index name, so `migration:generate` sees predicate changes as drop and create (R6.3). The tick uses `ON CONFLICT DO NOTHING` and doesn't need the name.
- **Fallback ladder, if S1 fails:**
  1. **EntitySchema:** the same ORM with no decorators at all.
  2. **Run the app on Node** (`^22.13.0` or `>=24.11.0`, R6.1) and keep Bun for tooling. croner runs there too (D12).
- **Decision:** D13, triggered only if S1 fails; D15.

### C8. Budgets and a context check, not only an iteration cap
- **Brief says:** "Hard cap on iterations."
- **Finding:**
  - Each iteration resends the whole history, so time and cost grow roughly quadratically.
  - Nothing in a cumulative budget checks whether the *next* request still fits the model's context. LM Studio's default context is 8k (R5.5), and SIWC can't set `truncation` (R1.2).
- **Proposal: keep the iteration cap, and add budgets plus a context check.**
  - **Budgets:**
    - cumulative input tokens, which is dollars on an API key or allowance on SIWC;
    - a timeout per tool call;
    - a total-turn limit;
    - wall-clock time per run, as a **hard deadline**.
  - **How the deadline is enforced.** One `AbortController` per run passes its signal to `runTurn`, to every exec RPC (with an app-side deadline of the tool timeout plus a margin), and to every fetch: model loads, token refreshes, notifications. A stream that never stops sending, such as a local model stuck in a repetition loop, is cut off too. Where the backend allows it, a per-profile `maxOutputTokens` bounds each generation; SIWC forbids it (R1.2).
  - **Context-fill check after every turn:** last `usage.input_tokens` + `usage.output_tokens` + `estimateTokens(pending outputs)`, against the profile's `contextTokens`. Output tokens count because the last response's message, call arguments and reasoning are all sent again. Above about 85%, finalize. An API context-overflow error takes the same path.
  - **Two stream timeouts per profile.** Healthy streams can be silent for minutes: during local prefill, a JIT load (R5.5), or OpenAI reasoning. So use:
    - a *time-to-first-output* limit, which is minutes for local and high-effort profiles;
    - a shorter *idle* limit between deltas.

    On OpenAI, request reasoning summaries so reasoning emits events; S4 checks that SIWC allows them.
  - **When a budget or the context check trips:**
    - Make one last turn with `tool_choice:"none"` on OpenAI, sent as a user message so it ends an eligible cache breakpoint (R3.1), and sized to fit. It asks "what did you do and what remains". On LM Studio the message stands alone: `"none"` there drops the tools, and the KV prefix with them (R15.3).
    - That becomes the run's output and seeds the next run's state. Status: **`capped`**, not `failed`.
    - If even the finalize turn can't fit, returns calls anyway, or fails, end as `capped` with a synthesised "budget exceeded; no summary" output.
    - smolagents and Microsoft Agent Framework end their step limits this way. Most other agent loops run the last call's tools, then stop with an error (R15.2).
  - **The turn limit first (2026-10-16).** The finalize turn needn't wait for the budgets. At its turn limit the session fails today with no answer, where most loops at least run the last calls (R15.2). With the turn limit as its only trigger:
    - run the last turn's calls first, as nearly every loop in R15.2 does, so the finalize turn can report them. A budget or the context check skips them instead, since running them would overrun what tripped;
    - then send the finalize turn as above: `tool_choice:"none"` on OpenAI, the message alone on LM Studio. The message alone kept a 9B model from calling tools in 3 of 3 tries (R15.3);
    - if it still returns calls, or fails, end as `capped` with the synthesised output;
    - the server logs the answer as capped, and exits with a code of its own, so a script can tell an answer, a capped answer and a failure apart.

    `MAX_TURNS` at N then allows N turns with tools and at most one finalize turn: smolagents' and Microsoft Agent Framework's arithmetic. Decision: D20.
  - **Per-profile output cap:** the model-visible output cap is set per profile, smaller for local models.
- **Check:** LM Studio supports `tool_choice:"none"` on Chat Completions (R5.2). On `/v1/responses` it accepts it but drops the tools from the prompt, which loses the KV prefix (R15.3).
- **Decision:** D9.

### C9. Narration fallback: nudge, don't execute
- **Brief says:** "Graceful fallback when a weak local model narrates a tool call in prose."
- **Problem:** with unrestricted shell access, executing a command extracted from prose risks running something the model wrote as an *example*.
- **Proposal:**
  1. **Detect the narration.** Markers include LM Studio's own `[TOOL_REQUEST]…[END_TOOL_REQUEST]` (R5.2), `<tool_call>…</tool_call>`, or a lone JSON object with `name` and `arguments`.
  2. **Nudge** with a user message: "you described a tool call in text; emit it as a function call". At most twice, then treat the text as the final answer.
  3. **Treat LM Studio's HTTP 500 "Failed to parse tool call"** on `/v1/responses` (R5.7) the same way. The history then has no assistant text, so the nudge says: "your last reply could not be parsed; emit exactly one function call".
  4. **Optional strict execute mode** per model profile. It fires only when the entire content is exactly one valid call that passes schema validation.
- **Decision:** D8.

### C10. Fence the scope explicitly
- **Brief says:** "The failure mode is slowly reimplementing LangChain badly."
- **Proposal:** a written **"won't build"** list (4.11), and a soft size budget of about 1.5k lines for `core`. Crossing either needs an explicit decision.
- **Decision:** D10 covers packaging. The fence itself needs no decision unless you object.

### C11. Store history one row per item
- **Brief says:** "messages (history as `jsonb`)".
- **Proposal:** keep `jsonb`, but store one row per item, holding the verbatim Responses item as a `jsonb` payload, instead of one growing `jsonb` array per run.
- **Why:**
  - Appending to a `jsonb` array rewrites the whole value every turn, O(n²) bytes over a run (R9).
  - Rows are append-only, like the run log.
  - Compaction can *mark* rows instead of deleting them, so the audit trail survives.
  - Full-text search over history becomes possible later.
- **Payloads must contain no NUL and no lone surrogates.**
  - `jsonb` rejects `\u0000`, and it rejects the escape `JSON.stringify` emits for a string cut in the middle of an emoji. Both were reproduced on Postgres 16 (R10).
  - One sanitiser in `core` (`toStorable`) runs at the persistence boundary on every `jsonb` payload and every `text` column. It replaces U+0000 with a marker and lone surrogates with U+FFFD.
  - It covers model output, skill bodies, app-tool output and exec output alike. The exec server's normalisation (C3) is only one of those sources.
  - Truncation always cuts on code-point boundaries.
- **Decision:** D7.

### C12. Before M1, where does the shell run?
- **Brief says:** "Isolation is Docker: the container is the boundary" (non-goal). C3 puts the shell in a workspace container behind an exec server, and M1 builds it (4.10).
- **Problem:** loop features are arriving before M1's compose stack. The next one, skills with the playwright-cli skill, needs a shell (R12.1), and the skill feeds the model untrusted web pages. With private data in reach and an open network, that is the lethal trifecta (R12.6). A shell also ends what `read_file`'s confinement stands in for: the tool-loop design keeps the `.env` refusal only until the workspace container exists.
- **What a host shell reaches:** everything the user's account can. On a developer machine that means SSH keys, cloud and package-registry credentials, tokens in the environment and in keychain-backed helpers, `.env` files in other projects, login files and LaunchAgents, the Docker socket, other tools' Playwright daemons (through `kill-all`, R12.2) and LM Studio's API. This was measured on the development Mac and is recorded here by category only, because this repo is public.
- **Options:**

| | Where commands run | C3's process control | At M1 |
|---|---|---|---|
| **A** | `bash -c` on the host, as the user | TypeScript, in the CLI | the engine moves into the workspace |
| **A+** | the same, inside a generated Seatbelt profile (R12.5) | TypeScript, in the CLI | the fence is deleted and the engine moves |
| **B-lite** | the workspace container, through `docker exec` and an in-container `timeout -k` (R12.3) | coreutils and a bash wrapper | the docker-exec glue is replaced |
| **B** | the workspace container, with C3's exec server built now | TypeScript, in the container | kept almost unchanged |

- **Analysis (2026-10-15):** an advocate per option and an impartial judge scored them on eight criteria: fidelity to the Brief's boundary, the blast radius of a prompt-injected model, cost now, rework at M1, testability, development ergonomics, portability to a Linux box, and fit with playwright-cli. Out of 40, B scored 31, B-lite 26, A 25 and A+ 23, ranked B, B-lite, A+, A.
  - **B over B-lite, narrowly.** Both need the same image and the same Chromium bring-up (R12.4), and B's boundary is no stronger. B's code is the M1 component under the 100% mutation bar; B-lite's glue is replaced at M1, and its process control lives in bash.
  - **A last, for untrusted browsing.** The judge called it defensible only for attended runs against sites the user picks.
  - **Effort, estimated:** A 2.5–3 days; A+ and B-lite 3–4; B 4–6.
- **What a host shell needs, from the analysis** (input to Q15):
  - an environment built from scratch, never `process.env`, because Bun loads `.env` into it and children inherit it;
  - a working directory of its own, outside any repository;
  - a `.playwright/` folder there and a per-run `PLAYWRIGHT_CLI_SESSION`, so runs share a browser neither with each other nor with other tools (R12.2);
  - `CI=1` among C3's prompt-disabling variables;
  - cleanup at run end, since the browser daemon outlives every command (R12.2). macOS has no `/proc`, and `ps eww` shows the environment of only some processes, so a sweep by run ID needs care there;
  - LM Studio's token auth, since its API needs none by default (R5.6).
- **Since 2026-11-01:** the file tools refuse nothing by path, the `.env` refusal included, though the workspace container doesn't exist yet. A container is the only sandbox (C20, D41).
- **Decision:** D18.

### C13. Call one model request a step, and keep "turn" for the user's exchange
- **Brief says:** "Hard cap on iterations." The design then named the iteration a turn: `runTurn` (4.3), cuts at turn boundaries (C5), the finalize turn (C8) and `MAX_TURNS`.
- **Problem:** the sources that define "turn" mean a user's whole exchange, and call one model call a step (R15.1). The API the app calls probably agrees: `reasoning.context`'s `current_turn` seems to span every request since the last user message. The two meanings can't collide while a run takes one user message. They will once a session can ask the user and resume (the `SessionStep` type plans this), once `reasoning.context` is set, and in compaction, which must say which boundaries it cuts at. A later rename would also reach what M1 starts to persist: a task's `limits`, TASK.md files (C6) and the run log (4.4).
- **Options:**

| | One model request | It and the calls it asked for | A user's exchange | Cost |
|---|---|---|---|---|
| **Keep** | turn | turn | unnamed | none now; "turn" means two things once a session takes a second user message |
| **Step** | model call | step | turn | one mechanical change: about 460 uses across the code, tests, specs and README, and the Brief's prose |

- **Proposal: Step, before M1, as a change of its own that doesn't change what the server does.**
  - `MAX_TURNS` becomes `MAX_STEPS`, the limit's name in Vercel's AI SDK, smolagents, tau-bench and Mastra. The session's own default of 8 can go with it, leaving the setting's 30 as the only default.
  - `core`'s `runTurn` runs one model request, without the tools, so it becomes `callModel`, and the `model-turn` spec is renamed to match. 4.4's run log already calls this a `model_call`.
  - `classify` returns a `Reply` rather than a `Turn`: calls, a final text, or nothing.
  - The session's `TurnStats`, `turn_limit` and `turn_failed` take step names. The `turn` log record becomes `model call`, beside `tool call`, with a `step` field.
  - The messages and the README count steps: "The model didn't answer within 30 steps".
  - "Turn" is left free for the exchange: with the new names, a session runs one turn of several steps.
  - Done before D20, the finalize turn is written in the new names from the start.
- **Against:** OpenAI's and Claude's Agent SDKs call their limits "max turns", so `MAX_TURNS` is the name people may look for. And where it mattered, the Brief has already said "model turn" (C5) and "user turns" (R2.4).
- **Decision:** D21.

### C14. SQLite in a data folder, in place of Postgres
- **Brief says:** "Database: Postgres. Concurrent scheduled runs writing at once. Full-text search, `jsonb`, `pgvector` available." 4.4, 4.8 and 4.9 build on it: row locks with `SKIP LOCKED`, partial unique indexes with `ON CONFLICT`, two roles and a grant matrix, an advisory lock for the one daemon, and `pg_dump`.
- **Asked (2026-10-29):** a data folder holding `db.sqlite`, used through TypeORM, as the first persistence. Its first job is keeping MCP servers' OAuth credentials between runs.
- **Finding (R17.2):**
  - **The load fits.** In WAL mode, four processes claimed 2,000 queued runs, each exactly once, in about 0.3–0.7 s, alongside 4,000 other writes. SQLite allows one writer at a time, and for one user and a handful of runs that is enough.
  - **The scheduler's Postgres features have counterparts,** mostly in raw SQL: a single-statement claim, `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING id`; the partial unique index with `INSERT … ON CONFLICT DO NOTHING RETURNING`, whose conflict target must repeat the index's predicate exactly; savepoints; and `BEGIN EXCLUSIVE` held on a lock database for the one daemon, which the kernel releases when the process dies.
  - **What doesn't carry over:** roles and grants, since triggers only guard against bugs and anything that can write the file can drop them; TypeORM's lock options, `.returning()` and `indexPredicate`, which throw on SQLite; `timestamptz`; and `jsonb` as Postgres means it.
  - **The costs are in how concurrency behaves, not in throughput.** The drivers are synchronous, so waiting for a lock freezes the waiting process. A deferred transaction that reads and then writes fails at once, whatever the busy timeout. And TypeORM gives each process one connection (C15).
  - **Where the file lives matters.** On Docker Desktop for macOS, SQLite's locking failed on bind mounts and held on named volumes. SQLite's own documentation rules out network file systems.
- **Proposal: SQLite for good, in a data folder on a local file system.** In Docker that is a named volume, and commands that write it, such as the MCP login, run inside the container, as C2 already planned for SIWC. 4.4, 4.8 and 4.9 lose their Postgres-only parts:

| Postgres in the draft | With SQLite |
|---|---|
| The `gremlin_owner` and `gremlin_app` roles, the grant matrix and the init script | None. Append-only triggers guard against bugs, with `recursive_triggers` on so `INSERT OR REPLACE` can't bypass them; the workspace never mounts the data folder (C3) |
| `pg_try_advisory_lock` for the one daemon | `BEGIN EXCLUSIVE` on a lock database in the data folder, held for the daemon's life |
| `FOR UPDATE SKIP LOCKED` claims and the `FOR UPDATE OF task` tick | Single-statement claims in raw SQL; `BEGIN IMMEDIATE` as the one lock order |
| The credential refresh under `SELECT … FOR UPDATE` | A lease row (C17) |
| `timestamptz` | Integer epoch milliseconds |
| `jsonb` and `text[]` | TypeORM's `json` or `jsonb` (SQLite's JSONB), and JSON arrays |
| The `postgres`, `migrate` and `backup` services, and `pg_dump` | No database service; `VACUUM INTO` a dated file |

- **Against:**
  - A run log that stays append-only even against a misbehaving app process goes: with SQLite it depends on keeping the agent away from the file (C3).
  - Only one host can use the file. `pgvector` becomes sqlite-vec, whose last release, 0.1.9, dates from 2026-03-31.
  - Postgres's cost in a container is still small. What SQLite saves is a server, its credentials, its roles and its backup service.
- **Decision:** D25.

### C15. TypeORM on SQLite, on Bun and on Node
- **Brief says:** "Model the domain in TypeScript classes" (the ORM row). C7's conventions cover decorators on Bun, with EntitySchema as the fallback (D13) and `emitDecoratorMetadata` off (D15). D19 has since added Node.
- **Finding (R17.1):**
  - **Decorators can't run on Node 26.** Its type stripping fails to parse them, and `--experimental-transform-types` was removed in 26.0.0. Under D19 every entity is therefore an EntitySchema: D13's fallback becomes the rule, and D15 no longer applies.
  - **The same EntitySchema code ran identically on both runtimes** with TypeORM 1.1.2: migrations at start-up, reads and writes, transactions and savepoints, cascades, and a unique violation.
  - **Two drivers work on both runtimes.** better-sqlite3 13 is now a Node-API addon with prebuilt binaries in the package, but it is outside TypeORM's declared `^12` range. The other is a stand-in over `node:sqlite`, passed through TypeORM's undocumented `driver` option; Bun implements `node:sqlite` natively. better-sqlite3 12 doesn't load on Bun, and sql.js loses writes between processes.
  - **TypeORM's SQLite path has one connection and one query runner per DataSource.** Overlapping transactions in one process corrupt each other. A second `transaction()` silently becomes a savepoint inside the first, and a failed transaction's write was committed.
- **Proposal: these conventions, on top of those in C7 that still apply (explicit column types, and never minifying identifiers):**
  1. **EntitySchema only,** with `import type` for TypeORM's types. `tsc` with `verbatimModuleSyntax` catches value imports, including the ones `migration:generate` writes.
  2. **One async mutex around all database work in a process.** No two `transaction()` calls run at once, and nothing awaits network I/O inside a transaction.
  3. **A write transaction starts with a write,** so that SQLite's busy handler can wait for the lock. A raw `BEGIN IMMEDIATE` helper may run only raw queries, since otherwise it corrupts TypeORM's count of open transactions.
  4. **Every pragma is set explicitly on open:** `journal_mode = WAL` (TypeORM's `enableWAL`), a short `busy_timeout`, since it is how long the event loop may freeze, `foreign_keys = ON`, `synchronous = FULL` at least while credentials are written, and `recursive_triggers = ON`.
  5. **Migrations are imported explicitly and run at start-up,** with `synchronize` off and one SQL statement per `query()`. better-sqlite3 throws on a second statement; `node:sqlite` and `bun:sqlite` silently drop it. A failed migration ends the process, because it leaves foreign keys off.
  6. **Raw SQL where TypeORM's SQLite path throws or misreports:** locks, `RETURNING`, the ids `orIgnore()` reports, and the count `dataSource.query()` returns for a write.
  7. **Unique violations are recognised by their error code** (`SQLITE_CONSTRAINT_UNIQUE`, or 2067), BigInt reading stays off, and blobs are `Uint8Array`.
- **Decision:** D26 for the driver. The conventions need no decision of their own once D25 is settled.

### C16. MCP without waiting for OAuth
- **Asked (2026-10-29):** persistence first, then a command that runs an MCP server's OAuth flow and saves its tokens, then an MCP client in the agent.
- **Finding:**
  - **Three kinds of server need no database** (R17.4): those that need no authorisation at all (Cloudflare's documentation server, DeepWiki and Microsoft Learn), those given a fixed bearer token, and stdio servers, which the specification says should take their credentials from the environment rather than from OAuth.
  - **Most vendors issue a fixed token for use without a browser** [M]: Linear, Notion (Business and Enterprise), Stripe, GitHub, Supabase, GitLab, Neon, Airtable, Intercom, monday, Zapier, Cloudflare, Atlassian and PayPal. Stripe accepts only agent keys from December. GitHub's server offers neither dynamic registration nor a metadata document, so it needs a token, or an OAuth app of your own, either way.
  - **OAuth is the fragile path for a scheduled runner.** Refresh tokens rotate, and reusing one can revoke the whole grant. A crash between the server rotating the token and the client committing it loses the grant, whatever the client does (R17.2).
- **Proposal:**
  - **A per-server header from the environment,** such as `Authorization: Bearer` followed by the value of a named variable, as the recommended way to use a server unattended. OAuth then serves the servers that offer nothing else.
  - **Two independent changes, then a third.** Persistence (`DATA_DIR`, the store, migrations and the credential tables) proceeds beside the MCP client (servers that need no auth, take a fixed token, or run over stdio). The OAuth login and OAuth-backed servers come after both, since they need both.
- **Against:** the request puts persistence first deliberately: it is also the foundation for runs, history and tasks (4.4). This order doesn't delay it; it only stops OAuth from holding up the client.
- **Decision:** D35 for the order. The header is part of D29.

### C17. The MCP login command, and a lease for the refresh
- **Asked (2026-10-29):** a command that starts the OAuth flow, logs the URL the user must open, and saves the tokens that later runs need.
- **Finding:**
  - **The shape is established practice** (R17.5). Codex, Claude Code, opencode, pi, Cursor and Amp each have a login command: an authorization code with PKCE, a loopback listener, and the URL printed. Codex, Claude Code and pi also accept the redirected URL pasted back, which is what works over SSH and in containers.
  - **The SDK does the protocol but not the plumbing** (R17.3). `auth()` covers discovery, registration (a metadata document, then dynamic registration), PKCE, the `resource` parameter, scopes and refresh. It has no listener, doesn't check `state`, and refreshes only after a 401.
  - **Registration** (R17.4): 22 of 27 servers offer dynamic client registration (DCR), 11 of them also a client ID metadata document (CIMD), and 5 offer neither. The 2026-07-28 specification deprecates DCR in favour of CIMD, which needs a JSON document at a stable HTTPS URL, published under the client's name.
  - **Refresh races are real** (R17.2). Against a mock server that rotates refresh tokens and detects reuse, a reused refresh token got the grant revoked. Holding `BEGIN IMMEDIATE` across the HTTP call stalled every writer in every process, and compare-and-swap alone didn't prevent the reuse. A lease did.
- **Proposal:**
  - **The command is `bun run mcp login <name>`,** and `bun run mcp:node login <name>` on Node: a subcommand of `bun run mcp`, the second entry point beside `main.ts` (D30).
    ```
    listen on 127.0.0.1:<port>/callback, bound explicitly: listen() without a host takes every interface
      and read stdin for a pasted redirect URL
    auth(): protected-resource metadata, even when the server answers 200 → authorization-server metadata
      → client: a configured client ID ▸ CIMD (D31) ▸ DCR with application_type native and
        token_endpoint_auth_method none, keeping any secret the server returns
    redirectToAuthorization(url) → log.info('authorize', { server, url })
    callback or paste → state and iss checked → finishAuth → saved under the issuer
    a fresh connection → tools/list → log.info('logged in', { server, tools })
    ```
    It waits up to 5 minutes and never logs a code or a token. In a container it listens on 0.0.0.0 with the port published to the host's 127.0.0.1, as C2 planned for SIWC, or takes the paste.
  - **Two providers over the same rows.** The login command's registers clients and redirects. The agent's never does either. It fails with "run `bun run mcp login <name>`", ignores the SDK's attempts to save a code verifier, and sets `onInsufficientScope: 'throw'`. The SDK treats a transient refresh failure as a reason to re-authorise, and would otherwise overwrite the verifier of a login in progress.
  - **Refresh ahead of time, under a lease:**
    ```
    UPDATE credential SET lease_owner = :me, lease_until = :now + L
     WHERE id = :id AND refresh_token = :seen AND (lease_until IS NULL OR lease_until < :now)
    1 row  → refresh over HTTP, outside any transaction, aborted before L runs out
             → UPDATE credential SET <tokens>, lease_owner = NULL
                WHERE id = :id AND lease_owner = :me AND refresh_token = :seen
    0 rows → another process holds the lease: wait, then read the row again
    ```
    A run refreshes before its first call when the token expires within 5 minutes, as 4.4 planned for SIWC, and once after a 401. `invalid_grant` sets `needs_login`. A timeout or a 5xx keeps the tokens and fails only this run's use of the server.
  - **One table for every rotating OAuth credential:** MCP servers now, and SIWC in M5 (4.4's `Credential`). A row holds the server's name and URL; the issuer; the protected-resource and authorization-server metadata as discovered, with the `resource` string kept verbatim; the registration (method, client ID, any secret, and the exact redirect URI); the tokens, `expires_at` and scope; `needs_login`; and the lease.
- **Against:**
  - Loopback redirect URIs registered without a port rely on the server honouring RFC 8252's rule that any port matches, and some servers match the host's spelling exactly. A fixed, configurable port is the safer default.
  - A crash between the server's rotation and our commit still loses the grant. Only a server-side reuse window recovers it.
- **Decision:** D30 for the command, D31 for registration, and D32 for token storage.

### C18. MCP tools in the agent
- **Brief says:** "A task gets the relevant subset, not every skill, because too many tools degrade the model's choices." The session also reads its tools once, to keep the prompt cache (R3.4).
- **Finding (R17.3, R17.5):**
  - **The SDK:** `@modelcontextprotocol/client` 2.4.0 is the stable line. The v1 package, `@modelcontextprotocol/sdk`, is maintenance-only and won't support the 2026-07-28 revision. A client-only install is 13 packages, none of them a server framework, and its zod dependency resolves to ours. 2.4.0 bundles a version of fast-uri with four advisories published on 2026-10-23; the fix is in 2.4.1, which isn't published yet.
  - **Names:** MCP allows `.`, `-` and up to 128 characters. LM Studio converts names to snake_case, Anthropic accepts 128 characters of `[a-zA-Z0-9_-]`, and OpenAI documents 64. 15 of server-everything's 16 tools have a `-` in their name.
  - **Strict mode:** OpenAI rejects the whole request when one `strict: true` tool's schema doesn't qualify, and typical MCP schemas don't: they have optional properties and no `additionalProperties: false`.
  - **Schemas fit.** The SDK's `fromJsonSchema` produces core's `ToolSchema` shape, validated by the ajv the SDK bundles.
  - **Results** can hold text, images, audio, resource links, embedded resources and structured content, while `ToolOutcome` is text.
  - **stdio:** the SDK's transport signals only its direct child, and a server started through `sh -c` left its grandchild running. `@mecha-gremlin/process` closes stdin by contract.
  - **The SDK writes `console.debug` to stdout,** where the agent's log records go.
  - **In practice,** per-server allow and deny lists are near-universal, `mcp__<server>__<tool>` is the common naming, and every surveyed harness reacts to `tools/list_changed`.
- **Proposal:**
  - **Names:** `mcp__<server>__<tool>`, in `[a-z0-9_]`, at most 64 characters, with a stable hash suffix on overflow or a collision; a map back to the MCP names; and server names checked for collisions once mapped.
  - **Schemas and strict mode:** each MCP `inputSchema` goes through `fromJsonSchema`, so `validateArgs` keeps working. MCP tools are sent without strict mode, and the built-in tools stay strict.
  - **One list per session,** with the MCP tools sorted after the built-in ones. A `tools/list_changed` mid-session is logged, and the next run sees the new list.
  - **Results:** text blocks as they are; resource links as their URIs; embedded text inline; structured content as JSON when no text came; images and audio as placeholders; `isError` as a failure; all capped as `read` is.
  - **stdio servers** run through a transport over `@mecha-gremlin/process`, which gains a stdin pipe. Each gets a process group of its own; an environment built from an allowlist plus its own variables, as `commandEnv` builds the shell's; and `GREMLIN_RUN_ID`, so that the run's sweep is the backstop.
  - **Lifecycle:** servers connect in parallel, with a start-up timeout, before the first model call. Calls carry a timeout and the run's abort signal, and the clients close before the sweep.
  - **The SDK's console output** goes through the logger, or nowhere.
- **Decision:** D33 for what a failed connection does, and D34 for the tools. 4.12 drafts the whole design, with D36 and D37 (R18).

### C19. A run's task: a file, or `--prompt`
- **Asked (2026-11-01):** make the agent take a Markdown file by default, with a parameter for a prompt given inline.
- **Finding:**
  - **Today the arguments, joined with spaces, are the task** (the `agent` spec). A long or multi-line task goes through the shell as `"$(cat task.md)"`, which arrives intact only when quoted, and only within the system's limit on arguments (R19).
  - **The Brief's words are taken.** C6 calls a TASK.md's body "the prompt", and `gremlin run <task>` and `gremlin skill-env set <skill> [--task <name>]` take a task definition's name (4.4, 4.8). A `--task` flag that holds text would give "task" a second meaning.
  - **Relative paths start from the repository's root** under `bun run`, as `WORK_DIR` does, wherever the command was typed (R19).
  - **Every inline call changes:** the README's usage and examples, CI's start-up check on Node, the `agent` spec's task requirement, and the run's tests.
- **Proposal:**
  - **`bun run agent <file>`:** the file's text, trimmed, is the task. Any text file will do: Markdown is expected, but the extension isn't checked. A blank file, or one with a NUL byte in its first 8 KiB, the test `read` uses, fails before any request.
  - **`--prompt <text>`, or `-p <text>`,** gives the task inline, as one argument.
  - **One way at a time.** No task, both forms, two files, or `--prompt` twice fail with an error that names both forms. As a missing task is today, it is reported with the configuration's problems, before the store opens and before any request.
  - **What the file tools refuse stays refused.** A `.env` file, or a file in the data folder, fails as a task file too, so that a slip of the shell's completion can't send secrets to the provider and print them in the `asking` record.
  - **Frontmatter is part of the task** (D40).
  - **The `asking` record keeps the task's text, and adds the file's path.** Until runs are stored, that record is the only copy of what was asked, and the file can change after the run: C6's "what did the prompt say at 3am".
  - **No stdin for now.** `-` could name it later, since stdin passes through `bun run` (R19).
- **Against:**
  - **Every inline habit breaks.** `bun run agent 'Say hi'` looks for a file named "Say hi", though the error names `-p`.
  - **A file has no size limit,** so a large one passed by mistake is sent whole. Whether that needs a cap depends on Q25.
  - **Under `bun run`, a path the shell completed in a subdirectory is wrong,** since the agent starts in the repository's root. Absolute paths always work.
- **Since 2026-11-01:** the file tools refuse nothing by path (D41), so what they refuse no longer covers `.env` files or the data folder, and a task file refuses neither (D43). A binary or blank one still fails.
- **Since 2026-11-05:** a task file's frontmatter is no longer part of the task. It is stripped from the prompt, and its `mcp` list chooses the run's servers (C21, D44, D45).
- **Decision:** D39 for how a run takes its task, and D40 for frontmatter.

### C20. The file tools refuse nothing by path
- **Brief says:** "The agent gets unrestricted file-system and shell access. Isolation is Docker: the container is the boundary, mounted volumes define what it can touch. No permission system in application code." (Non-goals)
- **Asked (2026-11-01):** "There is no point to restricting writes while allowing arbitrary shell commands, we should unrestrict writes by default." Then: "This harness should not worry about this type of safety, if we need sandboxing, we will use containers."
- **Finding (R20):**
  - **The fence is a leftover.** It was a boundary for three days, while `read_file` was the model's only tool. Since the shell arrived it has bounded the file tools alone, and the write fence was built to give clear errors, not to be a boundary.
  - **Its errors fall mostly on deliberate work.** Mistaken paths mostly fail on their own. What the fence refuses is a write the task means, which the model can still make through the shell, with fewer checks and a vaguer record.
  - **Taking the fence off writes alone would make the tools disagree:** `write` would create files that `read` refuses.
  - **`read`'s refusals of `.env` files and the data folder were weighed as leak guards,** for the reason C12 builds the shell's environment from scratch: to stop an accident, not a model that goes looking. The ask rules them out, and the data folder's files are binary anyway.
- **Proposal:**
  - **No file tool refuses a path for where it is.** `read`, `write`, `edit` and `apply_patch` drop the working-directory and skill-directory checks, the `.env*` refusal, the data-folder refusal, and the symbolic-link checks that served them. A relative path resolves against `WORK_DIR`, and an absolute path is used as it is.
  - **The refusals that don't depend on where a file is stay** (R20.2), and so does `read`'s 32 KiB cap.
  - **No setting brings the fence back.** With a shell in every run, a setting would only look like a sandbox. When one is needed, it is a container, as D3's workspace is.
  - **What follows from it:** `DATA_DIR` may be or contain `WORK_DIR`, since nothing refuses the data folder any more; `read`'s description drops "absolute inside a skill's directory"; and the README says, where it described the fence, that the file tools reach whatever you can, as the shell does.
  - **What stays:** the stdio servers' run directory outside `WORK_DIR` and `DATA_DIR`, and the shell's environment built from scratch (R20.6).
- **Against:**
  - **A mistaken path that happens to be writable now succeeds,** in `/tmp` or the home directory, where the fence refused it. The output names the path as given.
  - **The file tools can do what only the shell could:** replace a real `.env` with a template, delete `db.sqlite`, change a skill's files.
  - **It takes out code and tests** that `add-persistence` and `read-task-file` added days ago.
  - **With paths free to leave the working directory, a model is likelier to write `~/…`,** which no tool expands (R20.5, Q26).
- **Decision:** D41 for the file tools, D42 for a setting, and D43 for a task file.

### C21. A task names the MCP servers it needs
- **Brief says:** "A task gets the relevant subset, not every skill, because too many tools degrade the model's choices." (Part 1). 4.7 gives a task its skills through TASK.md's `skills:` list, but every run connects every enabled MCP server (4.12, D33).
- **Asked (2026-11-05):** "It's good that by default we expose all MCPs to the task, but we should have a way to limit the MCPs for a given task that does not need all of them, I was wondering if we could or should encode it into the prompt markdown or use env vars instead."
- **Finding (R21–R23):**
  - **Every task depends on every server.** A server that can't start fails tasks that never call it, and the only fix the error offers, `disable`, takes it from the tasks that do (R21.2).
  - **The definitions cost** about 21,900 tokens for the 15 servers measured, against about 700 for the built-in tools (Q21).
  - **The Brief already puts a task's choices in its frontmatter:** its skills (4.7), and its model profile and budgets (C6).
  - **An environment variable can't choose for one task** from `.env`, which every run reads, and can't differ by task in 4.8's one daemon (R21.4).
  - **Elsewhere, a run's own choice is a flag, and no harness chooses servers one by one through an environment variable.** A definition file narrows tools by server pattern while every server still connects, or brings servers of its own; only Claude Code's sub-agents name a configured server (R22.1, R22.2).
  - **Both parsers refuse frontmatter that notes do hold,** such as `title: Meeting: Q3 plan` (R23.1).
- **Proposal:**
  - **A task file's frontmatter names its servers,** in a top-level `mcp` list of the names `bun run mcp list` shows:
    ```markdown
    ---
    mcp: [docs, github]
    ---
    Summarise the issues opened since yesterday.
    ```
  - **No list means every enabled server,** as now, and `mcp: []` means none.
  - **A list is exact.** The run connects the servers it names and no others, so a server added later reaches only the tasks without a list.
  - **Servers, not tool patterns.** Elsewhere a pattern hides a server's tools while the server still connects (R22.1). Here a server that connects can fail the run (D33), so the list names servers, and only those connect.
  - **A name the store doesn't hold fails the run** before any network request, pointing to `bun run mcp list`. **So does a disabled one,** pointing to `bun run mcp enable <name>`, since the task says it needs it (D46).
  - **The block is stripped, and the body is the prompt** (D45), as every harness surveyed does (R22.4). A block counts when the trimmed text opens with a `---` line, a later `---` line closes it, and what lies between parses as a mapping or is empty. A block that parses as plain text, as after a horizontal rule, stays in the prompt.
  - **Frontmatter that isn't valid YAML fails the run,** with the parser's reason and line (D47): a broken block can be neither read nor safely sent, and notes do hold them (R23.1).
  - **A key the run doesn't read gets a warning,** and is ignored (D48), so that a misspelt `mcps` shows in the log, and a note's `tags` don't fail it.
  - **The list's shape is checked.** `mcp: docs`, `mcp:` and a list that holds anything but names fail the run, with a hint showing `mcp: [docs]` or `mcp: []` (R23.2). So does a name given twice.
  - **The `asking` record names the servers the task chose,** or says that it named none.
  - **D33's error gains a fix for one task:** give the task an `mcp` list without the server, beside `bun run mcp disable <name>`.
  - **An inline task's text is read the same way,** so `-p` needs no flag of its own.
  - **When TASK.md arrives (D5),** it reads the same key, and `gremlin apply` rejects unknown names, as for skills (4.7).
  - **It isn't a boundary.** The list narrows what the model is offered, for cost, relevance and reliability. The shell still reaches every server's API and the store (C20).
- **Against:**
  - **It reverses D40, four days on.** A note's frontmatter no longer reaches the model, so whatever the model needs from it moves to the body, and a note whose frontmatter isn't valid YAML, which runs today, fails (D45, D47).
  - **A misspelt key (`mcps`) is ignored,** and the run gets every server, as today; only its warning shows it (D48).
  - **The text and the list can disagree.** A task that mentions a server it doesn't list gets none of its tools, and the model reports that it can't reach the server, or works around it through the shell.
  - **Only the file given to the run chooses.** A task that has the model `read` another task file follows that file's text, not its list.
  - **It's stricter than the harnesses surveyed,** which mostly ignore a name that matches nothing (R22.1). A task file copied to a machine whose servers have other names fails until it's edited.
  - **Prose can pass for frontmatter.** A file that opens with a horizontal rule, a line such as `Note: call Ann` and another rule loses that line from the prompt, since it parses as a mapping.
- **Decision:** D44 for where the choice lives, D45 for what the frontmatter means, D46 for a listed server that's disabled, D47 for frontmatter that isn't valid YAML, and D48 for a key the run doesn't read. Q27 asks whether a task should narrow a server's tools as well.

### C22. A task can go without a server it marks optional
- **Brief says:** "Every server that isn't disabled is required." (4.12). D33 rejected a per-server `required` flag.
- **Asked (2026-11-05):** to cover optional servers in the change that lets a task choose its servers, rather than in a later one: a `?` marker, a warning record, and a note in the model's instructions.
- **Finding (R24, R22.3):**
  - **A task written to report a missing source can't,** since a server that can't start ends the run before the model sees anything (R24.2).
  - **No harness has a per-task optional flag.** Elsewhere a failed server is left out by default, Codex lets a server require itself, and only Claude Code tells the model (R22.3).
  - **No server name holds a `?`,** and both parsers keep `github?` as it is (R24.3).
- **Proposal:**
  - **A `?` after a listed name marks the server optional:** `mcp: [docs, github?]`.
  - **What would fail the run for a required server leaves an optional one out:** a reference that can't resolve, an entry that fails its checks, a login to give again, a start that fails or runs out of time, or a tool that `includeTools` names and the server doesn't list. So does being disabled, so D46 holds for unmarked servers only.
  - **A name the store doesn't hold still fails the run,** marked or not, and so does a name given twice, with or without its `?`.
  - **A left-out server is logged and told.** A `warn` record names it and the reason, and the model's instructions gain a line naming each left-out server and why, such as "it needs a login".
  - **The reason is the start-up failure's,** redacted as D33's error is, without stderr.
  - **A run whose servers all start sends its instructions unchanged,** for the prompt cache.
  - **Without a `?`, a server stays required,** as D33 says, and so does every server of a task without a list.
  - **The exit code doesn't change:** a run that answers exits with 0, whatever it left out.
- **Against:**
  - **A left-out server sets off no alert.** Until runs are stored and alerts exist (Q1), only the warning record and the task's own answer show it.
  - **A `?` can hide a broken configuration:** an unset variable or a spent login leaves the server out run after run, each time with only a warning.
  - **It's new syntax,** which no other harness has, in a list that otherwise holds plain names.
  - **It reverses D33 for the servers it marks.**
- **Decision:** D49.

### C23. One resident scheduler that waits for the next fire
- **Brief says:** "Fires task runs. Must handle overlapping runs safely. (**Open:** in-process scheduler vs cron/systemd timer invoking a CLI; where task definitions live, presumably the DB.)" (Part 1). 4.8 drafts one daemon, `gremlin serve`, whose tick runs every 15 s over each task's `next_run_at`, with per-profile workers and semaphores, backoff per limit domain, a single-instance lock and a boot sweep, and it argues against cron, systemd and `Bun.cron` timers (D6).
- **Asked (2026-11-08):** a lightweight scheduler, "one that hooks into the native CRON (Linux or maybe MacOS) but falls back to a NodeJS library if it's not available, the key thing for the system to be light and simple like this project overall". After R25: "Our cron daemon just needs a simple crontab-like file or database it would need to parse the schedule expression and wake itself up instead of checking the same thing every second". After R26 (2026-11-09): "We start it by giving it a config and a data directory location, the data directory will be used to store logs of the jobs and its own log". C24 takes the language.
- **Finding (R25, R26):**
  - **`Bun.cron`'s OS-level form can't be the native hook.** Its jobs get no working directory, so they load `~/.env` rather than the repository's, and its crontab rewrite replaces the whole table when `crontab -l` fails. Under Debian cron a job's output is lost. On macOS its plist leaves out `AbandonProcessGroup` and `ProcessType`, so leftover processes are killed and the job is throttled. Its fixes have waited 2–7 months (R25.1).
  - **One OS entry per task is the most code and the least uniform.** launchd takes no ranges or steps, so `*/5 9-17 * * 1-5` becomes 540 calendar entries; every task edit changes OS state; and the platforms disagree on missed fires, overlap and DST (R25.2).
  - **Where the Brief deploys, nothing native keeps time.** The Debian-based Bun and Node images have no cron, Alpine's busybox crond is installed but not started, and `crontab` takes entries when no daemon runs, so a native scheduler can't be detected in advance (R25.2, R25.5).
  - **Waking at the next fire depends on the clock, not the language.** Rust's `std` and tokio, Go, Node and Bun all wait on clocks that stop while a Mac sleeps or a Linux machine is suspended, so a scheduler that sleeps for the whole delay is late by the time asleep. The portable fix caps the wait and re-reads the wall clock, as croner (30 s), OpenClaw (60 s), cronie and busybox crond (each minute) do. Only the operating system's own wall-clock timers wait exactly (R26.1).
  - **The cap costs next to nothing:** at 60 s, one wakeup a minute, about 16 ms of CPU a day in Rust (R26.1).
  - **Catching up once is the common default.** launchd and systemd after sleep, systemd's `Persistent=` after a power-off, and Kubernetes, Claude Code Desktop, OpenClaw and Hermes run a missed fire once. The crons drop gaps longer than 10 minutes (Apple's) to 3 hours (Debian's and cronie's), and only fcron's `bootrun`, dcron's stamps and anacron's daily system jobs catch up a machine that was off (R25.2, R25.4, R26.2). Skipping a fire while the last run goes on is the common overlap default (R25.4).
  - **No existing daemon covers catch-up, run records, a per-run deadline and the working directory** on both macOS and the container images (R26.2).
  - **Scheduled runs meet gaps in this repository.** Runs started together on a fresh or migrating data folder fail, nothing bounds a whole run, and the agent's `ps` listing fails in five of the six official images (R25.5).
- **Proposal:**
  - **One resident scheduler of its own,** `gremlin-scheduler --config <file> --data-dir <dir>`, written in Rust in `packages/scheduler` (C24). It takes 4.8's rules, not its database: each wake decides from the wall clock what fell due since the last, a missed fire runs once (D52), a running job's next fire is skipped, and a run has a hard deadline.
  - **It waits until the earliest next fire, never longer than 60 s** (D54), so a fire is at most 60 s late after a sleep, a suspend or a clock step, as long as the wall clock is right at wake. Inside Docker Desktop's VM after the Mac sleeps, it can be later by the time to the VM's next clock step, which comes every 30 s **[M]** (R26.1). A backward step runs nothing twice.
  - **The config, in TOML,** holds the defaults and one table per job (D51), in one zone (D53):
    ```toml
    timezone = "Europe/London"
    working_dir = "/path/to/mecha-gremlin"
    command = ["/path/to/bun", "packages/agent/src/main/main.ts"]
    keep_runs = 50

    [[job]]
    name = "daily-summary"
    schedule = "0 7 * * *"
    args = ["tasks/daily-summary.md"]
    timeout = "30m"

    [[job]]
    name = "issue-digest"
    schedule = "*/30 9-18 * * 1-5"
    args = ["tasks/issue-digest.md"]
    catch_up = false
    ```
  - **A job is a command,** so the scheduler knows nothing of the agent, its store or its task files. Each run is `command` plus the job's `args`, started in `working_dir`, so that the agent reads `.env` there, with `PATH` and `LANG` set.
  - **The data directory holds:** `scheduler.log`, the scheduler's own records as JSON lines, shaped like the agent's; a lock, so that one scheduler serves a data directory; and `jobs/<name>/<start>.log`, each run's stdout and stderr, mode 0600, with the newest `keep_runs` kept. The newest log of each job holds its last start, so catching up after the machine was off needs no other state.
  - **Runs are its children,** each in its own process group. A timeout sends SIGTERM to the group, then SIGKILL. SIGTERM to the scheduler stops new runs and passes it on; SIGHUP rereads the config.
  - **Overlap skips the fire and logs it,** C6's `overlap: skip` and the commonest default elsewhere (R25.4); `queue` keeps D16's meaning.
  - **What keeps it running:** on a Mac, one LaunchAgent with `KeepAlive`, `WorkingDirectory` and `ProcessType` set; in Docker, the image's entrypoint, with a restart policy, `init: true` and a stop grace longer than a run's cleanup; on a Linux host, a systemd user service.
  - **Before it starts runs together,** the agent's store migrates once, or retries, so that concurrent runs don't fail (S13), and the image installs procps (Q24).
  - **croner-rust computes the fires,** pinned to the newest release, with DST and day-field tests (D12).
- **Against:**
  - **It doesn't hook into native cron,** as first asked: the operating system only starts and restarts it.
  - **A resident process,** where a native heartbeat needs none; in Rust it holds about 2 MiB (R26.3). The heartbeat, though, needs state and a lock between ticks, runs detached with their output in files, and dead-run detection without a daemon, and the container would still need a loop (R25.5).
  - **Up to 60 s late after a wake, and later inside Docker Desktop's VM until its clock is next stepped,** where launchd's and systemd's own calendar timers fire at the wake (R26.1).
  - **One process holds every schedule,** so a crash stops scheduling until it restarts. Runs stay separate processes, so a run's crash can't take it down, and the job logs let a restart catch up what it missed. Under systemd or Docker, though, a run still going when it crashes is killed with it, and isn't run again (R25.2).
  - **Schedules live apart from their tasks.** A renamed task file breaks its job until the config changes, and the config is one more private file beside `.env`.
  - **Every run pays its own start:** loading the agent's modules took 113–124 ms on Bun and 287–307 ms on Node, with 175–191 and 399–438 ms of CPU, where 4.8's in-process workers would share a warm runtime (R25.3).
  - **On macOS, a process launchd starts, and likely the runs it starts, can't reach `~/Documents`, `~/Desktop` or iCloud Drive** **[M]**, so a task that works there needs its files elsewhere (R25.2, Q28).
- **Decision:** D6 for the shape, D51 for where schedules live, D52 for missed fires, D53 for the zone and D54 for the wait. C24 takes the language (D50).

### C24. The scheduler is a Rust package
- **Brief says:** "TypeScript on Bun ... The work is I/O-bound. Instant edit-run loop matters more than anything Rust offers here. No compile step." (Part 1, settled; widened to Bun or Node by D19).
- **Asked (2026-11-08):** "I got the impression that the native OS cron solutions are not workable and that the Bun / Node ecosystem is not efficient. Our cron daemon just needs a simple crontab-like file or database it would need to parse the schedule expression and wake itself up instead of checking the same thing every second, should we not just write this in Rust?" After R26 (2026-11-09): "I am leaning towards having a scheduler under packages and have it written in Rust since 25MB is not 0 and it's functionality will be limited." Then decided, with a TOML config.
- **Finding (R26):**
  - **Rust doesn't make waking at the next fire correct.** `std::thread::sleep` and tokio count down on `CLOCK_UPTIME_RAW` on macOS and `CLOCK_MONOTONIC` on Linux, which stop in sleep and suspend. Rust can reach the operating system's wall-clock timers, safely on Linux through rustix and on macOS only through unsafe code; JavaScript can't, short of FFI. Against C23's 60 s cap they save about one wakeup a minute, and inside Docker Desktop's VM, whose clock is stepped every 30 s, a `CANCEL_ON_SET` timerfd wakes every 30 s anyway (R26.1).
  - **Nothing on the table checks every second while idle** but Bun's idle GC timer, which wakes the main thread and starts 7 helper threads every 30 s, and every second at first. `BUN_GC_TIMER_DISABLE=1` removes almost all of it, but only a source comment documents it, and it was measured once, over 4 minutes (R26.3).
  - **The footprint gap is large in ratio and small in amount.** Idle in a container, the same daemon held about 2 MiB in Rust, 29 MiB on Bun and 54 MiB on Node, and used 0.1–0.6 s, about 21 s (about 1.1 s with the GC timer off) and 3.6–7.3 s of CPU a day. Most of a JavaScript daemon's memory is the runtime binary, shared with the runs it starts, each of which loads 71–151 MB (R25.3, R26.3).
  - **Compile time isn't the cost at this size:** 9–16 s for a clean debug build and under half a second after an edit, which weakens the settled decision's "No compile step" for a package this small (R26.4).
  - **A second copy of everything is:** a second toolchain, CI job and supply chain, a toolchain bump every six weeks, a mutation gate that made 7 mutants where Stryker made 47 on the same logic, crates for signals and process-group kills, and binaries that need glibc 2.39, above D26's 2.34 floor (R26.3, R26.4).
  - **Parity depends on where schedules live.** In frontmatter or the store, a Rust scheduler needs a YAML reader set up to match the agent's, and SQL against TypeORM's schema on a differently built SQLite; with a config only the scheduler reads, it needs neither (R26.4).
  - **No existing daemon makes the question moot** (R26.2).
  - **Two advocates argued it from the checked research.** For Rust: a thin timekeeper of an estimated 500–700 lines that waits on the operating system's wall-clock timers and supervises runs. Against: a TypeScript daemon that reuses the store, YAML, process and logging packages under the existing Stryker bar. Both accepted the findings above, and differed on whether Rust's conditions hold: chiefly, schedules in a file only the scheduler reads, and a small scope.
- **Proposal:**
  - **A Rust package, `packages/scheduler`,** with its own `Cargo.toml`, `Cargo.lock` and `rust-toolchain.toml`, pinned to the newest stable Rust, and a small `package.json` whose scripts run cargo, so that it stays an `@mecha-gremlin/*` workspace package and `bun run check` runs its checks. Its binary, `gremlin-scheduler`, takes `--config` and `--data-dir` (C23).
  - **Kept small:** croner-rust for schedules, a TOML reader for the config, `std` for processes, and crates only for what `std` can't do, signals and process-group kills, while `std`'s `File::try_lock` can hold the lock **[K]**. No async runtime, no SQLite and no YAML.
  - **The quality bar, in Rust's tools:** rustfmt, clippy with warnings denied, `cargo test`, cargo-mutants, which fails on any missed mutant, and cargo-deny, in a CI job beside today's. Where the repository's style rules translate, they carry over, such as no `mod.rs` files, which clippy can enforce (R26.4).
  - **Built where it runs:** with cargo on a Mac, and in a multi-stage Docker build on the image's own Debian, since a binary built on current Debian needs glibc 2.39 (R26.4). Prebuilt binaries wait until someone needs them.
  - **The agent stays TypeScript on Bun or Node** (D19). The decision covers this package alone.
- **Against:**
  - **The research recommended TypeScript first.** A TypeScript daemon on Bun, with its idle GC timer off, would reuse the store, YAML, process and logging packages and stay under the 100% Stryker bar, holding about 16 MiB of its own beside another Bun process, against Rust's 2 MiB: most of a JavaScript daemon's memory is the runtime binary, which its runs share (R26.3).
  - **A second toolchain:** a pin bump every six weeks, clippy's new lints, its own supply chain and audit, and on GitHub's runners about 0.5 GB of toolchain downloaded in every job with an exact pin (R26.4).
  - **A coarser mutation gate:** on the same logic, cargo-mutants made 7 mutants where Stryker made 47, so tests for literals and whole conditions have to be written by hand (R26.4).
  - **Code the repository already has, written again:** process-group kills and signal handling, which `std` lacks, and records shaped like the agent logger's (R26.3).
  - **It reverses the settled "TypeScript on Bun" for one package,** and brings back a compile step and, for a build from source, a Rust toolchain.
- **Decision:** D50.

---

# Part 4: Draft design

This draft assumes the recommended option for every decision in Part 5. Sections that depend on an open decision name it.

**Words (D21, 2026-10-16).** This draft predates D21, and says "turn" for one model request. From the change `turn-to-step` on, the code calls that request a *model call*, and a model call with the tool calls in its reply a *step*. A *turn* is a user's whole exchange. So read 4.3's `runTurn` as `callModel`, its `Turn` as `Reply`, `keepLastTurns` as a count of steps, and the finalize turn as a finalize step.

**Provider boundary (D24, 2026-10-27).** The draft below predates Claude support. Current code uses an SDK-free `core` and one provider-bound session, with SDK-specific wire conversion in `agent`. OpenAI and LM Studio use Responses; Claude uses native streamed Messages with an API key. The shared loop does not switch providers. Native assistant output and Gremlin-authored inputs and outcomes stay in the in-memory history; provider statistics have complete, partial and unavailable states and named provider-specific usage, diagnostics and rate-limit fields. This change does not implement the future database, compaction, retry or budget designs below.

## 4.1 Architecture (D1, D2, D3)

```
                    docker compose (same artefact: your Mac, a client box)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  ┌──────────────────────┐   net: data (internal)  ┌───────────────────┐   │
 │  │ app (Bun)            │◀───────────────────────▶│ postgres+pgvector │   │
 │  │ • scheduler tick     │                         └───────────────────┘   │
 │  │ • agent loop         │   net: exec (internal)  ┌───────────────────┐   │
 │  │ • app tools          │────────────────────────▶│ workspace         │   │
 │  │ • app secrets,       │   exec RPC: run/read/   │ • exec server     │   │
 │  │   OAuth tokens       │   write                 │ • git, jq, py…    │   │
 │  └──────────┬───────────┘                         │ • NO app secrets  │   │
 │             │                                     │ • NO route to db  │   │
 │             │                                     └─────────┬─────────┘   │
 └─────────────┼───────────────────────────────────────────────┼─────────────┘
               │ Responses / Messages (streamed)              │ bind mounts
       ┌───────┴──────────┐                                    ▼
       ▼                  ▼                           ~/notes, ~/projects, skills/
 api.openai.com     LM Studio on the host (Metal GPU; can't run in a container on macOS)
 key | SIWC         host.docker.internal:1234, token auth on
 api.anthropic.com  direct API key, native Messages
```

## 4.2 Monorepo layout (D10)

```
mecha-gremlin/                          public repo
├── package.json                        bun workspaces: ["packages/*"]
├── tsconfig.json                       experimentalDecorators: true (emitDecoratorMetadata per D15);
│                                       no package-specifier `extends` (C7)
├── compose.yaml
├── .gitleaks.toml                      + pre-commit hook and CI job (M1)
├── packages/
│   ├── core/                           @mecha-gremlin/core: stateless functions, publishable;
│   │                                   Gremlin-owned types; no provider SDK or schema-library dependency
│   ├── yaml/                           @mecha-gremlin/yaml: Bun.YAML on Bun, the yaml package
│   │                                   elsewhere (D19)
│   ├── process/                        @mecha-gremlin/process: Bun.spawn on Bun,
│   │                                   node:child_process elsewhere (D19)
│   ├── store/                          @mecha-gremlin/store: SQLite in the data folder, DATA_DIR,
│   │                                   through TypeORM and better-sqlite3 (D25–D28)
│   ├── agent/                          @mecha-gremlin/agent: one run: the model choice, the loop,
│   │                                   tools, skills and provider SDK adapters (D22, D24)
│   ├── app/                            scheduler, app tools, CLI `gremlin`; runs agents. Its
│   │                                   entities and migrations are in `store` (D27)
│   │   ├── tsconfig.json               "extends": "../../tsconfig.json"; Bun reads the tsconfig of
│   │   │                               the directory it starts in, not the file's nearest (R6.2)
│   │   └── db/init/                    creates the gremlin_owner and gremlin_app roles (4.4)
│   └── workspace/                      exec server + Dockerfile = the agent's toolbox
├── skills/                             public example skills (SKILL.md)
├── examples/tasks/                     example TASK.md files
└── openspec/

~/gremlin-private/                      private git repo, mounted, never in source
├── tasks/*.md                          TASK.md definitions (D5)
├── skills/<name>/SKILL.md              your own skills (D4)
├── .gitignore                          *.env (secrets are never committed, even privately)
├── gremlin.env.example                 committed template; the real gremlin.env holds API keys and
│                                       the LM Studio token, validated at boot
├── postgres.env.example                template for postgres.env (superuser password)
└── migrate.env.example                 template for migrate.env (gremlin_owner credentials, 4.4)
```

Run gitleaks on the private repo too. If you'd rather version the secrets, encrypt the env files (sops/age) instead of committing them in plain text.

`core` is one package with subpath exports (`@mecha-gremlin/core/turn`, `…/compaction`, and so on) rather than six micro-packages. The app imports `core` only through those public exports, so the boundary stays real.

`yaml` and `process` are packages of their own (D19). Each adapts one thing to the runtime, so `core` stays free of runtime APIs and of the `yaml` dependency.

`store` is a package of its own too (D27): the agent, the login command and M1's app all use it, and it keeps TypeORM and better-sqlite3's native addon in one place.

## 4.3 Core library (signatures)

**Current boundary (D24):** `core/model-call` declares the provider-neutral request, result and error; `core/history` declares ordered inputs, outcomes and opaque provider-tagged native responses; `core/statistics` declares full provider-discriminated usage and diagnostics; and `core/tools` defines Standard Schema tools and local validation. Responses and Messages calls, request conversion, streaming and replay are in `agent/model`. The signatures below are the older design draft, not the current public API.

```ts
// @mecha-gremlin/core: stateless; data in, data out.
// Types come from `openai` (Responses API), a peerDependency. runTurn is the only function
// doing I/O, and only through the client the caller passes in (created with maxRetries: 0,
// so retry policy lives in nextStep).

// ── request assembly (cache-friendly) ──────────────────────────────────────
canonicalTools(tools: FunctionTool[]): FunctionTool[]            // sorted by name, stable key order
buildRequest(p: {
  model: string
  preamble: string                    // rules + task prompt + skill catalog → first developer item
  tools: FunctionTool[]               // frozen for the run
  items: ResponseInputItem[]          // run input + history
  profile: RequestProfile             // per-backend constraints (SIWC omissions, namespaces, cache mode…)
}): ResponseCreateParamsStreaming

// ── one model turn ──────────────────────────────────────────────────────────
runTurn(client: OpenAI, req: ResponseCreateParamsStreaming, opts: {
  firstOutputTimeoutMs: number; idleTimeoutMs: number; signal?: AbortSignal
}): Promise<TurnResult>
  // Streams and assembles the final Response; stores reasoning items from output_item.done.
  // Classifies errors by HTTP status and error.code, including terminal response.failed /
  // response.incomplete events, never by instanceof:
  // TurnResult = { ok: true; response }
  //   | { ok: false; error: 'plan_limit' | 'usage_unavailable' | 'rate_limit' | 'quota' | 'auth'
  //       | 'context_overflow' | 'incomplete' | 'first_output_timeout' | 'idle_timeout'
  //       | 'tool_parse_500' | 'unreachable' | 'transient' | 'fatal'; detail }
classify(response: Response): Turn
  // Turn = { kind: 'calls'; calls: FunctionCall[] } | { kind: 'final'; text: string }
  //      | { kind: 'narrated'; hint: string } | { kind: 'empty' }
detectNarratedCall(text: string): NarratedCall | null

// ── tool results ────────────────────────────────────────────────────────────
validateArgs(tool: FunctionTool, raw: string):
  { ok: true; args: unknown } | { ok: false; error: string }
toOutputItem(callId: string, outcome: ToolOutcome, limits: OutputLimits): FunctionCallOutputItem
truncateMiddle(text: string, maxBytes: number): { text: string; droppedBytes: number }
  // cuts on code-point boundaries, never inside a surrogate pair
normalizeOutput(bytes: Uint8Array): { text: string; binary: boolean }   // UTF-8 w/ replacement, no U+0000
toStorable<T>(value: T): T     // persistence boundary: U+0000 → marker, lone surrogates → U+FFFD (C11)

// ── loop policy (pure state machine; the caller's while-loop does the I/O) ──
contextFill(lastUsage: Usage, pending: ResponseInputItem[], contextTokens: number): number  // 0..1
  // (input_tokens + output_tokens + estimateTokens(pending)) / contextTokens
nextStep(state: LoopState, result: TurnResult, budget: Budget): Step
  // Step = execute(calls) | nudge(text) | retry(afterMs) | defer(reason) | finalize
  //      | finish(text) | abort(status)
repairHistory(items: ResponseInputItem[]): ResponseInputItem[]   // every call gets exactly one output

// ── skills (SKILL.md) ───────────────────────────────────────────────────────
parseSkill(dir: string, skillMd: string): Skill | SkillError     // frontmatter per spec (R7)
renderSkillCatalog(skills: Skill[]): string
activateSkillTool(skills: Skill[]): FunctionTool                 // enum of the task's skill names

// ── compaction seam ─────────────────────────────────────────────────────────
estimateTokens(items: ResponseInputItem[]): number
planCompaction(items: ResponseInputItem[],
               o: { limitTokens: number; keepLastTurns: number }): CompactionPlan | null
  // cuts only at turn boundaries; reasoning + call + output stay together (C5)
applyCompaction(items: ResponseInputItem[], plan: CompactionPlan,
                summary: string): ResponseInputItem[]
```

"The caller orchestrates" means the app's loop is about 60 lines over these functions. The README ships the same loop as a reference implementation.

## 4.4 Data model: TypeORM entities (D5, D7)

This is a future persistence draft. D24 adds only in-memory provider-native history; its database encoding, lossless replay and interaction with `toStorable` need a separate design.

**SQLite (D25, 2026-10-29).** D25 replaced Postgres with SQLite, so the Postgres-only parts below change as C14's table shows: no roles or grants, claims in raw SQL, `BEGIN EXCLUSIVE` on a lock database, times as integers, and a lease for the credential refresh (C17). `Credential` then arrives before M5, holding MCP servers' OAuth credentials as well as SIWC's.

```
 Task ──────────────< Run ───────────────< Item         conversation; append-only
  name (unique)        status                 seq, kind (message | function_call |
  schedule, tz         trigger (cron|manual)    function_call_output | reasoning),
  prompt               model_profile            payload jsonb (verbatim item, toStorable),
  model_profile        task_snapshot jsonb      compacted_into (nullable)
  skills text[]        created_at, started_at,
  limits jsonb         ended_at, heartbeat_at
  overlap_policy       usage jsonb    ────────< Event        run log; app role may only INSERT
  catch_up,            output text                seq, type (model_call | tool_start | tool_exec |
  catch_up_grace,      state_after jsonb            nudge | finalize | compaction | error |
  max_queue_age                                     skill_activated), data jsonb (latency,
  state jsonb ◀────────┘                            tokens, cached/written tokens, command,
  next_run_at timestamptz                           exit code, timed_out, binary, output up
  enabled, last_error                               to a hard cap)
  definition_hash

 ProfileState  (limit_domain, blocked_until, backoff_seconds, reason)   one row per limit domain:
                the SIWC credential, or a backend's base URL; reason needs_login has no expiry
 SchedulerState (single row: last_tick_at)                              catch-up and liveness ping
 SkillSetting  (skill_name, task_id nullable = global, env jsonb)       injected into exec calls (4.7)
 Credential    (provider = chatgpt_oauth, issued_client_id, ext_agent_host_id, access_token,
                refresh_token, id_token, scopes, expires_at, refreshed_at, needs_login)   built in M5
```

**States and transitions**
- **Run status:**
  - `queued → running | skipped | failed`;
  - `running → succeeded | failed | capped | deferred | abandoned`;
  - `skipped` rows can also be inserted directly.
- **Every transition is conditional on the status it starts from:** `UPDATE run … WHERE id = $1 AND status = <expected>`. So a run marked `abandoned` can't later be overwritten with `succeeded`, and two racing paths can't both move the same row.
- **One active run per task:** `UNIQUE (task_id) WHERE status IN ('queued','running')`, with an auto-generated name so `migration:generate` sees predicate changes (R6.3). Inserts use `ON CONFLICT DO NOTHING` (4.8).
- **`run.model_profile`** is copied from the resolved definition at insert. An index on `(model_profile, created_at) WHERE status = 'queued'` lets the worker claim per profile (4.8).

**Locking and liveness**
- **One lock order everywhere:** the task row first (`SELECT … FOR UPDATE`), then run rows. This covers the tick, finalisation, deferral, `gremlin run` and recovery, and avoids the deadlock reproduced in R10. The claim, the heartbeat and the boot sweep touch only run rows. Finalisation retries SQLSTATE 40P01.
- **Liveness:**
  - `heartbeat_at` is written by a timer, every 10 s, while a run is live. It is what `gremlin runs show` displays.
  - Recovery doesn't depend on it, because each run has a hard deadline (C8). Each run is wrapped in `try/finally`, which stops the timer, marks the run `failed` if it is still `running` (conditionally), and releases the profile semaphore.
- **Record before running:**
  - A turn's output items (reasoning, `function_call`) are written as soon as the turn completes, before anything executes.
  - A `tool_start` event (command, working directory, timeout) is written before each exec, and the `tool_exec` result event after it.
  - So a crash mid-command still leaves a record of what was running.

**Queries**
- **Claim queries** use find options with `lock: { mode: "pessimistic_write", onLocked: "skip_locked" }`, plus `tables` when joining. This keeps TypeORM's `null` guard (C7). The tick's due-task query is the documented exception (C7, 4.8).
- **Relation filters** are written `{ run: { id } }`, never as bare ids (R9).

**Roles, grants and migrations** (R10)

| Role | Used by | Rights |
|---|---|---|
| `gremlin_owner` | the one-shot `migrate` compose service only (4.9), with its own env file | owns every table |
| `gremlin_app` | the runtime; neither owner nor superuser | SELECT, INSERT and UPDATE on `task`, `run`, `item`, `profile_state`, `scheduler_state`, `skill_setting` and `credential`; SELECT and INSERT on `event`, plus USAGE on sequences. No DELETE or TRUNCATE anywhere, since `apply` disables tasks rather than deleting them |

- **Init script:** it creates both roles, then runs `ALTER DEFAULT PRIVILEGES FOR ROLE gremlin_owner GRANT SELECT, INSERT, UPDATE ON TABLES` (and `USAGE ON SEQUENCES`) `TO gremlin_app`.
- **Migrations:** the migration that creates `event` runs `REVOKE UPDATE ON event FROM gremlin_app`.
- **Foreign keys:** every foreign key into `event` and `item` uses `ON DELETE NO ACTION`. Cascades would let the app delete log rows through the parent row (R10).
- **Retention:** `gremlin prune --older-than <days>` runs as the owner (through the `migrate` service). It deletes events, then items, then runs, in foreign-key order.
- **Backups:** a nightly `pg_dump` writes to a host path outside the git repo. The `pgdata` volume is otherwise the only copy of `task.state`, run history and OAuth credentials.

**Credentials and secrets**
- **API keys and the LM Studio token** live in `gremlin.env`, validated at boot. A profile's auth reference names the variable.
- **`Credential` holds only rotating OAuth credentials (SIWC),** so it is built in M5.
- **Skill secrets** are written with `gremlin skill-env set <skill> [--task <name>] KEY`, which reads the value from stdin (M3).
- **Credential refresh (SIWC), conditional on the token:**
  - The caller passes the access token it used. Under `SELECT … FOR UPDATE`, refresh if the stored token is that same one or is close to expiry; otherwise use the newer stored token.
  - Then `POST` the refresh, with a timeout of about 15 s, `UPDATE`, and `COMMIT`. Only then use the new token.
  - Waiters set `SET LOCAL lock_timeout = '30s'`.
  - Refresh before a turn when the token expires within about 5 minutes, and once after a 401. Making the refresh conditional on the token handles clock skew after the host sleeps.
  - **`invalid_grant` or `refresh_token_reused`:** set `needs_login`, and block the credential's limit domain (`ProfileState` reason `needs_login`, no expiry) until `gremlin login` or an import clears it. Send one alert.

**Config, not database**
- **Model profiles** live in validated config: base URL, model, auth reference, concurrency, `contextTokens`, `maxOutputTokens` where allowed, the model-visible output cap, first-output and idle timeouts, request constraints, cache mode, and the limit domain.

## 4.5 Agent loop

**Current loop (D24):** bind one provider and model, copy the starting history, stream a model call, retain its native response, run locally validated client tools sequentially, append one outcome per call and yield before the next request. On the last allowed step, calls are recorded as not run. The retries, budgets, nudges, finalize step and persisted events in the draft below are not implemented by D24.

```
 prepare: load task snapshot, freeze tools + preamble, build run input (now(), carried state)
    │
    ▼
 ┌─▶ turn (stream) ──▶ classify / nextStep ──┬─ calls    → validate args → execute in order → outputs
 │                                           ├─ narrated → nudge (≤2), else treat as final
 │                                           ├─ final    → succeeded (output, state_after)
 │                                           ├─ empty    → nudge once, else failed
 │                                           ├─ retry    → backoff, same turn
 │                                           └─ defer    → deferred + profile backoff
 │      append items + events, check budgets and context fill
 └────────────── within budget ◀──┘   │ tripped
                                      ▼
                    finalize turn (tool_choice:"none", sized to fit) → capped
```

**Tool execution**

| Situation | Handling |
|---|---|
| Tool exits non-zero or throws | Output item with exit code and stderr tail; the loop continues |
| Tool timeout | Kill the process group (R8); output has `timed_out: true` and partial output |
| Direct child exits but a background grandchild holds the pipe | Wait about 1 s for EOF, then kill the group and return what was read (R10) |
| Command waits for input | Can't happen: stdin is closed and prompts are disabled (C3) |
| Binary or NUL-containing output | Normalised: UTF-8 with replacement, U+0000 replaced by a marker, `binary: true` (R10) |
| Huge output | The model sees head and tail, with a per-profile cap that is smaller for local models. The event keeps the full output up to a hard cap. The cap is enforced by reading the stream, not with `maxBuffer` (R8). |
| Invalid JSON or schema mismatch in arguments | Output item with the validation error and the expected schema, so the model can self-correct |
| Unknown tool name | Output item: "unknown tool X; available: …" |
| Several calls in one response | Run sequentially, in order. Every `call_id` gets exactly one output, even if the run stops early |

**Model output and context**

| Situation | Handling |
|---|---|
| Narrated call | Nudge, at most twice, as a user message (C9) |
| LM Studio HTTP 500 "Failed to parse tool call" | Nudge: "your last reply could not be parsed; emit exactly one function call" (C9) |
| Context nearly full, or an API context-overflow error | Finalize turn, sized to fit; if even that can't fit, `capped` with a synthesised summary (C8) |
| Iteration, token or wall-clock budget exceeded | Finalize turn, then `capped` (C8) |
| Finalize turn returns calls anyway, or fails | `capped`, with a synthesised "budget exceeded; no summary" output |
| Stream ends with `response.incomplete` or `response.failed` after HTTP 200 | Classified into a `TurnResult`: a truncated call is retried once; a usage-limit code is handled as a plan limit |
| No first output within the profile's first-output limit | Abort the turn, retry once, then `failed` |
| Silence between deltas beyond the idle limit | Abort the turn, retry once, then `failed` |

**Limits, auth and availability**

| Situation | Handling |
|---|---|
| SIWC plan limit: 429 before the stream, or `response.failed` mid-stream, with `subscription_sharing_usage_limit_exceeded` | Run becomes `deferred`, its fire is re-armed, and the credential's limit domain goes into backoff (4.8). The error gives no reset time, so the block lifts on the backoff probe or by hand (`gremlin unblock <domain>`). One alert points you to ChatGPT settings → Usage for the reset time. Never fall back to another model mid-run (C1) |
| `subscription_sharing_usage_unavailable` (503) | Bounded backoff within the run |
| HTTP 429 rate limit or 5xx | Bounded exponential backoff owned by `nextStep` (the SDK uses `maxRetries: 0` everywhere), then `failed` |
| `insufficient_quota` | `failed`, with no retry, and an alert |
| Access token near expiry, or HTTP 401 | Refresh before the turn if it expires within about 5 minutes. On a 401, refresh once and retry the turn (4.4) |
| Refresh fails with `invalid_grant` or `refresh_token_reused` | Run `failed`. The credential is marked `needs_login`, and its limit domain is blocked until you sign in again or import credentials (4.4), so later runs don't keep failing. One alert |
| Backend unreachable, on any profile: DNS failure, connection refused, no route, TCP or TLS connect timeout | Run becomes `deferred`, its fire is re-armed, and the backend's limit domain (its base URL) goes into backoff on the short schedule (4.8). HTTP 5xx stays transient |
| Hard deadline reached: wall clock, including a stream that never ends or a hung RPC or fetch | The run's `AbortController` fires. The run ends `capped`, with a synthesised summary (C8) |
| Uncaught exception in the loop | `finally` marks the run `failed` (conditionally), stops the heartbeat, releases the semaphore, and alerts |
| Process crash mid-run | At the next boot, the lock-holding daemon (4.8) marks `running` runs `abandoned`, and the exec server kills leftover processes. For `catch_up: once` tasks the fire is re-armed. The next run's input carries a note built from the abandoned run's items and events: its status, and the tool calls it started |

## 4.6 Request layout for caching

**Claude (D24):** every native Messages request uses top-level automatic ephemeral caching with a five-minute TTL. System instructions and ordered tool schemas stay fixed; cache hits depend on the provider's thresholds and lifetime. Cache reads and writes are reported separately, not assumed. Responses behavior remains as before.

```
 order sent to the model                       changes when…          cache
 ───────────────────────────────────────────   ─────────────────────  ──────────────────────────
 tools[]  (sorted, frozen for the run)         deployment / task edit ┐ shared by every run of a
 developer: base rules + task prompt           task edit              │ task (end of the initial
            + skill catalog                                           ┘ developer block, R3.1)
 user: now(), carried state, trigger           every run              ┐ shared by every turn of a
 items… (calls, outputs, reasoning, skill      append-only            │ run (implicit breakpoint at
         bodies from activate_skill)                                  ┘ the latest eligible item)
```

**Rules**
- **Keep per-run data out of the developer item.** Never put the time, state or anything else that varies per run there.
- **Freeze the request settings.** Never edit or reorder tools, or change `reasoning.effort`, `parallel_tool_calls`, `text.format`, verbosity, service tier or `prompt_cache_key` mid-run (R3.4).
- **Use `tool_choice` to stop tools.** The finalize turn's `tool_choice:"none"` is the sanctioned way to disable tools: OpenAI documents it as keeping the prefix, and S3 measures it. On OpenAI, `allowed_tools` can also narrow them. LM Studio rejects object `tool_choice` on Chat Completions (R5.2); S2 checks it on `/v1/responses`. There, `"none"` drops the tools from the prompt and loses the prefix, so the finalize turn relies on its message (R15.3).
- **Send nudges and the finalize prompt as user messages,** so they end an eligible breakpoint (R3.1).
- **Compaction is rare, chunky, and cut at turn boundaries** (C5).
- **Log cache use.** Every `model_call` event records cached and written tokens, so cache effectiveness is measured from day one.

**What carries across runs**
- **OpenAI before GPT-5.6:**
  - On the models listed in R3.2, organisations without ZDR get `24h` retention by default, and gpt-5.5 and gpt-5.5-pro accept nothing else. That is a maximum: entries typically last about 30 minutes.
  - Other earlier models use `in_memory`, typically 5–10 minutes idle and at most 1 hour.
- **GPT-5.6+:** a prefix is kept for at least 30 minutes after its last write or reuse (R3.1).
- **So expect cross-run hits only when a task reruns within about 30 minutes,** and assume a daily task misses. On pre-5.6 models, a stable per-task `prompt_cache_key` helps route a task's runs to the same cache. On GPT-5.6+, a key only partitions billing.
- **LM Studio MLX disk cache:** it restores shared prefixes across conversations, but only for text-only MLX models without a quantised KV cache or speculative decoding. It's lost when the model unloads, so carrying it across runs depends on the no-TTL preload (4.9, R5.3).
- **Under SIWC,** retention can't be set (R3.5).
- **S3 also checks** whether an explicit breakpoint after the developer item and the implicit end-of-input breakpoint both apply.

## 4.7 Skills: format and loading (D4)

- **Format:** the Agent Skills spec as written (R7), with no custom frontmatter keys. Gremlin-specific settings go in `metadata` as JSON-encoded strings, or in a future sidecar file.
- **Discovery:** skills are read in the app, from the private and public skill trees mounted read-only at `/skills/private` and `/skills/public`. The workspace mounts them at the same paths (4.9). Private overrides public. Names are validated like the reference validator, Unicode lowercase included.
- **Selection:** the `skills:` list in TASK.md frontmatter names the subset for that task. `gremlin apply` rejects unknown names.
- **Exposure:**
  - The catalog (name, description, path) goes in the developer item.
  - The `activate_skill` tool takes an enum of the task's skill names. Its output is the SKILL.md body plus the list of files in `scripts/` and `references/`.
  - The model runs scripts with `shell`.
- **Env and secrets:** each task's skills get their env from `SkillSetting`, injected into that run's exec calls. These are workspace-visible secrets, never the app's own (C3, D17).
- **Weak-model option:** `inline: true` per task puts the SKILL.md bodies straight into the developer item. That is stable per task, so still cacheable.

## 4.8 Scheduler and concurrency (D6, D12, D16)

**SQLite (C14, D25, 2026-10-29).** On SQLite, the tick and the claims below become raw SQL, the advisory lock becomes `BEGIN EXCLUSIVE` on a lock database in the data folder, and `SKIP LOCKED` goes, since a single-statement claim needs none (R17.2).

**A scheduler of its own (C23, D6, D50, 2026-11-09).** The scheduler is now a Rust process of its own, `packages/scheduler`, started with a TOML config and a data directory, not a tick inside `gremlin serve`. C23 proposes keeping this section's rules: catch up once (D52, open), skip or queue on overlap (D16), and a hard deadline per run. Nothing the database held carries over: the `task` table's `next_run_at`, `scheduler_state`, the claims, the per-profile workers and semaphores, and limit-domain backoff, which can return if runs move into the store. The single-instance lock becomes a lock in the scheduler's data directory. croner's role passes to croner-rust (D12), which gave the same fires as croner 11 on all 21 valid patterns R26.4 tried, DST included, but not on `0 0 1 * 5`, whose 1 March fire croner 11.0.0's February bug skips (R26.2, R26.4). croner 11 flips two of the DST behaviours pinned below: interval jobs now run in both copies of the repeated hour, and a fixed-time job in the spring-forward gap runs at the gap's end, 03:00 in New York, not an hour late, while an interval job's slots in the gap don't run (R25.3).

```
 daemon start (`gremlin serve`)
   take a session-level pg_try_advisory_lock(<constant>) on a dedicated connection; exit if taken.
   Only the lock holder runs the boot sweep, the exec reset, the tick and the workers. Other CLI
   commands (`gremlin run`, `apply`, `login`, `runs show`…) are plain DB clients and never sweep.
   boot sweep: running → abandoned (re-arm the fire for catch_up: once tasks, 4.5);
               queued runs of disabled tasks or unknown profiles → skipped / failed;
               the exec server kills everything except PID 1 and itself

 tick: every 15 s
   prev = scheduler_state.last_tick_at
   SELECT … FROM task
     WHERE enabled AND next_run_at <= now()
       AND NOT EXISTS (SELECT 1 FROM profile_state ps
                       WHERE ps.limit_domain = <domain of task.model_profile>
                         AND ps.blocked_until > now())
     FOR UPDATE OF task SKIP LOCKED                      (C7: the documented QueryBuilder exception)
   per due task, inside its own SAVEPOINT:
     missed = next_run_at > prev AND now() − next_run_at > catch_up_grace
              (the fire fell into a gap with no tick: app down, host asleep. Fires held back by an
               overlap conflict or a profile block were already seen by an earlier tick, so they are
               never "missed" and always fire once when released.)
     missed and catch_up = skip → INSERT run(status='skipped'); next_run_at = next fire after now
     else INSERT INTO run (…, status='queued', model_profile) ON CONFLICT DO NOTHING RETURNING id
        inserted                → next_run_at = croner.nextRun(schedule, tz, from = now)
        no row, overlap = skip  → INSERT run(status='skipped'); next_run_at = next fire after now
        no row, overlap = queue → leave next_run_at: fires on the first tick after the active run
                                  ends; further fires coalesce into one (D16)
     on error → ROLLBACK TO SAVEPOINT; task.last_error = …; next_run_at += 5 min; alert
   UPDATE scheduler_state SET last_tick_at = now()
   COMMIT, then send the dead-man's-switch ping (Q1)

 workers: one claim loop per profile
   take a semaphore slot (non-blocking per poll; released in finally on every path)
   limit domain blocked? → release the slot and wait until blocked_until; queued runs stay queued
   claim the oldest: find({ where: { status: 'queued', modelProfile }, order: { createdAt: 'ASC' },
                            lock: { mode: 'pessimistic_write', onLocked: 'skip_locked' } })
     task disabled since queueing → skipped
     max_queue_age set and exceeded (never for manual runs) → skipped
     else → running; hard deadline, heartbeat timer and try/finally as in 4.4
   every tick, and after config validation at boot: queued runs whose profile is no longer
   configured → failed (UPDATE … WHERE status='queued' AND model_profile <> ALL($configured))

 manual: `gremlin run <task> [--ignore-backoff]`
   locks the task row and inserts a queued run (trigger manual) through the same ON CONFLICT;
   reports "already active" when no row comes back; leaves next_run_at alone; exempt from catch_up
   and max_queue_age. With --ignore-backoff it can serve as the probe.
```

**Why this design over the alternatives**
- **The `ON CONFLICT` insert is the critical detail.** A plain INSERT that hits the partial unique index aborts the whole transaction (R10), so one overlapping task would roll back every other due task and never advance `next_run_at`, stalling the scheduler.
- **Per-task savepoints extend that protection** to every other per-task failure: a croner error, a bad time zone, a snapshot insert. One broken task records `last_error` and alerts, and the rest of the tick still commits. The liveness ping is sent only after a successful commit, so a tick that keeps failing shows up as dead even while the process stays up.
- **Why not cron or systemd invoking a CLI:**
  - Schedules live in the DB, so an external cron would need a synced copy.
  - Cron inside containers is awkward (R9).
  - systemd doesn't exist on macOS.
  - Both break "same artefact".
- **Why not `Bun.cron` timers (R8):**
  - Per-task timers have to be re-registered on every edit.
  - They forget runs missed while the process was down.
  - An error in a handler can kill the process.
  - A `next_run_at` column has none of these problems.
- **Why croner over `Bun.cron.parse` (D12):** since Bun 1.4.0 both take an explicit IANA time zone. croner adds a seconds field, a year field, and `L`/`W`/`#`, which Bun's parser rejects. It also runs on Node, which the D13 fallback would need (R8).

**Time zones and DST**
- `tz` is required per task, or taken from a deployment default (Q11). Never fall back to the process zone, which is UTC in a container. All times are stored as `timestamptz`.
- croner's DST behaviour (R10) is accepted and pinned with unit tests at both 2026 transitions:
  - fixed-time jobs run once in the fall-back hour;
  - interval jobs skip the repeated hour;
  - a job in the spring-forward gap runs an hour late.
- `catch_up` applies only to fires that fell into a gap with no tick (the `missed` rule above). `catch_up_grace` defaults to a few minutes rather than a multiple of the tick, so a single slow tick can't turn a fire into a miss.

**Deferral and backoff**
- **Deferred ends the run, not the fire.** A plan limit (SIWC) or an unreachable backend ends the run as `deferred`, which is terminal and keeps the partial output. In the same transaction, with the task row locked first, `task.next_run_at = least(next_run_at, now())`. The task is held while its limit domain is blocked, then fires once when the block lifts, as the probe. The next run's input carries a note on what the deferred run did.
- **Backoff is tracked per limit domain**, not per profile: the SIWC credential, or a backend's base URL. Two profiles on one ChatGPT account or one LM Studio server therefore probe and back off together.
- **Doubling:** `blocked_until = greatest(blocked_until, now() + backoff)`. The backoff doubles only when the previous block had already expired, from 15 minutes up to 4 hours for SIWC and from 1 minute up to 30 minutes for unreachable backends. Several runs failing at once therefore don't jump straight to the maximum.
- **Reset:** the backoff resets when any turn in the domain succeeds, or once the last block is older than the maximum.
- **Alerts** are sent once when a domain becomes blocked and once when it recovers, not for every deferral.
- **While a domain is blocked,** the tick doesn't enqueue its tasks, and the workers don't claim its queued runs (above). Missed fires coalesce into one.

**Concurrency**
- Each model profile has an in-process semaphore with a configured limit, and its own claim loop. A busy profile therefore never blocks claims for another.
- LM Studio allows 4 concurrent predictions by default (R5.4). Concurrent MLX requests reportedly evict each other's cache (R5.7), so 1 is a sensible default for local profiles.
- SIWC limits come from the plan.
- One daemon, enforced by the advisory lock above, so in-process semaphores are enough. Running two daemons would need heartbeat-based recovery instead of the boot sweep, and DB-backed semaphores (Q6).

## 4.9 Docker / compose

**SQLite (C14, D25, 2026-10-29).** With SQLite, the `postgres`, `migrate` and `backup` services below go. The app keeps its data folder on a named volume, never a bind mount on Docker Desktop (R17.2), and backs it up with `VACUUM INTO`.

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17                        # pin in S1
    env_file: ${GREMLIN_PRIVATE}/postgres.env            # POSTGRES_PASSWORD etc.
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./packages/app/db/init:/docker-entrypoint-initdb.d:ro   # roles (4.4); runs on an empty data dir only
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s, retries: 12 }
    restart: unless-stopped
    networks: [data]
  migrate:                                               # one-shot; the only holder of owner creds
    build: { context: ., dockerfile: packages/app/Dockerfile }
    command: ["bunx", "--bun", "typeorm", "migration:run", "-d", "src/data-source.ts"]
    env_file: ${GREMLIN_PRIVATE}/migrate.env             # gremlin_owner
    depends_on:
      postgres: { condition: service_healthy }
    restart: "no"
    networks: [data]
  app:
    build: { context: ., dockerfile: packages/app/Dockerfile }   # copies both tsconfig files (C7)
    command: ["bun", "run", "src/main.ts", "serve"]      # WORKDIR is packages/app (C7)
    env_file: ${GREMLIN_PRIVATE}/gremlin.env             # gremlin_app; API keys; LM Studio token
    volumes:
      - ${GREMLIN_PRIVATE}/tasks:/config/tasks:ro
      - ${GREMLIN_PRIVATE}/skills:/skills/private:ro     # same paths as in the workspace (4.7)
      - ./skills:/skills/public:ro
    depends_on:
      migrate: { condition: service_completed_successfully }
      workspace: { condition: service_healthy }
    init: true
    restart: unless-stopped
    networks: [data, exec, egress]
    extra_hosts: ["host.docker.internal:host-gateway"]   # Linux only; built in on Docker Desktop
  workspace:
    build: { context: ., dockerfile: packages/workspace/Dockerfile }
    user: "${GREMLIN_UID}:${GREMLIN_GID}"                # host user; the image has a writable HOME
    volumes:                                             # what the agent can touch = what you mount
      - ${HOME}/notes:/work/notes
      - ${GREMLIN_PRIVATE}/skills:/skills/private:ro
      - ./skills:/skills/public:ro
    healthcheck: { test: ["CMD", "/exec-server", "--health"], interval: 5s, retries: 12 }
    init: true                                           # reaps orphaned grandchildren
    restart: unless-stopped
    networks: [exec, egress]                             # egress: Q8
  backup:                                                # nightly pg_dump to a host path
    image: pgvector/pgvector:pg17
    env_file: ${GREMLIN_PRIVATE}/migrate.env
    volumes: ["${GREMLIN_BACKUPS}:/backups"]             # outside any git repo
    entrypoint: ["sh", "-c", "while :; do pg_dump -Fc -f /backups/gremlin-$$(date +%F).dump; sleep 86400; done"]
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped
    networks: [data]
networks:
  data:   { internal: true }
  exec:   { internal: true }
  egress: {}
volumes:
  pgdata: {}
```

The `migrate` service also runs `gremlin prune` on demand: `docker compose run --rm migrate bun run src/main.ts prune --older-than <days>`. Test a backup restore in M2.

**Networking notes** (R10):
- **Docker Desktop on macOS.** `host.docker.internal` is built in. It reaches services bound to 127.0.0.1 on the Mac, also from a container on internal plus normal networks. A container on an internal-only network can't resolve it.
- **Linux.** `host-gateway` resolves to the docker0 bridge IP, so a 127.0.0.1-bound LM Studio is unreachable. Bind LM Studio to the bridge IP or 0.0.0.0, with token auth.
- **`internal: true` networks.** They block the internet and other networks, but still allow the network's gateway IP. Removing `egress` from the workspace therefore wouldn't hide host services listening on 0.0.0.0.
- **The app needs a resilient start.** It retries its database connection at boot, and the app's restart policy keeps the scheduler running after crashes, Docker restarts and reboots. If the app itself is down it can't send alerts, so pair it with an external dead-man's-switch ping (Q1).

**LM Studio operations** (host side, R5.4–R5.7):
- **Enable token auth** (one GUI step), and keep the token only in the app's env (C3).
- **Preload models** with `lms load <model> --context-length <N> --parallel <K>` and no TTL.
- **Check the model at run start.** The app checks `GET /api/v1/models` for the loaded instance and its `parallel` and context values. If the instance is missing, for example after a reboot, the app either loads it with `POST /api/v1/models/load` at the intended context or defers with an alert. It never relies on JIT, for three reasons:
  - JIT loading uses the 8k default context (0.4.16+);
  - JIT and TTL reloads reportedly reset parallelism to 4 (R5.7);
  - the REST `parallel` field is changelog-only (R5.4), and S2 checks it.
- **Keep the server alive** with "run LLM server on login" or the llmster daemon. llmster has no macOS launchd guide.

**Hygiene, from M1:**
- gitleaks in a pre-commit hook and in CI, plus GitHub push protection.
- The app validates config and env against a schema at boot and refuses to start otherwise.
- `tsc --noEmit` runs in CI (C7).

## 4.10 Milestones

| | Scope | Done when |
|---|---|---|
| **M0 Spikes** | S1, S2, S3 and S5 (Part 5), as throwaway scripts with pass/fail results. S4 waits for M5, so the skeleton doesn't need a SIWC-eligible account | D1, D3, D8, D11, D13 and D15 can be closed |
| **M1 Walking skeleton** (the brief's slice) | **Infrastructure:** compose with restart policies, healthchecks, the `migrate` service and two DB roles with the grant matrix; Task, Run, Item and Event; `gremlin apply`. **Scheduling:** `gremlin serve` with the advisory lock; the tick with `ON CONFLICT`, per-task savepoints and the overlap index; a boot sweep limited to `running → abandoned` plus the exec reset; the per-profile worker. **Execution:** the loop with `shell`, `read`, and `write` and `edit` or `apply_patch` (D23), through the workspace, with a per-command timeout, process-group kill, closed stdin, a hard output cap with the ~1 s pipe wait, and output normalisation plus `toStorable`. **Recording:** record-before-running events, the run's hard deadline, and `gremlin runs show <id>`. **Profile and hygiene:** one profile, an OpenAI API key (D14); gitleaks, push protection, boot config validation, `tsc` in CI | A task fires on schedule, edits real files and leaves a readable transcript, and the system survives an app restart, a hung command and `yes` |
| **M2 Hardening** | The rest of 4.5: argument validation, model-visible output caps, budgets, the context-fill check and finalize; the compaction seam (`estimateTokens`, `planCompaction` returning null); narration nudges; first-output and idle timeouts; the catch-up rule and grace; limit-domain backoff and `deferred`, tested with an unreachable backend (an offline laptop now defers even the API-key profile); history repair; DST tests; failure notification and dead-man's switch (Q1); `gremlin prune`, nightly backups and a restore test | A deliberately broken task degrades gracefully, and you hear about it |
| **M3 Skills and state** | SKILL.md discovery in the app, catalog, `activate_skill`, `gremlin skill-env set`, carried state (Q2) | A task uses one of your skills and remembers something across runs |
| **M4 LM Studio** | Local profile, token auth, model check at run start, per-profile concurrency, review of cache telemetry | The same task runs on both backends |
| **M5 SIWC** | Starts with S4, and is gated on Q9: the `Credential` entity; login (compose-run with a published port, or host login plus import); the conditional refresh protocol and `needs_login`; plan-limit deferral and `gremlin unblock` | A task runs on plan usage and defers cleanly at the limit |
| **M6 Compaction summariser** | A plain summarising turn behind the M2 seam, **only if telemetry shows context growth** | A long run crosses the threshold and continues |
| **M7 Publish** | `core` API docs and reference loop, npm publish | The package is published |

**Loop features are arriving ahead of M1.** The tool loop came first (R11). Skills and the shell come next, with the shell on the host until the workspace exists (D18). M1 moves both into the workspace. MCP servers, and the persistence their OAuth credentials need, arrive ahead of M1 too (C16, D35).

## 4.11 Won't build (scope fence, C10)

- A plugin system, provider registry, event bus or multi-agent orchestration.
- Vector memory or RAG, until a skill needs it. `pgvector` stays available but unused.
- A web UI, until the CLI hurts.
- Switching models mid-run. Reasoning is tied to one model family; switch only between runs.
- OpenAI-hosted tools, or OpenAI's shell-tool skills in either mode (R4). They would split the code path from LM Studio.
- A soft size budget of about 1.5k lines for `core`. Crossing it means something is being reimplemented.

## 4.12 MCP servers in the agent (C16, C18, D29, D33, D34, D36, D37)

A draft for the change that gives the agent MCP servers ahead of OAuth (C16, D35): servers that need no authorisation, servers given a fixed header, and stdio servers. OAuth-backed servers come later, with the login command (C17). It rests on R17.3, R17.5 and R18.

```
 MCP_CONFIG ─▶ loadConfig: parse, resolve references, check ─▶ the servers, validated
                                                        │
 main: settings → skills → store → every server connects, in parallel, within startupTimeoutMs
                                     stdio: @mecha-gremlin/process, a stdin pipe, a group of its own
                                     http:  Streamable HTTP, with the configured headers
                                                        ▼
                     tools/list (lenient) → filters → schema preflight → model-facing names
                                                        ▼
       createSession: read · write, edit | apply_patch · shell · activate_skill · mcp__… (sorted)
                                                        ▼
            tools/call (lenient) → flatten → cap at 32 KiB → outcome, within toolTimeoutMs
                                                        ▼
 finish: close every client, in parallel → shell.dispose(), the sweep → closeStore
```

**Configuration (D29)**

**Superseded (2026-10-30).** D29 put MCP servers in the database, as rows the `bun run mcp` command writes, in place of the `MCP_CONFIG` file below. The change `add-mcp-servers` takes the entry format and references as the command's input. A review of its first draft changed more of 4.12, and where the two differ, the change's design is current. Among the changes:
- a run connects the servers after choosing the run ID and installing the signal handlers, since stdio servers carry `GREMLIN_RUN_ID`;
- every request names its own timeout, since the SDK otherwise ends each one at 60 seconds;
- plain `http` is refused when anything holds a reference, even for a loopback host, since Bun's fetch proxies loopback requests too (R18.1);
- every wait in closing a stdio server is bounded, and SIGKILL goes only to groups still alive;
- the run's directory lies in the OS's temporary directory and holds an empty `node_modules`, so npm reads no `.npmrc` above it;
- a server's text is redacted before it reaches a record or the model, and the logger escapes control characters.

- **`MCP_CONFIG` is optional.** Unset, there are no MCP servers and no file is read.
  - Set, it names a JSON file. A relative path resolves against the current directory, and the real path is used.
  - The file must be a regular file outside `WORK_DIR`, where the file tools could rewrite it.
  - `loadConfig` reads and checks it, so its problems join the other settings', each prefixed with the file's name, before any network request.
- **The format is Claude Code's `.mcp.json`,** the most common one, so most vendors' snippets paste in unchanged (R18.1):
  ```json
  {
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 120000,
      "mcpServers": {
          "deepwiki": {
              "type": "http",
              "url": "https://mcp.deepwiki.com/mcp",
              "includeTools": ["ask_wiki_question", "read_wiki_structure"]
          },
          "example": {
              "type": "http",
              "url": "https://mcp.example.com/mcp",
              "headers": { "Authorization": "Bearer ${EXAMPLE_MCP_TOKEN}" }
          },
          "playwright": {
              "command": "npx",
              "args": ["-y", "@playwright/mcp@0.0.83", "--image-responses", "omit"]
          }
      }
  }
  ```
  - **Top level:** `mcpServers`, which may be empty, and `startupTimeoutMs` and `toolTimeoutMs`, both required. Any other key is an error, with a hint where it belongs to another format (`servers`, `inputs`, `mcp`).
  - **An entry's transport** is its `type`: `stdio`, or `http` and its alias `streamable-http`. Without a `type`, `command` means stdio and `url` Streamable HTTP. Both or neither is an error; `sse` is refused as deprecated; and a typeless `url` ending in `/sse` gets a hint.
  - **stdio:** `command`, `args`, `env` and `cwd`.
    - `command` is resolved once, in `loadConfig`, against the server's `PATH`, its own `env.PATH` included. Relative and empty `PATH` entries are refused, and the resolved absolute path is what's spawned.
    - `cwd` defaults to an empty directory made for the run (D36).
  - **HTTP:** `url` and `headers`.
  - **Both kinds:**
    - `disabled`; per-server `startupTimeoutMs` and `toolTimeoutMs`; and `includeTools` and `excludeTools`, which name tools exactly as the server lists them.
    - `title` and `description` are accepted and ignored.
    - Any other field is an error, with a hint where another client spells it differently (`timeout`, `enabled`, `required`, `environment`, `enabled_tools` and the like).
  - **Strict JSON,** read by a small tokenizer of its own. It reports duplicate keys and a byte-order mark, gives line and column on both runtimes, and never quotes the file's text (R18.1).
- **References.**
  - `${NAME}` and `${env:NAME}` read an environment variable, as an own property only, trimmed as `config.ts` reads settings.
  - `$$` is a literal `$`. Any other `$` is an error with a hint: there are no defaults, no editor variables and no bare `$NAME`.
  - They work in `command`, in each argument, in `env` values, `cwd`, `url` and header values.
  - An unset or blank variable is an error, and `MODEL_API_KEY` can't be referenced. A disabled entry's references are checked but not resolved.
- **No literal secrets.** A credential slot must hold a reference: an `env` name, header name, query parameter or `--option` whose words include KEY, TOKEN, SECRET, PASSWORD, AUTH and the like. Numbers, booleans and `none` are exempt (R18.1). Text shaped like a token is refused (a `Bearer` value, `ghp_`, `sk-`, a JWT, a PEM key), and so is userinfo in a URL.
- **Headers** are RFC 9110 names, unique ignoring case.
  - `Accept`, `Content-Type`, `Content-Length`, `Host`, `Connection`, `Transfer-Encoding`, `Last-Event-ID`, `DPoP` and every `Mcp-*` name are reserved.
  - Values must be non-empty, and hold no control character other than tab and nothing above U+00FF. They are checked before any `Headers` object exists, since both runtimes' errors echo the value.
- **URLs** are `http` or `https`, with no userinfo, no fragment, and no port on fetch's bad-port list. Plain `http` is allowed only to a loopback host when a header or the query carries a reference, since Bun's fetch sends through `HTTP_PROXY` by default (R18.1).
- **Timeouts** are whole milliseconds, from 1,000 to 2,147,483,647: the floor catches a value given in seconds, and the ceiling is `setTimeout`'s.
  - `startupTimeoutMs` covers the spawn or the first request, the handshake and every `tools/list` page.
  - `toolTimeoutMs` is a wall-clock limit on one call, not reset by progress.
- **Server names** match `^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$` and are 1–24 characters long. Lowercased, with `-` turned to `_`, a name is its tools' prefix, and two names with the same prefix are an error.
- **Pinning.** An `npx`, `uvx` or `docker` entry without a version gets a warning: otherwise an unattended run would run whatever was published last. SEP-2633 says stdio entries SHOULD pin.

**Transports (D37)**
- **stdio runs through `@mecha-gremlin/process`,** which gains a required `stdin: 'ignore' | 'pipe'` (R18.3).
  - With `'pipe'`, the subprocess has a `WritableStream`. A write resolves once the pipe has taken the chunk; `close()` gives end-of-file; and once the process exits or closes its stdin, every write fails with `EPIPE`.
  - Each runtime gets its own small writer, because their raw APIs disagree.
  - The existing callers pass `'ignore'`.
- **The transport,** in `agent/src/mcp/stdio-transport.ts`, implements the SDK's `Transport` over it.
  - It spawns the server detached, in a process group of its own and in its `cwd`.
  - The environment comes from `serverEnv`: the shell's copied and non-interactive variables, the server's own, then `GREMLIN_RUN_ID`. The playwright-cli variables are left out, since they would also configure `@playwright/mcp`.
  - It frames messages with the SDK's `ReadBuffer`, wrapping each chunk as a `Buffer`, and with `serializeMessage`.
  - It always drains stderr, into an 8 KiB tail that is never logged line by line.
  - `close()` is idempotent and shares one promise:
    1. it lists the process groups of the server's descendants, once, before the first signal;
    2. it ends stdin, and waits;
    3. it sends SIGTERM to the group, and waits for the group to be empty, which also covers a wrapper leader such as `sh -c`;
    4. it sends SIGKILL to the group and to every listed group still alive.

    On macOS a group holding only a zombie answers EPERM, which counts as empty.
- **Streamable HTTP** uses the SDK's transport, with the configured headers in `requestInit` and its default `redirectPolicy: 'same-origin'`. There is no `authProvider` until the OAuth change.
- **Clients** are created with `new Client(…, { enforceStrictCapabilities: true })` and the legacy handshake, and `tools/list` goes only to a server that announces tools. That keeps the SDK's `console.debug` lines out of stdout (R18.3).

**Tools (D34)**
- **Listing is lenient.** The SDK's `listTools()` would lose the whole server over one malformed tool (R18.2), so the agent sends `tools/list` itself, with a loose result schema.
  - It follows `nextCursor` for up to 64 pages, and stops at a repeated cursor.
  - It checks each tool with `isSpecType.Tool`, and drops any that fails or has an empty name, with a log record.
- **Filters apply to raw names.** A tool is offered when `includeTools` is absent or names it, and `excludeTools` doesn't name it.
  - A name in both lists is an error.
  - An `includeTools` name the server doesn't offer fails the run. An unmatched `excludeTools` name only warns, since servers shrink their lists by scope, flags and version.
- **A schema preflight,** on a deep copy, since `fromJsonSchema` hands back the server's own object.
  - A tool whose schema has a root `oneOf`, `allOf` or `anyOf` is dropped, since Anthropic refuses the whole request over one. When `includeTools` names it, the run fails instead.
  - `properties: {}` and `items: {}` are added where missing.
  - The copy then goes through `fromJsonSchema`, so `validateArgs` keeps checking the arguments locally.
- **Names are `mcp__<server>__<tool>`.**
  - Each part has `_` inserted where an uppercase letter follows a lowercase letter or a digit, is lowercased, and has every character outside `[a-z0-9_]` turned to `_`.
  - A name over 64 characters keeps its first 55 and gains `_` and the first 8 hex digits of a SHA-256 of `server\0tool`.
  - When two tools would share a name, all of them take the hashed form. A raw name that a server lists twice keeps its first entry.
  - A map built once per session sends each call back to its server and raw name.
  - For the servers measured, the names stay at 53 characters or fewer (R18.2).
- **What's sent:** the description as it is, and the preflighted schema without `$schema`.
  - On Responses, MCP tools get `strict: false`, and the built-in tools stay strict. Left unset, Responses would likely normalise MCP schemas to strict mode, and the model would then send nulls that servers refuse (R18.2).
  - Titles, annotations, output schemas, icons and `_meta` are never sent.
- **One list per session.** The MCP tools follow the built-in ones, sorted by name, and stay fixed for the session, for the prompt cache. A `tools/list_changed` is logged, with the SDK's `autoRefresh` off so it doesn't refetch; the next run sees the new list.

**Calls and results**
- **Calls are lenient too.** The agent sends `tools/call` itself, with a loose result schema, and checks each content block with `isSpecType.ContentBlock`. The SDK's `callTool()` throws a whole result away over one malformed block, and checks structured content against an output schema, which the agent never lets it cache (R18.2).
- **Each call is bounded.** It gets `toolTimeoutMs` and the run's abort signal through an `AbortSignal`, since the SDK's `maxTotalTimeout` isn't a wall-clock limit (R17.3).
- **Results are flattened** into one text, joined with newlines:
  - text blocks as they are;
  - a resource link as `[resource link: <name> <uri> (<mimeType>)]`, leaving out the type when it's missing;
  - a text resource as `[resource <uri>]` followed by its text;
  - a blob resource, an image or audio as a placeholder giving its type, MIME type and size;
  - a block of another type, or a malformed one, as `[<type> block, not shown]`;
  - structured content as JSON only when no text block came, since it repeated the text in nearly every result seen;
  - and nothing at all as `(no output)`.
- **Capped at 32 KiB,** `read`'s limit, on a UTF-8 boundary, with a note giving the full size. Documentation tools return 14–31 KB, and DeepWiki's full wiki 509 KB (R18.2).
- **Errors:** `isError: true` becomes a failed outcome with its text. A JSON-RPC error, a timeout or a closed connection becomes a failed outcome naming the server and the tool.

**Start-up, failure and shutdown (D33)**
- **After the store opens and before the session,** every server that isn't disabled connects, in parallel, within its `startupTimeoutMs`. That covers the handshake and the whole tool list.
- **Every server that isn't disabled is required.** When one fails to start, to answer, or to list a tool that `includeTools` names, the agent closes them all and fails the run before the first model call. The error names the server and the reason, then the last lines of its stderr tail with the server's own configured values redacted. The tail is read once the transport has closed, since it lags stdout (R18.3).
- **Since 2026-11-05,** a task file's `mcp` list chooses the servers that connect, and a `?` marks one the run may go without, which is left out, with a warning and a line in the model's instructions, when it can't be used (C21, C22, D44–D49).
- **A server that dies mid-session isn't restarted.** Its tools' calls fail for the rest of the run, naming it (Q23).
- **`finish()`** closes every client in parallel, then runs the shell's sweep as the backstop, then closes the store. If the agent itself is killed, its stdio servers see end-of-file and exit within about 300 ms (R18.3).

**Logs**
- **An `info` record `mcp server`** for each server, once it has listed its tools: `name`, `transport`, `tools` (the names offered), the definitions' size in bytes, and a hash of the catalog, so that a change between runs shows (R18.2).
- **`tool call` and `tool result` records** name the model-facing tool, as now. Dropped tools and unmatched exclusions are `warn` records.
- **Nothing logs a resolved configuration value,** a header or a token. A test spies on `console.debug`, `log`, `info`, `warn` and `error` across the MCP tests and expects no call.

**What else changes**
- `process-spawning`: the stdin option and its scenarios (R18.3).
- `tool-calls` and the Responses adapter: a tool can be sent without strict mode.
- `agent`:
  - `MCP_CONFIG`, the start-up order, the tools offered and the records above;
  - the README's warning that MCP tool descriptions and results reach the model as untrusted text.
- **Docker images** need `ps` (procps), or a listing from `/proc`, for the sweep and for the transport's close (Q24).

**Open:** Q18 and S7 (LM Studio's handling of `__` and digits); Q21, deferring tool definitions (the 15 servers measured cost about 21,900 tokens, against about 700 for the built-in tools); Q23, Q24 and S10; and Q27, narrowing a server's tools for one task (C21).

---

# Part 5: Decisions, questions and spikes

## Decisions

| ID | Decision | Options | Recommendation | Status |
|---|---|---|---|---|
| D1 | LLM wire API | Responses only · Chat Completions only · both behind a thin adapter | **Responses only** was the original recommendation (C1) | open for the broader future design; D24 decides the current Responses and Messages adapters |
| D2 | OpenAI auth order | API key first · SIWC first · both at once | **API key first; SIWC in M5, after S4 and Q9** (C2) | open |
| D3 | Where the shell and file tools run | Workspace container · app container | **Workspace container** (C3) | open |
| D4 | What a skill is | SKILL.md plus a few app tools · JSON Schema plus handler (as briefed) · SKILL.md plus typed sidecars | **SKILL.md plus a few app tools** (C4) | open |
| D5 | Where task definitions live | DB canonical with TASK.md apply · files canonical · DB only | **DB canonical with TASK.md apply** (C6) | open |
| D6 | Scheduler (originally open) | In-process DB tick · cron/systemd invoking a CLI · `Bun.cron` timers. **Since 2026-11-09:** a resident scheduler of its own · one native heartbeat entry running a short tick each minute · one OS entry per task (R25) | **In-process DB tick** (4.8). **2026-11-09:** C23: a resident scheduler of its own that waits for the earliest next fire, with each run its own process. One entry per task, `Bun.cron`'s OS-level form included, is rejected (R25.1, R25.2) | **decided 2026-11-09: a resident scheduler of its own,** started with a config file and a data directory, as asked, in place of 4.8's tick over the database. Missed fires, the zone and the wait stay open (C23, D50, D52–D54) |
| D7 | History storage | One row per item · a `jsonb` array per run | **Row per item** (C11) | open |
| D8 | Narration fallback | Nudge · execute the parsed call | **Nudge; strict execute opt-in per profile** (C9) | open |
| D9 | Run limits | Iteration cap only · budgets, context check and finalize turn | **Budgets, context check and finalize** (C8, R15) | open |
| D10 | Core packaging | One package with subpath exports · one package per library | **One package** (4.2) | open |
| D11 | Compaction trigger | Threshold, chunky, at turn boundaries · sliding window | **Threshold at turn boundaries** (C5) | open |
| D12 | Cron expressions | croner · `Bun.cron.parse`. **Since 2026-11-09:** croner-rust (R26.2) | **croner** (4.8). **2026-11-09:** with the scheduler in Rust (D50), croner-rust, the newest, with DST and day-field tests. It gave the same fires as croner 11 on all 21 valid patterns R26.4 tried, DST included, and both flip two of 4.8's pinned DST behaviours. They differ where croner 11.0.0 skips some 1st-of-month fires of patterns that restrict both day fields, as with `0 0 1 * 5`, until the merged fix ships. `Bun.cron.parse` doesn't exist on Node, and differs from croner 11 in 8 DST cases (R25.3, R26.2, R26.4) | open |
| D13 | ORM fallback, only if S1 fails | EntitySchema · run the app on Node | **EntitySchema first** (C7) | conditional |
| D14 | First backend for M1 | OpenAI API key · LM Studio | **OpenAI API key**: the most reliable tool calling, so early harness bugs aren't mixed up with local-model quirks. LM Studio comes in M4 | open |
| D15 | `emitDecoratorMetadata` | Off, with explicit types · on, with `Relation<T>` and `import type` | **Off** (C7); S1 confirms | open |
| D16 | Meaning of overlap `queue` | Coalesce (fire once after the active run) · a real depth-1 queue (needs two partial indexes) | **Coalesce** (4.8) | open |
| D17 | Isolating skill secrets | Visible workspace-wide (documented) · per-task uid in the workspace | **Workspace-wide for now**; revisit with Q5. Per-task uids edge toward the non-goal | open |
| D18 | Where the shell runs before M1 | Host shell (A) · host shell in a Seatbelt fence (A+) · workspace container through `docker exec` (B-lite) · C3's workspace and exec server, built early (B) | **B**, narrowly over B-lite (C12) | **decided 2026-10-15: A**, a host shell. D3 still governs M1 |
| D19 | Which runtimes the server runs on | Bun only, declared in `engines` and checked at start-up · Bun or Node, through `@mecha-gremlin/yaml` and `@mecha-gremlin/process`, which use Bun's built-ins on Bun and Node's modules elsewhere (R14) | **Bun only**, declared and checked | **decided 2026-10-16: Bun or Node.** The tests run on both |
| D20 | What the session does at its turn limit | Fail with no answer (today) · run the last turn's calls, then fail (most loops, R15.2) · run them, then a finalize turn, and end `capped` (smolagents, Microsoft Agent Framework) | **Finalize, ahead of M2's budgets** (C8) | open |
| D21 | What "turn" names | One model request, as now · a user's whole exchange, with "step" for a model request and the calls it asked for, and "model call" for the request alone (R15.1) | **Step, before M1** (C13) | **decided 2026-10-16: Step.** The change `turn-to-step` carries it out, after the `model-hello` and `model-turn` capabilities became `server` and `model-call` |
| D22 | What the package that carries out a task is called | `server`, as now · `agent`, with M1's `app` around it · `agent` now, renamed `app` at M1 · `app`, 4.2's name · `gremlin`, the CLI's | **`agent`, with `app` around it**: it runs one agent, and "server" also names the model server and the exec server (C3) | **decided 2026-10-21: agent.** The change `server-to-agent` carries it out |
| D23 | The file tools, and their names | `write_file` beside `read_file`, as C4 first listed them · a whole-file write and an exact edit, `write` and `edit`, as in Claude Code, pi, opencode and Goose · Codex's `apply_patch` alone · both sets at once (R16) | **`read`, `write` and `edit`, with `apply_patch` in place of `write` and `edit` by a setting**: the pair most harnesses give every model, and the format GPT models are trained on as the alternative. Both at once would give two ways to do one thing (C4) | **decided 2026-10-22: `read` (renaming `read_file`), `write` and `edit` by default, and `apply_patch` instead with `FILE_TOOLS=apply-patch`.** The change `file-write-tools` carries it out |
| D24 | Claude and the provider boundary | Responses only · native Claude Messages beside Responses · a separate agent loop | **One loop, native provider adapters**; no SDK in `core` | **decided 2026-10-27:** direct Claude API key and `@anthropic-ai/sdk`; five-minute automatic caching; native in-memory replay; complete typed provider statistics; explicit settings and task. No database persistence or provider switching. `add-anthropic-support` carries it out. |
| D25 | The database | Postgres, as settled · SQLite in a data folder, for good · SQLite now and Postgres later | **SQLite for good, on a local file system** (C14). Postgres only if the run log must hold against a compromised app, or more than one host writes | **decided 2026-10-29: SQLite for good,** in a data folder on a local file system, which in Docker is a named volume. 4.4, 4.8 and 4.9 lose their Postgres-only parts, as C14's table shows |
| D26 | The SQLite driver under TypeORM | better-sqlite3 13 · a stand-in over `node:sqlite`, through TypeORM's `driver` option | **better-sqlite3 13**: one bundled SQLite on every runtime, and TypeORM's documented path. `engines.bun` rises to `>=1.4.4`, and the stand-in is the fallback, as in C7's ladder (C15) | **decided 2026-10-29: `better-sqlite3` 13** (R17.6). `engines.bun` rises to `>=1.4.4`, a root override pins `^13` for npm, the database opens before any network connection, and the Docker image needs glibc 2.34 or musl. The stand-in stays the fallback |
| D27 | Where persistence lives | a package, `@mecha-gremlin/store` · a `store` folder in `agent` · M1's `app` package, started now | **A package:** the agent, the login command and M1's app all use it, and it keeps TypeORM and the native addon in one place (4.2) | **decided 2026-10-29: a package, `@mecha-gremlin/store`.** The change `add-persistence` adds it |
| D28 | `DATA_DIR` | required · optional, with no persistence when it's unset | **Required:** an existing directory, its real path used, `db.sqlite` created 0600 inside it, and the file tools refusing it as they refuse `.env` files (C14) | **decided 2026-10-29: required.** It must not be or contain `WORK_DIR`. The change `add-persistence` carries it out. **2026-11-01:** the file tools no longer refuse the folder (D41), so the rule that it must not be or contain `WORK_DIR` goes too (C20) |
| D29 | Where MCP servers are configured | a JSON file named by a setting · rows written by commands | **A file, `MCP_CONFIG`, in Claude Code's `mcpServers` format,** with secrets given only as `${NAME}` references to environment variables, and a per-server header option. The database holds only what machines write (C16, 4.12) | **decided 2026-10-30: rows in the database,** written by a command, in place of a file. The change `add-mcp-servers` carries it out, with each entry in the `mcpServers` format and secrets still given as references |
| D30 | The login command | `bun run mcp-login <server>`, a second entry point in `agent` · a `gremlin` CLI with subcommands, now | **`mcp-login`;** `gremlin` arrives with M1's app (C17) | **decided 2026-10-30: `bun run mcp`,** one command with subcommands, a second entry point in `agent`. The change `add-mcp-servers` adds it with `add`, `list`, `remove`, `disable` and `enable`, and the OAuth change can add `login` |
| D31 | Client registration | a configured client ID, then DCR · CIMD as well, with a published metadata document | **A configured client ID, then DCR.** CIMD once a document is published under your name (C17) | **decided 2026-10-31: a configured client ID, then DCR,** as recommended. CIMD waits for a published document. The change `add-mcp-login` carries it out |
| D32 | Token storage | plain columns, with the file 0600 and fenced · encrypted columns, with a key from the environment | **0600 and the fence now;** encryption once backups exist (C17) | **decided 2026-10-31: plain columns,** in the 0600 file behind the fence, as recommended; encryption once backups exist. The change `add-mcp-login` carries it out. **2026-11-01:** D41 removes the fence, so until M1's workspace, which never mounts the data folder, the file's mode protects the tokens from other users only, as it always did from the shell |
| D33 | A configured server that can't connect or needs a login | fail the run before the first model call · skip the server with a warning · a per-server `required` flag | **Fail the run,** with an error that names the fix. An entry marked `disabled` is skipped, and there is no `required` flag (C18, 4.12) | **decided 2026-10-30: fail the run,** as recommended. The change `add-mcp-servers` carries it out |
| D34 | Which MCP tools the model sees | every tool of every server · per-server allow and deny lists | **`includeTools` and `excludeTools` from the start,** by the server's own names, with model-facing names as C18 proposes. An unmatched include fails the run, and an unmatched exclude only warns (C18, 4.12) | **decided 2026-10-30: `includeTools` and `excludeTools`,** as recommended. The change `add-mcp-servers` carries it out |
| D35 | The order of work | persistence, then the login, then the client, as asked · persistence and the client side by side, then the login | **Side by side, then the login** (C16) | **settled 2026-10-31 by the work's order:** persistence (`add-persistence`), then the client (`add-mcp-servers`), then the login (`add-mcp-login`) |
| D36 | The working directory of stdio servers | an empty directory made for each run · `WORK_DIR` · the directory the agent was started from | **An empty directory for each run,** and `WORK_DIR` only when an entry names it. npm reads `.npmrc` from its working directory, and a `.` in `PATH` resolves there, while the model can write to `WORK_DIR` (R18.1, 4.12) | **decided 2026-10-30: an empty directory for each run,** as recommended, made outside `WORK_DIR` and `DATA_DIR`. The change `add-mcp-servers` carries it out |
| D37 | How stdio servers are started and stopped | through `@mecha-gremlin/process`, with a new stdin pipe and the agent's own close sequence · the SDK's `StdioClientTransport` | **Through `@mecha-gremlin/process`.** The SDK's transport signals only its direct child, and Playwright's Chrome outlives a group kill unless its groups were listed first (R17.3, R18.3, 4.12) | **decided 2026-10-30: through `@mecha-gremlin/process`,** as recommended, which gains a stdin pipe. The change `add-mcp-servers` carries it out |
| D38 | The port the login's redirect comes to | a fixed port, configurable · any free port | **A fixed port, configurable:** some servers match redirect URIs exactly, host and port included (C17) | **decided 2026-10-31: any free port.** A saved client's registered port is used again when it is free, and a client registered through DCR is registered again when it isn't; the address the browser ends on can also be pasted. The change `add-mcp-login` carries it out |
| D39 | How a run takes its task | the arguments, joined with spaces, as now · a file by default, with `--prompt` and `-p` for the text inline · a file by default, with `--task` for the text inline · a file when the argument names one, the text otherwise | **A file by default, with `--prompt` and `-p` inline.** C6 calls a TASK.md's body the prompt, `--task <name>` already names a definition, and a guess from the argument is ambiguous whenever a task's text could name a file (C19) | **decided 2026-11-01: a file by default, with `--prompt` or `-p` for the text inline,** as recommended. The change `read-task-file` carries it out |
| D40 | A task file's frontmatter | part of the task, sent verbatim · refused until TASK.md gives it meaning · parsed now, starting on TASK.md's keys (D5) | **Verbatim:** notes that keep tags in their frontmatter run as they are, and a file without frontmatter means the same to a later TASK.md reader (C19) | **decided 2026-11-01: verbatim,** as recommended. The change `read-task-file` carries it out. **2026-11-05:** D45 supersedes it: the block is stripped from the prompt, and its keys configure the run |
| D41 | What the file tools refuse by path | as now: outside the working directory (for `read`, outside it and the skill directories), `.env*` names and the data folder · `read` alone, refusing `.env*` names and the data folder · nothing (R20) | **Nothing:** the refusals that don't depend on where a file is stay, and a container is the only sandbox (C20) | **decided 2026-11-01: nothing,** as asked: "This harness should not worry about this type of safety, if we need sandboxing, we will use containers." The change `remove-file-tool-fence` carries it out |
| D42 | A setting that brings the fence back | a setting, off by default · none | **None:** with a shell in every run, the setting would only look like a sandbox (C20) | **decided 2026-11-01: none,** as asked. The change `remove-file-tool-fence` carries it out |
| D43 | What a task file refuses by path | `.env*` names and the data folder, as C19 proposed against a slip of the shell's completion · nothing, as with the file tools (D41) | **Nothing:** C19 tied the rule to what the file tools refuse, and the harness guards no paths (C20). A binary or blank file still fails, since neither holds a task | **decided 2026-11-01: nothing,** as recommended. The change `remove-file-tool-fence` carries it out |
| D44 | Where a task's choice of MCP servers lives | nowhere: every enabled server for every task, as now · a list in the task file's frontmatter · an environment variable set for the run · a flag | **The frontmatter, with every enabled server when it names none:** the choice stays beside the text that relies on it, as 4.7's `skills:` list does. An environment variable can't choose for one task from `.env` or in 4.8's one daemon, and no harness surveyed chooses servers through one (C21, R21, R22) | **decided 2026-11-05: the frontmatter,** as recommended. The change `choose-task-mcp-servers` carries it out |
| D45 | What a task file's frontmatter means once a key in it is read | read the keys it knows, and still send the whole text verbatim · strip it, so that the body is the prompt, as C6 says of TASK.md · read only a `gremlin` mapping inside it | **Strip it:** the keys are configuration, which every harness surveyed keeps out of the prompt (R22.4), and C6 already reads TASK.md so. A block that parses as plain text stays in the prompt (C21, R23) | **decided 2026-11-05: strip it,** as recommended once asked "So you would send the frontmatter even though it's redundant?", where the first recommendation had been to send it verbatim. It supersedes D40. The change `choose-task-mcp-servers` carries it out |
| D46 | A server the task lists that's disabled | fail the run, pointing to `bun run mcp enable` · skip it with a warning, as Claude Code does a server that a policy blocks (R22.1) | **Fail the run:** the task says it needs the server, as D33 fails one that can't start (C21) | **decided 2026-11-05: fail the run,** as recommended, for a server the list doesn't mark optional (D49). The change `choose-task-mcp-servers` carries it out |
| D47 | Frontmatter that isn't valid YAML | fail the run, with the parser's reason and line · warn, and send the block as text with every enabled server | **Fail the run:** stripped, a broken block can be neither read nor safely sent, and notes do hold such blocks (C21, R23.1) | **decided 2026-11-05: fail the run,** as recommended. The change `choose-task-mcp-servers` carries it out |
| D48 | A key in the frontmatter that the run doesn't read | warn and ignore it · fail the run, as Gemini CLI's sub-agents do · ignore it silently, as Claude Code does (R22.4) | **Warn and ignore it:** a misspelt `mcps` shows in the log, and a note's `tags` don't fail it (C21) | **decided 2026-11-05: warn and ignore it,** as recommended. The change `choose-task-mcp-servers` carries it out |
| D49 | A server a task can go without | none: every listed server is required, as D33 says · a `?` after a listed name, which leaves the server out when it can't be used · a separate list of optional servers | **A `?` after the name:** a server that can't be used is left out, with a warning record and a line in the model's instructions, and a name the store doesn't hold still fails the run (C22, R24) | **decided 2026-11-05: a `?`,** as asked, in the change that lets a task choose its servers, where the recommendation had been a later change. The change `choose-task-mcp-servers` carries it out |
| D50 | The scheduler's language | TypeScript on Bun · TypeScript on Node · a thin Rust timekeeper, with every rule in TypeScript · the whole scheduler in Rust · an existing daemon as it is | **TypeScript on Bun,** with its idle GC timer off, and Node as the fallback (C24): in the research's judgment Rust pays only where Bun isn't present, tens of MB matter, schedules live in a file only the scheduler reads and a new decision accepts the coarser mutation gate, and Bun is on the host anyway to start the runs (R26.4) | **decided 2026-11-09: Rust,** as asked, where the recommendation had been TypeScript on Bun: a small package under `packages/`, started with a TOML config and a data directory for its own log and its jobs' logs, since "25MB is not 0 and it's functionality will be limited". With schedules in its own config, parity with the agent no longer weighs against it (C24) |
| D51 | Where a task's schedule lives | `schedule` in the task file's frontmatter, in a folder the scheduler reads · the scheduler's own config file · rows written by a command, as D29 does for MCP servers · DB canonical with TASK.md apply (D5) | **The scheduler's own config:** a Rust scheduler then reads no YAML and no store, so nothing has to stay in step with the agent (R26.4) | **decided 2026-11-09: the scheduler's own config file, in TOML,** as asked, with one `[[job]]` table per job, whose arguments name its task file (C23) |
| D52 | A fire missed while the machine slept or was off | run it once, for the latest missed slot · skip it, as cron does after a long gap · run it once only within a grace window | **Once, for the latest missed slot,** with `catch_up = false` for a job that should skip (C23): what launchd and systemd do after sleep, and systemd after a power-off too with `Persistent=true`, and the default of Kubernetes, Claude Code Desktop, OpenClaw and Hermes (R25.2, R25.4) | open |
| D53 | The zone schedules are read in | the process's zone: the host's under launchd or cron, UTC in a container · one `timezone` in the scheduler's config · a zone per job, defaulting to it | **One `timezone` in the config** (C23), so that one schedule means one instant on the host and in a container (R25.5). A zone per job can follow. It answers Q11 | open |
| D54 | How the scheduler waits for the next fire | a sleep capped at 60 s, then the wall clock · the operating system's exact wall-clock timers: an absolute `clock_nanosleep` or a `timerfd` on Linux, a GCD wall timer or a re-armed kqueue timer on macOS · exact on Linux, capped on macOS | **The capped sleep** (C23): portable, testable with a fake clock, and about 16 ms of CPU a day in Rust. Exact timers save about one wakeup a minute, and can follow without a change to the config (R26.1) | open |

## Open questions

| ID | Question | Why it matters |
|---|---|---|
| Q1 | Where do run results and failures go: push notification, email, a file, a daily digest? And should an external dead-man's switch watch the app itself? | Nothing in the brief delivers output. A 3am failure nobody sees is the classic failure mode, and a dead app can't alert anyone. |
| Q2 | What is "state between runs": prose notes or structured `jsonb`? Is it written by an app tool (`remember`) or taken from the final answer? | Shapes `task.state`, the run input and one app tool. |
| Q3 | Which local models will you run? | Decides whether LM Studio parses their tool calls natively or falls back to its injected prompt (R5.2), and so how often narration happens. So far: `prism-ml/bonsai-27b`, whose calls LM Studio parses natively (R11). |
| Q4 | Which plan would SIWC use: Plus, Pro, or an existing Business or Go seat? | Plus shares a 5-hour window with your own Codex use. Plus and Pro both draw on the weekly "ChatGPT Work and Codex" allowance. Whether Business or Go qualifies is unsettled (R1.2), and S4 tests it. |
| Q5 | Can two tasks touch the same mounted directories? | There is no app-level answer to two agents editing the same files. If they can, adopt a convention such as one working directory per task, and decide D17. |
| Q6 | One app daemon, always? | Assumed, and enforced: `gremlin serve` takes an advisory lock and refuses to start a second daemon (4.8). The boot sweep and the in-process semaphores rely on it. Running two would need heartbeat-based recovery and DB-backed semaphores. |
| Q7 | Is a CLI transcript (`gremlin runs show`) enough for inspecting runs at first? | Assumed yes until M2 or later. |
| Q8 | Does the workspace need internet access? If so, is reaching host services (`host.docker.internal`) an accepted risk, or should egress go through a proxy? | Assumed yes, with LM Studio token auth and host services treated as exposed (C3, R10). A proxy matters more on client boxes. |
| Q9 | Does SIWC cover a personal, unattended, scheduled runner? | The docs don't say. **For:** a guide for running an open-source app on a remote VM; the example agent name is OpenClaw, which has a built-in cron scheduler; and OpenAI's Codex lead called use through Sign in with ChatGPT in OSS clients "completely fine" (R1.4). **Against:** the Codex docs say "The right way to authenticate automation is with an API key" (R1.3). It needs OpenAI's answer or a reading of the terms, not a spike. |
| Q10 | Is a client deployment always one install per client, with no multi-tenancy? | Assumed yes. Otherwise every table needs a tenant key from the start. |
| Q11 | Which time zone do schedules use by default? | Without a zone, croner uses the process zone, which is UTC in containers (R8). Proposal: `tz` per task, with a deployment default (4.8). |
| Q12 | How does the model activate a skill: an `activate_skill` tool whose `name` is an enum of the skills, or by reading SKILL.md with `read_file`? | C4 and the client guide favour the tool (R12.7): no invented names, frontmatter stripped, a list of resources, and every activation logged. Reading needs no new tool. |
| Q13 | Where do skills come from before tasks exist: configured directories, the standard scan (`.agents/skills` and `~/.agents/skills`), or both? | A scan of the home directory picks up skills written for other agents. The playwright-cli skill is best read from the installed package, whose copy always matches the CLI (R12.1). |
| Q14 | How does the model read a skill's references: `read_file` with read-only skill roots, or through the shell? | The first widens `read_file` beyond the working directory, as the client guide suggests (R12.7). With a host shell (D18), the shell can read them either way. |
| Q15 | What is the shell tool's contract: arguments, output format and cap, exit codes, timeouts, environment, working directory, and cleanup at run end? | It is C3's process control, adapted to a host shell. C12 lists what the analysis says a host shell needs. |
| Q16 | What turn and context budget does browsing need? | Each page action is a shell call plus a snapshot read, so the cap of 8 turns is too low, and one snapshot read can add up to 32 KiB (R12.1). C8's budgets wait for M2. |
| Q17 | Where does SKILL.md parsing live, `core` or the server, and with which YAML parser? | 4.3 puts `parseSkill` in `core`. `Bun.YAML` can't run there (lint) or under Vitest on Node, so the `yaml` package would be `core`'s first runtime dependency. |
| Q18 | Does LM Studio's snake_case conversion keep a `__` separator, and do hyphenated MCP names come back unchanged? | It decides whether `mcp__<server>__<tool>` works on local models (C18, S7). |
| Q19 | Does the Responses API accept top-level function names longer than 64 characters, and does leaving `strict` unset make it normalise MCP schemas or fall back to non-strict? | The names and strict handling C18 proposes (S8). It needs an API key. |
| Q20 | Will the login command run where the browser is, or on a remote or containerised runner? | It decides whether pasting the redirect URL is the main path or the fallback (C17). |
| Q21 | Should MCP tools be offered directly, or deferred behind a tool search, as Claude Code, Codex, opencode and pi now do by default? | It matters once servers bring dozens of tools: their definitions fill the prompt (R17.5). |
| Q22 | Is a server identified by its name alone, or by its name and URL? | pi and Codex key credentials by both, so one URL configured under two names holds two sign-ins (R17.5). |
| Q23 | Should a stdio server that exits mid-session be restarted, as the stdio binding says a client SHOULD, or should its calls fail for the rest of the run? | 4.12 lets them fail, which keeps a run's tools fixed. A restart needs a new handshake, and the same tool list (R18.3). |
| Q24 | Do the Docker images install procps, or do the sweep and the transport read `/proc` on Linux? | The official Bun and Node images ship no `ps`, so in them the sweep fails and the transport finds no descendants to stop (R18.3). **2026-11-09:** `node:latest`, the full Debian image, has procps. `node:slim`, `oven/bun:latest` and `oven/bun:slim` have no `ps`, and the Alpine images' BusyBox `ps` refuses the sweep's options, so every run there logs `cleanup failed` (R25.5). |
| Q25 | What does each provider do with a first request larger than the model's context: fail it, or cut it silently? | A task file has no size limit, unlike an argument (R19), and LM Studio's default context has been 8k since 0.4.16 (R5.5). A failure ends the run with an error, while a silent cut runs a task the model saw only in part. It decides whether a task file needs a cap (C19). |
| Q26 | Should the file tools expand a leading `~` to the home directory? | None does: `~/notes.md` makes a directory named `~` in `WORK_DIR` (R20.5). The shell expands it, and once paths may leave the working directory (D41), a model is likelier to write one. |
| Q27 | Should a task narrow a server's tools as well as choose the server? | A task that only reads could be offered only a server's read tools, as `includeTools` narrows them for every run (D34). A list of names can grow into a mapping, such as `mcp: {docs: [search]}`, without breaking (C21). |
| Q28 | Where does the scheduler run first: on the host, as the agent runs today (D18), or in the container the Brief deploys (4.9)? | It decides what keeps the scheduler running, a LaunchAgent or a restart policy. On macOS, a process launchd starts likely can't reach `~/Documents`, `~/Desktop` or iCloud Drive **[M]** (R25.2). |
| Q29 | Should a scheduled run be told its slot time, and that it is catching up? | A run caught up hours late doesn't know it (R25.5). 4.8 already gives the run after a deferred one a note on what that run did. |
| Q30 | How does a run's failure reach you: through the scheduler's log alone, a command the scheduler runs on failure, or Q1's alerts? | The scheduler now holds each run's exit code and log, and a 3am failure nobody sees is the classic failure mode Q1 names. |

**Q12–Q17 (2026-10-16).** The OpenSpec change `skills-and-shell` answers each in its design (`openspec/changes/archive/2026-10-16-skills-and-shell/design.md`):

| Question | Design decision |
|---|---|
| Q12 | 3 |
| Q13 | 1 |
| Q14 | 4 |
| Q15 | 5 and 7 |
| Q16 | 9 (`MAX_TURNS`) |
| Q17 | 2 |

The change was implemented and archived on 2026-10-16, which settles them. Its live check browsed with the playwright-cli skill on a local 9B model.

## Spikes (M0)

| ID | Spike | Pass when | Unblocks |
|---|---|---|---|
| S1 | TypeORM and Postgres on Bun | **Entities:** circular relations across files, with metadata both off and on; `jsonb`; the partial unique index. **Claims and ticks:** a find-options `SKIP LOCKED` claim inside a transaction; the tick query with `NOT EXISTS … FOR UPDATE OF task`; the `ON CONFLICT` tick with one conflicting task doesn't block the others; a per-task savepoint contains a failing task; the tick-vs-finalisation lock order holds under a race. **Scheduling rules:** an `overlap: queue` plus `catch_up: skip` task fires once after a long run; a `catch_up: skip` task fires once when its domain's block lifts. **Tooling:** both migration commands run through `bunx --bun` from `packages/app`; the tsconfig matrix passes (started from root and from `packages/app`, in the image and in `bun test`); the boot self-check fires when it should. **Grants:** as `gremlin_app`, UPDATE, DELETE and TRUNCATE on `event` fail with 42501, and deleting a run that has events fails with 23503. **Driver:** TypeORM 1.1.2 on pure-JS `pg` (not `pg-native`) under Bun 1.4.3 holds up under concurrent claims and ticks. | ORM choice; D13, D15 |
| S2 | LM Studio `/v1/responses` with **your** models | Multi-turn function calls with client-held history; the developer item honoured; `tool_choice:"none"` works and whether it keeps the KV prefix; malformed-call behaviour (text or HTTP 500); BT#2257's intermittent 500s; `cached_tokens` reported; the longest silent gap measured; the REST `parallel` load field; object `tool_choice` and `allowed_tools` on `/v1/responses`. | D1, D8 |
| S3 | OpenAI Responses with the target GPT model | `store:false` with reasoning items replayed from `output_item.done` across tool turns; replay across a compaction boundary; cached and written tokens visible; whether `tool_choice:"none"` keeps the cache; whether an explicit breakpoint and the implicit end-of-input breakpoint both apply; reasoning summaries as a liveness signal; the longest silent gap. | D1, D11, caching config |
| S4 | SIWC end to end | Eligibility on the actual account type; both login routes (C2); the issued `client_id` stored and used; refresh rotation under two concurrent runs, serialised; namespaced tools or `additional_tools`; the limit-error shapes (429 before the stream, `response.failed` mid-stream, bare `{"detail"}` bodies) and any reset hint; whether reasoning summaries are allowed. Runs at the start of M5, not in M0. | The technical half of D2; Q9 is answered separately |
| S5 | Docker plumbing and the exec server | **Networking:** `host.docker.internal` reaches LM Studio on 127.0.0.1 (Docker Desktop only; on Linux, bind to the bridge IP), and internal-network reachability matches R10. **Process control:** the exec server kills process groups on timeout and on client disconnect; kills processes that escaped with `setsid` through `GREMLIN_RUN_ID`; on reset, kills everything except PID 1 and itself; returns promptly when a background grandchild holds the pipe; never blocks on stdin; reaps zombies under `init`. **Output:** `yes` with a 5-minute timeout returns head and tail within the cap while memory stays flat; binary, NUL and cut-emoji output is stored safely. **Ownership:** on a Linux host, files the agent writes are owned by the host user. | D3, 4.9 |
| S6 | better-sqlite3 13 and TypeORM on Linux | The R17.1 scenario passes with better-sqlite3 13 and with the `node:sqlite` stand-in, on Bun and on Node, in Debian and Alpine images and on CI's runner; `bun install --frozen-lockfile` builds nothing; the tests and Stryker run with it on both runtimes | D26 |
| S7 | MCP tool names through LM Studio | A model on LM Studio sees and calls `mcp__<server>__<tool>` names, including ones mapped from hyphens, and the calls map back to the MCP names (Q18) | D34 |
| S8 | MCP schemas on the Responses API | Typical MCP schemas are accepted without strict mode, with `strict` unset as well as `false`; a 65-character name is accepted or refused (Q19) | D34 |
| S9 | The login end to end | Against one DCR server and one that needs a pre-registered client (GitHub): through the callback, by pasting, and from a container with a published port; then a refresh under two concurrent runs | D30, D31 |
| S10 | Chromium under `@playwright/mcp` on Linux | In the Docker image, the transport's close leaves no browser process, whether the server is running, hung or killed abruptly; and whether a browser outlives its server's abrupt death there, as it does on macOS (R18.3) | D37 |
| S11 | The scheduler under launchd, on a disposable Mac or macOS VM, never the host | A `KeepAlive` LaunchAgent with `WorkingDirectory`, `ProcessType`, `PATH` and `LANG` set: after a 10-minute sleep its first wake comes within 60 s and each job that missed a fire catches up once; the Login Items entry and any "Background Items Added" notice are noted, and switching the item off stops it; whether a run it starts reaches `~/Documents` and iCloud Drive; and `launchctl bootstrap` without a GUI login fails with an error that can be named | C23 on macOS, Q28 |
| S12 | The capped wait after a real sleep and suspend | The scheduler's first wake comes within 60 s of waking: from a 10-minute macOS sleep, inside Docker Desktop's VM across that sleep, and from a Linux suspend (`rtcwake` in a VM). Each job that missed a fire catches up exactly once | D54, D52 |
| S13 | Runs started together, after the migration fix | 8 runs started within 10 ms, on a fresh data folder and on one with a pending migration, 5 trials each on Bun and Node, give no failures; today 2–3 of 4 fail on Bun (R25.5) | C23 |
| S14 | A run's timeout, and stopping the scheduler | A timeout's SIGTERM reaches a run that is mid MCP call and mid shell command: it exits with 143 within its cleanup time, and no process with its run ID is left, with procps installed. SIGTERM to the scheduler, from `docker stop` with a stop grace set from that time, ends the run the same way and logs it | C23 in the container, Q24 |
| S15 | Exact wall-clock timers in the scheduler | On GitHub-hosted Ubuntu and macOS runners, a Linux `timerfd` (`CLOCK_REALTIME` with `TFD_TIMER_ABSTIME` and `TFD_TIMER_CANCEL_ON_SET`) and a macOS GCD timer at `dispatch_walltime`, or a kqueue timer re-armed on `HOST_NOTIFY_CALENDAR_SET`, start a fire within 1 s of its time after a forward `sudo date` step, and nothing after a backward one. In a VM, a fire due during a suspend starts at resume | D54 |

**S2 status (2026-10-12).** On `prism-ml/bonsai-27b`, the first criterion passes: multi-turn function calls with client-held history. `cached_tokens` is reported too (R11). The other criteria are still open.

**S2 status (2026-10-16).** On `ornith-1.5-9b-mlx`, `tool_choice:"none"` is accepted, but it drops the tools from the prompt: it doesn't keep the KV prefix, and it doesn't stop a model that wants a tool (R15.3). The other open criteria are unchanged.

**S5 status (2026-10-15).** `docker exec` process control, same-path mounts and container networking were measured on Docker Desktop (R12.3). Still open: the exec server, ownership on a Linux host, a run-ID sweep as a non-root user, and the real playwright-cli with Chromium in a container (R12.4).

**S6 status (2026-10-29).** Run for D26 (R17.6). Both paths pass on Debian 13, Alpine 3.24, AlmaLinux 9 and a copy of CI's Ubuntu 24.04, on amd64 and arm64, under Bun 1.4.4 and Node 26.13.0, under Vitest, and through this repository's own lint, type check and Stryker. `better-sqlite3` 13 needs glibc 2.34 or musl, on x64 or arm64; the stand-in ran everywhere. Still open: GitHub's own runner, which was only copied.

---

## Verification log

**Round one.** After the first draft, independent agents fact-checked the research against primary sources and reviewed the design. Each serious correction was then re-checked by a second agent, with instructions to keep the brief's claim unless the evidence against it was solid.

**Round two.** One agent audited whether every round-one finding had landed correctly, and another reviewed the revised design afresh.

All corrections from both rounds are applied in this version.

| Area | Claims checked | Corrections | Notable |
|---|---|---|---|
| OpenAI subscription and SIWC (R1) | 58 | 14 | Eligibility sources conflict; limit errors also arrive mid-stream with no reset time; 15 omitted fields, not 8; issued `client_id`; Terms of Use and fraud-flagging context; post dates |
| Responses API and OpenAI skills (R2, R4) | 36 | 4 | Local-mode API skills exist (still OpenAI's `shell` tool); reasoning shared within a model family; `output_item.done` |
| Prompt caching (R3) | 36 | 6 | `24h` is a maximum, typically about 30 minutes; `tool_choice` changes are cache-safe; eligible breakpoints; more cache breakers |
| LM Studio (R5) | 68 | 7 | BT#1756 closed; the `strict` warning was on `/v1/responses`; the 0.4.15 fix was for Claude Code; the REST `parallel` field is undocumented |
| TypeORM (R6.1, R6.3) | 53 | 6 | Driver change is per family, so Postgres is unaffected; the `null` guard's scope by API and version; `emitDecoratorMetadata` optional; `FOR UPDATE OF` whenever joining |
| Bun (R6.2, R8) | 48 | 14 | **Bun reads the cwd's tsconfig**; `Bun.cron` gained `{ tz }` in 1.4.0; `maxBuffer` is per stream; #14888 is a Bun issue |
| Agent Skills and background (R7, R9, 4.9) | 34 | 5 | Codex's sidecar holds no typed tools; Unicode skill names; TypeORM #12712; Docker gateway caveats |
| Completeness against the research notes | | 3 dropped, 12 distorted | Lost hedges restored; Part 1 status tables moved to 3.0 |
| Design review (Parts 3–5) | | 31 issues | **High severity:** `ON CONFLICT` tick; heartbeat timer; context-fill check; NUL-safe storage. **Medium severity, among others:** lock order, role separation, skills mounted in the app, milestone order |
| Round two: fix audit | 106 findings | 92 correct, 13 fixed | Restored hedges (R1.5 "mostly right" [M]); the catch-up rule no longer overrides `queue` or the post-block probe; smaller qualifiers in 4.5, 4.6, 3.0, C2 and C4 |
| Round two: fresh design review | | 25 issues | **High severity:** "missed" fires defined by a gap with no tick (persisted `last_tick_at`); deferred runs re-arm their fire. **Medium severity:** workers respect backoff; `run.model_profile`; a single daemon via advisory lock; a hard per-run deadline; full grant matrix with no-cascade foreign keys and a `migrate` service; a storage sanitiser for NUL and lone surrogates; per-task savepoints; token-conditional refresh; per-profile claim loops; the exec output cap in M1. **Low severity:** limit-domain backoff, `tool_start` events, state machine, context fill counting output tokens, the tick query, `gremlin run`, secrets in env, milestone gating, env files untracked, workspace user, `setsid` cleanup, retention and backups, "unreachable" on every backend |

**R12 and C12 (2026-10-15).** Two probes on the development Mac and two research agents gathered 109 claims. An independent fact-check re-verified the 12 source-based claims that matter most (11 hold, 1 partly) and flagged 16 places where a probe report concluded more than its commands showed. The notable corrections:
- `kill-all` reaches only the same user's processes;
- "`docker exec` works" covered its mechanics, not playwright-cli in a container;
- run-ID sweeps were tested only as root;
- a container reaches loopback-only host services through `host.docker.internal`, so rebinding LM Studio wouldn't hide it.

All are folded into R12 and C12.

**R17 (2026-10-29).** Five research agents gathered 142 findings. They measured on Bun 1.4.4 and Node 26.12.1 on macOS arm64, in Linux containers and against local mock servers, and read 29 vendors' public OAuth metadata. Four independent verifiers re-checked the 60 claims the decisions rest on: 46 hold, 14 hold partly, and none failed. The harness survey (R17.5) wasn't re-checked. The corrections and the verifiers' 40 additions are folded into R17, and a second agent checked each R17 subsection against its report. The notable corrections:
- a second `transaction()` usually doesn't fail: it becomes a savepoint inside the first, and the two lose each other's rows;
- a failed migration leaves foreign keys off for the rest of the process;
- the SDK treats a transient refresh failure as a reason to re-authorise;
- 2026-07-28 is the current revision of the MCP specification, and it deprecates dynamic client registration;
- the newest MCP client bundles a version of fast-uri with four fresh advisories.

One verifier's addition didn't survive integration: that 2026-07-28 dropped the rule that authorization servers rotate public clients' refresh tokens. The sentence moved to the revision's security-considerations page, where it still stands, and R17.2 says so.

**R17.6 and S6 (2026-10-29).** Three spikes, for D26, gathered 57 findings: on Linux in Docker, in a throwaway clone of this repository, and on macOS. Three independent checkers re-ran the 27 that D26 rests on: 24 hold and 3 hold partly. Their 24 additions are folded into R17.6. The notable corrections:
- Bun's isolated install finds `better-sqlite3` 13 through its hoisting fallback as well as through TypeORM's peer link;
- npm in a workspace would silently install `better-sqlite3` 12 for TypeORM's peer range, rather than fail;
- under load, Stryker counted static mutants that no test killed as timeouts;
- the speed comparison didn't replicate, so R17.6 claims no winner.

**R18 (2026-10-29).** Three research agents gathered 89 findings for the MCP client's design. Three independent checkers re-checked the 36 that the design rests on: 30 hold and 6 hold partly. They also criticised each proposal, and their 38 additions are folded into R18 and 4.12. A second agent checked each R18 subsection against its report. The notable corrections:
- a stdio server's working directory steers what `npx` installs, so 4.12 doesn't start servers in `WORK_DIR` by default (D36);
- `callTool()`, like `listTools()`, loses a whole result over one malformed block;
- behind a wrapper such as `sh -c`, closing on the leader's exit cut the real server's shutdown short, so 4.12's close waits for the group;
- Bun's `node:child_process` applies backpressure to stdin, so only one of the stdin scenarios can't hold for it.

**R25 (2026-11-08).** Four research agents gathered 138 findings for a light scheduler: `Bun.cron` from its source, with Linux cron probed in containers; the native schedulers of Linux and macOS; in-process cron libraries, with measured costs; and a survey of harnesses and container cron runners. Four independent checkers re-checked all 138: 117 hold, 21 hold partly, and none failed. Their 34 additions are folded into R25.1–R25.4. A completeness critic then read the Brief's scheduler design and probed this repository's code, filling 14 gaps (R25.5) and leaving 5 as spikes; its findings weren't re-checked. A drafting agent wrote each R25 subsection from its checked report, and a second agent checked it against the report. The notable corrections:
- the Alpine variants of the official images ship busybox `crontab`, so `Bun.cron` registers there with no daemon running: a success doesn't mean jobs will fire, and a rejection doesn't mean the host has no scheduler;
- in cron mode Bun loads `.env` from the job's working directory, `$HOME` under cron, and those values beat the project's;
- croner 11.0.0's month-end bug skips a fire only coming out of February, not in every short month;
- Kubernetes' `Forbid` defers a missed slot and starts it once the active Job ends, rather than dropping it;
- opencode-tasks counts only completed runs, so a failing task starts again every minute.

**R26 (2026-11-08).** Four research agents gathered 103 findings for the scheduler's language: the clocks behind each runtime's timers, read in source; existing daemons and Rust crates; the same daemon built in Rust, Bun and Node, and measured; and what a Rust crate would cost this repository. Four independent checkers re-checked 99 of them: 79 hold, 20 hold partly, and none failed. Their 35 additions are folded into R26. Two advocates, one for Rust and one against, then argued from the checked research; C24 weighs them. A drafting agent wrote each R26 subsection from its checked report, and a second agent checked it against the report. The notable corrections:
- Bun's idle CPU and context switches were undercounted 2–5 times by summing only live threads; nearly all of them come from its idle GC timer, and `BUN_GC_TIMER_DISABLE=1` brings them below Node's;
- croner 11.0.0 and croner-rust 4.0.3 differ on `0 0 1 * 5`, which the JavaScript release's February bug skips;
- besides a capped loop, one absolute wall-clock wait is also correct on Linux, through one safe rustix call, so only macOS needs unsafe code;
- serde-saphyr reads frontmatter as the agent does once three options are set, except for `0755`;
- cargo-mutants does mutate inside conditions; what it lacks are mutants of literals, whole conditions and method calls;
- on GitHub's runners, an exact toolchain pin downloads about 0.5 GB in every job.

---

## Sources

**OpenAI**
- help.openai.com/en/articles/8156019 (API billing)
- help.openai.com/en/articles/20001542 (plan usage; read via web.archive.org)
- help.openai.com/en/articles/6825453 (release notes)
- developers.openai.com/siwc/quickstart
- developers.openai.com/siwc/token-sharing-open-source, plus /sign-in, /profiles-and-sessions, /models-and-inference, /preview-limitations, /token-reference, /errors-and-recovery, /self-hosted-vms, /codex-app-server
- developers.openai.com/cookbook/articles/sign-in-with-chatgpt
- developers.openai.com/api/docs/guides/migrate-to-responses, /deprecations, /guides/reasoning, /guides/function-calling, /guides/prompt-caching, /guides/prompt-caching/diagnostics, /guides/tools-skills, /guides/agents-api/overview, /changelog
- developers.openai.com/api/docs/models/gpt-6.1-sol, /gpt-6-sol, /gpt-6-astra
- developers.openai.com/blog/responses-api
- learn.chatgpt.com/docs/auth, /docs/auth/ci-cd-auth, /docs/build-skills, /docs/sign-in-with-chatgpt
- openai.com/policies/terms-of-use (effective 2026-01-01; read via web.archive.org)
- openai-node 7.32.0 type definitions
- x.com/thsottiaux/status/2009742187484065881, /2090675027670978569, /2104991529416999243
- Secondary: WorkOS (2026-10-01), The Star (2026-10-04), VentureBeat (2026-01-09), Simon Willison (2025-12-12, 2025-12-20, 2026-02-11), OpenCode v1.1.11 release notes and issue #7410, devday.openai.com

**LM Studio**
- lmstudio.ai/docs, specifically /developer/openai-compat, /developer/openai-compat/tools, /developer/rest, /developer/rest/load, /developer/rest/list, /developer/core/headless, /developer/core/ttl-and-auto-evict, /developer/core/authentication (source: github.com/lmstudio-ai/docs)
- lmstudio.ai/changelog, specifically 0.4.7, 0.4.10, 0.4.15, 0.4.26
- lmstudio.ai/blog/lmstudio-v0.3.23, /lmstudio-v0.3.29, /openresponses, /0.4.0, /mlx-engine-agentic-workloads
- github.com/lmstudio-ai/lmstudio-bug-tracker issues 670, 1154, 1628, 1709, 1714, 1756, 1904, 2061, 2074, 2086, 2115, 2224, 2257, 2320, 2390, 2419
- github.com/lmstudio-ai/lms issue 489
- mlx-engine PRs 352, 369

**TypeORM, Postgres and Bun**
- typeorm.io/blog/typeorm-1-0, /docs/releases/1.0/release-notes/, /docs/data-source/null-and-undefined-handling, /blog/future-of-typeorm, /docs/help/faq/#how-to-use-typeorm-in-esm-projects
- github.com/typeorm/typeorm:
  - releases 1.1.0 and 1.1.2;
  - issues 9316, 9738, 9862, 10118, 12712;
  - PRs 11437, 11766, 11836, 11878, 12690, 12692, 12730, 12771, 12860;
  - `.github/workflows/tests.yml` and docs (query-builder, entities)
- registry.npmjs.org/typeorm
- postgresql.org/docs/current/sql-select.html
- bun.com/blog/bun-v1.0.3, /bun-v1.3.10, /bun-v1.3.11, /bun-v1.3.12, /bun-v1.4.0
- bun.com/docs/runtime/cron, /docs/runtime/child-process, /docs/pm/bunx
- github.com/oven-sh/bun:
  - issues 4136, 4290, 6172, 6326, 7591, 14888, 20994, 28131, 28605, 44120;
  - PRs 27248, 34496, 35122, 35471, 36461, 36747, 38719, 40823
- node-postgres issue 3201
- github.com/Hexagon/croner

**Agent Skills**
- agentskills.io/specification, /client-implementation/adding-skills-support, /skill-creation/using-scripts
- github.com/agentskills/agentskills (skills-ref parser, validator and tests)
- code.claude.com/docs/en/skills

**Docker**
- docs.docker.com/reference/cli/docker/network/create/ (internal mode)
- docs.docker.com/reference/compose-file/networks/
- docs.docker.com/reference/cli/dockerd/ (host gateway IP)
- docs.docker.com/reference/cli/docker/container/run/
- github.com/moby/moby/issues/9098 (killing the `docker exec` client)
- docs.docker.com/ai/sandboxes/ (Docker Sandboxes, `sbx`)

**Playwright and agent harnesses (R12)**
- the installed @playwright/cli 0.1.22 and its bundled playwright-core (lib/tools/cli-client/, coreBundle.js, skills/)
- playwright.dev/docs/docker; mcr.microsoft.com/playwright tags
- github.com/SWE-agent/mini-swe-agent; github.com/SWE-agent/SWE-ReX
- github.com/OpenHands/OpenHands (0.59.0)
- github.com/openai/codex issues #21292, #31560 and #34474; codex-rs/exec-server
- github.com/anthropics/sandbox-runtime and its issue #210
- simonwillison.net/2025/Jun/16/the-lethal-trifecta

**MCP, OAuth and SQLite (R17)**
- modelcontextprotocol.io/specification/2026-07-28: /basic/authorization with its authorization-server-discovery, client-registration and security-considerations pages, /server/tools, /basic/versioning and /changelog; /specification/2025-11-25/basic/authorization, /2025-06-18/basic/authorization and /draft
- github.com/modelcontextprotocol/modelcontextprotocol: PRs 2059, 2858 and 3384; issues 1614 and 3223; SEPs 991, 2207, 2468 and 3398; `schema/2026-07-28/schema.ts`. github.com/modelcontextprotocol/ext-auth and its issue 18
- github.com/modelcontextprotocol/typescript-sdk: the READMEs on `main` and `v1.x`; at v2.4.0, `docs/` and `examples/`; PRs 2877, 3106 and 3108, and issue 3101. `@modelcontextprotocol/client@2.4.0`, `@modelcontextprotocol/core@2.4.0` and `@modelcontextprotocol/sdk@1.32.2`
- github.com/advisories GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr, GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp, GHSA-6qxp-vccf-f47h and GHSA-6prh-2h8m-c8cw
- rfc-editor.org RFCs 7591, 7636, 8252, 8414, 8628, 8707, 9207, 9700 and 9728; ietf.org/archive/id/draft-ietf-oauth-v2-1-16.txt and /draft-ietf-oauth-client-id-metadata-document-02.txt
- auth0.com/docs/secure/tokens/refresh-tokens; developer.okta.com/docs/guides/refresh-tokens; `@cloudflare/workers-oauth-provider@1.2.4`
- typeorm.io/docs/drivers/sqlite; github.com/typeorm/typeorm releases 1.1.1 and 1.1.2, PRs 12691 and 12971, and issues 1884, 2479, 8668, 9862, 11164, 11236 and 12012; `typeorm@1.1.2` (`driver/better-sqlite3`, `driver/sqlite-abstract`, `driver/sqljs`, `migration/MigrationExecutor.js`)
- github.com/WiseLibs/better-sqlite3: v13.0.0, issues 1503 and 1514; `better-sqlite3@13.0.3`; github.com/sql-js/sql.js v1.15.2; github.com/asg017/sqlite-vec
- github.com/oven-sh/bun: issues 4290 and 16469, PRs 36712 and 44968, `src/jsc/bindings/BunProcess.cpp` at bun-v1.4.4; bun.com/docs/runtime/sqlite and /nodejs-compat; bun.com/blog/bun-v1.4.0 and /bun-v1.4.4
- nodejs.org/docs/v26.12.1/api/sqlite.html and /typescript.html; github.com/nodejs/node v26.13.0; github.com/npm/cli issue 9837
- sqlite.org/wal.html, /lang_transaction.html, /c3ref/busy_handler.html, /howtocorrupt.html, /useovernet.html, /lang_upsert.html, /lang_conflict.html, /jsonb.html, /backup.html and /pragma.html
- docs.docker.com/desktop/settings-and-maintenance/settings
- Harnesses: code.claude.com/docs/en/mcp; github.com/openai/codex (`codex-rs/rmcp-client`, `codex-mcp`, `cli`, `core`); github.com/google-gemini/gemini-cli; github.com/anomalyco/opencode; github.com/aaif-goose/goose; github.com/charmbracelet/crush; github.com/microsoft/vscode; github.com/zed-industries/zed; github.com/badlogic/pi-mono; github.com/huggingface/smolagents; cursor.com/docs/cli/mcp; ampcode.com/docs/customize/mcp
- The MCP documentation and public OAuth metadata of the 29 vendors in R17.4's survey; the client metadata documents of VS Code, Claude Code, Codex, goose, Cursor and MCPJam
- platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools; developers.openai.com/api/docs/guides/function-calling and /structured-outputs; github.com/openai/openai-openapi

**MCP client design (R18)**
- modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio and /server/tools; /specification/2025-11-25/basic/lifecycle
- github.com/modelcontextprotocol/modelcontextprotocol PR 2633 (SEP-2633, `mcp.json`)
- code.claude.com/docs/en/mcp; cursor.com/docs/context/mcp; code.visualstudio.com/docs/copilot/reference/mcp-configuration; learn.chatgpt.com/docs/extend/mcp
- github.com/openai/codex (`codex-rs/config`, `codex-rs/tools/src/json_schema.rs`); github.com/google-gemini/gemini-cli; github.com/anomalyco/opencode; github.com/aaif-goose/goose; github.com/charmbracelet/crush; github.com/zed-industries/zed; github.com/microsoft/vscode (`src/vs/platform/mcp`); github.com/badlogic/pi-mono; github.com/cline/cline
- `@modelcontextprotocol/client@2.4.0` and `@modelcontextprotocol/core@2.4.0`; the servers `@modelcontextprotocol/server-everything@2.1.0`, `server-filesystem@2.1.0`, `server-memory@2.0.1`, `server-sequential-thinking@2.0.0`, `@playwright/mcp@0.0.83`, `chrome-devtools-mcp@1.12.0`, `@upstash/context7-mcp@4.4.4`, `@azure/mcp@4.0.0-beta.4`, and `mcp-server-fetch`, `mcp-server-git` and `mcp-server-time`; the endpoints mcp.deepwiki.com/mcp, docs.mcp.cloudflare.com/mcp, learn.microsoft.com/api/mcp, mcp.context7.com/mcp and huggingface.co/mcp
- developers.openai.com/api/docs/guides/structured-outputs and /function-calling; github.com/openai/openai-python `src/openai/lib/_pydantic.py`; github.com/anthropics/claude-code issue 56174; github.com/mark3labs/mcphost PR 90
- `js-tiktoken@1.0.21`; `openai-harmony` 0.0.8; `bun-types@1.4.4`; the `oven/bun:1.4.4` and `node:26.13.0-slim` Docker images
