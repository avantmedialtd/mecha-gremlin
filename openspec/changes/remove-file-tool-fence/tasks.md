## 1. The tools

- [x] 1.1 In `packages/agent/src/tools/read.ts`, `write.ts`, `edit.ts` and `apply-patch.ts`, take each path as `resolve(workDir, path)` in place of `fenceRead` or `fenceWrite`, and read and write through it. Create each tool for the working directory alone: `read` drops the skill directories, and every tool drops the data folder. `read`'s description says "The path is relative to the working directory, or absolute."
- [x] 1.2 In `apply-patch.ts`, refuse a patch that names one file twice when two paths resolve to the same path, or both exist and have the same real path. Read and write each file through its resolved path, and keep removing a deleted or moved path as the patch names it.

## 2. The run

- [x] 2.1 In `src/main/args.ts`, drop the task file's refusals of `.env` files and the data folder, with the `realpath` they needed, and `readTask`'s `dataDir` parameter. Read the file once through its resolved path, as now, and keep the missing, binary and blank cases and their messages.
- [x] 2.2 In `src/main/main.ts`, create the tools for the working directory alone, and call `readTask` without the data folder.
- [x] 2.3 In `src/config/config.ts`, drop `overlap` and its error, so that `DATA_DIR` may be or contain `WORK_DIR`.

## 3. The fence's module

- [x] 3.1 Move `errorCode` and `reasonOf` from `src/tools/fence.ts` to `src/tools/errors.ts`, and `isInside` to `src/mcp/run-directory.ts`, exported for its tests. Point every import at them: the tools, `src/main/args.ts` and `src/mcp/run-directory.ts`. `src/exec/sweep.ts`, and `src/mcp/bearer.ts`, `login.ts` and `servers.ts`, define copies of their own and stay as they are. Then delete `fence.ts`, with `isInsideAny`, `isEnvFile`, `fenceRead` and `fenceWrite`.

## 4. Tests

- [x] 4.1 In `test/tools/read.test.ts`, `write.test.ts`, `edit.test.ts` and `apply-patch.test.ts`, drop the cases for refused paths, and test the deltas' new scenarios:
  - outside the root, by `..` and by an absolute path;
  - through a symbolic link, the link staying a link;
  - `.env` files and the data folder;
  - a skill's file, read and written;
  - a relative path that exists only in a skill directory;
  - the database, refused as a binary file;
  - a file named twice through a link, and deleting a link.
- [x] 4.2 In `test/main/args.test.ts` and `test/main/main.test.ts`, an `.env` task file, a link to one and a text file in `DATA_DIR` are each taken as the task, and "A failed call" reads a missing file. In `test/config/config.test.ts` and `test/main/main.test.ts`, a `DATA_DIR` that is or contains `WORK_DIR` is accepted.
- [x] 4.3 Delete `test/tools/fence.test.ts`. Move its `reasonOf` tests to `test/tools/errors.test.ts`, and test `isInside` in a new `test/mcp/run-directory.test.ts`, with the edge cases the fence's tests covered: a name that starts with two dots is inside, and a sibling whose name starts with the directory's is outside.

## 5. Documentation and checks

- [x] 5.1 Update the README:
  - the layout's `tools` line, without "the fence the file tools share";
  - the file tools' section, in place of "The four tools share a fence": a path is relative to the working directory or absolute, wherever it points, and the tools reach whatever your account can, as the shell does. Then the refusals that stay, and that a container is the way to bound them;
  - the task file's failures, without the sentence on `.env` files and the data folder;
  - the data folder's "The shell can read it" note: the file tools reach the folder too, and `read` refuses the database as a binary file;
  - `DATA_DIR`'s row in the settings table, without "It must not be `WORK_DIR` or contain it."
- [x] 5.2 Add a line to the Brief's log saying that `remove-file-tool-fence` carries out D41, D42 and D43, by category only.
- [x] 5.3 Run these, and fix what fails:
  - `bun run check`;
  - a scoped `bun run mutation`, at 100%, over `src/tools/read.ts`, `write.ts`, `edit.ts`, `apply-patch.ts` and `errors.ts`, `src/main/args.ts`, `src/main/main.ts`, `src/config/config.ts` and `src/mcp/run-directory.ts`;
  - `openspec validate remove-file-tool-fence --strict`.
