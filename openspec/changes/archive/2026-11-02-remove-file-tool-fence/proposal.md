## Why

The file tools refuse paths outside the working directory, `.env` files and the data folder, but every run also has a shell, which reaches all of them. The fence was a boundary only while `read_file` was the model's only tool (Brief R20). Since then it has refused writes a task means, which a model then makes through the shell, with fewer checks and a vaguer record in the log. This harness leaves sandboxing to containers, so no file tool and no task file refuses a path for where it is (Brief C20, D41, D42 and D43).

## What Changes

- **BREAKING: no file tool refuses a path for where it is.** `read`, `write`, `edit` and `apply_patch` resolve a relative path against the working directory and use an absolute one as it is, wherever it points: outside the working directory, through a symbolic link, inside a skill's directory or the data folder, or to an `.env` file.
- **The refusals that don't depend on where a file is stay,** with their messages:
  - a directory, for every tool;
  - replacing a file larger than 32 KiB, for `write` and for `apply_patch`'s Add File and Move to;
  - a binary file, for `read`;
  - a file larger than 10 MiB, holding a NUL byte or not valid UTF-8, for `edit` and `apply_patch`'s Update File;
  - a file named twice, and a patch that doesn't apply whole, for `apply_patch`.

  `read` still returns at most 32 KiB per call.
- **`read` is created for the working directory alone.** The skill directories need no allowance: a skill's files are read by absolute path, like any others.
- **BREAKING: a task file may be any text file.** An `.env` file, or a file in the data folder, is taken as the task like any other. A missing, binary or blank one still fails.
- **`DATA_DIR` may be or contain `WORK_DIR`.** The rule against it existed because the file tools refused the data folder.
- **No setting brings the fence back.** When sandboxing is needed, the agent runs in a container.
- **The README** describes the file tools without the fence, says that they reach whatever your account can, as the shell does, and drops the fence from the task file's failures, the data folder's notes and `DATA_DIR`'s row.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `read-tool`: "Read a UTF-8 text file under a root directory" becomes "Read a UTF-8 text file", from any path. "Never read outside the root and the skill directories" goes, and "Refuse secrets, directories and binary files" gives way to "Refuse directories and binary files".
- `write-tool`: "Write a UTF-8 text file under the working directory" becomes "Write a UTF-8 text file", to any path. "Never write outside the working directory" goes, and "Refuse secrets, directories and large files" gives way to "Refuse directories and large files".
- `edit-tool`: "Edit only text files under the working directory" gives way to "Edit only text files", without `write`'s fence.
- `apply-patch-tool`: "Add, delete, update and move files under the working directory" gives way to "Add, delete, update and move files", without `write`'s fence.
- `agent`: changes three requirements:
  - "Carry out a task through the agent loop, and log the answer": a task file is no longer refused for its name or its place, and the tools have no roots;
  - "Log each model call and tool call": its failed call is a read of a missing file;
  - "Read the configuration from the environment, and validate it at start-up": `DATA_DIR` may be or contain `WORK_DIR`.

## Impact

- **`packages/agent`:**
  - `src/tools/fence.ts` goes. `errorCode` and `reasonOf` move to a module of their own in `src/tools/`, and `isInside` to `src/mcp/run-directory.ts`, its last user;
  - `src/tools/read.ts`, `write.ts`, `edit.ts` and `apply-patch.ts`: paths resolved without the fence, each tool created for the working directory alone, and `read`'s description;
  - `src/main/args.ts`: the task file's refusals of `.env` files and the data folder, and `readTask`'s data folder;
  - `src/main/main.ts`: the tools and the task, without the skill directories and the data folder;
  - `src/config/config.ts`: the rule that `DATA_DIR` must not be or contain `WORK_DIR`;
  - the tests: `test/tools/fence.test.ts`, and the fence's cases in the tools' tests, `test/main/args.test.ts`, `test/main/main.test.ts` and `test/config/config.test.ts`.
- **The repository root:** the README's layout, file tools, task file, data folder and `DATA_DIR` passages; the Brief's log.
- **Not in scope:**
  - expanding `~` in the file tools' paths (Brief Q26);
  - the shell's environment, built from scratch (Brief C12, Q15);
  - the stdio servers' run directory, which still lies outside `WORK_DIR` and `DATA_DIR` (Brief D36);
  - a container for the agent's tools (Brief C3, D3).
