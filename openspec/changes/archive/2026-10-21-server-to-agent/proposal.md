## Why

`packages/server` serves nothing. It takes one task, runs the agent loop, logs the answer and exits, and nothing listens. The name came from `hello-to-server`, and "server" already means two other things here: the model server it calls (LM Studio, `lms server start`, "The model server at …"), and the exec server that C3 and 4.1 put in the workspace container at M1. What the package runs is an agent, so that's its name. When M1 comes, the scheduler, the database and the `gremlin` CLI go in a new `packages/app`, which runs agents, so this name won't need to change again.

## What Changes

- **BREAKING: the scripts are renamed.**
  - `bun run server` becomes `bun run agent`.
  - `bun run server:node` becomes `bun run agent:node`.

  The arguments and settings don't change, and no alias keeps the old names.
- **The package moves:** `packages/server` becomes `packages/agent`, and `@mecha-gremlin/server` becomes `@mecha-gremlin/agent`.
- **"The server" becomes "the agent"** wherever it means this program: the specs, the README, CI, code comments, test names and test helpers. Where the OS process is meant, the text says "the agent's process" or "the agent process", so the model is never read as "the agent".
- **Every remaining "server" means the model server, and says so.** The failure table in the specs reads "the model server", not "the server". Mentions that are already unambiguous don't change: `lms server start`, `server_error`, failure.ts's "The model server at …", and the tests' `FakeServer`.
- **CI:** the Node step becomes "Start the agent on Node", running `bun run agent:node`.
- **The `server` capability becomes `agent`** after archiving, by moving its folder, as `model-hello` became `server` (85cbb50).
- **Brief.md:**
  - D22 records the name;
  - 4.2's layout puts `agent/` between `core/` and `app/`;
  - a dated line at the top points to both.

  Its records stay as they were written.

## Capabilities

### New Capabilities
None. `agent` is `server` under a new name, moved after archiving.

### Modified Capabilities
- `server`:
  - the commands are `bun run agent` and `bun run agent:node`;
  - "the server" becomes "the agent" in every requirement;
  - the failure table says "the model server";
  - `packages/agent/package.json` declares the runtimes.

  Two requirements are replaced, to rename them and their scenarios: "Run the server on Bun or on Node", and "Stop the session's processes when the server ends".
- `agent-loop`: `createSession` takes the agent's configuration, and chooses the model as the agent does.
- `read-file-tool`, `skills` and `structured-log`: "the server" becomes "the agent".
- `shell-tool`: "the server" becomes "the agent", and its environment and process become "the agent process's".
- `result`: the packages whose functions report failures as values are `core` and `agent`.

## Impact

- **Code:**
  - `git mv packages/server packages/agent`, with its `package.json`'s name and description;
  - the root `package.json`'s scripts;
  - `bun.lock`'s workspace entries;
  - the comments in `src/config`, `src/exec` and `test/signal-guard.ts`;
  - the tests' helpers, names and temp-directory prefixes.
- **Unchanged:** the vitest, Stryker and tsconfig globs, which match `packages/*`.
- **Also changes:** the CI workflow, the README and Brief.md.
- **Dependencies:** none.
- **Users:** `bun run server` stops working; use `bun run agent`.
