# anthropic-messages Specification

## Purpose
The agent's Claude adapter for Anthropic's native Messages API: the request it sends, the client tools it offers, how it replays assistant blocks and tool results, its prompt caching and cache diagnostics, and how it handles complete and incomplete streams.
## Requirements
### Requirement: Send a native streamed Messages request
With `MODEL_PROVIDER=anthropic`, the agent SHALL use `@anthropic-ai/sdk` 1.x and the `2026-10-21` Messages API to call the configured model at `{MODEL_BASE_URL}/v1/messages`, using the explicitly configured API key, output-token limit and reasoning effort. It SHALL stream the response, disable SDK retries, and send the task instructions as the system input. The Anthropic base URL SHALL be the SDK's origin or proxy prefix, not an automatically appended `/v1` URL. When `ANTHROPIC_WORKSPACE_ID` is configured the request SHALL carry `anthropic-workspace-id`; otherwise the agent SHALL NOT invent one.

#### Scenario: Configured request
- **WHEN** the provider is `anthropic`, the base URL is `https://api.anthropic.com`, the model is `claude-test`, the output limit is 4096 and the effort is `medium`
- **THEN** the request goes to `https://api.anthropic.com/v1/messages`, streams, names `claude-test`, sends `max_tokens` 4096 and `output_config.effort` `medium`, and uses the configured API key

#### Scenario: Workspace-scoped request
- **WHEN** `ANTHROPIC_WORKSPACE_ID` is set
- **THEN** every Claude Messages request carries that value in `anthropic-workspace-id`

#### Scenario: Explicit configuration wins
- **WHEN** the SDK's own API-key or base-URL environment variables conflict with the validated Gremlin configuration
- **THEN** the request uses Gremlin's configured key and base URL

### Requirement: Offer the existing client tools with local validation
The adapter SHALL offer Gremlin's tools as Anthropic client tools, in the session's existing order, with each tool's name, description and draft-07 input JSON Schema. It SHALL NOT enable Anthropic strict tool use or remove schema constraints merely to fit strict mode. The loop SHALL validate every returned tool input with the existing Standard Schema validator before running its handler. Invalid arguments and unknown tools SHALL be returned as failed tool results; a handler that throws SHALL remain a recoverable tool failure.

#### Scenario: Paging constraints remain visible
- **WHEN** Claude is offered `read`
- **THEN** its input schema retains the positive-integer constraints for `offset` and `limit`, and the tool does not request Anthropic strict mode

#### Scenario: Invalid arguments do not run a handler
- **WHEN** Claude calls `read` with arguments that fail its local schema
- **THEN** the handler does not run and the next request returns the validation error as a tool result with `is_error: true`

### Requirement: Replay complete assistant blocks and grouped tool results
After a completed Claude message, the history SHALL retain its native assistant content blocks in their original order, including text, tool use, thinking, redacted thinking and signatures. For every client tool-use block, the session SHALL record exactly one outcome. Before the next Claude call, the adapter SHALL send the unchanged assistant blocks followed immediately by one user message containing all corresponding `tool_result` blocks in call order, with the matching `tool_use_id`. A failed outcome SHALL set `is_error: true`; a successful outcome SHALL carry the handler's text. No client tool result SHALL be omitted or duplicated. No unsupported server-side tool SHALL be treated as a Gremlin client call.

#### Scenario: Two calls with thinking
- **WHEN** Claude returns a signed thinking block, text, `tool_use` A and `tool_use` B, and both tools run
- **THEN** the next request replays all four assistant blocks unchanged and its immediately following user message contains results A and B in order

#### Scenario: A tool fails
- **WHEN** the first tool outcome is a failure and the second succeeds
- **THEN** the first result has `is_error: true`, the second contains its successful text, and Claude is called again

#### Scenario: Step limit prevents execution
- **WHEN** Claude asks for two tools on the session's last permitted step
- **THEN** neither handler runs and history records one failed not-run result for each call

### Requirement: Cache the growing Claude prompt
Every Claude request in the session SHALL enable top-level automatic prompt caching with `cache_control` of type `ephemeral` and TTL `5m`. Tool definitions and system instructions SHALL remain identical and in the same order for the session. The agent SHALL expose actual reported cache-read and cache-write statistics but SHALL NOT assume a cache hit, since provider thresholds and cache lifetime apply.

Every Claude request SHALL also opt in to cache diagnostics with `diagnostics.previous_message_id`: `null` when the history holds no Claude reply, otherwise the ID of the latest reply. The history SHALL keep each reply's ID with its content blocks; a reply without a string ID SHALL leave the next request at `null` rather than fail. The reported diagnostics SHALL be exposed with the call's statistics.

#### Scenario: A multi-step request uses the cache policy
- **WHEN** a Claude session makes two model calls
- **THEN** both requests carry the five-minute automatic cache policy and identical tools and system instructions

#### Scenario: Diagnostics compare each request with the previous reply
- **WHEN** a Claude session makes two model calls
- **THEN** the first request sends `diagnostics.previous_message_id` as `null` and the second sends the first reply's ID

#### Scenario: Prefix too short for caching
- **WHEN** Claude reports zero cache reads and writes for a short prompt
- **THEN** the agent reports those zeroes without treating the call as a failure or claiming a cache hit

### Requirement: Handle complete and incomplete Claude streams safely
The adapter SHALL accumulate the streamed message and require the terminal `message_stop` before acting on it. A completed `end_turn` with text SHALL yield a final answer, and a completed `tool_use` with client tool blocks SHALL yield those calls. A refusal with text SHALL yield that text. `max_tokens` and `model_context_window_exceeded` SHALL yield an `incomplete` failure; a stream error, missing terminal event, malformed tool-use stop or unsupported stop SHALL yield a classified failure. No tool SHALL run from an incomplete or broken response. The adapter SHALL preserve available partial statistics and treat streaming usage updates as cumulative, not additive. Usage from a stream that reached `message_stop` SHALL be complete when it reports both token counts and every reported field is well formed. A field the API leaves out because it does not apply SHALL stay absent and SHALL NOT make the usage partial.

#### Scenario: Truncated tool input
- **WHEN** Claude stops at `max_tokens` while producing a tool-use input
- **THEN** the call fails as incomplete, no tool runs, and any reported usage is exposed

#### Scenario: Stream breaks after partial usage
- **WHEN** a Claude stream reports input usage and then fails before `message_stop`
- **THEN** the call fails, no tool runs, and the received usage is exposed as partial

#### Scenario: Fields that don't apply are left out
- **WHEN** a completed stream reports token and cache counts but no server-tool or thinking-token details
- **THEN** the usage is complete, and those fields are absent rather than null or zero

#### Scenario: Cumulative usage is not summed twice
- **WHEN** successive message-delta events report cumulative output counts 10 and 25
- **THEN** the final reported output count is 25, not 35

#### Scenario: Refusal is visible
- **WHEN** Claude completes a refusal with text
- **THEN** the final result presents that text rather than treating it as an empty answer

