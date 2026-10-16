## Context

`bun run hello [task…]` starts the server's entry point, `packages/server/src/main/main.ts`. Since `skills-and-shell` it carries out a task with a shell, `read_file` and the skills in `SKILLS_PATH`. On 2026-10-16 its live check browsed with the playwright-cli skill on a local 9B model. "Find the title of https://example.com" answered "Example Domain" in four turns, about a minute.

The user asked to rename the script to `server`, and to make it do something that uses the playwright skill. They chose:
- **the default task:** "Use the playwright-cli skill to find the title of https://example.com";
- **how the skill is found:** explicitly, through `SKILLS_PATH` as now. The alternatives were adding `@playwright/cli` as a dependency, with `SKILLS_PATH` defaulting to its bundled skills, and a script that falls back to the global install's skills.

**Measured on 2026-10-16:**
- OpenSpec refuses a MODIFIED requirement whose scenario is retitled ("current spec contains scenario(s) not present in the modified block"), even together with a RENAMED entry.
- Bun's script shell expands `$(…)` and `${VAR:-default}`, though nothing here uses them.

## Goals / Non-Goals

**Goals:**
- `bun run server` and `bun run server:node` start the server, with the arguments and settings `hello` took.
- With no task, the server uses the playwright-cli skill to find example.com's title.
- "The hello" disappears from what people read: the spec, the README, CI, comments and test names.

**Non-Goals:**
- **Keeping `hello` as an alias.** The rename is a clean break; the README says what replaced it.
- **Finding the skill without `SKILLS_PATH`** (the user's choice).
- **Renaming the `model-hello` capability.** OpenSpec can't rename a capability, only replace every requirement in a new one, and its ID is internal.
- **Changing the Brief's records,** which describe the hello as it was when they were written.

## Decisions

**1. The scripts.**
- **Root `package.json`:**
  - `server` is `bun packages/server/src/main/main.ts`;
  - `server:node` is `node --env-file-if-exists=.env packages/server/src/main/main.ts`;
  - `hello` and `hello:node` go.
- **Unchanged:** `packages/server/package.json`'s own `start` script.

**2. The default task.**
- **Text:** `DEFAULT_TASK` in `args.ts` becomes "Use the playwright-cli skill to find the title of https://example.com".
- **Why this one:** it's quick and stable on a small local model, it exercises the whole path (activation, the shell, the browser, the sweep), and its answer is known.
- **Alternative:** the top three Hacker News stories. More useful, but stories 10 to 12 took 29 turns in the live check.

**3. Skills stay explicit.**
- **Nothing fills in `SKILLS_PATH`.** The README's Run section shows it set in `.env` before the first run:

  ```sh
  echo "SKILLS_PATH=$(npm root -g)/@playwright/cli/skills" >> .env
  ```

- **Without it,** the server offers no `activate_skill`, and the model has only the shell and `read_file` for the default task. That's the documented behaviour of an unset `SKILLS_PATH`.
- **Prerequisites,** in the README: for the default task, playwright-cli (`npm install -g @playwright/cli`) and Google Chrome, which playwright-cli drives by default.

**4. "The hello" becomes "the server" wherever people read it.**
- **Covered:** the README, the CI step and its comments, code comments (`exec/run.ts`, `exec/sweep.ts`), and test names and helpers (`startHello` becomes `startServer`).
- **Unchanged:** sample texts such as "Hello there!" in other tests and specs.

**5. The spec delta.**
- **MODIFIED:** two requirements need text changes only, "Carry out a task and log the answer" and "Log each tool call and turn".
- **Replaced (REMOVED plus ADDED):** two requirements, because OpenSpec won't retitle a scenario (Context):
  - "Run on Bun or on Node" becomes "Run the server on Bun or on Node", whose scenario is "CI starts the server on Node";
  - "Stop the session's processes when the hello ends" becomes "Stop the session's processes when the server ends", whose scenario is "No handler outlives the server".
- **Order:** OpenSpec appends added requirements. Both replaced requirements are the spec's last two already, so the order stays.

**6. Archiving.** `model-hello`'s Purpose already speaks of the server entry point; it gains the commands, `bun run server` and `bun run server:node`.

## Risks / Trade-offs

- **`bun run hello` stops working.** → The proposal marks it BREAKING, and the README's Run section shows the new commands. Nothing else in the repository runs the old scripts once CI is updated.
- **The default task depends on the network and Chrome,** where the old one read a local file. → The README lists the prerequisites. CI never runs the default task, only the Node start-up check against a closed port.
- **Without `SKILLS_PATH`, the default task may wander,** with the model guessing at playwright-cli without its instructions. → The README's Run section sets it first; the user chose explicit configuration over a default.

## Migration Plan

Run `bun run server` instead of `bun run hello`, and `bun run server:node` instead of `bun run hello:node`. Put `SKILLS_PATH` in `.env` for the default task. Rolling back means reverting the change.

## Open Questions

None.
