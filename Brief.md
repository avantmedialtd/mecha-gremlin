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

▸ How each settled decision stands after research: 3.0. None has been changed.

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

▸ **1. Scheduler.** Proposal: an in-process tick driven by the database (4.8, D6). Where task definitions live: C6, D5.

▸ **2. Agent loop.** Draft in 4.5. Budgets and a context-fill check beyond the iteration cap: C8. Narration handling: C9, using LM Studio's own markers (R5.2).

▸ **3. Skills.** The SKILL.md spec has no typed tools (R7), so C4 proposes a different split. Storage: on disk (4.7).

▸ **4. Base tools.** Where they execute: C3. Process-group kill, pipe and stdin handling, and output caps: C3, 4.5, R8, R10.

▸ **5. Persistence.** One row per history item rather than one `jsonb` array per run (C11). Entity draft: 4.4.

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

---

# Part 3: Where the brief stands, and challenges

## 3.0 Status of the original brief

**Settled decisions.** No decision has been changed.

| Area | Status after research |
|---|---|
| Language/runtime | Holds. Bun 1.4.3 is current (2026-10-10). Watch out: Bun reads the `tsconfig.json` of the directory it's started from (R6.2, C7). It has built-in cron (R8), which bears on D6. |
| Database | Holds. Everything the scheduler needs is reachable from TypeORM: `FOR UPDATE SKIP LOCKED`, partial unique indexes, `ON CONFLICT DO NOTHING`, `jsonb` and native `vector` columns (R6.3, R10). |
| ORM | Holds, with conditions. TypeORM 1.1.2 is healthy, but its CI doesn't run on Bun. Four transpiler gotchas are verified on Bun 1.4.3, and the migration and minify items are [M] (R6.2). See C7 and S1. |
| LLM client | Holds: the `openai` SDK covers the Responses API natively. Two qualifications. LM Studio should always run with token auth (C3, 4.9), so "a dummy key locally" becomes a real token. SIWC's namespace rule for function tools may need its own code path (C2, S4). The separate Known-risks premise, "stick to mainstream chat-completions", has shifted: on OpenAI, Chat Completions can't call tools on GPT-5.4+ with reasoning (R2.2), while the LM Studio pass on its own still recommends it there (R5.8). See C1; D1 is open. |
| Models | Holds. New: a ChatGPT subscription can now pay for your own calls through SIWC plan usage. That covers Plus and Pro; for other plans the sources conflict (R1.2, C2). |
| Deployment and isolation | Holds. On macOS, LM Studio has to run on the host, outside compose (R9). Where the boundary sits: C3. |
| Repo | Holds. Proposal: one `core` package with subpath exports (D10). |

**Known risks.**

| Risk | What the research found | Where it goes |
|---|---|---|
| TypeORM runtime type gap | **Closed:** 1.x throws on `null`/`undefined` in high-level `where` criteria, for find/count/exists since 1.0.0 and for writes since 1.1.0 (R6.1). **Remains open:** QueryBuilder `.where()` silently matches zero rows on `null`; a bare id under a relation key returns an arbitrary row (#12712, R9); entity-instance criteria are unvalidated; `jsonb` payloads are unchecked; partial-index predicates under explicit names aren't diffed (R6.3); Bun's metadata ignores `strictNullChecks` while `emitDecoratorMetadata` is on (R6.2 gotcha 4, moot if D15 turns it off). | C7: pin `typeorm >= 1.1.0`, find-options locks, `{ run: { id } }` filters, `tsc` in CI, integration tests |
| TypeORM on Bun | Works with legacy decorators, but isn't in TypeORM's CI. Four transpiler gotchas verified on 1.4.3, including the cwd-tsconfig rule. Migrations and minify are [M] (R6.2). | C7, S1, D13, D15 |
| OpenAI compatibility | The premise has shifted. OpenAI's Chat Completions can't call tools on GPT-5.4+ unless reasoning effort is `none` (R2.2). LM Studio serves `/v1/responses` (R5.1), though the LM Studio pass alone would still pick Chat Completions (R5.8). | C1, D1, S2, S3 |
| OpenAI subscription | No ChatGPT plan includes API credits (R1.1). SIWC plan usage (2026-09-29) is official for Plus and Pro; the sources conflict for other plans. It is Responses-only, with constraints, and the docs don't address unattended personal use (R1.2). | C2, D2, S4, Q4, Q9 |
| Scope creep | No research needed. | C10 |

## Challenges

These are **proposals, not decisions**. Each links to a decision in Part 5. "Brief says" quotes or paraphrases Part 1.

### C1. Use the Responses API, not Chat Completions
- **Brief says:** "stick to mainstream chat-completions plus tool-calling" (Known risks).
- **Proposal:** make the Responses API the only wire format for every backend. Use it statelessly (`store:false`, replaying the full input including reasoning items) and always streamed.
- **Why:**
  - On OpenAI, Chat Completions can't call tools on GPT-5.4+ unless reasoning effort is `none`, and it can't call tools at all on GPT-6 Astra or GPT-6.1 Sol (R2.2).
  - It also drops reasoning between calls (R2.3), which is exactly what a tool loop needs to keep.
  - SIWC is Responses-only (R1.2).
  - LM Studio serves `/v1/responses` with function tools and client-held history (R5.1), and only that endpoint reports `cached_tokens` (R5.3).
  - So one Responses code path *could* cover every backend, and Chat Completions can't. LM Studio's side is pending S2.
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
| **Base tools** | workspace | app code: `shell`, `read_file`, `write_file` | always, in `tools[]` |
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
  - **Cut only at turn boundaries.** That means after all outputs of one model turn, before the next reasoning, message or call group.
    - The API rejects a `function_call_output` whose `function_call` is missing.
    - Developers also report HTTP 400s for a `function_call` sent without its reasoning item, and for a reasoning item without the item that follows it.
    - So reasoning, call and output are kept or dropped as one unit. S3 tests a replay across a compaction boundary.
  - **Use `tool_choice` to stop tool calls.** A forced final answer uses `tool_choice:"none"` rather than removing tools. OpenAI documents that this keeps the cached prefix (R3.4); S3 measures it.
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
    - Make one last turn with `tool_choice:"none"`, sent as a user message so it ends an eligible cache breakpoint (R3.1), and sized to fit. It asks "what did you do and what remains".
    - That becomes the run's output and seeds the next run's state. Status: **`capped`**, not `failed`.
    - If even the finalize turn can't fit, returns calls anyway, or fails, end as `capped` with a synthesised "budget exceeded; no summary" output.
  - **Per-profile output cap:** the model-visible output cap is set per profile, smaller for local models.
- **Check:** LM Studio supports `tool_choice:"none"` on Chat Completions (R5.2). Support on `/v1/responses` is unverified, so S2 checks it.
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

---

# Part 4: Draft design

This draft assumes the recommended option for every decision in Part 5. Sections that depend on an open decision name it.

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
               │ Responses API (stream, store:false)           │ bind mounts
       ┌───────┴──────────┐                                    ▼
       ▼                  ▼                           ~/notes, ~/projects, skills/
 api.openai.com     LM Studio on the host (Metal GPU; can't run in a container on macOS)
 key | SIWC         host.docker.internal:1234, token auth on
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
│   │                                   `openai` as a peerDependency, plus one JSON Schema validator
│   ├── app/                            entities, migrations, scheduler, loop, app tools, CLI `gremlin`
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

## 4.3 Core library (signatures)

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
- **Use `tool_choice` to stop tools.** The finalize turn's `tool_choice:"none"` is the sanctioned way to disable tools: OpenAI documents it as keeping the prefix, and S3 measures it. On OpenAI, `allowed_tools` can also narrow them. LM Studio rejects object `tool_choice` on Chat Completions (R5.2); S2 checks `/v1/responses`.
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
| **M1 Walking skeleton** (the brief's slice) | **Infrastructure:** compose with restart policies, healthchecks, the `migrate` service and two DB roles with the grant matrix; Task, Run, Item and Event; `gremlin apply`. **Scheduling:** `gremlin serve` with the advisory lock; the tick with `ON CONFLICT`, per-task savepoints and the overlap index; a boot sweep limited to `running → abandoned` plus the exec reset; the per-profile worker. **Execution:** the loop with `shell`, `read_file` and `write_file` through the workspace, with a per-command timeout, process-group kill, closed stdin, a hard output cap with the ~1 s pipe wait, and output normalisation plus `toStorable`. **Recording:** record-before-running events, the run's hard deadline, and `gremlin runs show <id>`. **Profile and hygiene:** one profile, an OpenAI API key (D14); gitleaks, push protection, boot config validation, `tsc` in CI | A task fires on schedule, edits real files and leaves a readable transcript, and the system survives an app restart, a hung command and `yes` |
| **M2 Hardening** | The rest of 4.5: argument validation, model-visible output caps, budgets, the context-fill check and finalize; the compaction seam (`estimateTokens`, `planCompaction` returning null); narration nudges; first-output and idle timeouts; the catch-up rule and grace; limit-domain backoff and `deferred`, tested with an unreachable backend (an offline laptop now defers even the API-key profile); history repair; DST tests; failure notification and dead-man's switch (Q1); `gremlin prune`, nightly backups and a restore test | A deliberately broken task degrades gracefully, and you hear about it |
| **M3 Skills and state** | SKILL.md discovery in the app, catalog, `activate_skill`, `gremlin skill-env set`, carried state (Q2) | A task uses one of your skills and remembers something across runs |
| **M4 LM Studio** | Local profile, token auth, model check at run start, per-profile concurrency, review of cache telemetry | The same task runs on both backends |
| **M5 SIWC** | Starts with S4, and is gated on Q9: the `Credential` entity; login (compose-run with a published port, or host login plus import); the conditional refresh protocol and `needs_login`; plan-limit deferral and `gremlin unblock` | A task runs on plan usage and defers cleanly at the limit |
| **M6 Compaction summariser** | A plain summarising turn behind the M2 seam, **only if telemetry shows context growth** | A long run crosses the threshold and continues |
| **M7 Publish** | `core` API docs and reference loop, npm publish | The package is published |

## 4.11 Won't build (scope fence, C10)

- A plugin system, provider registry, event bus or multi-agent orchestration.
- Vector memory or RAG, until a skill needs it. `pgvector` stays available but unused.
- A web UI, until the CLI hurts.
- Switching models mid-run. Reasoning is tied to one model family; switch only between runs.
- OpenAI-hosted tools, or OpenAI's shell-tool skills in either mode (R4). They would split the code path from LM Studio.
- A soft size budget of about 1.5k lines for `core`. Crossing it means something is being reimplemented.

---

# Part 5: Decisions, questions and spikes

## Decisions

| ID | Decision | Options | Recommendation | Status |
|---|---|---|---|---|
| D1 | LLM wire API | Responses only · Chat Completions only · both behind a thin adapter | **Responses only** (C1) | open |
| D2 | OpenAI auth order | API key first · SIWC first · both at once | **API key first; SIWC in M5, after S4 and Q9** (C2) | open |
| D3 | Where the shell and file tools run | Workspace container · app container | **Workspace container** (C3) | open |
| D4 | What a skill is | SKILL.md plus a few app tools · JSON Schema plus handler (as briefed) · SKILL.md plus typed sidecars | **SKILL.md plus a few app tools** (C4) | open |
| D5 | Where task definitions live | DB canonical with TASK.md apply · files canonical · DB only | **DB canonical with TASK.md apply** (C6) | open |
| D6 | Scheduler (originally open) | In-process DB tick · cron/systemd invoking a CLI · `Bun.cron` timers | **In-process DB tick** (4.8) | open |
| D7 | History storage | One row per item · a `jsonb` array per run | **Row per item** (C11) | open |
| D8 | Narration fallback | Nudge · execute the parsed call | **Nudge; strict execute opt-in per profile** (C9) | open |
| D9 | Run limits | Iteration cap only · budgets, context check and finalize turn | **Budgets, context check and finalize** (C8) | open |
| D10 | Core packaging | One package with subpath exports · one package per library | **One package** (4.2) | open |
| D11 | Compaction trigger | Threshold, chunky, at turn boundaries · sliding window | **Threshold at turn boundaries** (C5) | open |
| D12 | Cron expressions | croner · `Bun.cron.parse` | **croner** (4.8) | open |
| D13 | ORM fallback, only if S1 fails | EntitySchema · run the app on Node | **EntitySchema first** (C7) | conditional |
| D14 | First backend for M1 | OpenAI API key · LM Studio | **OpenAI API key**: the most reliable tool calling, so early harness bugs aren't mixed up with local-model quirks. LM Studio comes in M4 | open |
| D15 | `emitDecoratorMetadata` | Off, with explicit types · on, with `Relation<T>` and `import type` | **Off** (C7); S1 confirms | open |
| D16 | Meaning of overlap `queue` | Coalesce (fire once after the active run) · a real depth-1 queue (needs two partial indexes) | **Coalesce** (4.8) | open |
| D17 | Isolating skill secrets | Visible workspace-wide (documented) · per-task uid in the workspace | **Workspace-wide for now**; revisit with Q5. Per-task uids edge toward the non-goal | open |

## Open questions

| ID | Question | Why it matters |
|---|---|---|
| Q1 | Where do run results and failures go: push notification, email, a file, a daily digest? And should an external dead-man's switch watch the app itself? | Nothing in the brief delivers output. A 3am failure nobody sees is the classic failure mode, and a dead app can't alert anyone. |
| Q2 | What is "state between runs": prose notes or structured `jsonb`? Is it written by an app tool (`remember`) or taken from the final answer? | Shapes `task.state`, the run input and one app tool. |
| Q3 | Which local models will you run? | Decides whether LM Studio parses their tool calls natively or falls back to its injected prompt (R5.2), and so how often narration happens. |
| Q4 | Which plan would SIWC use: Plus, Pro, or an existing Business or Go seat? | Plus shares a 5-hour window with your own Codex use. Plus and Pro both draw on the weekly "ChatGPT Work and Codex" allowance. Whether Business or Go qualifies is unsettled (R1.2), and S4 tests it. |
| Q5 | Can two tasks touch the same mounted directories? | There is no app-level answer to two agents editing the same files. If they can, adopt a convention such as one working directory per task, and decide D17. |
| Q6 | One app daemon, always? | Assumed, and enforced: `gremlin serve` takes an advisory lock and refuses to start a second daemon (4.8). The boot sweep and the in-process semaphores rely on it. Running two would need heartbeat-based recovery and DB-backed semaphores. |
| Q7 | Is a CLI transcript (`gremlin runs show`) enough for inspecting runs at first? | Assumed yes until M2 or later. |
| Q8 | Does the workspace need internet access? If so, is reaching host services (`host.docker.internal`) an accepted risk, or should egress go through a proxy? | Assumed yes, with LM Studio token auth and host services treated as exposed (C3, R10). A proxy matters more on client boxes. |
| Q9 | Does SIWC cover a personal, unattended, scheduled runner? | The docs don't say. **For:** a guide for running an open-source app on a remote VM; the example agent name is OpenClaw, which has a built-in cron scheduler; and OpenAI's Codex lead called use through Sign in with ChatGPT in OSS clients "completely fine" (R1.4). **Against:** the Codex docs say "The right way to authenticate automation is with an API key" (R1.3). It needs OpenAI's answer or a reading of the terms, not a spike. |
| Q10 | Is a client deployment always one install per client, with no multi-tenancy? | Assumed yes. Otherwise every table needs a tenant key from the start. |
| Q11 | Which time zone do schedules use by default? | Without a zone, croner uses the process zone, which is UTC in containers (R8). Proposal: `tz` per task, with a deployment default (4.8). |

## Spikes (M0)

| ID | Spike | Pass when | Unblocks |
|---|---|---|---|
| S1 | TypeORM and Postgres on Bun | **Entities:** circular relations across files, with metadata both off and on; `jsonb`; the partial unique index. **Claims and ticks:** a find-options `SKIP LOCKED` claim inside a transaction; the tick query with `NOT EXISTS … FOR UPDATE OF task`; the `ON CONFLICT` tick with one conflicting task doesn't block the others; a per-task savepoint contains a failing task; the tick-vs-finalisation lock order holds under a race. **Scheduling rules:** an `overlap: queue` plus `catch_up: skip` task fires once after a long run; a `catch_up: skip` task fires once when its domain's block lifts. **Tooling:** both migration commands run through `bunx --bun` from `packages/app`; the tsconfig matrix passes (started from root and from `packages/app`, in the image and in `bun test`); the boot self-check fires when it should. **Grants:** as `gremlin_app`, UPDATE, DELETE and TRUNCATE on `event` fail with 42501, and deleting a run that has events fails with 23503. **Driver:** TypeORM 1.1.2 on pure-JS `pg` (not `pg-native`) under Bun 1.4.3 holds up under concurrent claims and ticks. | ORM choice; D13, D15 |
| S2 | LM Studio `/v1/responses` with **your** models | Multi-turn function calls with client-held history; the developer item honoured; `tool_choice:"none"` works and whether it keeps the KV prefix; malformed-call behaviour (text or HTTP 500); BT#2257's intermittent 500s; `cached_tokens` reported; the longest silent gap measured; the REST `parallel` load field; object `tool_choice` and `allowed_tools` on `/v1/responses`. | D1, D8 |
| S3 | OpenAI Responses with the target GPT model | `store:false` with reasoning items replayed from `output_item.done` across tool turns; replay across a compaction boundary; cached and written tokens visible; whether `tool_choice:"none"` keeps the cache; whether an explicit breakpoint and the implicit end-of-input breakpoint both apply; reasoning summaries as a liveness signal; the longest silent gap. | D1, D11, caching config |
| S4 | SIWC end to end | Eligibility on the actual account type; both login routes (C2); the issued `client_id` stored and used; refresh rotation under two concurrent runs, serialised; namespaced tools or `additional_tools`; the limit-error shapes (429 before the stream, `response.failed` mid-stream, bare `{"detail"}` bodies) and any reset hint; whether reasoning summaries are allowed. Runs at the start of M5, not in M0. | The technical half of D2; Q9 is answered separately |
| S5 | Docker plumbing and the exec server | **Networking:** `host.docker.internal` reaches LM Studio on 127.0.0.1 (Docker Desktop only; on Linux, bind to the bridge IP), and internal-network reachability matches R10. **Process control:** the exec server kills process groups on timeout and on client disconnect; kills processes that escaped with `setsid` through `GREMLIN_RUN_ID`; on reset, kills everything except PID 1 and itself; returns promptly when a background grandchild holds the pipe; never blocks on stdin; reaps zombies under `init`. **Output:** `yes` with a 5-minute timeout returns head and tail within the cap while memory stays flat; binary, NUL and cut-emoji output is stored safely. **Ownership:** on a Linux host, files the agent writes are owned by the host user. | D3, 4.9 |

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
