## Context

- **The fence, in `tools/fence.ts`.** `fenceRead` and `fenceWrite` resolve a path against the working directory and refuse it when it lies outside the working directory (for `read`, outside it and the skill directories), when its name starts with `.env`, or when it lies inside the data folder. They check the path as written and with links resolved, and give the real path, which the tool then reads or writes. For a target that doesn't exist yet, `fenceWrite` takes the real path of its nearest existing ancestor, and it refuses a broken link. The module also holds `isInside`, `isInsideAny`, `isEnvFile`, `errorCode` and `reasonOf`.
- **What else uses it.**
  - `main/args.ts` refuses an `.env` task file and one in the data folder, through `isEnvFile`, `isInside` and the file's real path.
  - `config/config.ts` refuses a `DATA_DIR` that is or contains `WORK_DIR`, through `isInside`, because the file tools would have refused everything in such a working directory.
  - `mcp/run-directory.ts` refuses a temporary directory inside `WORK_DIR` or `DATA_DIR`, through `isInside`, for npm's `.npmrc` lookup (Brief D36, R18.1).
  - `errorCode` and `reasonOf` are imported by the tools, `main/args.ts`, `exec/sweep.ts` and three modules in `mcp/`.
- **`apply_patch`'s claim.** Each path a patch names goes through `fenceWrite`. The real path it gives locates the file the hunk reads and writes, and keys the check that refuses a file named twice, so a link and its target count as one file. A deleted or moved path is already removed as the patch names it, so a link goes, not what it points to.
- **The shell.** Every run offers it, and it runs `bash -c` as the user (Brief D18), so the fence never bounded what the model can reach (Brief R20).

## Goals / Non-Goals

**Goals:**
- No file tool and no task file refuses a path for where it is (D41, D43), and no setting brings the fence back (D42).
- Every refusal that doesn't depend on where a file is stays, with its message.
- The tools agree: what `write` creates, `read` reads.

**Non-Goals:**
- Expanding `~` (Q26).
- The shell's environment (C12, Q15), and the stdio servers' run directory (D36).
- A sandbox, which is a container's job (D3).

## Decisions

- **A path resolves once, lexically, and is used as it is.** Each tool takes `resolve(workDir, path)`: a relative path resolves against the working directory, and an absolute one is used as it is. Reads and writes go through that path, so the file system follows links as it does for any program. Writing through a link replaces its target's contents and leaves the link a link, as today.
  - **What changes for links:** a broken link is no longer refused. Writing through one creates its target where the link points, when that directory exists.
  - **Turned down:** using the real path in place of the path as given. With nothing to refuse, it changes nothing a read or a write sees.
- **Each tool is created for the working directory alone.** These are `readTool(workDir)`, `writeTool(workDir)`, `editTool(workDir)` and `applyPatchTool(workDir)`. `read` drops the skill directories, and every tool drops the data folder.
- **`apply_patch` still refuses a file named twice.** It refuses the patch when two paths name one file: the same resolved path, or the same real path for a target that exists. That covers a link and its target, and `a.txt` and `./a.txt`. The hunk reads and writes through the resolved path.
  - **What it no longer catches:** a new file named in two ways through a linked directory, such as `out/new.txt` and `real/new.txt` when `out` links to `real`. The later hunk's content wins, and the report lists both.
  - **Turned down:** keeping `fenceWrite`'s walk to the nearest existing ancestor just for this key. It is the fence's most intricate code, and would serve only a patch that names one new file in two ways.
- **The descriptions.** `read`'s becomes "The path is relative to the working directory, or absolute." in place of "…, or absolute inside a skill's directory." `write`'s says the path is relative to the working directory, and so does `apply_patch`'s, as Codex's V4A convention has it. Both are still true, so neither changes. Nor do the starting instructions, which never named the fence.
- **The task file is read through its path.** `fromFile` resolves the path against `process.cwd()` and reads it once, as today. The `.env` and data-folder checks go, with the `realpath` that served them, and so does `readTask`'s data folder. A missing file is still "No task file at …", and a binary or blank one still fails.
  - **A side effect on Bun:** `realpath` fails with `EBADF` on `/dev/stdin` when stdin is a pipe, which `read-task-file`'s design recorded. Without it, Bun 1.4.4 reads a piped `/dev/stdin` as Node does (measured). Taking the task from stdin still waits for `-`.
- **The configuration lets `DATA_DIR` be or contain `WORK_DIR`.** `overlap` goes from `config/config.ts`, with its error. Nothing refuses such a working directory any more. The README still advises a data folder of the agent's own.
- **`fence.ts` goes.**
  - **What moves:** `errorCode` and `reasonOf` go to `tools/errors.ts`. `exec` and `mcp` already import them from `tools/`, so only the module's name changes for them. `isInside` moves to `mcp/run-directory.ts`, its last user, and is exported for its tests.
  - **What goes:** `isInsideAny`, `isEnvFile`, `exists`, `fenceRead` and `fenceWrite`.
  - **Turned down:** keeping `fence.ts` for what's left, under a name that no longer says what it holds.
- **The tests.**
  - The fence's own tests go. `reasonOf`'s move with it, and `isInside`'s edge cases (a name that starts with two dots is inside; a sibling whose name starts with the directory's is outside) become tests of `isInside`.
  - In the tools', the task file's and the configuration's tests, each case for a refused path either goes or becomes a case for a path that now works, as the delta's scenarios say.

## Risks / Trade-offs

- **[A mistaken path that happens to be writable now succeeds]** → The output names the path as given, and the log records it as the tool's argument. Paths from container habits, such as `/workspace/…` or `/home/…`, still fail on macOS: the system volume is read-only, and `/home` belongs to the automounter (Brief R20.3).
- **[The file tools can replace a real `.env`, delete `db.sqlite`, or change a skill's files]** → As the shell always could. A container bounds them when that matters (D3).
- **[A new file named twice through a linked directory isn't caught]** → The later hunk wins, and the report shows both.
- **[A model writes `~/…`]** → It lands in a directory named `~` inside the working directory, as it does today. Q26 asks whether to expand it.
- **[Tests and code that `add-persistence` and `read-task-file` added days ago go]** → Their scenarios stay where they still hold: a binary or blank task file, and the database read as a binary file.
- **[`openspec archive` refuses the agent delta as written]** → Its first requirement drops one current scenario, "A task file the file tools refuse", and the archive takes a missing scenario for a stale delta. Remove that scenario from the main spec just before archiving. The other deltas replace their changed requirements whole, so they keep every scenario they modify. A trial archive on a copy of `openspec/` then applied every delta, and the 20 specs passed `openspec validate --specs --strict`.
- **[The archive puts a renamed or added requirement last]** → OpenSpec 1.6 rebuilds a spec in its original requirements' order, and a renamed requirement no longer matches its old place. After archiving, move `read-tool`'s "Read a UTF-8 text file" and "Refuse directories and binary files" back to the top, in that order, and `apply-patch-tool`'s "Add, delete, update and move files" back before "Change nothing unless the whole patch applies, and report each file". Then refresh the Purpose lines of `write-tool` and `edit-tool`, which say "under the working directory", and `read-tool`'s "what it may read".
