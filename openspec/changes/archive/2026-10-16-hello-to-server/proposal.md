## Why

The entry point is still called "the hello", a name from the first bootstrap change, and with no task it asks what `package.json`'s check script runs. Since `skills-and-shell`, it carries out tasks with a shell and skills, and the point of that change was browsing with the playwright-cli skill. `bun run server`, with a default task that uses the skill, says what the server is for and shows it working.

## What Changes

- **BREAKING: the scripts are renamed.**
  - `bun run hello` becomes `bun run server`.
  - `bun run hello:node` becomes `bun run server:node`.

  The arguments and settings don't change, and no alias keeps the old names.
- **The default task uses the playwright-cli skill:** "Use the playwright-cli skill to find the title of https://example.com" replaces the question about the check script.
- **Skills stay explicit.** Nothing fills in `SKILLS_PATH`: the README says to set it in `.env` to playwright-cli's skills. Without it, the default task's skill isn't loaded, and the model has only the shell and `read_file`.
- **"The hello" becomes "the server"** in the spec, the README, CI, code comments and test names. The `model-hello` capability keeps its name.
- **CI:** the Node step becomes "Start the server on Node", running `bun run server:node`.
- **README:**
  - the run examples;
  - the prerequisites for the default task: playwright-cli and Google Chrome;
  - `SKILLS_PATH` in `.env`;
  - a sample log from a real run of the new default task.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `model-hello`:
  - the commands are `bun run server` and `bun run server:node`;
  - with no task, the server uses the playwright-cli skill to find example.com's title;
  - "the hello" becomes "the server".

  Two requirements are replaced to rename them and their scenarios: "Run on Bun or on Node", and "Stop the session's processes when the hello ends".

## Impact

- **Code:**
  - `package.json`'s scripts;
  - the default task in `packages/server/src/main/args.ts`;
  - the comments in `src/exec/run.ts` and `src/exec/sweep.ts`;
  - the tests that name the hello or its default task;
  - the CI workflow;
  - the README.
- **Dependencies:** none.
- **Users:** `bun run hello` stops working; use `bun run server`.
- **Builds on** `skills-and-shell`, which isn't on `main` yet: this branch starts from it.
