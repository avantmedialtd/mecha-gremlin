## MODIFIED Requirements

### Requirement: Results as values
The `core` package SHALL export `Result<T, E>`, which is either `Ok<T>`, `{ ok: true, value }`, or `Err<E>`, `{ ok: false, error }`, with the constructors `ok(value)` and `err(error)`. `ok` SHALL return exactly an `Ok<T>` and `err` exactly an `Err<E>`, so a value built with one needs no check before its field is read. Every function in `core` and `agent` that reports a failure as a value, instead of throwing, SHALL return a `Result` rather than declare its own success and failure shapes.

#### Scenario: A success
- **WHEN** `ok(42)` is called
- **THEN** it returns `{ ok: true, value: 42 }`

#### Scenario: A failure
- **WHEN** `err("no such file")` is called
- **THEN** it returns `{ ok: false, error: "no such file" }`
