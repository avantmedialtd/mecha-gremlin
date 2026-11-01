## 1. The task's source

- [ ] 1.1 Move `parse` and `refusalsOf` from `packages/agent/src/main/mcp-args.ts` to a module of their own in `src/main/`. It takes the sentences that end a refusal, one for an unknown option and one for a value, and suggests `--<name>=<value>`, by the long name, for a value that starts with `-`. `mcp-args.ts` passes `UNKNOWN_IN_ADD` or `SEE_HELP` as now, and its messages don't change.
- [ ] 1.2 Export `read`'s binary test from `src/tools/read.ts` as a function of the bytes: a NUL byte in the first 8 KiB means binary. Use it in `read`.
- [ ] 1.3 Rewrite `src/main/args.ts` to take the task from a file or from `--prompt`. The details:
  - **Parsing:** a task file as the one positional argument, or `--prompt` or `-p`, parsed through 1.1's module;
  - **Refusals:** those in the delta's first requirement, with errors that end with one usage sentence showing both forms;
  - **Resolving:** the file resolves against `process.cwd()`. Its name and its real path must not be a `.env*` file's, and its real path must not be inside the data folder, when one is given;
  - **Reading:** once, then probed with 1.2's test, decoded as UTF-8 and trimmed;
  - **The result:** `Result<{ text, file }, string>`, with `file` the absolute path, or `undefined` for `--prompt`.

## 2. The run

- [ ] 2.1 In `src/main/main.ts`, await the task after `loadConfig`, passing the data folder when the configuration gave one. Report the task's problem with the configuration's, before skills load and the store opens.
- [ ] 2.2 Add `taskFile` to the `asking` record, beside `task`.

## 3. Tests

- [ ] 3.1 In `test/main/main.test.ts`, give the runs' default arguments as `['-p', TEST_TASK]`. Test the delta's new and changed scenarios there:
  - no task;
  - a task from the arguments, with `-p` and with `--prompt`;
  - a task from a file, and its frontmatter;
  - a missing file, and a binary or blank one;
  - `.env`, a link to it, and a file in `DATA_DIR`;
  - one way to give the task;
  - the task's problems with the configuration's;
  - the `asking` record with and without `taskFile`.
- [ ] 3.2 Test the parser on its own, beside the module of 1.3, with files in a temporary directory, and move `test/config/explicit-config.test.ts`'s task test there. Test 1.1's module through both commands: the `mcp` command's messages unchanged, and `-p` given a value that starts with `-`.

## 4. Documentation and checks

- [ ] 4.1 Update the README:
  - the usage section's examples and its description of the command, with a task file and `-p`;
  - the note on quoting, now about `-p`'s value;
  - the examples in "Running with servers" and "Skills".
- [ ] 4.2 Give CI's start-up check in `.github/workflows/ci.yml` its task with `-p`.
- [ ] 4.3 Add a line to the Brief's log saying that `read-task-file` carries out D39 and D40, by category only.
- [ ] 4.4 Run these, and fix what fails:
  - `bun run check`;
  - a scoped `bun run mutation`, at 100%, over `src/main/args.ts`, 1.1's module, `src/main/mcp-args.ts`, `src/tools/read.ts` and `src/main/main.ts`;
  - `openspec validate read-task-file --strict`.
