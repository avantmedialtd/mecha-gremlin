## MODIFIED Requirements

### Requirement: Create a session from the configuration
The server SHALL provide an async `createSession(config, options)`. It takes the server's configuration, plus a list of tools each paired with a handler, and a starting history. It SHALL:
- choose the model as the server's model choice describes: LM Studio's loaded model, or `MODEL` for another provider;
- build its own `openai` client from the configuration's base URL and API key;
- send the configured reasoning effort, when there is one, with every turn.

When the caller sets a turn limit that isn't a positive integer, it SHALL resolve to `err(reason)` naming the limit, before it chooses the model, so no request at all is sent. When no model can be chosen, it SHALL resolve to `err(reason)`, and no turn is sent. Otherwise it SHALL resolve to `ok(session)`, where the session has:
- `model`: the chosen model;
- `note`: when the model was picked out of several, which one, and how to pick another;
- `steps`: an async generator of the session's steps;
- `history`: the session's history. It starts as a copy of the starting history, which is left unchanged, and grows as the session runs.

#### Scenario: Another provider's configured model
- **WHEN** the provider is `openai` and `MODEL` is `test-model`
- **THEN** the session's model is `test-model`, and every request names it

#### Scenario: LM Studio's loaded model
- **WHEN** the provider is `lmstudio` and LM Studio has `prism-ml/bonsai-27b` loaded
- **THEN** the session asks LM Studio's native models endpoint first, its model is `prism-ml/bonsai-27b`, and every request names it

#### Scenario: No model to use
- **WHEN** the provider is `lmstudio` and LM Studio has no model loaded
- **THEN** `createSession` resolves to `ok: false` with an error that suggests `lms load`, and no turn is sent

#### Scenario: A turn limit that isn't a positive integer
- **WHEN** the caller sets the turn limit to 0, -1, 2.5, `NaN` or `Infinity`
- **THEN** `createSession` resolves to `ok: false` with an error naming the limit, and no request is sent, not even to LM Studio's models endpoint

#### Scenario: The client comes from the configuration
- **WHEN** a session runs with a configuration whose base URL is `http://model.test/v1` and whose key is `test-key`
- **THEN** every request goes to `http://model.test/v1/responses` with the bearer key `test-key`

#### Scenario: The reasoning effort comes from the configuration
- **WHEN** the configuration's reasoning effort is `low`
- **THEN** every request carries `reasoning.effort` `low`, and with no effort configured no request carries `reasoning`

#### Scenario: The starting history is copied
- **WHEN** a session runs to its end
- **THEN** the array passed as its starting history is unchanged
