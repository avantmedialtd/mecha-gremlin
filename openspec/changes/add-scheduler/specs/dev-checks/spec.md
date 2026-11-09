## ADDED Requirements

### Requirement: The scheduler's checks run with the others
The scheduler package's `check` script SHALL run `cargo fmt --check`, `cargo clippy --all-targets --locked` with warnings denied, and `cargo test --locked`, failing when any of them fails. `bun run check` SHALL run it after the TypeScript checks. CI SHALL run the same checks in a job of their own, on Linux and on macOS.

#### Scenario: The checks include the scheduler
- **WHEN** `bun run check` runs
- **THEN** after the tests on Bun and on Node, it runs the scheduler's format check, clippy and tests

#### Scenario: A clippy warning
- **WHEN** the scheduler's code holds something clippy warns about
- **THEN** the scheduler's check fails, and so does `bun run check`

#### Scenario: CI on both systems
- **WHEN** CI runs
- **THEN** the scheduler's format check, clippy and tests run on `ubuntu-latest` and on `macos-latest`

### Requirement: Mutation testing catches every mutant in the scheduler
`bun run mutation:scheduler` SHALL run cargo-mutants over the scheduler, under the repository's memory guard, and SHALL fail when a mutant survives or times out. CI SHALL run it on Linux, and its job SHALL fail when it fails. Only an equivalent or unreachable mutant SHALL be turned off: by an `exclude_re` entry in `.cargo/mutants.toml` that matches it alone, or by `#[mutants::skip]` on a function whose every mutant is equivalent or unreachable, each with its reason in a comment on the line above.

#### Scenario: A surviving mutant
- **WHEN** a mutant of the scheduler survives its tests
- **THEN** `bun run mutation:scheduler` exits with a failure, and CI's scheduler job fails

#### Scenario: A mutant that times out
- **WHEN** a mutant makes a test hang until cargo-mutants' timeout
- **THEN** `bun run mutation:scheduler` exits with a failure

#### Scenario: A mutant that runs away with memory
- **WHEN** a mutant makes the scheduler or its tests grow past the memory guard's limit
- **THEN** the guard kills that process, and cargo-mutants goes on to the next mutant

### Requirement: The scheduler's dependencies are checked for advisories
CI SHALL run `cargo deny check advisories` over the scheduler's dependencies, report only, as it runs `bun audit`: the step SHALL show as failed when a dependency has an advisory, and the job SHALL still pass.

#### Scenario: A dependency with an advisory
- **WHEN** one of the scheduler's dependencies has a published advisory
- **THEN** CI's advisory step shows as failed, and the scheduler's job still passes
