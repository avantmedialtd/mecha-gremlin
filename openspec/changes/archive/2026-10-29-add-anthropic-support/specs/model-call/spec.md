## MODIFIED Requirements

### Requirement: Call the model once, streamed and stateless
The agent's provider adapters SHALL offer a provider-neutral model-call operation using Gremlin-owned request, result and error types declared by `@mecha-gremlin/core/model-call`. The operation SHALL make exactly one streamed model request through the selected provider's client and SHALL resolve to a `Result` instead of throwing for model, HTTP or transport failures. The session SHALL own and send the conversation history on each call. The Responses adapter SHALL send `stream: true` and default `store` to `false` when the request doesn't set it; a caller's explicit `store: true` SHALL be retained. The Anthropic adapter SHALL use its native Messages API as `anthropic-messages` specifies.

#### Scenario: Responses request is streamed and stateless by default
- **WHEN** a Responses model call is made with a request that sets neither `stream` nor `store`
- **THEN** the HTTP request to `/responses` has `stream: true` and `store: false`

#### Scenario: Caller's explicit Responses store setting is kept
- **WHEN** a Responses model call explicitly sets `store: true`
- **THEN** the request has `store: true`

#### Scenario: Anthropic uses its native protocol
- **WHEN** the selected provider is `anthropic`
- **THEN** the call uses the Anthropic SDK's streamed Messages API and not `/responses` or Chat Completions

### Requirement: Return the reply text and usage when the call completes
When the provider's stream completes successfully, the operation SHALL return `ok(value)` carrying a Gremlin-owned view of the reply, the provider's native replay data and complete provider-specific statistics. For Responses, the reply text SHALL be the concatenation of every `output_text` part of every `message` item, in order; the native replay data SHALL retain every completed output item. For Anthropic, the native replay data SHALL retain the reply's ID and its complete assistant content blocks, in order, and the reply view SHALL use the text and client tool-use blocks as `anthropic-messages` specifies. Reasoning and thinking blocks SHALL NOT be included in the answer text. The native data SHALL be kept in the session history rather than only in the provider client.

#### Scenario: Completed Responses call
- **WHEN** a Responses stream completes with message text "Hello there!" and 12 output tokens
- **THEN** the result is `ok: true`, its reply text is "Hello there!", and its typed Responses usage reports 12 output tokens

#### Scenario: Reasoning is not answer text
- **WHEN** a completed response contains a reasoning or thinking block followed by text "Hi!"
- **THEN** the reply text is "Hi!" and the native replay data still contains the reasoning or thinking block

#### Scenario: Native content is kept rather than reconstructed
- **WHEN** an Anthropic reply contains thinking with a signature, text and a tool-use block
- **THEN** the result retains the complete native blocks in their original order and separately provides a tool-call view for the loop

### Requirement: Classify a call's failures as values
The model-call operation SHALL return `err(error)` instead of throwing, where `error` has `kind` and `detail`, and HTTP failures also have `status`. The kind SHALL be `unreachable`, `timeout`, `auth`, `rate_limit`, `bad_request`, `server_error`, `incomplete`, `failed`, `aborted` or `fatal`. Classification SHALL use the HTTP status, the error's class name including inherited classes, and the caller's abort signal, not `instanceof` checks. A failed or incomplete call SHALL also expose any provider statistics and headers received, identifying partial usage as partial; it SHALL NOT report missing values as zero. The session SHALL retain the call's step number and elapsed time even when no usage arrives.

#### Scenario: Endpoint not reachable
- **WHEN** the connection fails before any HTTP response
- **THEN** the result is `ok: false` with error kind `unreachable` and no invented usage

#### Scenario: Authentication rejected
- **WHEN** the endpoint answers HTTP 401
- **THEN** the result is `ok: false` with error kind `auth` and status 401

#### Scenario: Server error
- **WHEN** the endpoint answers HTTP 500
- **THEN** the result is `ok: false` with error kind `server_error` and status 500

#### Scenario: Response ends incomplete
- **WHEN** a Responses stream ends with `response.incomplete` or Claude stops at `max_tokens` or `model_context_window_exceeded`
- **THEN** the result has error kind `incomplete` and its detail names the reason when supplied

#### Scenario: Response fails mid-stream
- **WHEN** the stream reports a failure or breaks after it has started
- **THEN** the result has error kind `failed` and its detail contains the available error message

#### Scenario: Stream ends without a terminal event
- **WHEN** a stream ends without the provider's required terminal event
- **THEN** the result has error kind `failed` and no tool in that incomplete response runs

#### Scenario: Caller aborts
- **WHEN** the caller's abort signal fires during the call
- **THEN** the result has error kind `aborted`

#### Scenario: An incomplete call has reported usage
- **WHEN** a provider reports token usage and then ends the call incomplete
- **THEN** the result exposes the reported usage with its actual completeness and the session exposes the step's number and elapsed time

### Requirement: Core stays free of configuration and side effects
The `core` package SHALL NOT read environment variables, write to stdout or stderr, or construct API clients. Its source and public declarations SHALL NOT import either `openai` or `@anthropic-ai/sdk`, including type-only imports. Its dependencies, peer dependencies and development dependencies SHALL name neither SDK. Types needed by the shared loop, history, tools, model call and provider statistics SHALL be declared by Gremlin rather than aliased to an SDK type. SDK clients and protocol conversion SHALL reside in the agent's provider adapters.

#### Scenario: Core has no provider SDK dependency
- **WHEN** `packages/core` source and `package.json` are inspected
- **THEN** they contain no import or dependency on either provider SDK, and no reference to `process.env`, `Bun.env` or `console`

## ADDED Requirements

### Requirement: Expose complete, typed provider statistics
Each model call SHALL expose a Gremlin-owned, provider-discriminated statistics type with named, statically typed fields for every statistic reported by the supported Responses or Anthropic Messages protocol. It SHALL retain the complete provider usage object and the provider's reported usage-related response diagnostics and service tier, with their native field meanings and nullability. Responses usage SHALL include `input_tokens`, `input_tokens_details.cached_tokens`, `input_tokens_details.cache_write_tokens`, `output_tokens`, `output_tokens_details.reasoning_tokens` and `total_tokens`. Anthropic usage SHALL include `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, the `cache_creation` 5-minute and 1-hour counts, `output_tokens_details.thinking_tokens`, `server_tool_use` web-search and web-fetch counts, `inference_geo`, `service_tier` and `speed`. The inlined types SHALL cover every field of the installed SDK's corresponding usage and response diagnostic types, not merely this list.

The statistics SHALL also contain individually named, typed fields for documented rate-limit headers when received: Responses request, token and project-token limit, remaining and reset headers; Anthropic request, total-token, input-token, output-token, priority-input, priority-output, fast-input and fast-output limit, remaining and reset headers; and `retry-after`. Header values SHALL retain the reported strings. Other HTTP headers and credentials SHALL NOT be exposed as statistics. A partial usage object SHALL have a distinct typed state from complete and unavailable usage, with fields present only when actually received.

Any provider-neutral summary SHALL be additional to, not a replacement for, the provider-specific fields. Anthropic total input SHALL count uncached input, cache writes and cache reads; Responses input already includes cached input. Reasoning or thinking tokens SHALL NOT be added to output a second time. Unreported values SHALL remain absent or null as reported, not zero. Compatibility of missing LM Studio usage fields is not expanded by this requirement.

#### Scenario: Complete Anthropic usage retains every breakdown
- **WHEN** Claude returns uncached input 400, cache writes 100, cache reads 500, a 5-minute write count, output and thinking counts, server-tool counts, service tier and speed
- **THEN** the Anthropic statistics expose every reported field under named typed properties, and any total-input summary is 1,000

#### Scenario: Responses usage retains cache writes
- **WHEN** a Responses endpoint reports both cached and cache-write tokens and reasoning tokens
- **THEN** its typed statistics expose all three values as well as the input, output and total counts

#### Scenario: Reported rate-limit headers
- **WHEN** the Anthropic response carries `anthropic-ratelimit-input-tokens-remaining` and `retry-after`
- **THEN** both appear in their named Anthropic statistics fields with their original string values

#### Scenario: Missing and zero differ
- **WHEN** a provider reports zero cached tokens in one call and does not report that statistic in another
- **THEN** the first is exposed as zero and the second is absent or null, as received

#### Scenario: Provider-specific fields type-check
- **WHEN** a consumer narrows the statistics to the Anthropic variant
- **THEN** the Anthropic usage and diagnostic fields have their declared types, and Responses-only fields are not presented as Anthropic fields

#### Scenario: SDK statistics evolve
- **WHEN** an installed SDK's usage or diagnostic type gains a field
- **THEN** adapter-level compile-time compatibility checks identify any missing Gremlin-owned field without requiring an SDK dependency in `core`
