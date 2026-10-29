## Context

`createSession` builds an `openai` client and sends Responses requests. `HistoryItem`, `ToolCall`, `ResponseUsage` and `callModel`'s request and response are SDK types; `core/history` imports the SDK's replay helper. The loop runs Gremlin's tools in order and stores each Responses item, reasoning included. It yields a step before starting the next model call. The main program logs only four token counts, while failed calls have no `StepStats`.

Claude's native Messages API instead returns an assistant message containing ordered content blocks. Client tool results are blocks in the immediately following user message. A thinking block and its signature must be sent back unchanged with the tool-use block. The Responses API and Messages API cannot share a wire-format history, but the loop's decisions and tool handlers can be shared.

The user chose a direct Claude API key, the Anthropic TypeScript SDK, explicit configuration, a session fixed to one provider, native data in the in-memory history, and complete provider-specific typed statistics. `core` must not depend on an SDK. An OpenAI reasoning change and database storage come separately.

## Goals / Non-Goals

**Goals:**
- Run the existing tool loop against Claude, OpenAI and LM Studio on Bun and Node.
- Keep protocol-specific clients and serialization behind a small boundary; make core's public types Gremlin-owned.
- Keep replay data intact in the history and make each provider's complete reported statistics accessible with named types.
- Validate explicit configuration before networking, with an independently testable Zod schema per provider.
- Keep all existing tool execution, step-limit, cleanup and failure guarantees, except for the intentional configuration and API breaks.

**Non-Goals:**
- Database persistence, history migration or changing provider within a session.
- Enabling new OpenAI encrypted-reasoning features, repairing LM Studio's incomplete usage responses, or introducing an agent SDK, provider registry or plugin framework.
- Claude subscription or OAuth credentials, Bedrock/Vertex/Foundry, Anthropic server tools, automatic model fallback, retries, or a run-wide token or money budget.
- Changing the host shell's security boundary or the tools' own behavior.

## Decisions

### 1. One loop, two protocol adapters

```text
                  createSession(config, tools, starting history)
                                   │ selects once
                                   ▼
                   shared session and tool execution
                                   │
                        model-call boundary
                         /               \
                Responses adapter    Messages adapter
                openai SDK           @anthropic-ai/sdk
                OpenAI / LM Studio   Anthropic API
```

The boundary accepts Gremlin's model, instructions, tools, history and provider settings, and returns a result with the native replay data, a Gremlin-owned view of calls or final text, and provider statistics. The loop appends the replay data before running calls, validates and executes calls one at a time, records one outcome per call and yields each step. On the last step it records a failed outcome for each not-run call. A provider is bound at creation: a history item carrying another provider's native data is rejected, including when both providers happen to use Responses. There is no automatic conversion or fallback.

Place the inlined domain types and provider-neutral helpers in `core`, and the SDK clients, wire types, request assembly, error classification and replay conversion in `agent`'s model adapters. `core` has no dependency, peer dependency, runtime import or type import from either SDK; it neither constructs clients nor reads environment variables or logs. Its public types are Gremlin-owned, not aliases to SDK types. The old SDK-shaped `callModel`, tool and history exports change rather than acquiring compatibility shims. The Responses adapter retains existing request semantics (`stream: true`, `store: false`, same reasoning effort and tools), error classification and replay helper behavior; the separate OpenAI encrypted-reasoning change stays separate.

**Alternative:** use Anthropic's OpenAI-compatible Chat Completions endpoint. Gremlin uses Responses, not Chat Completions, and Anthropic positions that compatibility layer for testing and omits prompt caching. A gateway or a second copy of the agent loop would hide protocol differences or duplicate loop policy.

### 2. History is data, not a lowest-common-denominator transcript

The ordered session history contains Gremlin-authored instructions, user input and tool outcomes, plus the complete native replay data from every completed assistant response. The outside of the adapter treats native data as an opaque, provider-tagged value; the adapter which created it can read it with its own types. Its representation is actual data in `session.history`, not a client object, callback, or private SDK cache. The caller's starting history is copied and remains untouched; the session's history grows and is stable while a yielded step is handled.

The adapter derives a common call view (ID, name and argument JSON) without reconstructing the replay payload from that view. Anthropic's parsed object input is serialized for the existing `ToolHandler.invoke` and local schema validation, while the original tool-use block stays intact. On the next request the adapter preserves the full assistant content array and sends all of that response's tool results together, in call order, as the next user message. Failures use `is_error: true`. Text alongside calls remains in native history; calls win for the loop as today.

Request construction can change the envelope or omit output-only/SDK-only fields required to form a valid input, but does not mutate the stored response or discard replay-relevant content. In particular, Claude thinking and redacted-thinking blocks, signatures and ordering survive. Unsupported native history fails with an actionable history error instead of silently dropping replay-relevant data. The Responses adapter continues to use the SDK's `toResponseInputItems`, which removes SDK-only fields and omits items that SDK documents as non-replayable; this change does not alter that existing OpenAI behavior.

**Alternative:** normalize everything to text, calls and an ad-hoc metadata field. That loses block ordering and may lose signed or encrypted provider state. Database representation and any encoding for it are deliberately not decided here.

### 3. Claude uses Messages directly

Use `@anthropic-ai/sdk` 1.x with the Messages API and its `2026-10-21` API version. Instantiate the SDK in the agent with the explicitly configured key and base URL, `maxRetries: 0`, and stream one message per model call. The SDK base URL is the origin or proxy prefix, for example `https://api.anthropic.com`; it appends `/v1/messages` itself. Pass the required model, output-token limit and effort; map the existing initial instructions to Claude's system input. An optional `ANTHROPIC_WORKSPACE_ID` is sent as `anthropic-workspace-id` for personal or service keys not scoped to a workspace; when unset no workspace ID is invented.

Use the SDK's message accumulation while observing the stream's terminal `message_stop` and errors. Do not run a tool from an incomplete stream. `max_tokens` and `model_context_window_exceeded` become `incomplete` errors; `end_turn` yields the final text, `tool_use` yields client calls, and a refusal with text remains visible as the answer. Empty replies retain the existing `empty` outcome. A malformed or unsupported stop is an explicit error, not a guessed final answer. Preserve any available partial usage on an interrupted or incomplete call; never add cumulative streaming usage updates together.

For each tool, send its name, description and the existing draft-07 input JSON Schema as an Anthropic client tool. **Do not request Anthropic strict tool use:** its strict JSON Schema subset excludes numerical constraints such as `minimum`, which Gremlin's `read` schema uses. Removing those constraints would change what the model sees. Always run the existing local validation and return its errors to the model. The Responses adapter keeps its existing `strict: true` behavior.

Enable top-level automatic prompt caching with `cache_control` set to `ephemeral` and a five-minute TTL on every Claude request. The tools and instructions are frozen in the same order throughout the session. Cache reuse depends on provider thresholds and prefix matching; it is not guaranteed. This is an explicitly approved provider-specific default, not a general configuration fallback.

### 4. Configuration is explicit and validated with Zod

`loadConfig` uses a discriminated Zod schema for the chosen provider, with the common settings checked as well. Preserve trimmed values, blank-as-unset, aggregated actionable errors, `MAX_TURNS`' rejection and the real-path check for the working directory. Reject invalid configuration and a missing task before model selection or any network call. Check `LOG_FORMAT` first to choose the diagnostic format, but continue checking all independently checkable settings even if it is invalid or missing. In that case use formatted output only for the startup errors, including `LOG_FORMAT`; this does not make it a valid default.

| Setting | Contract |
|---|---|
| `MODEL_PROVIDER` | Required: `lmstudio`, `openai` or `anthropic`. |
| `MODEL_BASE_URL` | Required for every provider; valid HTTP(S), no query or fragment, trailing slashes removed. LM Studio retains its `/v1` check. Anthropic takes the SDK base URL, not the `/v1/messages` URL. |
| `MODEL_API_KEY` | Required for every provider. LM Studio with authentication off still needs an explicit non-empty value for the Responses SDK; no dummy is supplied by Gremlin. |
| `MODEL` | Required for every provider. LM Studio verifies the named key or instance is loaded and never loads one or chooses the first. |
| `MODEL_REASONING_EFFORT` | Required. Responses accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; Anthropic accepts `low`, `medium`, `high`, `xhigh` or `max`, passed as `output_config.effort`. Never translate `none` or `minimal` to another value. |
| `MODEL_MAX_OUTPUT_TOKENS` | Required for Anthropic: a positive safe integer in decimal digits, sent as `max_tokens`. For Responses providers it is not supported by this change; reject it when set rather than ignoring it. |
| `ANTHROPIC_WORKSPACE_ID` | Optional for Anthropic, omitted when unset. It selects the workspace when the chosen API key requires one. |
| `MAX_STEPS`, `FILE_TOOLS`, `LOG_FORMAT`, `WORK_DIR` | Required for every provider and checked by the same startup validation. Keep their existing accepted values and path rules. |
| `SKILLS_PATH` | Optional: absence means no skills, not a substitute path or implicit search. |

Zod can validate a provider's effort vocabulary without maintaining a model catalog. Whether a particular model accepts an otherwise valid effort or token limit is checked by the provider; report its error rather than silently changing the request. An empty or missing task is an error and does not run the browsing example. Update the Node CI smoke test to provide all required values and an explicit task.

### 5. Statistics are a full typed contract

`StepStats` carries the step number, elapsed seconds, provider and a discriminated, Gremlin-owned provider-statistics type. Inline the complete current SDK `ResponseUsage` and Anthropic `Usage` fields and nested types, preserving the providers' names, nullability and meanings. Anthropic's usage includes input and output counts, cache reads and writes, the 5-minute and 1-hour cache-write breakdown, thinking-token breakdown, server-tool counts, inference region, service tier and speed. Responses usage includes input, output and total tokens, cache-read/write counts and reasoning tokens. Include the SDK's typed response cache diagnostics and service tier when the provider reports them. Claude reports diagnostics only to a request that opts in by naming the previous reply's ID, so the history keeps that ID with the reply's content blocks. Claude also leaves out the usage fields that don't apply to a message, though the SDK types them as null: its complete usage requires only the two token counts, and keeps the other fields absent when unreported.

The same provider-specific type carries the documented response rate-limit headers when present, with individually named fields and their original string values: Responses' request, token and project-token limits, remaining amounts and resets; Anthropic's request, token, input/output, priority and fast limits, remaining amounts and resets; and `retry-after`. Do not expose all HTTP headers or credentials. An absent or null provider field is not replaced with zero. Partial streaming usage is typed as partial, and absence is distinct from a complete zero-usage report. Keep elapsed time and any available usage/headers on `model_call_failed` as well as completed steps.

Any common token summary is a derived convenience, not the source of truth. Claude's total input is uncached input plus cache writes plus cache reads; Responses' input is already inclusive. Thinking tokens are included in output. Do not calculate a price from counts or assume both providers bill identically. Both pretty and JSON `model call` records contain the full provider stats, not just the current four selected fields.

In the adapter package, add compile-time compatibility checks between the inlined full usage/diagnostic types and the installed SDK types, plus fixtures exercising every named field and header. This catches SDK drift without importing SDK types into `core`. Keep current LM Studio behavior if it omits a Responses usage detail; improving that compatibility is a separate change.

### 6. Test the shared contract and each wire format

Use fake HTTP/SSE responses, not live API credentials, in the regular Bun and Node test suites. Share loop tests for sequential calls, unknown tools, validation failures, handler exceptions, step limits, paused yields and stats. Add provider-specific request and replay tests: Claude's thinking/signature blocks, several calls and grouped results, partial JSON deltas, `is_error`, caching, request headers, terminal and truncated streams, stop reasons, error classifications and reported statistics. Retain Responses and LM Studio regression tests, including replay of the native items currently returned. A paid real-API smoke test is optional and never part of CI.

## Risks / Trade-offs

- **New required settings break existing runs** → list the required values and a migration example; update CI and all tests, and report all invalid settings before network calls.
- **SDK types and Gremlin-owned stats can drift** → pin the SDK major version, compare types in the adapter package, and test every supported usage and header field.
- **Claude can spend tokens on thinking before visible text** → require the user to select `MODEL_MAX_OUTPUT_TOKENS`; report truncation and preserve available usage instead of treating it as an answer.
- **Cache writes cost more and short prefixes may miss** → document the five-minute automatic policy and expose read/write counts without promising a hit.
- **A malformed or interrupted stream could request a tool** → wait for a valid terminal message and stop reason before running anything.
- **The SDK might read its own environment or emit diagnostics** → pass the validated key, base URL and retry setting explicitly, test precedence against conflicting SDK variables, and keep Gremlin's structured error and secret-handling behavior.

## Migration Plan

Supply explicit `MODEL_PROVIDER`, `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL`, `MODEL_REASONING_EFFORT`, `MAX_STEPS`, `FILE_TOOLS`, `LOG_FORMAT` and `WORK_DIR`, plus `MODEL_MAX_OUTPUT_TOKENS` for Anthropic. Provide a task on the command line. A caller of the old `core` SDK-shaped API must migrate to Gremlin-owned model, tool, history and stats types. There is no stored data to migrate. Reverting the change restores the old requirements and defaults; no database rollback is involved.

## Open Questions

- The exact SDK patch version is selected at implementation and recorded in the lockfile; the 1.x major and its API version are part of this design.
- Future persisted native history must round-trip provider data losslessly. Its encoding, migrations and any interaction with the Brief's `toStorable` sanitizer are outside this change.

## Sources

- Anthropic: [Messages and streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), [tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), [thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [rate-limit headers](https://platform.claude.com/docs/en/api/rate-limits), [strict-schema limitations](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations) and [API-version migration](https://platform.claude.com/docs/en/api/migration-2026-10-21).
- OpenAI: [Responses reasoning](https://developers.openai.com/api/docs/guides/reasoning) and [rate-limit headers](https://developers.openai.com/api/docs/guides/rate-limits). The installed `openai` SDK and the existing specs define the Responses behavior preserved here.
