## 1. Rename `read_file` to `read`

- [ ] 1.1 `git mv packages/agent/src/tools/read-file.ts packages/agent/src/tools/read.ts`, and the same for its test (design decision 7):
  - `readFileTool` becomes `readTool`, and the tool's name becomes `read`;
  - its messages say "the read tool": `… is outside the directories the read tool may read.` and `… is an environment file. The read tool doesn't read those: they hold secrets.`;
  - its description is unchanged apart from the name.
- [ ] 1.2 Rename the other mentions:
  - `shell.ts` imports `READ_LIMIT` from `./read.ts` (its cut note changes in 1.6);
  - `core/src/skills.ts`'s catalog instruction says to read a skill's own files with the `read` tool;
  - `main.ts` uses `readTool`;
  - comments that name `read_file`, such as the one in `skills/skills.ts`.
- [ ] 1.3 The tests follow the `read-file-tool`, `agent-loop`, `tool-calls`, `structured-log`, `skills` and `shell-tool` deltas:
  - `core`'s `tools`, `history`, `model-call` and `skills` tests;
  - the agent's `read`, `shell`, `log`, `session` and `main` tests.

  `agent-loop`'s unknown-tool test calls `delete`. Check with `grep -rn read_file packages`, which finds nothing.
- [ ] 1.4 Paging in `read.ts` (design decision 8):
  - the arguments `offset` and `limit`, each `integer ≥ 1 | null`, required in the model's JSON Schema, with a missing one read as null;
  - streamed reading by line, with `\r\n` kept;
  - the 32 KiB cap ending on a whole line, and the long-line cut at a character boundary;
  - the continuation notes;
  - the past-the-end error, with the empty-file exception;
  - the binary probe on the file's first 8 KiB whatever the offset.

  The description says how to page: "offset is the first line to read, from 1, and limit the most lines; pass null for both to read from the start. Each call returns at most 32 KiB in whole lines, with a note giving the offset to continue from."
- [ ] 1.5 `test/tools/read.test.ts` covers the `read-file-tool` delta: the new schema scenarios, a left-out or null `offset` and `limit`, invalid values, every scenario of "Cap what it returns" with the new notes, and every scenario of "Read part of a file by lines".
- [ ] 1.6 `shell.ts`'s cut note suggests paging through the saved output with the `read` tool, as the `shell-tool` delta says. `test/tools/shell.test.ts` checks the new text.

## 2. The shared fence

- [ ] 2.1 Create `packages/agent/src/tools/fence.ts` (design decision 2):
  - Move `isInside`, `isInsideAny`, `isEnvFile` and `errorCode` out of `read.ts`.
  - Add the read check: the read tool's lexical and real-path checks with the `.env` refusal, returning the real target or the error, with the messages from 1.1.
  - Add the write check for a root and a tool name:
    - the path must be lexically inside the root;
    - the name must not begin with `.env`;
    - the nearest existing ancestor's real path must be inside the root's real path;
    - an existing target is resolved with its real path checked, the `.env` check included;
    - a broken symbolic link is refused.

    It returns `Result<string, string>`, with the messages from the design.
- [ ] 2.2 `read.ts` uses the fence. `test/tools/read.test.ts` passes without further changes.
- [ ] 2.3 `test/tools/fence.test.ts` covers the write check: `..`, absolute paths in and out, a skill directory, a linked directory pointing outside with a missing subpath below it, a link to a file outside, a broken link, a link inside, `.env`, `config/.env.local`, and a link to `.env`.

## 3. `write`

- [ ] 3.1 `packages/agent/src/tools/write.ts`, following `write-tool`'s spec and design decision 3:
  - strict `{path, content}`;
  - the write fence, then the directory and over-`READ_LIMIT` refusals;
  - `mkdir` with `recursive`, then an in-place write;
  - the `Created`/`Replaced` output with singular and plural counts;
  - every error as an `err`.

  Tool description: "Create or replace a UTF-8 text file with the given content, creating missing directories. The path is relative to the working directory. To change part of a file, use the edit tool; files over 32 KiB can't be replaced whole."
- [ ] 3.2 `test/tools/write.test.ts` covers every scenario in `write-tool`'s spec, including the kept mode, the 32,768-byte boundary and an unwritable parent directory.

## 4. `edit`

- [ ] 4.1 `packages/agent/src/tools/edit.ts`, following `edit-tool`'s spec and design decision 4:
  - strict `{path, old_string, new_string, replace_all}`;
  - the write fence;
  - the missing, directory, over-10-MiB, NUL and fatal-UTF-8 refusals;
  - the empty and unchanged checks;
  - a non-overlapping count with a literal replacement;
  - the 0-match error with the CRLF hint, and the ambiguous-match error;
  - the output text.

  Tool description: "Replace exact text in a file. old_string must match the file exactly, including whitespace and indentation, and occur once unless replace_all is true. Read the file first to copy the text. To create or replace a whole file, use the write tool."
- [ ] 4.2 `test/tools/edit.test.ts` covers every scenario in `edit-tool`'s spec, including the kept mode and the bytes outside the replacement left unchanged.

## 5. `apply_patch`

- [ ] 5.1 `packages/core/src/patch.ts`, pure and exported as `@mecha-gremlin/core/patch` (design decision 5). It holds:
  - `parsePatch(text)`, giving `Result<Hunk[], string>`: Codex's grammar, whitespace-tolerant markers, the heredoc wrapper, empty chunk lines as context, and Codex's `invalid patch:` and `invalid hunk at line <n>,` errors;
  - `applyChunks(contents, chunks, path)`, giving `Result<string, string>`:
    - the `@@` header seek;
    - the four-pass seek, with Codex's Unicode folding table;
    - the retry without a trailing empty line;
    - the `*** End of File` anchor and appending;
    - context lines kept from the file, and line endings kept line by line, with the file's first ending for inserted lines.
- [ ] 5.2 `packages/core/test/patch.test.ts` covers the parsing and matching scenarios in `apply-patch-tool`'s spec, plus each fold in the Unicode table and each of the four passes alone.
- [ ] 5.3 `packages/agent/src/tools/apply-patch.ts`:
  - strict `{patch}`;
  - parse, then refuse a path named twice;
  - fence every path, `Move to` destinations included;
  - read and check every Update and Delete source, and check every Add target for a directory or the 32 KiB rule;
  - compute all the new contents;
  - only then write, delete and move, in the patch's order, creating parent directories;
  - the `Success. Updated the following files:` report;
  - on an I/O error partway, an error listing the files already changed.

  The tool description explains the format with one example, adapted from Codex's apply_patch instructions. It also says that `@@ <line>` picks the place when the old lines occur more than once.
- [ ] 5.4 `test/tools/apply-patch.test.ts` covers the file-system scenarios in `apply-patch-tool`'s spec: add with new directories, delete, a missing delete, move with update, the fence, `.env`, a large Add target, a path named twice, a later hunk failing with nothing changed, and the success report with a move.

## 6. Wiring and settings

- [ ] 6.1 `config.ts`: `FILE_TOOLS` (`write-edit` | `apply-patch`, default `write-edit`) goes into `Config` as `fileTools`. An invalid value gives `FILE_TOOLS must be write-edit or apply-patch; got "<value>".` and is reported with the other problems. `test/config/config.test.ts` covers the default, both values, an invalid value, and that it joins the other problems.
- [ ] 6.2 `main.ts`:
  - the tools are `read`, then `write` and `edit` or `apply_patch`, then `shell`, then `activate_skill`;
  - the developer item's sentence names `read` and the file tools on offer (design decision 6).

  `test/main/main.test.ts` covers the `agent` delta's scenarios: the tools offered with and without skills, the patch tool set, the developer item, the logged `read` round trip, and `WORK_DIR` with `write`.
- [ ] 6.3 `packages/agent/package.json`'s `description` names the file tools. CSpell accepts the new words: add real words to `cspell.json`, and fix anything that is a typo.

## 7. Docs and the Brief

- [ ] 7.1 README: the tools paragraph lists `read`, `write`, `edit` and `apply_patch`, and when each is offered, and says `read` pages by line; no `read_file` is left; the settings document `FILE_TOOLS`; the `core` row mentions `patch`.
- [ ] 7.2 Brief.md (public: no host specifics):
  - add **R16**, file-writing tools in coding harnesses, with the design's table, findings and sources, marked **[H]** and dated 2026-10-21/22;
  - add **D23** to the decisions table: the tools `read`, `write` and `edit` (renaming `read_file`, and not `write_file`) by default, `apply_patch` by `FILE_TOOLS`, decided 2026-10-22, carried out by `file-write-tools`;
  - C4's base-tools row, ▸4 and M1's slice name `read`, `write` and `edit` where they now say `read_file` and `write_file`, with `apply_patch` as the alternative. R11, R12 and Q14 keep `read_file`, as history;
  - add a 2026-10-22 line to the revision log at the top.

## 8. Verify

- [ ] 8.1 `bun run check` passes: format, lint, spellcheck, typecheck, and tests on Bun and on Node.
- [ ] 8.2 Mutation testing: run Stryker on the new and changed files and kill every survivor. The files are `fence.ts`, `read.ts`, `write.ts`, `edit.ts`, `apply-patch.ts`, `shell.ts`, `core/src/patch.ts`, `core/src/skills.ts`, `config.ts` and `main.ts`. Report the scores; CI runs the full run.
- [ ] 8.3 A live check against the loaded model, when LM Studio is up:
  - `bun run agent "Create hello.md saying hi, then change hi to hello"` in a scratch `WORK_DIR`, and the same with `FILE_TOOLS=apply-patch`;
  - report the tool calls from the log.

  If no model is loaded, report NOT-RUN.
