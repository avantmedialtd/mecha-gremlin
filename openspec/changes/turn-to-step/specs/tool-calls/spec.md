## ADDED Requirements

### Requirement: Classify a model call's output
`classify(output)` SHALL classify the output items of a completed model call, the model's reply, as exactly one of:
- `calls`, when there is at least one `function_call` item: every `function_call` item, in output order, whatever text the output also holds;
- otherwise, `final`, when the text is non-empty after trimming whitespace. The text is the concatenation, in order, of every `message` item's `output_text` and `refusal` parts. The result carries the trimmed text;
- otherwise, `empty`.

#### Scenario: Calls win over text
- **WHEN** the output holds a `reasoning` item, a `message` item whose text is "\n\n", and a `function_call` item for `read_file`
- **THEN** the result is `calls` with that one call

#### Scenario: Several calls keep their order
- **WHEN** the output holds two `function_call` items, `call_a` then `call_b`
- **THEN** the result is `calls` with `call_a` then `call_b`

#### Scenario: The answer is trimmed
- **WHEN** the output holds one `message` item with the text "\n\nThe check script runs the linter."
- **THEN** the result is `final` with the text "The check script runs the linter."

#### Scenario: Text from several messages is joined
- **WHEN** the output holds two `message` items with the texts "Hello, " and "world"
- **THEN** the result is `final` with the text "Hello, world"

#### Scenario: A refusal is the answer
- **WHEN** the output holds a `message` item whose only part is a `refusal`, "I can't help with that."
- **THEN** the result is `final` with the text "I can't help with that."

#### Scenario: Nothing to act on
- **WHEN** the output holds only a `reasoning` item and a `message` item whose text is whitespace
- **THEN** the result is `empty`

## REMOVED Requirements

### Requirement: Classify a completed turn's output
**Reason**: Replaced by "Classify a model call's output". The result's type is `Reply` rather than `Turn`; its kinds don't change.
**Migration**: Use `Reply` where `Turn` was used.
