# dev-checks Specification

## Purpose

The repository's own checks: the tests, mutation testing and CI, and which runtime each runs on.

## Requirements

### Requirement: The tests run on Bun
`bun run test` SHALL run every test with Bun as the runtime, the runtime the app runs on. A server test SHALL fail when it runs on another runtime.

#### Scenario: The runtime the tests see
- **WHEN** `bun run test` runs
- **THEN** every test sees `process.versions.bun` set, and the server's runtime test passes

#### Scenario: A test run that slipped back to Node
- **WHEN** the server's tests run on Node
- **THEN** the server's runtime test fails, saying the tests must run on Bun

### Requirement: core's tests also run on Node
`bun run test:node` SHALL run `core`'s tests with Node as the runtime. `bun run check` and CI SHALL run it as well as `bun run test`.

#### Scenario: core on Node
- **WHEN** `bun run test:node` runs
- **THEN** only `core`'s tests run, they see `process.versions.bun` unset, and they pass

#### Scenario: The checks include it
- **WHEN** `bun run check` runs
- **THEN** it runs `core`'s tests on Node after the tests on Bun

### Requirement: Mutation testing runs on Bun and catches every mutant
`bun run mutation` SHALL run Stryker with Bun as the runtime, in Stryker's own process and in the test runs it starts, and SHALL fail when the mutation score is below 100%.

#### Scenario: The tests a mutant runs see Bun
- **WHEN** `bun run mutation` runs
- **THEN** the server's runtime test passes in its runs, and the report shows killed mutants

#### Scenario: A surviving mutant fails the run
- **WHEN** a mutant survives
- **THEN** `bun run mutation` exits with a failure

