# Brief: Self-hosted scheduled agent runner

> Input for a spec. Decisions below are settled unless marked **open**. Your job: turn this into a full spec (architecture, package layout, data model, interfaces, milestones). Push back where a decision looks wrong; don't silently change it.

> **Revision 2, 2026-10-11.** Updated with the research done on 2026-10-11 and a first round of analysis. How to read it:
> - **Part 1** is the original brief, word for word. Lines marked **▸** are pointers added in this revision; no original line was changed.
> - **Part 2** is the research, with sources and confidence: **[H]** high, **[M]** medium, **[L]** low or unconfirmed, **[K]** background knowledge not re-checked in this pass. Several findings are newer than Claude's training data and rest on the cited sources alone.
> - **Part 3** challenges settled decisions. Each one is a **proposal awaiting a decision**. None has been applied.
> - **Part 4** is a draft design that assumes the recommended options. It changes if a decision goes the other way.
> - **Part 5** is the log of decisions, open questions and spikes, to work through one step at a time.

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

▸ **Research status of the settled decisions.** No decision has been changed. Challenges are in Part 3.

| Area | Status after research |
|---|---|
| Language/runtime | Holds. Bun 1.4.3 is current (2026-10-10). It now has built-in cron, both in-process and OS-level (R8), which matters for the scheduler choice (D6). |
| Database | Holds. Everything the scheduler needs is reachable from TypeORM: `FOR UPDATE SKIP LOCKED`, partial unique indexes, `jsonb` and native `vector` columns (R6.3). |
| ORM | Holds, with conditions. TypeORM 1.1.2 is healthy, but its CI doesn't run on Bun, and there are five sharp edges under Bun (R6.2). See C7 and spike S1. |
| LLM client | Holds. The `openai` SDK covers the Responses API natively. The separate Known-risks line "stick to mainstream chat-completions" does not hold (C1). |
| Models | Holds. New: a Plus or Pro ChatGPT subscription can now pay for your own calls through "Sign in with ChatGPT", with conditions (R1.2, C2). |
| Deployment and isolation | Holds. On macOS, LM Studio has to run on the host, outside compose (R9). Where the boundary sits: C3. |
| Repo | Holds. Proposal: one `core` package with subpath exports rather than one package per library (D10). |

## Layering

**1. Core libraries (open source, unopinionated)**
- Pure, stateless functions you ask to do one thing. Data in, data out.
- No persistence, no scheduling, no I/O opinions, no infrastructure dependencies.
- No "engine" object that owns a loop and calls back into injected adapters. **No DI, no persistence interfaces.** The caller orchestrates.
- Candidate libraries (spec should refine): build tool schemas from skills, run one model turn, extract tool calls from a response, format tool results back into messages, compaction (history to compacted history), message ordering for cache-friendly prefixes.

▸ Refined list with signatures: 4.3. "Run one model turn" is the only candidate that does I/O, through a client the caller passes in. The loop's *policy* can still be a pure function (`nextStep`), with the caller's `while` loop doing the I/O.

**2. App (also in the public repo, deliberately opinionated)**
- Postgres + TypeORM, scheduler, orchestration loop, skill loading, logging.
- Makes no apology for its choices and doesn't abstract them away.

**Privacy model: public code, private data.**
Everything private (secrets, client specifics, my own skills and task definitions) lives in persistence and config, never in source. So the whole repo is publishable.
- Enforce this mechanically, not by vigilance: secret scanning on commit, config schema validation at boot.

▸ Proposed shape: a private git repo mounted into the containers (tasks, skills, env), alongside the public repo (4.2 and 4.9). Secret scanning with gitleaks in pre-commit and CI, plus GitHub push protection (M6).

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

▸ Pointers per component:
- **1. Scheduler.** Proposal: an in-process tick driven by the DB (4.8, D6). Task definitions: C6 and D5.
- **2. Agent loop.** Draft in 4.5. Budgets beyond the iteration cap: C8. Narration handling: C9, plus LM Studio's own markers (R5.2).
- **3. Skills.** The SKILL.md spec has no typed tools (R7), so C4 proposes a different split. Storage: on disk (4.7).
- **4. Base tools.** Where they execute: C3. Process-group kill and output caps under `Bun.spawn`: R8.
- **5. Persistence.** One row per history item instead of one `jsonb` array per run (C11). Entity draft: 4.4.
- **6. Run log.** Keep it out of the agent's reach with C3 plus an INSERT-only DB grant (4.4).
- **7. Compaction.** Compaction and caching do fight unless compaction is rare and chunky (C5).
- **8. Prompt caching.** Caching now differs by OpenAI model generation as well as by backend (R3, R5.3). Request layout: 4.6.

## Known risks to address in the spec

- **TypeORM runtime type gap:** queries that typecheck but fail at runtime. Mitigate with conventions and tests.
- **TypeORM on Bun:** verify decorators, `reflect-metadata`, and migrations work cleanly under Bun before committing. Have a fallback plan if not.
- **OpenAI-compatible is ~95% compatible:** stick to mainstream chat-completions plus tool-calling. Verify LM Studio supports exactly what the loop uses.
- **OpenAI subscription for API calls:** confirm the auth mechanism and its limits before relying on it.
- **Scope creep:** the harness stays small. The failure mode is slowly reimplementing LangChain badly.

▸ **Risk status after research:**

| Risk | What the research found | Where it goes |
|---|---|---|
| TypeORM runtime type gap | 1.0 now throws on `null`/`undefined` in a find `where` (R6.1). In 0.3.x those were silently dropped and could match every row (R9). What remains: Bun's metadata ignores `strictNullChecks`; raw SQL strings in partial-index predicates aren't diffed; `jsonb` payloads are unchecked. | C7 conventions, integration tests against real Postgres |
| TypeORM on Bun | Works with legacy decorators. Not in TypeORM's CI. Five sharp edges, all verified on Bun 1.4.3 (R6.2). | C7, S1, fallback ladder D13 |
| OpenAI compatibility | The premise has shifted. On OpenAI, Chat Completions can't call tools on GPT-5.4+ unless reasoning effort is `none` (R2.2). LM Studio serves `/v1/responses` (R5.1). | C1, D1, S2, S3 |
| OpenAI subscription | No ChatGPT plan includes Platform API credits (R1.1). "Sign in with ChatGPT" (2026-09-29) is the official route for Plus and Pro, over Responses only, with constraints. Eligibility for a personal unattended runner is unclear (R1.2). | C2, D2, S4, Q4, Q9 |
| Scope creep | No research needed. | C10: a "won't build" list and a size budget |

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

▸ Drafts: 1 → 4.2, 2 → 4.3, 3 → 4.4, 4 → 4.5, 5 → 4.7, 6 → 4.8, 7 → 4.9, 8 → 4.10. Item 9 is Part 3 plus Part 5. Every draft depends on the open decisions in Part 5.

---

# Part 2: Research (2026-10-11)

**Method.** Three research passes on 2026-10-11, covering OpenAI, LM Studio, and TypeORM/Bun/Agent Skills.
- **Sources:** official docs, changelogs, GitHub releases and issues, npm metadata.
- **Local checks** on Bun 1.4.3 (macOS): transpiler output and spawn behaviour.
- **OpenAI docs:** the pages carry no dates and were fetched on 2026-10-11. help.openai.com and openai.com block fetchers, so those were read through search snippets only.
- **Shorthand:**
  - **OAI** = developers.openai.com
  - **LMS docs** = lmstudio.ai/docs (source: github.com/lmstudio-ai/docs, last commit 2026-10-08)
  - **LMS CL x** = lmstudio.ai/changelog/lmstudio/lmstudio-vx
  - **LMS BT#n** = github.com/lmstudio-ai/lmstudio-bug-tracker/issues/n

## R1. OpenAI: what a subscription can pay for

**R1.1 No ChatGPT plan includes Platform API credits.** API usage is billed separately, pay-per-token. **[H]** (help.openai.com/en/articles/8156019)

**R1.2 Sign in with ChatGPT (SIWC), "ChatGPT plan usage" from your own code.**
- **Launch:** announced at OpenAI DevDay on 2026-09-29, reported by WorkOS (2026-10-01) and The Star (2026-10-04). It is the official, non-Codex way to spend a Plus or Pro plan from your own code.
- **Confidence:** **[H]** on the mechanics, **[M]** on who qualifies.
- **Sources:** OAI /siwc/token-sharing-open-source and its sub-pages /sign-in, /models-and-inference, /preview-limitations, /token-reference, /errors-and-recovery; help.openai.com/en/articles/20001542.

**Eligibility**
- Plus and Pro only, so Business is out.
- Plan usage is "available to all open-source partners and selected private clients". The docs are written for "open-source and locally hosted apps".
- Paid or remotely hosted apps go through an interest form.

**Auth**
- OAuth with PKCE (S256), with a loopback callback at `http://127.0.0.1:<port>/auth/callback`.
- Apps register themselves with `client_id=dynamic_agent_client` plus an `ext_agent_host_id`; there is no client secret.
- Scopes: `offline_access resource.invoke chatgpt.tokens.use.direct`.
- Access tokens last 1 hour. Refresh tokens last 30 days and **rotate on every refresh**, so refreshes must be serialised.
- To refresh, `POST auth.openai.com/api/accounts/oauth/token` with `resource=https://api.openai.com/v1`.
- There is a documented procedure for moving the credentials to a self-hosted VM.

**Endpoint**
- `POST https://api.openai.com/v1/responses` only.
- The official SDK works with the OAuth access token passed as the API key, and `maxRetries: 0`.
- The docs say verbatim: "do not point it at ChatGPT's `backend-api` endpoints."

**Request constraints**
- `store:false` and `stream:true` are required.
- `role:"system"` items are rejected; use `instructions` or developer messages instead.
- Omit `temperature`, `top_p`, `max_output_tokens`, `metadata`, `truncation`, `prompt_cache_retention`, `user` and `background`.
- `previous_response_id` isn't available over HTTP, so the full input is replayed every turn.
- Hosted tools are unavailable: file search, Code Interpreter, image generation, hosted MCP, `tool_search`.
- Function tools must be grouped "in namespaces or supply them through `additional_tools` input items".

**Limits**
- Requests draw on the plan's ChatGPT/Codex allowance.
- Plus has a 5-hour window shared across all connected apps. Pro has no 5-hour limit.
- Users can set a weekly cap per app.
- At the limit the API returns HTTP 429 `subscription_sharing_usage_limit_exceeded`. Billing never silently switches to the API.

**Not addressed in the docs:** whether a closed-source personal runner counts as "open-source", and whether unattended scheduled runs are allowed.

**R1.3 Codex "Sign in with ChatGPT".** **[H]** (learn.chatgpt.com/docs/auth, learn.chatgpt.com/docs/auth/ci-cd-auth)
- Codex CLI, SDK and app-server officially run on plan usage, but the docs say "API keys are still the recommended default for automation".
- The ChatGPT `auth.json` may be used on "trusted private" CI runners: one file per runner, never shared between concurrent jobs. Codex refreshes it when it is more than about 8 days old.
- Enterprise admins can issue Codex access tokens "for trusted scripts, schedulers, and private CI runners".
- Codex app-server can run on a SIWC token through a custom provider with `wire_api="responses"`.

**R1.4 The unofficial route: the Codex backend.** **[M]**
- **Status:** some apps call `chatgpt.com/backend-api/codex/responses` directly with Codex OAuth tokens. OpenAI never published a contract for that endpoint, and its new docs steer apps away from it. No explicit terms-of-service ban and no enforcement reports were found. The research reads it as tolerated but unsupported, and now superseded by SIWC.
- **Constraints (community reverse-engineering):** `store:false`, streaming, replaying encrypted reasoning, Codex's own prompt in `instructions`, and Codex's 5-hour and weekly windows.

**R1.5 Third-party harness timeline.**
- **2026-01-09 (approximately):** Anthropic blocked third-party harnesses from using Claude subscriptions, server-side (secondary sources). **[M]**
- **2026-01-10:**
  - OpenCode v1.1.11 added "Codex authentication support" (GitHub release notes). **[H]**
  - Tibo Sottiaux of OpenAI posted that OpenAI was "working with OpenCode" so Codex subscriptions would work there. This was seen through a second-hand mirror; the original post wasn't opened. **[M]**
- **2026-09-30:** Tibo Sottiaux posted "You can now use your ChatGPT subscription directly in over 60 partners products… Devin, OpenCode, Lovable" (seen through an X mirror only). **[M]**
- The help centre lists OpenCode, OpenClaw, Pi and T3 as open-source examples.

## R2. OpenAI: Chat Completions vs Responses

**R2.1 Status.** "While Chat Completions remains supported, Responses is recommended for all new projects." Chat Completions is not deprecated and has no entry on the deprecations page. **[H]** (OAI /api/docs/guides/migrate-to-responses, /api/docs/deprecations)

**R2.2 Tool calling is restricted on Chat Completions (2026).** **[H]** that the restrictions exist; the docs disagree on details.
- Migration guide: "Starting with GPT-5.4, Chat Completions does not support tool calling with `reasoning_effort` values other than `none`."
- Reasoning guide: "Chat Completions does not support function calling with GPT-6 Astra or GPT-6.1 Sol."
- gpt-6.1-sol model page: "Chat Completions is supported without tool calling."
- Inconsistency: the gpt-6-astra model page still lists function calling as supported.

**R2.3 Reasoning across turns.** "In Chat Completions, reasoning is dropped between calls" (OAI /blog/responses-api).

**R2.4 Stateless pattern.** Set `store:false` and replay every reasoning item. New in 2026: `encrypted_content` is returned by default. The old `include:["reasoning.encrypted_content"]` is still accepted but no longer needed (OAI /api/docs/guides/reasoning).

**R2.5 Published claims for Responses over Chat Completions.**
- Cache utilisation: "40% to 80% improvement when compared to Chat Completions in internal tests". The archived cookbook words it as going "from 40% to 80%".
- "3% improvement in SWE-bench".
- The blog adds "5% better on TAUBench".

**R2.6 Assistants API.** "Officially sunset on August 26, 2026, and is no longer available." The deprecation was announced on 2025-08-26.

## R3. OpenAI: prompt caching

Sources: OAI /api/docs/guides/prompt-caching, and the types in openai-node 7.32.0.

**R3.1 GPT-5.6 and later.**
- Minimum 1,024 visible input tokens.
- One implicit breakpoint at the end of the latest message, plus explicit `prompt_cache_breakpoint` markers on content blocks (up to 4 cache writes per request).
- Configured with `prompt_cache_options {mode: implicit|explicit, ttl: "30m"}`. 30m is the only value and the default, and each reuse refreshes it.
- **Cache writes cost 1.25× the input price.** Reads cost 0.1× (0.05× on GPT-6.1 Sol).
- `prompt_cache_retention` is deprecated. `prompt_cache_key` is optional and only separates cache accounting, because routing is automatic.

**R3.2 Earlier models.**
- The minimum "varies by request settings".
- Breakpoints fall at model-dependent intervals (every 2,048 tokens on GPT-5.5), and `cached_tokens` is rounded down to a multiple of 128.
- `prompt_cache_retention` is `in_memory` (5–10 minutes idle, up to 1 hour) or `24h`. **The default is now `24h` for organisations without zero data retention (ZDR).**
- `24h` is supported on gpt-5.5 and 5.5-pro (which accept only `24h`), 5.4, 5.2, the 5.1 family, 5, 5-codex and 4.1.
- No charge for cache writes. `prompt_cache_key` is a routing hint; keep each key to about 15 requests per minute.

**R3.3 Usage reporting.**
- Responses: `usage.input_tokens_details.cached_tokens` and `cache_write_tokens`.
- Chat Completions: `usage.prompt_tokens_details.cached_tokens` and `cache_write_tokens`.
- The discount on cached input is "up to 95%". Cached tokens still count toward tokens-per-minute limits.

**R3.4 What breaks the cache.** Changing the model, the tools (any edit or reordering), `parallel_tool_calls`, `text.format`, `reasoning.effort`, verbosity, or compaction. The guide recommends `tool_choice:"none"` or `allowed_tools` over removing tools. That suggests changing `tool_choice` keeps the cache, but the guide doesn't say so outright.

**R3.5 Under SIWC,** `prompt_cache_retention` must be omitted (R1.2).

## R4. OpenAI: skills

OpenAI has adopted SKILL.md.
- **Codex** (learn.chatgpt.com/docs/build-skills):
  - A skill is a `SKILL.md` with `name` and `description`, and the docs say it will "build on the open agent skills standard".
  - Codex finds skills in `.agents/skills`, `~/.agents/skills` and `/etc/codex/skills`, and loads the full instructions only when a skill is used.
  - It arrived in Codex and ChatGPT around December 2025 (Simon Willison, 2025-12-12 and 2025-12-20).
- **API** (OAI /api/docs/guides/tools-skills):
  - Described as "compatible with the open Agent Skills standard".
  - Upload skills with `POST /v1/skills` or send them inline. Attach them through the shell tool's `environment.skills`: `skill_reference` for hosted containers, or name, description and path for a local shell.
  - Responses API only. It was live by 2026-02-11 (Willison).
  - This is OpenAI-hosted machinery. LM Studio offers only function tools, so using it would split the code path (C4).

## R5. LM Studio (latest release 0.4.26, 2026-10-08)

**R5.1 Endpoints.** **[H]**
- **OpenAI-compatible** (LMS docs /developer/openai-compat, LMS CL 0.4.26):
  - `GET /v1/models`.
  - `POST /v1/chat/completions`, `/v1/responses`, `/v1/embeddings` and `/v1/completions` (legacy).
  - `POST /v1/decisions` (0.4.26; needs a "decision model").
- **Anthropic-compatible:** `POST /v1/messages` since 0.4.1 (2026-01-30).
- **`/v1/responses`** arrived in **0.3.29 (2025-10-06)**.
  - It supports function tools, SSE streaming, `reasoning.effort`, `previous_response_id`, and remote MCP if you opt in.
  - 0.3.39 (2026-01-15) made it Open Responses compliant (lmstudio.ai/blog/lmstudio-v0.3.29, /blog/openresponses).
  - **Stateless use works.** The docs' comparison table allows assistant messages in the request. Codex `--oss` is an officially supported client and uses this endpoint, so full client-held history works.
- **Native REST:** `/api/v1/{chat, models, models/load, models/unload, models/download[/status]}` has been official since **0.4.0 (2026-01-28)**. The old `/api/v0/*` is still documented. Only `/api/v1/chat` lets you set `context_length` per request (LMS docs /developer/rest).

**R5.2 Tool calling on `/v1/chat/completions`.** **[H]**
- **`tool_choice`:**
  - `"auto"`, `"none"` and `"required"` work since 0.3.15. The changelog says `"required"` works on the llama.cpp engine only.
  - A named-function object is rejected with HTTP 400: `Invalid tool_choice type: 'object'. Supported string values: none, auto, required` (LMS BT#670, still open; last report April 2026).
- **Streaming:**
  - Tool calls arrive as OpenAI-style `delta.tool_calls` chunks: id and name first, then argument fragments.
  - Arguments stream as they are generated (0.3.17). Parallel-call streaming was fixed in 0.3.18 and 0.3.19.
  - `finish_reason` is `"tool_calls"` in both streaming and non-streaming responses.
- **Native parsing.** A model counts as native when its chat template supports tools and LM Studio knows its output format; LM Studio then parses the calls into `tool_calls`. Formats added over time:
  - Qwen/Hermes `<tool_call>`, Llama 3.1/3.2, Mistral;
  - gpt-oss Harmony, which also gets a constrained tool-call grammar on llama.cpp since 0.4.7;
  - Qwen3-Coder/3.5 XML-style, GLM, MiniMax M2, Seed-OSS, Nemotron, LFM2, Gemma 4.
- **Default (prompt-based) parsing** for every other model:
  - LM Studio injects a system prompt using `[TOOL_REQUEST]{json}[END_TOOL_REQUEST]`.
  - `tool`-role messages are rewritten as `user`.
  - Tool names are converted to snake_case before the model sees them (0.3.23).
- **Malformed calls.** The docs say: "If LM Studio cannot parse any correctly formatted tool calls, it will simply return the response to the standard `message.content` field." No `finish_reason` is documented for that case. The docs' list of native models is out of date (LMS docs /developer/openai-compat/tools).
- **Flags:** `parallel_tool_calls` is not documented. The server log says `strict` is "not yet supported and will be ignored" (LMS BT#2257, August 2026).

**R5.3 Prompt/KV caching.**
- **Reporting [H].** Reuse of a shared prefix is on by default.
  - `/v1/responses` reports `usage.input_tokens_details.cached_tokens` (blog/openresponses).
  - `/v1/chat/completions` does **not** return `prompt_tokens_details.cached_tokens` (LMS BT#2390 and BT#2419, both open, September 2026). Cache hits there show up only in debug logs (`lms log stream`).
- **MLX [H].** mlx-engine 1.8.5 (lmstudio.ai/blog/mlx-engine-agentic-workloads, 2026-06-05) added a disk-backed cache:
  - It saves the KV cache in 256-token chunks keyed by their content and evicts the least recently used.
  - It restores the longest cached prefix across requests, including other conversations that share the same system prompt.
  - It deletes its temp file when the model unloads.
  - Text-only models got this in mlx-engine PR #352 (2026-07-24). Models with a quantised KV cache or speculative decoding are excluded.
  - An `enable_disk_cache` load option was added in PR #369 (2026-08-21).
- **llama.cpp [M].**
  - 0.4.15 fixed the cache being dropped on every message.
  - A new engine layer, "LM Studio Engine Protocol", has been on by default since 0.4.19. Users' logs show upstream llama-server behaviour (LMS BT#2086, BT#2257):
    - each request goes to the slot whose cached prompt shares the longest prefix with it;
    - there is an 8 GiB prompt cache in host RAM (`--cache-ram`), changeable only through the advanced llama.cpp argument overrides added in 0.4.24.
- **`previous_response_id` [M].** 0.4.17 (2026-06-26) fixed chained responses re-processing an ever-growing prompt. LMS BT#2074 is still open, labelled fixed-in-next-update.

**R5.4 Concurrency.** **[H]**
- **llama.cpp:** continuous batching since 0.4.0 (lmstudio.ai/blog/0.4.0), controlled by two load options:
  - **Max Concurrent Predictions** (default 4; requests beyond that are queued);
  - **Unified KV Cache** (default on; all requests share one KV budget instead of fixed slices).
- **Setting it:** `lms load --parallel N` (0.4.1), or the `parallel` field on `/api/v1/models/load` (0.4.7).
- **MLX:** batching for text models since 0.4.2 (2026-02-06), and for vision models since 0.4.13 (2026-05-13). The docs page still says "MLX coming soon", which is out of date.

**R5.5 Headless operation and JIT loading.** **[H]**
- **llmster, the headless daemon (0.4.0):**
  - Install with `curl -fsSL https://lmstudio.ai/install.sh | bash` (Linux and Mac), then run `lms daemon up` and `lms server start [--port --bind --cors]`.
  - The docs give a systemd startup guide for Linux only; there is nothing for macOS launchd.
- **Desktop-app alternative:** the "run LLM server on login" setting keeps the server running from the tray after the window closes. The last server state is restored on launch, and any `lms` command wakes the service.
- **JIT loading** (on by default):
  - A request naming a downloaded model that isn't loaded makes LM Studio load it, and the request waits.
  - OpenAI-compatible endpoints send no load-progress events, and `/v1/models` lists every downloaded model.
  - JIT-loaded models unload after 60 minutes idle by default. A `ttl` field in the request body changes that per request.
  - Auto-Evict (on by default) keeps at most one JIT-loaded model. Models you loaded manually are not touched.
  - Models loaded with `lms load` never expire unless you pass `--ttl`. With JIT off, you must load the model first.
  - Sources: LMS docs /developer/core/headless, /developer/core/ttl-and-auto-evict.
- **Default context length: 8k since 0.4.16.** Preload with an explicit `--context-length`.

**R5.6 Auth.** **[H]**
- API tokens arrived in 0.4.0 and are **off by default**. Turn on "Require Authentication" in Server Settings and create tokens (with permissions) in the GUI.
- Clients send `Authorization: Bearer <token>`; the Anthropic endpoint also accepts `x-api-key`. In the `openai` SDK, set `apiKey` to the token; with auth off, any non-empty string works (LMS docs /developer/core/authentication).
- There is no command-line way to enable auth or create tokens (lmstudio-ai/lms#489, open), so it needs one GUI step.
- The server binds to 127.0.0.1 by default.

**R5.7 Unconfirmed: user reports without staff confirmation.** **[L]**
- **`tool_choice:"required"`:** can return empty content with `finish_reason:"stop"` (LMS BT#1904), or tool-call text inside `content` (LMS BT#2115, 0.4.18).
- **`/v1/responses` problems:**
  - It can return HTTP 500 "Failed to parse tool call" instead of falling back to text (LMS BT#2224, July 2026).
  - The `instructions` field is reportedly ignored (LMS BT#1154).
- **`parallel_tool_calls:false`:** not enforced (LMS BT#1756).
- **Cache under concurrency:**
  - Concurrent MLX requests may invalidate each other's cache (LMS BT#2320, August 2026).
  - Processing a new prompt pauses MLX generations already running (LMS BT#1709).
  - For llama.cpp, it is *inferred* from upstream llama-server, not from LM Studio docs, that up to N concurrent conversations keep their cache (one slot each, plus the RAM cache).
- **Load and reload:**
  - When the shared KV cache is full, concurrent requests fail instead of queueing (LMS BT#1628).
  - JIT and TTL reloads reset Max Concurrent Predictions to 4 (LMS BT#1714, BT#2061).
- **Docker:** `host.docker.internal` from Docker Desktop on macOS should reach a host service bound only to 127.0.0.1. Test it with curl. If it doesn't work, bind to 0.0.0.0 and turn on auth.

**R5.8 What the LM Studio research pass recommended, taken on its own:**
- Use `/v1/chat/completions` and keep the history in the runner, because it is the most mature path and prefix caching works there.
- Preload with `lms load … --context-length --parallel` rather than relying on JIT defaults.
- When `content` contains tool-call markers but `tool_calls` is empty, treat it as a failed call and retry.

That recommendation was made without the OpenAI findings. C1 weighs both.

## R6. TypeORM

**R6.1 Status.** **[H]**
- **Latest is 1.1.2 (2026-10-08).** 1.0.0 shipped on 2026-05-19, 1.1.0 on 2026-07-13 and 1.1.1 on 2026-09-01. The 0.3.x line is still maintained under the npm `legacy` tag (0.3.31, 2026-07-13).
- **Breaking changes in 1.0:**
  - Only `DataSource` remains; `Connection` and the global helpers are gone.
  - `relations` and `select` must use object syntax.
  - Removed: `findByIds`, `findOneById`, `exist()`, `@EntityRepository`, `getCustomRepository`, `TYPEORM_*` env loading, and the lock modes `pessimistic_partial_write` and `pessimistic_write_or_fail`.
  - **`null`/`undefined` in a find `where` now throws.**
  - Non-nullable `ManyToOne` relations now load with INNER JOIN.
  - Requires Node 20+ and targets ES2023. Drivers are narrowed to mysql2 and better-sqlite3 (as reported by the research pass; Postgres via `pg` is unaffected, see R6.2).
  - A codemod exists: `npx @typeorm/codemod v1 src/`.
- **ESM:** still CommonJS internally, with a thin `index.mjs` wrapper and no `"type":"module"`. `reflect-metadata` is now a dependency, imported by the entry point.
- **Decorators:**
  - Only legacy `experimentalDecorators` plus `emitDecoratorMetadata` work. Standard TC39 decorators are not supported.
  - Issue #9862 is still open. On 2026-07-08 a maintainer said it needs a package split, and that "driver and platform support" comes first.
  - The alternative is EntitySchema.
- **Maintenance health:**
  - Vendure's parent company Elevantiq took over ("The Future of TypeORM", 2024-10-01).
  - Releases resumed with 0.3.21 on 2025-03-03.
  - In 2025: 8 releases, 575 PRs merged (versus 63 the year before), over 2,300 issues closed.
- **Sources:** typeorm.io/blog/typeorm-1-0, typeorm.io/docs/releases/1.0/release-notes/, github.com/typeorm/typeorm/releases, github.com/typeorm/typeorm/issues/9862, typeorm.io/blog/future-of-typeorm.

**R6.2 TypeORM on Bun** (latest Bun is 1.4.3, 2026-10-10).
- **No official support [H].** TypeORM's CI tests Node 20 and 24 only. Its docs mention Bun once, about binary data being `Uint8Array`.
- **Decorators [H]:**
  - `emitDecoratorMetadata` has worked since Bun 1.0.3 (2023-09-22).
  - Bun issue #4136 re-tested a TypeORM repro and was closed as working (2026-07-29).
  - **Since Bun 1.3.10 (2026-02-26), if Bun doesn't see `experimentalDecorators` it compiles standard decorators instead, which breaks TypeORM.**
- **Gotchas, verified on 1.4.3 [H]:**
  1. **tsconfig `extends`.** Extending a package (for example `"extends": "@tsconfig/bun"`) silently drops both decorator flags. This is open Bun issue #6326; its fix PR was closed unmerged. Put both flags directly in the app's own `tsconfig.json`.
  2. **"Cannot access before initialization".** For `author: User`, Bun emits `typeof User === "undefined" ? Object : User`, which throws `ReferenceError: Cannot access uninitialized variable` with circular imports (Bun #7591, open). The fix is to type relation properties as `Relation<User>`, as TypeORM's ESM FAQ describes.
  3. **Import `Relation` as a type.** Use `import type { Relation }` or `import { type Relation }`. A plain value import is kept by Bun and fails with `SyntaxError: Export named 'Relation' not found` (Bun #20994). The same applies to any interface used as a decorated property's type (Bun #6172; fix PR #35471 is still open).
  4. **Nullable columns.** Bun's metadata ignores `strictNullChecks` (Bun #44120), so always give columns an explicit `type`.
- **CLI and migrations [M].**
  - `cli.js` starts with a `node` shebang, so plain `bunx typeorm` runs under Node.
  - Use `bunx --bun typeorm migration:run -d src/data-source.ts`, or `bun ./node_modules/typeorm/cli.js …`. The CLI loads `.ts` files with `import()` or `require()`, which Bun handles natively.
  - TypeORM's docs only describe ts-node. The Bun route comes from a community comment on #9738 (2025-07-02).
- **`pg` driver [M].** Pure-JS `pg` 8.23.1 is commonly used on Bun, and the old Bun crash issues are closed. `pg-native` does not work on Bun.
- **Bundling [M].** Building with `--minify` breaks the app (open issue #14888), likely because table and migration names come from class names. Give entities and migrations explicit names, or don't minify identifiers.
- **Sources:** bun.com/blog/bun-v1.0.3, bun.com/blog/bun-v1.3.10, github.com/oven-sh/bun/issues/6326, /7591, /20994, typeorm.io/docs/help/faq/#how-to-use-typeorm-in-esm-projects, github.com/typeorm/typeorm/issues/9738.

**R6.3 Postgres features for a job scheduler.** **[H]**
- **SKIP LOCKED.**
  - `.setLock("pessimistic_write").setOnLocked("skip_locked")` produces `FOR UPDATE SKIP LOCKED`.
  - `setLock(mode, undefined, ["alias"])` produces `FOR UPDATE OF …`; use it when the query has outer joins.
  - Find options also accept `lock: { mode, onLocked }`.
  - `getMany`/`getOne` throw `PessimisticLockTransactionRequiredError` outside a transaction.
- **Partial unique indexes.**
  - `@Index([...], { unique: true, where: '"status" = \'queued\'' })` takes a raw SQL string; quote camelCase column names.
  - Schema diffing never compares the predicate itself. Auto-generated index names hash the `where`, so a change shows up as drop and create. With an explicit index name, edits to the predicate are **not** detected.
  - For upserts against a partial index, use `orUpdate(cols, conflictCols, { indexPredicate })`.
  - The 1.0 release notes call PR #11318 "partial index support", but it actually adds `@Index({ type: "gin" | "brin" | "hash" | … })`.
- **`jsonb`:** long supported.
- **pgvector:** native `vector` and `halfvec` column types since 0.3.27 (2025-09-19, PR #11437).
  - Declare as `@Column("vector", { length: 1536 }) embedding: number[]`; values come back as `number[]`.
  - TypeORM runs `CREATE EXTENSION IF NOT EXISTS "vector"` when the DataSource starts, and only warns if it lacks rights.
  - There is no HNSW or IVFFlat index type. Create those in a migration and mark them `@Index("name", { synchronize: false })`.
  - Write similarity queries in raw SQL with the operators `<->`, `<=>` and `<#>`.
- **Sources:** github.com/typeorm/typeorm docs (query-builder/1-select-query-builder.md, entity/1-entities.md), PR #11437, issue #10118.

**R6.4 Unconfirmed.** **[L]**
- TypeORM has made no official statement about Bun, and its CI doesn't test the CLI under Bun.
- Whether `pg` is stable on Bun under heavy load: there is no TypeORM or node-postgres test coverage on Bun.
- Whether TypeScript 7 (7.0.2, 2026-07-08) type-checks `emitDecoratorMetadata` code the same way 6.x did. This affects type-checking only, since Bun does its own transpiling.

## R7. Agent Skills (SKILL.md)

- **Origin [H].** Anthropic released it as an open standard on 2025-12-18. The spec lives in the `agentskills/agentskills` repo, was last edited on 2026-08-04, and has no version number.
- **Frontmatter [H].**
  - `name` is required: 1–64 characters of `a-z`, `0-9` and `-`, with no leading, trailing or double hyphens. It must match the directory name.
  - `description` is required: 1–1024 characters.
  - Optional fields: `license`, `compatibility` (up to 500 characters), `metadata` (a string-to-string map), and `allowed-tools` (space-separated, marked experimental).
- **Directory layout [H].** `SKILL.md`, plus optional `scripts/`, `references/` and `assets/`. References should be relative and one level deep.
- **Progressive disclosure [H].**
  - Only name and description (about 50–100 tokens) load at startup. The body loads on activation, and resources load on demand.
  - The client guide recommends scanning `<project>/.agents/skills` and `~/.agents/skills`, often also `.claude/skills`, with project-level skills overriding user-level ones.
  - Activation is either by reading the file, or through an `activate_skill` tool whose name parameter is an enum of skill names.
- **Adopters [H].** Claude and Claude Code, OpenAI Codex and ChatGPT, GitHub Copilot, VS Code, Cursor, Gemini CLI, JetBrains Junie, Amp, OpenCode, OpenHands, Goose, Roo Code, Kiro, Factory, Mistral Vibe, Databricks, Snowflake, Spring AI, and others.
- **Typed tools: the spec has none [H].** Skills are instructions plus scripts, and a script's interface is documented through `--help`, with JSON on stdout.
  - Claude Code adds its own fields (`arguments`, `context: fork`, `hooks` and others), but claude.ai and the Skills API reject unknown keys.
  - Codex keeps its extras in a separate `agents/openai.yaml` file (UI, invocation policy, MCP tool dependencies).
  - For portability, put typed schemas in a file alongside SKILL.md, as Codex does, or in `metadata`.
- **Sources:** agentskills.io/specification, agentskills.io/client-implementation/adding-skills-support, agentskills.io/skill-creation/using-scripts, code.claude.com/docs/en/skills, learn.chatgpt.com/docs/build-skills.

## R8. Bun: scheduling and process control

- **`Bun.cron` [H].**
  - **OS-level** (Bun 1.3.11, 2026-03-18): `await Bun.cron(path, expr, title)` registers with crontab, launchd or Task Scheduler, and the script exports `default.scheduled()`. `Bun.cron.parse` and `Bun.cron.remove` came in the same release.
  - **In-process** (Bun 1.3.12, 2026-04-09): `Bun.cron(expr, handler, { tz })` returns a `CronJob` with `stop`, `ref` and `unref`.
  - **Bun 1.4.0** changed the default timezone for in-process jobs and for `parse` from UTC to local time.
  - Only 5-field expressions are accepted; a seconds field is rejected (verified).
  - Runs never overlap: the next fire is scheduled after the handler settles.
  - An error thrown in the handler becomes an `uncaughtException`, and the process exits if nothing listens for it.
  - It schedules within one process only; it doesn't coordinate across instances.
- **croner 10.0.1 (2026-02-01) [H].** States it works on "Bun >=1.0.0" and runs a Bun CI job. Supports seconds and year fields, `timezone`, `protect` (prevents overlapping runs), `nextRuns` and `catch`.
- **`Bun.spawn` [H].** Options include `timeout`, `killSignal` (default SIGTERM), `signal`, `maxBuffer` and `detached` (which calls `setsid`). Tested on Bun 1.4.3 on macOS:
  - `timeout` kills only the direct child. Grandchildren started by `sh -c` survive.
  - `detached: true` followed by `process.kill(-proc.pid, "SIGKILL")` kills the whole process group.
  - `maxBuffer` works with the async API, but it kills the child rather than truncating, and the captured output overshot the limit by up to about 64 KB. For a hard cap, read the stream yourself and truncate.
  - `stderr` defaults to `"inherit"`; pass `"pipe"` to capture it.
- **Unconfirmed [L].** Whether `maxBuffer` counts stdout and stderr separately or together.
- **Sources:** bun.com/docs/runtime/cron, bun.com/blog/bun-v1.3.12, github.com/oven-sh/bun/pull/36461, github.com/Hexagon/croner, bun.com/docs/runtime/child-process, bun-types 1.4.3 `bun.d.ts`.

## R9. Background facts used in the analysis

These come from general knowledge and were **[K]** not re-checked in this research pass.

- **No Mac GPU in containers.** Docker Desktop on macOS gives containers no access to the Mac's Metal GPU. LM Studio therefore runs on the host, and containers reach it at `host.docker.internal`.
- **`jsonb` is never updated in place.** A Postgres UPDATE writes a new row version holding the whole value, re-TOASTed if it's large. Appending to an ever-growing `jsonb` array rewrites the whole history on every turn: O(n²) bytes written over a run.
- **TypeORM 0.3.x dropped `undefined` filters.** It silently removed `undefined` properties from a find `where`, so `findOneBy({ id: undefined })` matched an arbitrary row. 1.0's throw (R6.1) closes that hole.
- **Classic cron is awkward inside containers.** Jobs don't inherit the container's environment, output doesn't reach `docker logs` without redirection, and it needs PID-1 and supervisor handling.
- **No systemd on macOS.** systemd timers don't exist there; the equivalent is launchd.

---

# Part 3: Challenges to the brief

These are **proposals, not decisions**. Each links to a decision in Part 5. "Brief says" quotes or paraphrases Part 1.

### C1. Use the Responses API, not Chat Completions
- **Brief says:** "stick to mainstream chat-completions plus tool-calling" (Known risks).
- **Proposal:** make the Responses API the only wire format for every backend. Use it statelessly (`store:false`, replaying the full input including reasoning items) and always streamed.
- **Why:**
  - On OpenAI, Chat Completions can't call tools on GPT-5.4+ unless reasoning effort is `none`, and on some newer models it can't call tools at all (R2.2). It also drops reasoning between calls, which is exactly what a tool loop needs to keep (R2.3).
  - SIWC is Responses-only (R1.2).
  - LM Studio serves `/v1/responses` with function tools and client-held history (R5.1), and only that endpoint reports `cached_tokens` (R5.3).
  - Taken together, one Responses code path covers every backend, and Chat Completions doesn't.
- **Consequences:**
  - History becomes a list of Responses *items*: `message`, `function_call`, `function_call_output`, and `reasoning` with `encrypted_content`. They are stored verbatim.
  - `call_id` is the brief's "tagged with its tool-call ID".
  - Always stream. SIWC requires it, it keeps long local generations from hitting HTTP timeouts, and token flow doubles as a liveness heartbeat.
  - Reasoning items are tied to the model that produced them, so a run never switches model mid-history. Switching happens only between runs.
  - Put the preamble in a `developer`-role first item rather than in `instructions` or a `system` item. SIWC rejects `system` items, and LM Studio reportedly ignores `instructions` (R5.7). Confirm this in S2.
- **Consistent with the brief:** it is still the official `openai` SDK and still no provider abstraction, because the SDK covers Responses natively.
- **Risk:** LM Studio's Responses endpoint is less battle-tested. It reportedly returns HTTP 500 on unparseable tool calls instead of text (R5.7). Spike S2 covers it.
- **Decision:** D1.

### C2. OpenAI auth: API key first, SIWC behind a spike
- **Brief says:** "OpenAI subscription for API calls: confirm the auth mechanism and its limits before relying on it." Also: "Claude is out: a Claude subscription can't be used for API calls."
- **Finding:**
  - No ChatGPT plan includes API credits (R1.1).
  - Since 2026-09-29, SIWC officially lets Plus and Pro usage pay for calls from your own code (R1.2). That makes the Claude/OpenAI asymmetry in the Models row real.
- **Proposal:** model profiles get `auth: api_key | chatgpt`. Build the API-key path first. Treat SIWC as spike S4 and milestone M4.
- **Why it isn't the default yet:**
  - **Eligibility is unclear.** The docs target "open-source and locally hosted apps". This repo is public and runs locally, which plausibly fits. Whether unattended scheduled runs are allowed isn't addressed (R1.2, Q9).
  - **On Plus, usage is shared.** Runs compete with your own ChatGPT and Codex use in the 5-hour window. HTTP 429 `subscription_sharing_usage_limit_exceeded` must therefore be a first-class outcome: the run is **`deferred`**, not `failed` (Q4).
  - **Refresh tokens rotate on every refresh.** Two concurrent runs refreshing at once would log each other out, so refreshes are serialised with a row lock on the credential row (4.4).
  - **Client boxes will use API keys anyway.** They count as remotely hosted or paid deployments, which go through an interest form (R1.2).
  - **The login flow needs work in Docker.** OAuth uses a loopback callback on `127.0.0.1:<port>`, so the first login needs a `gremlin login` step run on the host or through a forwarded port. The refresh token then lives in the DB.
  - **Request shape differs.** SIWC needs `stream:true`, omits `temperature`, `max_output_tokens` and `prompt_cache_retention`, and wants function tools in namespaces or `additional_tools` (R1.2). The request builder takes these constraints from the model profile, so they stay config rather than a code path, except possibly the namespace rule, which S4 must check.
- **Decision:** D2.

### C3. Run the agent's shell in a separate workspace container
- **Brief says:** "Isolation is Docker: the container is the boundary, mounted volumes define what it can touch."
- **Problem:** if the shell runs inside the app container, the boundary encloses the agent *together with* what it shouldn't touch:
  - API keys and SIWC tokens, readable from the environment with `cat /proc/self/environ`;
  - Postgres, including its own run log, which turns "append-only" into an honour system;
  - the scheduler process.
- **Proposal:** a `workspace` container is the agent's world.
  - It has the toolbox image and the mounted volumes, but no secrets and no route to the database network.
  - The app talks to it over an internal network through a small exec server (around 100 lines: run a command, read a file, write a file).
  - There is still zero permission code. Docker just draws the line in the right place.
- **Bonuses:**
  - The workspace image is the agent's toolbox: install git, jq, Python and so on without bloating the app image.
  - The run log can also be protected with an INSERT-only DB grant (4.4).
  - Privileged "app tools", written by you and needing secrets, run in the app. Commands written by the model run in the workspace.
- **Cost:** one more image and a tiny RPC. The exec server has to handle process-group kill and output caps itself (R8).
- **Decision:** D3.

### C4. Skills are SKILL.md folders, not typed tools
- **Brief says:** "Self-describing units (JSON Schema plus handler), loaded from a registry … Ideally compatible in spirit with the SKILL.md convention."
- **Finding:** the SKILL.md spec has no typed tools. A skill is instructions plus scripts, and only the name and description are preloaded (R7). OpenAI has adopted the same standard (R4).
- **Proposal:** with shell and `read_file` as base tools, a SKILL.md skill needs **no new tools**.
  - `tools[]` stays at about four entries for good. Skills grow as a catalog in the preamble.
  - That removes the "too many tools degrade the model's choices" problem, and a `tools[]` that never changes is ideal for caching (R3.4).

| | Runs in | Defined as | Model sees |
|---|---|---|---|
| **Base tools** | workspace | app code: `shell`, `read_file`, `write_file` | always, in `tools[]` |
| **App tools** | app | TypeScript schema plus handler | per task, only things that need secrets or the DB (state, notify) |
| **Skills** | workspace | SKILL.md folder plus `scripts/` | catalog (name and description) in the preamble; body loaded via `activate_skill` |

- **Activation:**
  - Use `activate_skill(name)` with an enum of the task's skills, which the spec allows (R7).
  - Weak local models follow it more reliably than "read the file at this path", and every activation lands in the run log.
  - The skill body comes back as the tool's output, so it lands in the append-only history rather than the cached preamble.
- **Storage:** on disk. The scripts have to be files in the workspace anyway. The DB holds which skills each task uses, plus per-skill env and secrets.
- **Left open, not built:** typed skill tools declared in a sidecar file next to SKILL.md, as Codex does with `agents/openai.yaml` (R7), with handlers as workspace scripts.
- **Not used:** OpenAI's hosted shell-tool skills (R4). LM Studio only offers function tools, so they would split the code path.
- **Decision:** D4.

### C5. Compaction must be rare and chunky to coexist with caching
- **Brief says:** "Compaction only touches the middle, so the two don't fight."
- **Finding:**
  - Within a run, the whole append-only history is a cacheable prefix.
  - Compacting the middle invalidates everything after the first compacted item, which is everything except the preamble and the task.
  - OpenAI lists compaction as a cache-breaker (R3.4). On GPT-5.6+ every rebuild is a write billed at 1.25× (R3.1).
- **Proposal:**
  - One large compaction when the context passes a threshold (say 70%) costs one cache rebuild. A sliding window that trims a little every turn misses the cache every turn, which is the worst case.
  - `planCompaction` returns null until the threshold is reached, then compacts one large block.
  - For the same reason, a forced final answer uses `tool_choice:"none"` rather than removing tools (R3.4).
- **Decision:** D11.

### C6. Task definitions: DB canonical, authored as TASK.md files
- **Brief says:** "where task definitions live, presumably the DB."
- **Proposal:** the DB is the source of truth, but you author tasks as `TASK.md` files in a private git repo, and `gremlin apply ./tasks` upserts them.
  - The frontmatter holds schedule, timezone, model profile, skills, budgets, overlap and catch-up policy. The body is the prompt.
  - Every run stores a snapshot of the resolved definition.
- **Why:**
  - Prompts behave like code: you want diffs, history and your editor.
  - "What did the prompt say at 3am" gets a definite answer.
  - A future client UI can still edit the DB.
  - It mirrors SKILL.md in spirit.
- **Decision:** D5.

### C7. TypeORM on Bun: proceed with five conventions and a fallback ladder
- **Brief says:** verify decorators, `reflect-metadata` and migrations under Bun; have a fallback plan.
- **Proposal: proceed, with five conventions** (all verified on Bun 1.4.3, R6.2):
  1. **Decorator flags inline, plus a boot check.** Put `experimentalDecorators` and `emitDecoratorMetadata` **inline** in the app's own `tsconfig.json`, never inherited through `extends`. Add a boot self-check that fails fast if decorator metadata is missing, because Bun 1.3.10+ silently compiles TC39 decorators otherwise.
  2. **`Relation<T>` with `import type`.** Type every relation property as `Relation<T>`, and import `Relation` and any interface types used on decorated properties with `import type`.
  3. **Explicit column types.** Every `@Column` gets an explicit `type`, enforced by a lint rule, because Bun's metadata ignores `strictNullChecks`.
  4. **Migrations under Bun:** `bunx --bun typeorm migration:generate|run -d src/data-source.ts`.
  5. **Never minify**, and name entities and migrations explicitly.
- **Runtime type gap:**
  - 1.0's throw on `null`/`undefined` in a find `where` closes the worst hole (R6.1, R9).
  - The rest is covered by integration tests against a real Postgres for every repository method, especially the claim and lock queries.
  - Use explicit index names on partial indexes, with predicate changes written as hand-made migrations, because diffing won't catch them (R6.3).
- **Fallback ladder, if S1 fails:**
  1. **EntitySchema:** same ORM, no decorators, which removes the Bun-specific metadata risks.
  2. **Run the app on Node** and keep Bun for tooling.
- **Decision:** D13, triggered only if S1 fails.

### C8. Budgets, not only an iteration cap
- **Brief says:** "Hard cap on iterations."
- **Finding:** each iteration resends the whole history, so time and cost grow roughly quadratically with run length.
- **Proposal: keep the iteration cap and add budgets.**
  - **Budgets:**
    - cumulative input tokens, which is dollars on an API key or allowance on SIWC;
    - wall-clock time per run;
    - a timeout per tool call;
    - a stream-idle timeout per model call, which tells "slow local model" apart from "hung".
  - **When a budget trips,** make one last turn with `tool_choice:"none"` asking for "what I did and what remains". That becomes the run's output and seeds the next run's state, and the run's status is **`capped`**, not `failed`.
- **Check:** LM Studio supports `tool_choice:"none"` on Chat Completions (R5.2). Support on `/v1/responses` is unverified, so S2 checks it.
- **Decision:** D9.

### C9. Narration fallback: nudge, don't execute
- **Brief says:** "Graceful fallback when a weak local model narrates a tool call in prose."
- **Problem:** with unrestricted shell access, executing a command extracted from prose risks running something the model wrote as an *example*.
- **Proposal:**
  1. **Detect the narration.** Markers include LM Studio's own `[TOOL_REQUEST]…[END_TOOL_REQUEST]` (R5.2), `<tool_call>…</tool_call>`, or a lone JSON object with `name` and `arguments`.
  2. **Nudge.** Append "you described a tool call in text; emit it as a function call". Do this at most twice, then treat the text as the final answer.
  3. **Optional strict execute mode,** per model profile. It fires only when the entire content is exactly one valid call that passes schema validation.
  4. **Treat LM Studio's HTTP 500 the same way.** The reported 500 "Failed to parse tool call" on `/v1/responses` (R5.7) takes the nudge path.
- **Decision:** D8.

### C10. Fence the scope explicitly
- **Brief says:** "The failure mode is slowly reimplementing LangChain badly."
- **Proposal:** a written **"won't build"** list (4.11) and a soft size budget of about 1.5k lines for `core`. Crossing either needs an explicit decision.
- **Decision:** D10 covers packaging; the fence itself needs no decision unless you object.

### C11. Store history one row per item
- **Brief says:** "messages (history as `jsonb`)".
- **Proposal:** keep `jsonb`, but store one row per item, holding the verbatim Responses item as a `jsonb` payload, instead of one growing `jsonb` array per run.
- **Why:**
  - Appending to a `jsonb` array rewrites the whole value on every turn: O(n²) bytes over a run (R9).
  - Rows are append-only, like the run log.
  - Compaction can *mark* rows instead of deleting them, so the audit trail stays intact.
  - Full-text search over history becomes possible later.
- **Decision:** D7.

---

# Part 4: Draft design

This draft assumes the recommended option for every decision in Part 5. Anything marked with a decision ID changes if that decision goes the other way.

## 4.1 Architecture

```
                    docker compose (same artefact: your Mac, a client box)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │  ┌──────────────────────┐   net: data (internal)  ┌───────────────────┐   │
 │  │ app (Bun)            │◀───────────────────────▶│ postgres+pgvector │   │
 │  │ • scheduler tick     │                         └───────────────────┘   │
 │  │ • agent loop         │   net: exec (internal)  ┌───────────────────┐   │
 │  │ • app tools          │────────────────────────▶│ workspace    (D3) │   │
 │  │ • secrets, tokens    │   exec RPC: run/read/   │ • exec server     │   │
 │  └──────────┬───────────┘   write                 │ • git, jq, py…    │   │
 │             │                                     │ • NO secrets      │   │
 │             │                                     │ • NO route to db  │   │
 │             │                                     └─────────┬─────────┘   │
 └─────────────┼───────────────────────────────────────────────┼─────────────┘
               │ Responses API (stream, store:false)    (D1)   │ bind mounts
       ┌───────┴──────────┐                                    ▼
       ▼                  ▼                           ~/notes, ~/projects, skills/
 api.openai.com     LM Studio on the host (Metal GPU; can't run in a container on macOS)
 key | SIWC (D2)    host.docker.internal:1234
```

## 4.2 Monorepo layout

```
mecha-gremlin/                          public repo
├── package.json                        bun workspaces: ["packages/*"]
├── tsconfig.json                       decorator flags inline, no package `extends` (C7)
├── compose.yaml
├── packages/
│   ├── core/                           @mecha-gremlin/core: stateless functions, publishable;
│   │                                   deps: openai (types), one JSON Schema validator
│   ├── app/                            entities, migrations, scheduler, loop, app tools, CLI `gremlin`
│   └── workspace/                      exec server (~100 lines) + Dockerfile = the agent's toolbox
├── skills/                             public example skills (SKILL.md)
├── examples/tasks/                     example TASK.md files
└── openspec/

~/gremlin-private/                      private git repo, mounted, never in source
├── tasks/*.md                          TASK.md definitions (D5)
├── skills/<name>/SKILL.md              your own skills (D4)
└── gremlin.env                         secrets; validated at boot
```

`core` is one package with subpath exports (`@mecha-gremlin/core/turn`, `…/compaction`, and so on) rather than six micro-packages (D10). The app imports `core` only through its public exports, so the boundary stays real.

## 4.3 Core library (signatures)

```ts
// @mecha-gremlin/core: stateless; data in, data out.
// Types come from `openai` (Responses API). runTurn is the only function doing I/O,
// and only through the client the caller passes in.

// ── request assembly (cache-friendly) ──────────────────────────────────────
canonicalTools(tools: FunctionTool[]): FunctionTool[]            // sorted by name, stable key order
buildRequest(p: {
  model: string
  preamble: string                    // rules + task prompt + skill catalog → developer item
  tools: FunctionTool[]               // frozen at run start
  items: ResponseInputItem[]          // run input + history
  profile: RequestProfile             // per-backend constraints (SIWC omissions, cache mode…)
}): ResponseCreateParamsStreaming

// ── one model turn ──────────────────────────────────────────────────────────
runTurn(client: OpenAI, req: ResponseCreateParamsStreaming,
        opts: { idleTimeoutMs: number; signal?: AbortSignal }): Promise<TurnResult>
  // streams, assembles the final Response, classifies errors:
  // TurnResult = { ok: true; response } | { ok: false; error: 'plan_limit' | 'rate_limit'
  //              | 'auth' | 'idle_timeout' | 'tool_parse_500' | 'transient' | 'fatal'; detail }
classify(response: Response): Turn
  // Turn = { kind: 'calls'; calls: FunctionCall[] } | { kind: 'final'; text: string }
  //      | { kind: 'narrated'; hint: string } | { kind: 'empty' }
detectNarratedCall(text: string): NarratedCall | null

// ── tool results ────────────────────────────────────────────────────────────
validateArgs(tool: FunctionTool, raw: string):
  { ok: true; args: unknown } | { ok: false; error: string }
toOutputItem(callId: string, outcome: ToolOutcome, limits: OutputLimits): FunctionCallOutputItem
truncateMiddle(text: string, maxBytes: number): { text: string; droppedBytes: number }

// ── loop policy (pure state machine; the caller's while-loop does the I/O) ──
nextStep(state: LoopState, turn: Turn, budget: Budget): Step
  // Step = execute | nudge | finish | finalize (tool_choice:none) | abort
repairHistory(items: ResponseInputItem[]): ResponseInputItem[]   // every call gets an output

// ── skills (SKILL.md) ───────────────────────────────────────────────────────
parseSkill(dir: string, skillMd: string): Skill | SkillError     // frontmatter per spec (R7)
renderSkillCatalog(skills: Skill[]): string
activateSkillTool(skills: Skill[]): FunctionTool                 // enum of the task's skill names

// ── compaction seam ─────────────────────────────────────────────────────────
estimateTokens(items: ResponseInputItem[]): number
planCompaction(items: ResponseInputItem[],
               o: { limitTokens: number; keepLast: number }): CompactionPlan | null
applyCompaction(items: ResponseInputItem[], plan: CompactionPlan,
                summary: string): ResponseInputItem[]
```

"The caller orchestrates" means the app's loop is about 60 lines over these functions. The README ships the same loop as a reference implementation.

## 4.4 Data model (TypeORM entities)

```
 Task ─────────────< Run ──────────────< Item          conversation; append-only
  name (unique)       status                seq, kind (message | function_call |
  schedule, tz        trigger (cron|manual)    function_call_output | reasoning),
  prompt              task_snapshot jsonb      payload jsonb (verbatim Responses item),
  model_profile       started_at, ended_at     compacted_into (nullable)
  skills text[]       heartbeat_at
  limits jsonb        usage jsonb   ────────< Event         run log; INSERT-only DB grant
  overlap_policy      output text               seq, type (model_call | tool_exec | nudge |
  catch_up            state_after jsonb           finalize | compaction | error | skill_activated),
  state jsonb  ◀──────┘                           data jsonb (latency, tokens, cached_tokens,
  next_run_at                                     cache_write_tokens, exit code, timed_out,
  enabled                                         full stdout/stderr up to a hard cap)
  definition_hash

 SkillSetting  (skill_name, task_id nullable = global, env jsonb)  secrets injected into exec calls
 Credential    (provider, kind: api_key | chatgpt_oauth, tokens jsonb, refreshed_at)
               refresh under SELECT … FOR UPDATE; SIWC refresh tokens rotate (R1.2)
```

- **Run status:** `queued → running → succeeded | failed | capped | deferred | skipped | abandoned`.
- **One active run per task:** `UNIQUE (task_id) WHERE status IN ('queued','running')`, with an explicit index name. Predicate changes go in hand-written migrations (R6.3).
- **Model profiles** live in validated config, not the DB: base URL, model, auth reference, concurrency, request constraints, cache mode. Credentials live in the DB because SIWC tokens rotate.
- **Run-log immutability:** the app's DB role has `INSERT` but not `UPDATE` or `DELETE` on `event`. Together with C3, the agent can't touch its own log.

## 4.5 Agent loop

```
 prepare: load task snapshot, freeze tools + preamble, build run input (now(), carried state)
    │
    ▼
 ┌─▶ turn (stream) ──▶ classify ──┬─ calls    → validate args → execute in order → output items
 │                                ├─ narrated → nudge (≤2), else treat as final
 │                                ├─ final    → succeeded (output, state_after)
 │                                └─ empty    → nudge once, else failed
 │         append items + events, heartbeat, check budgets
 └──────────────── within budget ◀──┘   │ tripped
                                        ▼
                      finalize turn (tool_choice:"none") → capped
```

| Situation | Handling |
|---|---|
| Tool exits non-zero or throws | Output item with exit code and stderr tail; loop continues |
| Tool timeout | Kill the process group (`detached` + `kill(-pid)`, R8); output has `timed_out: true` and partial output |
| Invalid JSON or schema mismatch in arguments | Output item with the validation error and the expected schema, so the model can self-correct |
| Unknown tool name | Output item: "unknown tool X; available: …" |
| Huge output | The model sees head and tail (cap around 16 KB); the event keeps the full output up to a hard cap (around 1 MB); stream reading enforces the cap, not `maxBuffer` (R8) |
| Several calls in one response | Run them sequentially, in order. Every `call_id` gets exactly one output, even if the run stops early |
| Narrated call, or LM Studio 500 "Failed to parse tool call" | Nudge, at most twice (C9) |
| HTTP 429 plan limit (SIWC) | Run becomes `deferred` and is retried after the reset; never fall back to another model mid-run (C1) |
| HTTP 429 rate limit or 5xx | Bounded exponential backoff, then `failed` |
| Auth failure | `failed`, and alert (Q1) |
| Stream idle longer than N seconds | Abort the turn, retry once, then `failed` |
| Iteration, token or wall-clock budget exceeded | Finalize turn, then `capped` (C8) |
| Process crash mid-run | Stale heartbeat makes the run `abandoned`; the next run starts fresh with the carried state |

## 4.6 Request layout for caching

```
 order sent to the model                       changes when…          cache
 ───────────────────────────────────────────   ─────────────────────  ──────────────────────────
 tools[]  (sorted, frozen at run start)        deployment / task edit ┐ shared by every run of a
 developer: base rules + task prompt           task edit              │ task (explicit breakpoint
            + skill catalog                                           ┘ on GPT-5.6+, R3.1)
 user: now(), carried state, trigger           every run              ┐ shared by every turn of a
 items… (calls, outputs, reasoning, skill      append-only            │ run (implicit breakpoint
         bodies from activate_skill)                                  ┘ at the end)
```

Rules:
- Never put the time, state or anything else that varies per run into the developer item.
- Never reorder tools, or change reasoning effort or tool choice, mid-run (R3.4).
- Compaction is rare and chunky (C5).
- Every `model_call` event records cached and written tokens, so cache effectiveness is measured from day one.

What carries across runs:
- OpenAI ≤5.5 keeps cached prefixes for 24h by default (R3.2), so a daily task may still hit the cache. GPT-5.6+ keeps them for 30 minutes (R3.1).
- LM Studio's MLX disk cache restores shared prefixes across conversations (R5.3).
- Under SIWC, retention can't be set (R3.5).

## 4.7 Skills: format and loading

- **Format:** the Agent Skills spec as written (R7), with no custom frontmatter keys. Gremlin-specific settings go in `metadata` or a future sidecar file.
- **Discovery:** scan the mounted private `skills/` first, then the public `skills/`; private overrides public. The workspace mounts both read-only at `/skills`.
- **Selection:** `skills:` in TASK.md frontmatter names the subset for that task.
- **Exposure:**
  - The catalog (name, description, path) goes in the developer item.
  - The `activate_skill` tool has an enum of the task's skill names. Its output is the SKILL.md body, plus the list of files in `scripts/` and `references/`.
  - The model runs scripts with `shell`.
- **Env and secrets:** each task's skills get their env from `SkillSetting`, injected into that run's exec calls. These are task-scoped secrets the agent can read, never the app's own keys.
- **Weak-model option:** `inline: true` per task puts the SKILL.md bodies straight into the developer item. That is stable per task, so still cacheable.

## 4.8 Scheduler and concurrency

```
 every 15s, one app process
 BEGIN
   SELECT … FROM task WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED
   per due task:  INSERT run(status='queued')            ← may hit the partial unique index
                  next_run_at = croner.nextRun(schedule, tz, from=now)
 COMMIT

 UNIQUE INDEX one_active_run ON run(task_id) WHERE status IN ('queued','running')
   conflict = the previous run is still going → record 'skipped' (overlap_policy: skip | queue)
 worker:   claim queued → running (heartbeat every turn) → terminal status
 recovery: at boot and every tick, 'running' with a stale heartbeat → 'abandoned'
 missed fires (laptop asleep, Docker stopped): catch_up: once | skip, per task
 manual:   `gremlin run <task>` inserts a run through the same index
```

- **Why not cron or systemd invoking a CLI:**
  - Schedules live in the DB, so an external cron would need a synced copy.
  - Cron inside containers is awkward (R9).
  - systemd doesn't exist on macOS.
  - Both break "same artefact".
- **Why not `Bun.cron` timers (R8):**
  - Per-task timers have to be re-registered on every edit.
  - They forget runs missed while the process was down.
  - An error thrown in the handler can kill the process.
  - A `next_run_at` column handles all three.
- **Why croner over `Bun.cron.parse`:** croner takes an explicit timezone and has seconds support. Bun 1.4 changed `parse`'s default to local time, and containers usually run in UTC (R8).
- **Concurrency:** an in-process semaphore per model profile, with a configured limit.
  - LM Studio allows 4 concurrent predictions by default (R5.4).
  - Concurrent MLX requests reportedly evict each other's cache (R5.7), so a limit of 1 is a sensible default for local models.
  - SIWC limits come from the plan.
  - With one app process, in-process semaphores are enough. The DB-level locks above keep a second instance safe later.

## 4.9 Docker / compose

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg17          # pin in S1
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [data]
  app:
    build: { context: ., dockerfile: packages/app/Dockerfile }
    env_file: ${GREMLIN_PRIVATE}/gremlin.env
    volumes:
      - ${GREMLIN_PRIVATE}/tasks:/config/tasks:ro
    networks: [data, exec, egress]
    extra_hosts: ["host.docker.internal:host-gateway"]   # Linux; built in on Docker Desktop
    depends_on: [postgres, workspace]
  workspace:
    build: { context: ., dockerfile: packages/workspace/Dockerfile }
    volumes:                               # what the agent can touch = what you mount
      - ${HOME}/notes:/work/notes
      - ${GREMLIN_PRIVATE}/skills:/skills/private:ro
      - ./skills:/skills/public:ro
    networks: [exec, egress]               # egress: Q8
networks:
  data:   { internal: true }
  exec:   { internal: true }
  egress: {}
volumes:
  pgdata: {}
```

**LM Studio operations** (host side, R5.5–R5.7):
- Preload models with `lms load <model> --context-length <N> --parallel <K>` and no TTL. JIT loading would use the 8k default context (0.4.16+), and JIT or TTL reloads reset parallelism to 4.
- Keep the server running with "run LLM server on login" or the llmster daemon. macOS has no launchd guide.
- Check that `host.docker.internal` reaches LM Studio on 127.0.0.1 (S5). If it doesn't, bind to 0.0.0.0 **and** enable token auth, which needs one GUI step.

**Hygiene:**
- gitleaks in a pre-commit hook and in CI, plus GitHub push protection.
- The app validates config and env against a schema at boot and refuses to start otherwise.

## 4.10 Milestones

| | Scope | Done when |
|---|---|---|
| **M0 Spikes** | S1–S5 (Part 5), throwaway scripts with pass/fail results | Every spike is answered; D1, D2 and D13 can be closed |
| **M1 Walking skeleton**, the brief's slice | compose (postgres, app, workspace); Task/Run/Item/Event; `gremlin apply`; scheduler tick, croner and the overlap index; loop with `shell`/`read_file`/`write_file` through the workspace; one model profile (API key or LM Studio); `gremlin runs show <id>` prints the transcript | A task fires on schedule, edits real files, and you can read exactly what it did |
| **M2 Hardening** | Process-group kill, output caps, argument validation, budgets plus finalize, narration nudges, abandoned/catch-up/deferred, history repair, failure notification (Q1) | A deliberately broken task degrades gracefully and you hear about it |
| **M3 Skills and state** | SKILL.md discovery, catalog, `activate_skill`, per-task env, carried state (Q2) | A task uses one of your skills and remembers something across runs |
| **M4 Second provider and auth** | SIWC or LM Studio, whichever M1 didn't use; per-profile concurrency; review cache telemetry | The same task runs on both backends |
| **M5 Compaction seam** | Threshold, `planCompaction`, a plain summarising turn; **only if M4 telemetry shows context growth** | A long run crosses the threshold and continues |
| **M6 Publish** | `core` API docs and reference loop, gitleaks in pre-commit and CI, boot config validation, npm publish | The repo is safe to make public |

## 4.11 Won't build (scope fence, C10)

- Plugin system, provider registry, event bus, multi-agent orchestration.
- Vector memory or RAG, until a skill needs it. `pgvector` stays available but unused.
- A web UI, until the CLI hurts.
- Switching models mid-run. Reasoning items are tied to one model; switch only between runs.
- OpenAI-hosted tools and skills (R4). They would split the code path from LM Studio.
- A soft budget of about 1.5k lines for `core`. Crossing it means something is being reimplemented.

---

# Part 5: Decisions, questions and spikes

## Decisions

| ID | Decision | Options | Recommendation | Status |
|---|---|---|---|---|
| D1 | LLM wire API | Responses only · Chat Completions only · both behind a thin adapter | **Responses only** (C1) | open |
| D2 | OpenAI auth order | API key first · SIWC first · both at once | **API key first, SIWC after S4** (C2) | open |
| D3 | Where the shell and file tools run | Workspace container · app container | **Workspace container** (C3) | open |
| D4 | What a skill is | SKILL.md plus a few app tools · JSON Schema plus handler (as briefed) · SKILL.md plus typed sidecars | **SKILL.md plus a few app tools** (C4) | open |
| D5 | Where task definitions live | DB canonical with TASK.md apply · files canonical · DB only | **DB canonical with TASK.md apply** (C6) | open |
| D6 | Scheduler (originally open) | In-process DB tick · cron/systemd invoking a CLI · `Bun.cron` timers | **In-process DB tick** (4.8) | open |
| D7 | History storage | One row per item · `jsonb` array per run | **Row per item** (C11) | open |
| D8 | Narration fallback | Nudge · execute the parsed call | **Nudge; strict execute opt-in per profile** (C9) | open |
| D9 | Run limits | Iteration cap only · budgets plus finalize turn | **Budgets plus finalize turn** (C8) | open |
| D10 | Core packaging | One package with subpath exports · one package per library | **One package** (4.2) | open |
| D11 | Compaction trigger | Threshold, chunky · sliding window | **Threshold** (C5) | open |
| D12 | Cron expressions | croner · `Bun.cron.parse` | **croner** (4.8) | open |
| D13 | ORM fallback, only if S1 fails | EntitySchema · run the app on Node | **EntitySchema first** (C7) | conditional |

## Open questions

| ID | Question | Why it matters |
|---|---|---|
| Q1 | Where do run results and failures go: push notification, email, a file, a daily digest? | Nothing in the brief delivers output. A 3am failure nobody sees is the classic failure mode. |
| Q2 | What is "state between runs": prose notes or structured `jsonb`? Written by an app tool (`remember`) or taken from the final answer? | Shapes `task.state`, the run input and one app tool. |
| Q3 | Which local models will you run? | Decides whether LM Studio parses their tool calls natively or falls back to its injected prompt (R5.2), and so how often narration happens. |
| Q4 | Plus or Pro? | Only Plus shares a 5-hour window with your own ChatGPT and Codex use (R1.2). |
| Q5 | Can two tasks touch the same mounted directories? | There is no app-level answer to two agents editing the same files. If yes, use a convention such as one working directory per task. |
| Q6 | One app instance, always? | Assumed. The DB locks make a second instance safe, but the concurrency semaphores would have to move into the DB. |
| Q7 | Is a CLI transcript (`gremlin runs show`) enough for inspecting runs at first? | Assumed yes until M2 or later. |
| Q8 | Does the workspace need internet access? | Assumed yes, through the egress network. |
| Q9 | Does SIWC eligibility cover a personal, unattended, scheduled runner? | The docs don't say (R1.2). Ask OpenAI or read the terms before relying on it. |
| Q10 | Is a client deployment always one install per client, with no multi-tenancy? | Assumed yes. Otherwise every table needs a tenant key from the start. |
| Q11 | Which timezone do schedules use by default? | croner needs an explicit zone, and containers run in UTC. Proposal: `tz` per task, with a deployment default. |

## Spikes (M0)

| ID | Spike | Pass when | Unblocks |
|---|---|---|---|
| S1 | TypeORM on Bun | Entities with circular relations across files (`Relation<T>`), `jsonb`, a partial unique index, a `SKIP LOCKED` claim inside a transaction, `migration:generate` and `migration:run` through `bunx --bun`, and the boot self-check all work on Bun 1.4.x | ORM choice; D13 |
| S2 | LM Studio `/v1/responses` with **your** models | Multi-turn function calls with client-held history, developer item honoured, `tool_choice:"none"` works, malformed-call behaviour observed (text or HTTP 500), `cached_tokens` reported | D1, D8 |
| S3 | OpenAI Responses with the target GPT model | `store:false` with reasoning-item replay across tool turns, cached and written tokens visible, and whether a `tool_choice` change keeps the cache | D1, caching config |
| S4 | SIWC end to end | Login from or for a container, refresh rotation under two concurrent runs (serialised), namespaced tools or `additional_tools`, the 429 response shape | D2, Q9 |
| S5 | Docker plumbing | `host.docker.internal` reaches LM Studio on 127.0.0.1; the exec server kills process groups on timeout and caps output by reading the stream | D3, 4.9 |

---

## Sources

**OpenAI**
- help.openai.com/en/articles/8156019 (API billing)
- help.openai.com/en/articles/20001542 (SIWC)
- developers.openai.com/siwc/token-sharing-open-source, plus /sign-in, /models-and-inference, /preview-limitations, /token-reference, /errors-and-recovery
- developers.openai.com/api/docs/guides/migrate-to-responses
- developers.openai.com/api/docs/deprecations
- developers.openai.com/api/docs/guides/reasoning
- developers.openai.com/api/docs/guides/prompt-caching
- developers.openai.com/api/docs/guides/tools-skills
- developers.openai.com/blog/responses-api
- learn.chatgpt.com/docs/auth, learn.chatgpt.com/docs/auth/ci-cd-auth, learn.chatgpt.com/docs/build-skills
- openai-node 7.32.0 type definitions
- Secondary: WorkOS (2026-10-01), The Star (2026-10-04), Simon Willison (2025-12-12, 2025-12-20, 2026-02-11), OpenCode v1.1.11 release notes, X mirrors of posts by Tibo Sottiaux

**LM Studio**
- lmstudio.ai/docs, specifically /developer/openai-compat, /developer/openai-compat/tools, /developer/rest, /developer/core/headless, /developer/core/ttl-and-auto-evict, /developer/core/authentication (source: github.com/lmstudio-ai/docs)
- lmstudio.ai/changelog
- lmstudio.ai/blog/lmstudio-v0.3.29, /blog/openresponses, /blog/0.4.0, /blog/mlx-engine-agentic-workloads
- github.com/lmstudio-ai/lmstudio-bug-tracker issues 670, 1154, 1628, 1709, 1714, 1756, 1904, 2061, 2074, 2086, 2115, 2224, 2257, 2320, 2390, 2419
- github.com/lmstudio-ai/lms issue 489
- mlx-engine PRs 352, 369

**TypeORM and Bun**
- typeorm.io/blog/typeorm-1-0, typeorm.io/docs/releases/1.0/release-notes/, typeorm.io/blog/future-of-typeorm, typeorm.io/docs/help/faq/#how-to-use-typeorm-in-esm-projects
- github.com/typeorm/typeorm releases, issues 9738, 9862, 10118, PR 11437, and docs (query-builder, entities)
- bun.com/blog/bun-v1.0.3, /bun-v1.3.10, /bun-v1.3.12
- bun.com/docs/runtime/cron, bun.com/docs/runtime/child-process
- github.com/oven-sh/bun issues 4136, 6172, 6326, 7591, 14888, 20994, 44120, PRs 35471, 36461
- github.com/Hexagon/croner

**Agent Skills**
- agentskills.io/specification, /client-implementation/adding-skills-support, /skill-creation/using-scripts
- github.com/agentskills/agentskills
- code.claude.com/docs/en/skills
