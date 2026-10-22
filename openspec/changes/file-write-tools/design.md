## Context

The agent's tools are `read_file`, `shell` and, when skills are loaded, `activate_skill`. The only way to write a file today is through the shell. `read_file` holds a fence: the root and skill directories, `.env*` refused, real paths checked. Its helpers (`isInside`, `isInsideAny`, `isEnvFile`) are private to `tools/read-file.ts`.

On 2026-10-21 a survey of ten harnesses checked their current source and docs; it goes into the Brief as R16. Findings:

| Harness | Write | Edit | Matching | Overwrite guard |
|---|---|---|---|---|
| Claude Code | `Write(file_path, content)` | `Edit(file_path, old_string, new_string, replace_all)` | exact; unique unless `replace_all` | read first (newer models may skip it), plus a permission prompt |
| Anthropic text editor tool | `create(path, file_text)` | `str_replace`, `insert` | exact; errors on 0 or many | left to the client; the reference code's `create` refuses existing files |
| Codex CLI | none | `apply_patch` (freeform, V4A) | exact, then trailing whitespace ignored, then trimmed, then punctuation folded | approval policy; `Add File` overwrites |
| Responses API `apply_patch` type | `create_file` | `update_file`, `delete_file` (V4A diffs) | the client's | left to the client |
| Gemini CLI | `write_file` | `replace(…, allow_multiple)` | exact, then whitespace-tolerant, then fuzzy, then an LLM fixer | confirmation with a diff |
| OpenHands | `create` | `str_replace`, `insert`, `undo_edit` | exact, then stripped | `create` refuses existing files; writes atomically |
| opencode | `write` | `edit(…, replaceAll)`; `apply_patch` for GPT | nine fallback matchers | permission prompt; its read-before-write check was removed in April 2026 |
| Cline | none | `editor`; `apply_patch` for GPT | exact after normalising line endings | no whole-file overwrite |
| pi | `write(path, content)` | `edit(path, edits[{oldText, newText}])` | exact, then fuzzy | none |
| Goose | `write(path, content)` | `edit(path, before, after)` | exact, unique | none |

Sources, checked 2026-10-21/22:
- code.claude.com/docs/en/tools-reference
- platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool
- github.com/anthropics/claude-quickstarts (computer_use_demo/tools/edit.py)
- github.com/openai/codex (codex-rs/apply-patch/src/{parser,seek_sequence,file_update,text_file}.rs; codex-rs/core/src/tools/handlers/apply_patch_spec.rs)
- developers.openai.com/api/docs/guides/tools-apply-patch
- github.com/google-gemini/gemini-cli (packages/core/src/tools/{edit,write-file}.ts)
- github.com/OpenHands/software-agent-sdk (openhands-tools/openhands/tools/file_editor/editor.py)
- github.com/anomalyco/opencode v1.19.3 (packages/opencode/src/tool/{edit,write}.ts) and PR #22999
- github.com/cline/cline (sdk/packages/core/src/extensions/tools/executors/editor.ts)
- github.com/badlogic/pi-mono (packages/coding-agent/src/core/tools/{write,edit}.ts)
- github.com/aaif-goose/goose (crates/goose/src/agents/platform_extensions/developer/edit.rs)

What the survey shows:
- **The toolset:** a whole-file write plus an exact find-and-replace edit, or `apply_patch` in their place for GPT-family models.
- **Shared rules:** parent directories are created; zero or many matches is an error asking for more context.
- **The usual guard against overwriting is a person approving a diff.** This agent runs unattended (M1), so the comparable harnesses are pi and Goose, which keep no file state at all.

## Goals / Non-Goals

**Goals:**
- `write` and `edit` as the default pair, and `apply_patch` as an alternative set, chosen by `FILE_TOOLS`.
- One fence for all four file tools.
- `read` pages through a file by line, as every surveyed harness with a read tool does.
- Errors a weak local model can act on: each says what was wrong and what to do next.
- The pure parts are in `core` and the file-system parts in the agent, so that at M1 the file-system side can move behind the exec server (C3) without changes to the patch logic.

**Non-Goals:**
- The Responses API's native `apply_patch` tool type, `apply_patch_call` items and their outputs. LM Studio lacks them, and `core`'s `classify` handles only function calls.
- Fuzzy matching in `edit`, an `insert` command, `undo_edit`, multi-edit, atomic writes, or keeping file state between calls (read-before-write, staleness).
- Refusing `.git/` or other sensitive paths beyond `.env*`.
- `grep` and `glob` tools. The user wants them, in a change of their own after this one.
- Line numbers in `read`'s output. The shell is unfenced (D18), so such a list would only look like a boundary.

## Decisions

### 1. One setting picks the set: `FILE_TOOLS=write-edit|apply-patch`
- `write-edit` is the default and offers `write` and `edit`; `apply-patch` offers `apply_patch`. Each value names the tools it offers, so `edit` is never both a value and a tool. The two sets are never offered together.
- The default doesn't depend on the provider: write and edit are the preferred pair.
- **Alternatives:**
  - all three at once, which gives two ways to do one thing and so worse tool choice (C4);
  - switching to `apply_patch` per model as opencode and Cline do, which is a guessing table to maintain. A setting is explicit, and per-task model profiles (C2) can carry it later.
- An invalid value is reported at start-up like any other setting: an `error` record naming `FILE_TOOLS`, exit code 1.
- **Tool order:** `read`, then the file tools (`write`, `edit`, or `apply_patch`), then `shell`, then `activate_skill`. Keeping the order stable keeps the cached prefix stable within a configuration.

### 2. The shared fence, in `tools/fence.ts`
- **Reads**, unchanged: lexically inside the root or a skill directory, then the same with links resolved, and `.env*` refused under either name.
- **Writes:** the root only, since skill directories are read-only.
  - The target need not exist. The fence takes the real path of the nearest existing ancestor and requires it to be inside the root's real path. That way a linked directory can't lead outside, even when the tool will create directories below it.
  - **An existing target** that is a link is resolved, and its real path must be inside the root.
  - **A broken link** is refused: `writeFile` would follow it and create its target wherever it points.
  - **A requested or real name beginning with `.env`** is refused.
- **Messages** name the tool:
  - `"<path>" is outside the working directory, the only place the <tool> tool may write.`
  - `"<path>" is an environment file. The <tool> tool doesn't write those: they hold secrets.`
- **The fence returns** `Result<string, string>`: the absolute real target, or the error.
- The read tool's checks stay as they are. Its messages say "the read tool" where they said `read_file`: `"<path>" is outside the directories the read tool may read.` and `"<path>" is an environment file. The read tool doesn't read those: they hold secrets.`

### 3. `write(path, content)`
- **The names `write` and `edit`** are Claude Code's (`Write`, `Edit`), pi's, Goose's and opencode's, rather than the Brief's `write_file`.
  - `read_file` becomes `read`, as in Claude Code, pi and opencode, so the file tools match (decision 7).
  - `apply_patch` keeps Codex's name, which GPT models are trained on.
  - Prose and error messages say "the `write` tool" and "the `edit` tool" wherever the bare verb would read as an ordinary word.
- **Arguments:** both required strings, in a strict object.
- **It writes the content exactly** as given, as UTF-8, creating missing parent directories with `mkdir -p` semantics.
  - An existing file keeps its mode.
  - The write is in place, not through a temporary file and a rename. That's what most harnesses do, and a rename would replace links and reset the mode.
- **It refuses:**
  - a directory;
  - an existing file larger than `READ_LIMIT` (32 KiB), the most one read returns. The error says replacing it whole could drop what the model hasn't read, and to change it with `edit`. Paging makes the whole file readable, but nothing records whether the model read every page. When the replacement content is no larger than the file, a rewrite after a truncated read loses data, and the model can't tell. Refusing on size alone keeps the rule stateless.
- **It returns** `Created <path> (<n> lines, <b> bytes).` or `Replaced <path> (<n> lines, <b> bytes).`
  - `<path>` is the argument as the model wrote it.
  - A line count is the number of newline-terminated lines, plus one when the content doesn't end in a newline and isn't empty.
- **Alternative:** a required `create|replace` mode, rejected because no surveyed harness does it, and it costs every call a decision.

### 4. `edit(path, old_string, new_string, replace_all)`
- **Arguments:** all four are required, `replace_all` a boolean. Strict mode needs every property required; this is the same reason `shell` has no timeout argument.
- **The file must exist.** It must be no larger than 10 MiB (OpenHands' limit), have no NUL byte, and be valid UTF-8, checked with a fatal `TextDecoder`. Replacing text in a file that decoded lossily would corrupt the rest of it.
- **`old_string` must not be empty** (that's `write`'s job), and it must differ from `new_string`.
- **Matching is exact,** counted without overlaps.
  - **0 matches:** `old_string wasn't found in "<path>". It must match the file exactly, including whitespace and indentation: read the file again and copy the text.` When the file holds `\r\n` and `old_string` holds a `\n` without a `\r`, a sentence adds that the file uses CRLF line endings. Cline normalises them; we only point it out.
  - **More than one match without `replace_all`:** `old_string occurs <n> times in "<path>". Include more of the surrounding text to make it unique, or set replace_all to true to replace every one.`
- **The replacement** goes in literally. `String.prototype.replaceAll` with a function replacer avoids `$&` and `$1` being treated as patterns.
- **It returns** `Replaced 1 occurrence in <path>.` or `Replaced <n> occurrences in <path>.`

### 5. `apply_patch(patch)`, following Codex
- **Grammar:** Codex's Lark grammar for V4A:
  - `*** Begin Patch`, one or more hunks, `*** End Patch`;
  - the hunks are `*** Add File: <path>` with `+` lines, `*** Delete File: <path>`, and `*** Update File: <path>`, optionally followed by `*** Move to: <path>`;
  - an update's chunks start with `@@` or `@@ <context line>` and hold ` `, `-` and `+` lines, optionally ending with `*** End of File`.
- **Leniency, as in Codex:**
  - whitespace around markers is ignored;
  - a `<<'EOF'` / `<<EOF` / `<<"EOF"` heredoc wrapper around the whole patch is stripped;
  - a patch with no hunks is an error.
- **Matching, as in Codex's `seek_sequence`:**
  - An `@@ <line>` header is found first, as a single line, searching forward from the previous chunk's end.
  - Then the chunk's old lines (context and `-`) are found from there, in four passes: exact, ignoring trailing whitespace, trimmed, and trimmed with Unicode dashes, quotes and spaces folded to ASCII.
  - **Retry:** if that fails and the old lines end with an empty line, the search is retried without it.
  - **End of file:** `*** End of File` anchors the search at the end of the file.
  - **An empty old side** appends the new lines at the end of the file.
  - **Order:** chunks apply in order, and the first match is taken, not a unique one.
  - **Context lines** keep the file's own text, so a lenient match doesn't rewrite them.
  - **Line endings** are kept line by line, and inserted lines use the file's first line ending (LF when it has none).
- **Paths** are relative to the root, or absolute, and every path goes through the write fence, `Move to` destinations included. A patch that names one path in more than one hunk, as source or destination, is refused. Codex would apply them in sequence; refusing keeps all-or-nothing simple.
- **All or nothing:**
  1. Parse the patch.
  2. Fence every path.
  3. Read every file to update or delete. The files to update must meet `edit`'s rules: they exist, are at most 10 MiB, contain no NUL and are valid UTF-8. A file to delete must exist and not be a directory.
  4. Compute every new content.
  5. Only then write, in the patch's order.

  An I/O error during the writes stops there, and the error lists what was already written.
- **Add File:**
  - The content is the `+` lines joined with `\n`, plus a final `\n`.
  - An existing file is replaced, as in Codex, but under `write`'s 32 KiB rule, for the same reason.
  - Parent directories are created.
- **Move to:** writes the destination, creating its parent directories, then removes the source.
- **It returns** Codex's text, `Success. Updated the following files:` followed by one line per file: `A <path>`, `M <path>` or `D <path>`. A moved file is listed as `M` with its destination.
- **Errors** follow Codex's wording, so models trained on it recognise them:
  - `Failed to find context '<line>' in <path>`;
  - `Failed to find expected lines in <path>:` with the lines;
  - `invalid hunk at line <n>, <message>`;
  - `invalid patch: <message>`.
- **Code layout:** `core/patch.ts` holds the pure part: `parsePatch(text)` gives `Result<Hunk[], string>`, and `applyChunks(contents, chunks, path)` gives `Result<string, string>`. `tools/apply-patch.ts` holds the fence, the reads, the writes and the result text.
- **The tool description** explains the format compactly, with one example, adapted from Codex's apply_patch instructions. A function tool can't carry a grammar constraint, so the description is all the format guidance the model gets.

### 6. The developer item and the docs
- **The developer item** becomes:
  - with `edit`: "…You have a shell, read for reading text files, write for creating or replacing a file, and edit for changing part of one…";
  - with `patch`: "…, and apply_patch for writing and changing them…".
- **The README** lists the tools and documents `FILE_TOOLS`.
- **The Brief:**
  - R16 holds the table and sources above;
  - D23 records the shape, the names and the setting (decided 2026-10-22);
  - C4's table row, ▸4 and M1's slice name `write` and `edit` where they now say `write_file`, with `apply_patch` as the alternative;
  - a log line goes at the top.
- **After archive, by hand**, because a delta can't rename a capability or change a Purpose:
  - move `openspec/specs/read-file-tool` to `openspec/specs/read-tool`, retitle it `# read-tool Specification`, and make its Purpose name the `read` tool;
  - the Purpose lines of `agent` (its tools), `skills` and `shell-tool`, wherever they name `read_file`.

### 7. `read_file` becomes `read` everywhere it is named
- **Specs:** MODIFIED deltas for every requirement that names it, with scenario titles unchanged, so the archive accepts them:
  - `read-file-tool` (all four requirements), `agent`, `skills` and `shell-tool`, where it names the tool;
  - `agent-loop`, `tool-calls` and `structured-log`, where it is an example name. `agent-loop`'s unknown-tool example calls `delete`, since `write` is now a real tool.
- **Code:**
  - `tools/read-file.ts` becomes `tools/read.ts` and `readFileTool` becomes `readTool`, with the tool's name and messages;
  - `shell.ts`'s cut note and description;
  - `core/src/skills.ts`'s catalog instruction;
  - `main.ts`'s developer item;
  - comments that name `read_file`, such as the one in `skills/skills.ts`.
- **Tests** follow the code and the specs' examples: `core`'s `tools`, `history`, `model-call` and `skills` tests, and the agent's `read`, `shell`, `log`, `session` and `main` tests.
- **Docs:** the README; in the Brief, the design parts (C4's table, ▸4, M1's slice). Research and questions written before (R11, R12, Q14) keep `read_file`, as history.
- **Check:** `grep -rn read_file packages openspec/specs README.md` finds nothing after the archive and the hand steps.

### 8. `read` pages by line: `offset` and `limit`
- **Why:**
  - Every surveyed harness with a read tool pages: pi and Claude Code (`offset`, `limit`), Gemini CLI (`start_line`, `end_line`) and opencode (`offset`).
  - Ours stops at a file's first 32 KiB, leaving the rest to the shell's `sed -n`.
  - Lines, not bytes, because `edit` and `apply_patch` work on text the model copies, and a line is the unit it sees.
- **Arguments:**
  - `offset` is the first line, counting from 1. `limit` is the most lines.
  - Both are `integer ≥ 1 | null` and listed as required in the JSON Schema, because strict mode needs every property required. This is the constraint that kept a timeout off `shell`. It's accepted here because paging is the point.
  - Models that ignore strict mode (LM Studio doesn't enforce it) will often leave them out. A missing `offset` or `limit` therefore counts as null instead of failing validation.
  - **How:** either the tool's schema reports zod's output JSON Schema (`.nullable().default(null)` makes both required there), or the tool fills missing nullable keys before validating. The spec's scenarios fix the behaviour; the implementer picks the mechanism and keeps `core`'s `validateArgs` unchanged.
- **Lines:**
  - `\n` ends a line, and a final unterminated run counts as a line.
  - `\r\n` stays intact in the output, so CRLF files can be edited exactly.
  - No line numbers are added: Claude Code's `cat -n` prefixes get copied into `old_string` by mistake, and the continuation note already gives the next `offset`.
- **The cap** stays at 32 KiB per call but ends on a whole line.
  - A single line longer than that is cut at a character boundary, as today, and the rest of it is reachable only through the shell. That is rare in text the agent edits: minified files and logs.
- **Notes,** after a blank line:
  - `[showing lines A–B; read with offset B+1 to continue]`;
  - `[line A is longer than 32 KiB: showing its first N bytes; the rest of the line can be seen only through the shell]`, plus `read with offset A+1 to continue after it` when lines follow.

  No total line count is given, because counting would mean reading the whole file. An `offset` past the end does count, and its error gives the number of lines.
- **Implementation:**
  - Read the file as a stream, skipping lines up to `offset`, and stop at the cap or `limit`. A large file then costs only what's read.
  - The binary probe still looks at the file's first 8 KiB, whatever `offset` asks for.
- **Existing scenarios:** the cap's five scenarios all use one-line files, so their output is unchanged and only the note's wording changes.

## Risks / Trade-offs

- **Exact matching fails often on small models** (whitespace, tabs against spaces, CRLF) → the 0-match error says how to recover and points out CRLF. Fuzzy passes, like Codex's, can be added later if the logs show repeated misses.
- **`write` can still clobber a small file** the model never read → that's accepted, as in pi and Goose. Every call's arguments are logged, so the earlier content can be traced through any earlier `read` or `shell` output. Mid-run backups are out of scope.
- **`apply_patch` takes the first match, not a unique one,** so it can edit the wrong place in repetitive files → that's Codex's behaviour, which GPT models are trained on. `@@` headers are the way to disambiguate, and the description says so.
- **A function-tool `apply_patch` without a grammar constraint** lets models send malformed patches → the parser's errors name the line, and Codex's lenient parsing absorbs common slips.
- **Logging whole `content` and `patch` arguments** makes records large → that's acceptable before M1. The run log's storage (C11, D7) handles size separately.
- **The fence is not a boundary** → the security notes in the proposal and the Brief say so (D18).

## Migration Plan

There is nothing to migrate. With `FILE_TOOLS` unset, a run gets `write` and `edit`. A new tool list means one cache miss for the first request of each run, which happens anyway.

## Open Questions

- Should `FILE_TOOLS` default to `apply-patch` for the `openai` provider? It doesn't for now, by the user's preference. Revisit when M1's model profiles exist.
