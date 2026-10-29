## Why

Gremlin can run its own tools with OpenAI and LM Studio, but its loop, history and public core types are tied to the OpenAI Responses API. Adding Claude through Anthropic's Messages API needs a provider boundary that keeps Gremlin in charge of the loop, preserves each provider's replay data, and exposes the statistics each provider reports without flattening them away.

## What Changes

- Add direct Claude API-key support through the official `@anthropic-ai/sdk`, with streaming, the existing tools, signed thinking and tool-result replay, and automatic five-minute prompt caching. The provider's own client tools are not substituted for Gremlin's.
- **BREAKING:** replace OpenAI SDK types in the core library's public contracts with Gremlin-owned, inlined types. Move SDK-specific request, replay and stream handling behind Responses and Anthropic adapters; `core` depends on neither SDK.
- Keep native replay data in the in-memory session history, opaque to the rest of Gremlin, complete and ordered. A session is bound to one provider and cannot replay another provider's native history.
- Expose every reported, known provider statistic in explicitly typed, provider-specific structures, including complete usage and reported diagnostics and rate-limit fields. A common summary may be derived without replacing the provider's data; missing and partial data remain distinguishable.
- **BREAKING:** validate configuration with provider-specific Zod schemas. Require an explicit provider, model, API key, base URL, reasoning effort and operational settings; require a per-call output-token limit for Anthropic. Do not silently supply configuration defaults, except the explicitly chosen Anthropic cache policy. LM Studio checks that the named model is loaded and never selects the first one itself.
- **BREAKING:** a task argument is required. Running without one fails rather than starting the example browsing task.
- Update the README, tests and CI for explicit settings, and run the existing agent behavior against both provider adapters without paid calls in the regular test suite.

## Capabilities

### New Capabilities

- `anthropic-messages`: the native Claude Messages adapter, including request configuration, streaming, caching, tool round trips and replay of native content.

### Modified Capabilities

- `model-call`: a provider-neutral call contract, Gremlin-owned types, classified failures, and complete typed provider statistics.
- `tool-calls`: provider-neutral tool definitions, replies and history, with provider-specific wire conversion outside `core`.
- `agent-loop`: one provider-bound session and the shared tool-execution loop with native replay data and typed statistics.
- `agent`: explicit task and configuration, Anthropic selection and settings, named LM Studio models, and complete model-call logs.
- `structured-log`: require an explicit log format rather than defaulting it, while retaining actionable startup errors.

## Impact

- `packages/core`: replace OpenAI-dependent exports and remove its OpenAI peer and development dependencies; retain its stateless and configuration-free boundary.
- `packages/agent`: add the Anthropic SDK and provider adapters; change configuration, session, model-call logging and argument handling. The existing `openai` SDK remains here for Responses endpoints.
- Consumers of the current OpenAI-shaped `core` exports and existing environment files must migrate. CI's Node startup check must provide explicit settings and a task.
- Update tests, README and the Brief's current design and decisions. Keep the earlier research as historical context.
- Not in scope: database persistence; switching providers within a session or converting histories between them; new OpenAI encrypted-reasoning behavior; fixing LM Studio's missing statistics; Claude subscription/OAuth authentication; native Anthropic server tools; new retry or cost-budget policy.
