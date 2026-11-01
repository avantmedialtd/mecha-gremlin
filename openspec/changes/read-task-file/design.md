## Context

- **How the task arrives today.** `main/args.ts`'s `parseArgs` joins the arguments with spaces and trims them. `main.ts` logs its error together with `loadConfig`'s, and exits before skills load, before the store opens and before any request. The `asking` record logs the text as `task`.
- **How the `mcp` command parses.** It uses `node:util`'s `parseArgs`, strictly. On failure it reads the same arguments leniently to name the option it refused (`mcp-args.ts`'s `parse` and `refusalsOf`). All its options are long.
- **What `read` refuses.** Through `tools/fence.ts`, it refuses `.env*` files and the data folder, by the name as given and by the real path. It also refuses binary files by Git's test, a NUL byte in the first 8 KiB (`readHead`).
- **Where relative paths start.** `bun run` starts the agent in the repository's root, whatever directory the command was typed in, and sets no `INIT_CWD` (Brief R19). `loadConfig` resolves `WORK_DIR` against `process.cwd()`, which the run's tests mock.
- **`parseArgs` and a short option.** Measured on Bun 1.4.4 and Node 26.12.1, it treats a short string option the same on both:
  - `-p 'Say hi'` and `-pSay` give the value;
  - `-p=-x` gives `=-x`, so a value that starts with `-` has to be given as `--prompt=-x`;
  - `-p -x` and a bare `-p` throw;
  - a second `-p` silently replaces the first.

## Goals / Non-Goals

**Goals:**
- `bun run agent <file>` as the normal way, with the file's text as the task (D39, D40).
- `--prompt <task>`, or `-p <task>`, for a task typed inline.
- Every mistake in giving the task caught before any request, with an error that names both forms, beside the configuration's problems.
- Nothing the file tools refuse reaching the model, or the log, as the task.

**Non-Goals:**
- stdin, which `-` could name later.
- A size cap, which waits on Q25.
- TASK.md's frontmatter (C6, D5). A task file's frontmatter is part of the task (D40).
- A help text, and a task file combined with `--prompt`.

## Decisions

- **One positional argument or `--prompt`, through `parseArgs`.** The options are `{ prompt: { type: 'string', short: 'p' } }`, parsed strictly, with positionals allowed and tokens on.
  - **What fails:** no task; a file and `--prompt` together; two positionals; `--prompt` twice, counted from the tokens because the values keep only the last; and a blank `--prompt`.
  - **The errors** end with one usage sentence that shows both forms. The one for two positionals also says to quote the task after `-p`, since `-p Say hi` is a value and a file.
  - **Turned down:**
    - joining the words after `--prompt`, as the arguments are joined today, which would make `-p Say hi` ambiguous;
    - an `--inline` switch that changes what the positionals mean;
    - a hand-written loop, beside a command that already uses `parseArgs`.
- **The strict-then-lenient parse is shared.** `parse` and `refusalsOf` move from `mcp-args.ts` to a module of their own in `main/`, which both commands import.
  - **The hints:** each command passes the sentences that end its refusals, one for an unknown option and one for a value. These are `UNKNOWN_IN_ADD` or `SEE_HELP` for the `mcp` command, and the usage sentence for the agent.
  - **A value that starts with `-`** is suggested as `--<name>=<value>`, by the long name, since `-p=<value>` gives `=<value>`. The `mcp` command's options are all long, so its messages don't change.
  - **Turned down:** a copy in `args.ts`, which would drift from the original.
- **A relative path resolves against `process.cwd()`,** as `WORK_DIR` does, so `task.md` and `WORK_DIR=.` mean the same directory. Under `bun run`, that is the repository's root (R19).
  - **The not-found error** gives the absolute path it looked at, which shows where it looked when the command was typed in a subdirectory.
  - **Turned down:** `INIT_CWD`, which Bun doesn't set; and `WORK_DIR`, the model's directory rather than the one the command was typed in.
- **The file tools' refusals, without their root.** A task file may be anywhere, unlike a file `read` reads.
  - **What is still refused:** its name as given, and its real path, must not be a `.env*` file's (`isEnvFile`); and its real path must not be inside the data folder (`isInside`).
  - **Why:** the task goes to the provider, and in full into the `asking` record, so what the model may never read shouldn't reach it as its task through a slip of the shell's completion.
  - **Without a valid `DATA_DIR`,** the data-folder check is skipped. The run fails on that setting anyway, and the task's other problems are still reported with it.
  - **Turned down:** no refusal, on the grounds that the user chose the file. A slip would send secrets away and log them.
- **Read once, then probe and trim.**
  - **The read:** the whole file is read into memory and checked for a NUL byte in its first 8 KiB, then decoded as UTF-8 and trimmed. One read can't see a file change between a probe and a read, and it works for a pipe, such as `/dev/stdin`, which can't be read twice.
  - **The probe** becomes an export of `tools/read.ts` that takes the bytes, so `read` and the task file apply one rule.
  - **The trim** removes leading and trailing whitespace, a byte-order mark among it, which `trim` counts as whitespace. Frontmatter, line endings and inner whitespace stay as written (D40). A file that is blank once trimmed fails, as a blank `--prompt` does.
  - **The errors:** a missing file is "no task file" at its absolute path, with `-p` named. Other failures, such as a directory, give the path and the system's reason, as `reasonOf` words it.
- **Read before the store, reported with the configuration.**
  - **The order:** `main.ts` calls `loadConfig`, then awaits the task, passing the data folder when the configuration gave one.
  - **The reader** gives `Result<{ text, file }, string>`, where `file` is the absolute path, or `undefined` for `--prompt`.
  - **On failure,** the problems are logged together, and the run exits with code 1 before skills load, before the store opens and before any request.
- **The `asking` record keeps `task` and adds `taskFile`.**
  - **`task`** stays the text sent.
  - **`taskFile`** is the absolute path for a task from a file. It is undefined otherwise, which the logger leaves out.
  - **Why the text stays:** until runs are stored, the record is the only copy of what was asked, and the file can change after the run (C19).
  - **Turned down:** the path and size alone.
- **`-p` wherever a task was given inline.** This covers:
  - the README's usage and examples, and its "Running with servers";
  - CI's start-up check, as `bun run agent:node -p 'Check startup'`;
  - the run tests' default arguments, `['-p', TEST_TASK]`.

  The README's note on quoting stays, now for `-p`'s value. The `agent` spec's Bun-or-Node requirement already says "an explicit task", which `-p` gives, so it doesn't change.

## Risks / Trade-offs

- **[Every inline habit breaks]** → The not-found error names `-p`, and the README shows both forms.
- **[A path typed relative to a subdirectory resolves from the repository's root under `bun run`]** → The not-found error gives the absolute path it tried, which shows why. Absolute paths always work.
- **[A large file is sent whole, unlike an argument, which the system caps]** → No cap until Q25 settles how each provider treats an oversized first request.
- **[A FIFO with no writer, given as the task file, waits]** → Accepted. Pipes are read like any other file, which is also what makes `/dev/stdin` work.
