## ADDED Requirements

### Requirement: Run on Bun or on Node
The hello SHALL run on Bun with `bun run hello`, and on Node with `bun run hello:node`, taking the same arguments and settings. `bun run hello:node` SHALL load the `.env` file in the current directory when there is one, and SHALL start without one; other `.env` files that Bun reads, such as `.env.local`, are not read on Node. `packages/server/package.json` SHALL declare both runtimes in `engines`. CI SHALL start the hello on Node.

#### Scenario: On Node
- **WHEN** `bun run hello:node` runs with `MODEL_BASE_URL` set to `http://127.0.0.1:9/v1`, where nothing listens, and there is no `.env`
- **THEN** Node notes on stderr that `.env` wasn't found, an `error` record says LM Studio can't be reached at that URL, and the exit code is 1, as on Bun

#### Scenario: Settings from .env on Node
- **WHEN** the `.env` in the current directory sets `MODEL_PROVIDER` to `nonsense`, and the hello runs on Node with `--env-file-if-exists=.env`
- **THEN** an `error` record names `MODEL_PROVIDER`, and the exit code is 1

#### Scenario: CI starts the hello on Node
- **WHEN** CI's check job runs
- **THEN** it runs `bun run hello:node` with `MODEL_BASE_URL` set to a port where nothing listens, and fails unless the exit code is 1 and the output says LM Studio can't be reached
