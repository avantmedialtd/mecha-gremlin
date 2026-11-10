# dev-checks Specification

## Purpose

The repository's own checks: the tests, mutation testing and CI, which runtime each runs on, and the Rust scheduler's checks beside them.
## Requirements
### Requirement: The tests run on Bun and on Node
`bun run test` SHALL run every test with Bun as the runtime, and `bun run test:node` SHALL run every test with Node. Each script SHALL name its runtime in `TEST_RUNTIME`, as `bun` or `node`, and a test SHALL fail unless the tests run on the runtime `TEST_RUNTIME` names. Tests of an implementation that needs Bun SHALL run only on Bun, and Node's run SHALL report them as skipped. `bun run check` and CI SHALL run both scripts.

#### Scenario: On Bun
- **WHEN** `bun run test` runs
- **THEN** every test runs and sees `process.versions.bun` set, and they all pass, the runtime test included

#### Scenario: On Node
- **WHEN** `bun run test:node` runs
- **THEN** every package's tests run with `process.versions.bun` unset, the Bun-only tests are reported as skipped, and the rest pass

#### Scenario: A script that slipped to the other runtime
- **WHEN** the tests run on Node with `TEST_RUNTIME` set to `bun`, or on Bun with it set to `node`
- **THEN** the runtime test fails, and its message names both runtimes

#### Scenario: Tests run without a script
- **WHEN** the tests run with `TEST_RUNTIME` unset, or set to anything but `bun` or `node`
- **THEN** the runtime test fails, saying to run the tests with `bun run test` or `bun run test:node`

#### Scenario: The checks include both
- **WHEN** `bun run check` runs
- **THEN** it runs the tests on Bun, then on Node

### Requirement: Mutation testing runs on Bun and catches every mutant
`bun run mutation` SHALL run Stryker with Bun as the runtime, in Stryker's own process and in the test runs it starts, with `TEST_RUNTIME` set to `bun`. It SHALL fail when the mutation score is below 100%.

#### Scenario: The tests a mutant runs see Bun
- **WHEN** `bun run mutation` runs
- **THEN** the runtime test passes in its runs, the tests of both implementations in each runtime package run, and the report shows killed mutants

#### Scenario: A surviving mutant fails the run
- **WHEN** a mutant survives
- **THEN** `bun run mutation` exits with a failure

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
`bun run mutation:scheduler` SHALL run cargo-mutants over the scheduler, under the repository's memory guard, and SHALL fail when a mutant survives or times out. CI SHALL run it on Linux, and its job SHALL fail when it fails. Only an equivalent or unreachable mutant SHALL be turned off: by an `exclude_re` entry in `.cargo/mutants.toml` that matches it alone, or by `#[mutants::skip]` on a function whose every mutant is equivalent or unreachable, each with its reason in a comment on the line above. The one exception SHALL be the two functions that hand the scheduler's `install` and `uninstall` the real `launchctl` and home directory, which SHALL carry `#[mutants::skip]` with that reason, since no test may call them (Requirement: The scheduler's tests leave the machine's launchd alone).

#### Scenario: A surviving mutant
- **WHEN** a mutant of the scheduler survives its tests
- **THEN** `bun run mutation:scheduler` exits with a failure, and CI's scheduler job fails

#### Scenario: A mutant that times out
- **WHEN** a mutant makes a test hang until cargo-mutants' timeout
- **THEN** `bun run mutation:scheduler` exits with a failure

#### Scenario: A mutant that runs away with memory
- **WHEN** a mutant makes the scheduler or its tests grow past the memory guard's limit
- **THEN** the guard kills that process, and cargo-mutants goes on to the next mutant

### Requirement: The scheduler's tests leave the machine's launchd alone
No test of the scheduler SHALL run `launchctl` or write in the real `~/Library/LaunchAgents`, in `bun run check`, in `bun run mutation:scheduler` or in CI. `install` and `uninstall` SHALL be tested against a fake runner and a temporary home, and the binary's tests SHALL NOT run them.

#### Scenario: Checks on a Mac
- **WHEN** `bun run check` or `bun run mutation:scheduler` runs on a Mac
- **THEN** no LaunchAgent is written, loaded or removed

#### Scenario: A mutant of install
- **WHEN** a mutant of `install` drops one of its checks
- **THEN** its tests still call only the fake runner, and it writes only in the tests' temporary folders

### Requirement: The scheduler's dependencies are checked for advisories
CI SHALL run `cargo deny check advisories` over the scheduler's dependencies, report only, as it runs `bun audit`: the step SHALL show as failed when a dependency has an advisory, and the job SHALL still pass.

#### Scenario: A dependency with an advisory
- **WHEN** one of the scheduler's dependencies has a published advisory
- **THEN** CI's advisory step shows as failed, and the scheduler's job still passes

