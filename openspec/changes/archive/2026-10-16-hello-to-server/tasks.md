## 1. Scripts and the default task (`model-hello`)

- [x] 1.1 Root `package.json` (design decision 1):
  - `hello` becomes `server`: `bun packages/server/src/main/main.ts`;
  - `hello:node` becomes `server:node`: `node --env-file-if-exists=.env packages/server/src/main/main.ts`.

  No alias keeps the old names.
- [x] 1.2 `packages/server/src/main/args.ts`: the default task becomes "Use the playwright-cli skill to find the title of https://example.com"
- [x] 1.3 "The hello" becomes "the server" in code comments: `src/exec/run.ts`, `src/exec/sweep.ts`, and any other found with `grep -rni hello packages/*/src`. Sample texts such as "Hello there!" stay.

## 2. Tests (`model-hello`)

- [x] 2.1 `packages/server/test/main/main.test.ts`:
  - the default task's expected text;
  - `startHello` becomes `startServer`;
  - describe titles follow the spec's requirement names, such as "Stop the session's processes when the server ends";
  - "the hello" becomes "the server" in test names and comments.

  Check the other tests with `grep -rni hello packages/*/test test`. Sample texts stay.
- [x] 2.2 `bun run check` passes, and `bun run mutation` reaches 100%

## 3. CI

- [x] 3.1 `.github/workflows/ci.yml`:
  - the `NODE_VERSION` comment says Node starts the server;
  - the step becomes "Start the server on Node" and runs `bun run server:node`;
  - its comment and its `::error::` message speak of the server.

  Push with gh's credential, `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push`, because the keychain's token can't push workflow files.
- [x] 3.2 CI passes on the branch: both jobs, with the mutation job at 100%

## 4. README

- [x] 4.1 README:
  - **Run:** `bun run server` and `bun run server:node`, and what the default task does. It's preceded by setting `SKILLS_PATH` in `.env` once: `echo "SKILLS_PATH=$(npm root -g)/@playwright/cli/skills" >> .env`. Without it the default task's skill isn't loaded;
  - **Prerequisites:** for the default task, playwright-cli (`npm install -g @playwright/cli`) and Google Chrome, which playwright-cli drives by default;
  - **"The hello" becomes "the server"** throughout, including the Skills section's example, the settings, and the CI section's Node step;
  - **the sample log** stays as it is for now. The session replaces it in 5.3.

## 5. Live check (the session's)

- [x] 5.1 Against the local LM Studio, with `SKILLS_PATH` set to playwright-cli's skills and a dedicated `WORK_DIR`:
  - `bun run server` answers "Example Domain" and exits 0;
  - `bun run server:node` does the same on Node;
  - afterwards `pgrep -fl gremlin-<run>` prints nothing for either run.
- [x] 5.2 `bun run hello` fails, saying there's no such script
- [x] 5.3 Replace the README's sample log with the pretty output of 5.1's run on Bun

## 6. After archiving (the session's)

- [x] 6.1 After `openspec archive`:
  - add the commands, `bun run server` and `bun run server:node`, to `model-hello`'s Purpose;
  - check that "Run the server on Bun or on Node" and "Stop the session's processes when the server ends" are still the spec's last two requirements;
  - run `openspec validate --all --strict`.
