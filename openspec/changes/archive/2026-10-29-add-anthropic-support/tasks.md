## 1. Provider-neutral contracts and dependencies

- [x] 1.1 Add `@anthropic-ai/sdk` 1.x to `packages/agent` and update the lockfile; keep `openai` in the agent and remove its peer and development dependencies from `packages/core`.
- [x] 1.2 Define Gremlin-owned model-call request, reply, call, result and classified-error types in `core`, with no provider SDK imports or aliases.
- [x] 1.3 Define ordered history types for Gremlin-authored inputs and outcomes plus opaque provider-tagged native replay data, without losing data to a normalized transcript.
- [x] 1.4 Inline complete, provider-discriminated Responses and Anthropic usage and diagnostic types in `core`, including named rate-limit fields and distinct complete, partial and unavailable usage states.
- [x] 1.5 Keep Standard Schema argument validation and draft-07 schema generation in `core`, and move SDK-specific tool, output and history conversion into the agent adapters.
- [x] 1.6 Define the agent's provider-neutral adapter boundary and update consumers of the replaced `core` exports; ensure `core` neither constructs clients nor reads configuration or logs.

## 2. Explicit configuration and startup

- [x] 2.1 Replace configuration defaults in `loadConfig` with provider-discriminated Zod schemas requiring explicit provider, base URL, API key, model, reasoning effort, `MAX_STEPS`, `FILE_TOOLS`, `LOG_FORMAT` and `WORK_DIR`.
- [x] 2.2 Validate each provider's effort vocabulary; require a positive safe-integer `MODEL_MAX_OUTPUT_TOKENS` for Anthropic, reject it for Responses providers, and support optional `ANTHROPIC_WORKSPACE_ID` only as specified.
- [x] 2.3 Preserve trimming, blank-as-unset, URL and LM Studio path validation, real working-directory resolution, optional `SKILLS_PATH`, and rejection of the old `MAX_TURNS` setting.
- [x] 2.4 Aggregate all independently checkable configuration errors before networking, including when the provider is unknown; check `LOG_FORMAT` first for diagnostic formatting without treating pretty output as a valid default.
- [x] 2.5 Require a non-blank task argument and remove the browsing example fallback; fail before model selection or any network request when it is absent.
- [x] 2.6 Require the configured LM Studio model and verify it matches a loaded LLM key or instance through the native endpoint; preserve its actionable errors and never choose or load a model automatically.

## 3. Responses adapter

- [x] 3.1 Move Responses client construction, request assembly, streaming and failure classification into an agent adapter while retaining existing OpenAI and LM Studio request behavior, including `stream`, `store`, effort and strict function tools.
- [x] 3.2 Convert Gremlin tools and history into Responses input, preserving the existing `toResponseInputItems` replay behavior, ordered tool outcomes and errors for unsupported items.
- [x] 3.3 Return a Gremlin-owned reply view alongside all native completed output items, and capture reported Responses usage, diagnostics and documented rate-limit headers without changing LM Studio's missing-statistics behavior.

## 4. Anthropic Messages adapter

- [x] 4.1 Construct the Anthropic client with the validated key and SDK base URL, disable SDK retries, and send native streamed Messages requests with the specified API version, model, output limit, effort and optional workspace header.
- [x] 4.2 Map instructions to system input and convert the existing ordered tools to Anthropic client tools using their unmodified draft-07 schemas without enabling strict tool use.
- [x] 4.3 Enable top-level automatic ephemeral caching with the five-minute TTL on every request and keep session instructions and tool definitions stable and ordered.
- [x] 4.4 Accumulate streaming events, partial JSON and cumulative usage; require a valid terminal `message_stop` before acting, and classify incomplete, malformed, aborted, transport and HTTP failures without running partial tool calls.
- [x] 4.5 Derive final text or ordered client-call views while retaining complete native assistant blocks, including signed thinking and redacted thinking, in their original order.
- [x] 4.6 Replay the unchanged assistant content followed immediately by one user message containing every corresponding ordered `tool_result`, matching IDs and marking failed outcomes with `is_error: true`.
- [x] 4.7 Capture every supported Anthropic usage field, response diagnostic, service tier and documented rate-limit header, including statistics available on failed or interrupted calls.
- [x] 4.8 Opt every request in to cache diagnostics against the latest reply's ID, kept in the history, and treat a finished stream's usage as complete when the fields that don't apply are left out.

## 5. Shared session and tool loop

- [x] 5.1 Select and bind one provider adapter in `createSession`, copy the starting history, and reject cross-provider or unsupported native history without silently converting it.
- [x] 5.2 Send the full replayable history through the bound adapter each step, append native responses before executing tools, and keep history stable while a yielded step is handled.
- [x] 5.3 Execute each call sequentially with existing local argument validation; record exactly one outcome per call for success, unknown tools, invalid input and handler exceptions.
- [x] 5.4 Preserve the step-limit behavior: never execute calls on the last allowed step, record a failed not-run outcome for each, yield `step_limit` and stop.
- [x] 5.5 Attach step number, elapsed time and available provider statistics to completed and failed model-call steps; retain existing final, empty, history-error, cleanup and no-throw behavior.

## 6. Statistics and logging

- [x] 6.1 Extract each documented provider rate-limit and `retry-after` header into a named typed field with its original string value; do not expose arbitrary headers or credentials.
- [x] 6.2 Preserve complete and partial reported usage, diagnostics, nulls and missing values without inventing zeroes or summing cumulative streaming counts twice.
- [x] 6.3 If providing a common token summary, derive it from provider statistics with Anthropic cache writes and reads included in input, Responses input already inclusive, and thinking or reasoning not double-counted.
- [x] 6.4 Log full provider-specific statistics, step and elapsed time for every attempted model call in pretty and JSON formats, including failures, without logging native replay data or secrets.
- [x] 6.5 Add adapter-level compile-time compatibility checks between Gremlin's inlined complete statistics types and the installed SDK usage and diagnostic types so SDK field drift is detected.

## 7. Automated tests

- [x] 7.1 Update core contract, tools, reply and history tests for Gremlin-owned types, preserved local validation and the absence of either SDK from `core` imports and dependencies.
- [x] 7.2 Test each Zod provider schema, required and invalid settings, effort and token-limit boundaries, URL and working-directory rules, optional skills, `MAX_TURNS`, aggregated errors and diagnostic formatting.
- [x] 7.3 Test missing and blank tasks and verify invalid configuration or task sends no network request; test named LM Studio models, missing and unloaded models, and no automatic fallback.
- [x] 7.4 Keep Responses and LM Studio fake-HTTP/SSE regression tests for requests, classification, strict tools, replay order, SDK helper behavior and unchanged statistics compatibility.
- [x] 7.5 Add Anthropic fake-HTTP/SSE tests for request URL, key and SDK-environment precedence, workspace header, model, effort, output limit, tools, instructions and five-minute caching.
- [x] 7.6 Test Anthropic replay of signed and redacted thinking, text, multiple calls and grouped success/error results, including streamed partial JSON and preservation of native block order.
- [x] 7.7 Test both adapters' error classifications and terminal handling, including refusal, empty output, truncation, broken streams, missing terminal events, aborts and the guarantee that incomplete calls do not run tools.
- [x] 7.8 Exercise every typed usage, diagnostic and rate-limit field, complete/partial/unavailable states, missing versus zero values, cumulative updates and logs for successful and failed calls in both formats.
- [x] 7.9 Run shared loop tests against both adapters for ordered tools, validation failures, unknown tools, handler exceptions, step limits, paused yields, provider binding, history copying and process cleanup.

## 8. CI, documentation and checks

- [x] 8.1 Update the Node CI startup smoke test to supply an explicit task and all required LM Studio settings while still asserting the expected unreachable-server error.
- [x] 8.2 Update the README with explicit provider configuration and task examples, the Anthropic SDK base URL and output limit, optional workspace ID, caching behavior, statistics and migration from prior defaults and core exports.
- [x] 8.3 Update `Brief.md` to reflect the current provider boundary, native in-memory replay, typed statistics and configuration decisions while preserving historical research.
- [x] 8.4 Run `bun run check` and the OpenSpec strict validator; fix failures, with regular Bun and Node tests using fake provider responses rather than paid API calls.
- [x] 8.5 Review surviving mutants and add targeted tests or justify equivalent mutants, then rerun `bun run mutation` against the final changes without lowering CI's 100% threshold.
