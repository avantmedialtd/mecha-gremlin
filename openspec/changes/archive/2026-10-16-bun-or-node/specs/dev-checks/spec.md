## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Mutation testing runs on Bun and catches every mutant
`bun run mutation` SHALL run Stryker with Bun as the runtime, in Stryker's own process and in the test runs it starts, with `TEST_RUNTIME` set to `bun`. It SHALL fail when the mutation score is below 100%.

#### Scenario: The tests a mutant runs see Bun
- **WHEN** `bun run mutation` runs
- **THEN** the runtime test passes in its runs, the tests of both implementations in each runtime package run, and the report shows killed mutants

#### Scenario: A surviving mutant fails the run
- **WHEN** a mutant survives
- **THEN** `bun run mutation` exits with a failure

## REMOVED Requirements

### Requirement: The tests run on Bun
**Reason**: Replaced by "The tests run on Bun and on Node". The tests now run on both runtimes, and the runtime test checks the one each script names.
**Migration**: None needed: `bun run test` still runs every test on Bun.

### Requirement: core's tests also run on Node
**Reason**: Replaced by "The tests run on Bun and on Node". Every package's tests now run on Node, not only `core`'s.
**Migration**: None needed: `bun run test:node` now runs the whole suite on Node, `core`'s tests included.
