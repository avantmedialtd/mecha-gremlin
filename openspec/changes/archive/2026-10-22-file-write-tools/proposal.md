## Why

The agent can read files but can change them only through the shell, by quoting a file's content inside `bash -c`: JSON escaping, then a heredoc, then `$` and backticks. The local 9B and 27B models get that wrong, and the log shows a bash string instead of what changed. The Brief planned a write tool, `write_file`, as a base tool from the start (C3, C4, M1's slice), and M1's acceptance is a task that "edits real files". A survey of ten coding harnesses (Brief R16) shows the typical pair: a whole-file write and an exact find-and-replace edit, with GPT-family models given `apply_patch` instead.

## What Changes

- **The file tools are named `read`, `write` and `edit`,** as in Claude Code, pi and opencode, rather than the Brief's `read_file` and `write_file`.
  - **BREAKING:** `read_file` is renamed `read`, and its messages name it "the read tool".
  - Every spec, test and doc that names it follows, including the examples in `core`'s specs and tests.
- **`read` pages through files by line**, as pi, Claude Code, Gemini CLI and opencode's read tools do. It takes `offset` (the first line, from 1) and `limit` (the most lines), both nullable. Each call returns whole lines up to 32 KiB, and a note gives the `offset` to continue from. Today everything past a file's first 32 KiB is out of its reach.
- **`write(path, content)`**: creates or replaces a UTF-8 text file under the working directory, creating missing parent directories. It returns whether it created or replaced the file, with its line and byte counts.
  - It refuses to replace a file larger than one read returns (32 KiB). The model may not have read all of such a file, and rewriting it would then drop the unread part silently. The error points to the `edit` tool.
- **`edit(path, old_string, new_string, replace_all)`**: replaces exact text in an existing file.
  - `old_string` must occur exactly once, unless `replace_all` is true.
  - Zero or several matches fail with an error that gives the count and says how to recover.
- **`apply_patch(patch)`**: applies a patch in the V4A format that OpenAI's Codex uses. It can add, update, delete and move files, and matches context leniently, as Codex does. All the patch's changes are worked out before any file is touched, so a patch that doesn't apply changes nothing.
- **A shared fence.** All three tools write only under the working directory. Skill directories stay read-only. Like `read`, they refuse `.env*` files, and they check paths both as written and with symbolic links resolved. The checks move out of `read-file.ts`, which becomes `read.ts`, into a module the four tools share.
- **A new setting, `FILE_TOOLS`**: `write-edit` (the default) offers `write` and `edit`; `apply-patch` offers `apply_patch` instead. The two sets are never offered together, as in opencode and Cline, which give GPT models `apply_patch` in place of write and edit. The default doesn't depend on the provider: write and edit are the preferred pair.
- **The developer item** names the file tools on offer. The tools are offered in this order: `read`, then the file tools, then `shell`, then `activate_skill`.
- **Brief:**
  - R16 records the harness survey, with its sources.
  - D23 records the tool shape, the names and `FILE_TOOLS`.
  - C4's table and M1's slice name the new tools.
- **Not in this change:**
  - OpenAI's native `apply_patch` tool type, which LM Studio lacks; C4 rejected the native shell tool for the same reason.
  - Fuzzy matching for `edit`.
  - Read-before-write or staleness checks: only Claude Code enforces them (R16).
  - `grep` and `glob` tools, as in Claude Code, Gemini CLI and opencode. They come next, in a change of their own.
  - Approval prompts, which the non-goal rules out.
  - Refusing writes inside `.git/`.

## Capabilities

### New Capabilities
- `write-tool`: the `write` tool: what it may write, the 32 KiB replacement rule, parent directories, and what it returns.
- `edit-tool`: the `edit` tool: exact matching, uniqueness and `replace_all`, the files it refuses, and its errors.
- `apply-patch-tool`: the `apply_patch` tool: the V4A format it accepts, lenient context matching, all-or-nothing application, and what it returns.

### Modified Capabilities
- `agent`:
  - the tools offered and the developer item depend on `FILE_TOOLS`;
  - the configuration gains `FILE_TOOLS`, validated at start-up like the other settings;
  - `read_file` becomes `read` wherever it is named.
- `read-file-tool`: the tool is named `read`, and its messages say "the read tool". It gains `offset` and `limit`, and its 32 KiB cap now ends on a whole line, with a note giving the `offset` to continue from. After archive the capability folder is renamed `read-tool` by hand, since OpenSpec can't rename a capability.
- `agent-loop`, `tool-calls` and `structured-log`: their examples name `read` instead of `read_file`. `agent-loop`'s unknown-tool example calls `delete`, because `write` now exists.
- `skills`: the catalog tells the model to read a skill's files with the `read` tool.
- `shell-tool`: the note on cut output suggests paging through the saved output with the `read` tool.

## Impact

- **Code:**
  - `packages/core/src`: a new `patch` module that parses V4A and applies hunks to text, as pure functions exported by name.
  - `packages/agent/src/tools`: new `write.ts`, `edit.ts`, `apply-patch.ts` and `fence.ts`; `read-file.ts` becomes `read.ts`, pages by line and uses the fence; `shell.ts`'s cut note names the `read` tool.
  - `packages/core/src/skills.ts`: the catalog's instruction names the `read` tool.
  - `packages/agent/src/config/config.ts` and `main/main.ts`.
  - Tests for all of it, held to the 100% mutation bar, and the README.
- **Dependencies:** none.
- **Security:**
  - The shell is unfenced on the host (D18), so the fence bounds only these tools. It turns the model's mistakes into clear errors; it is not a boundary.
  - Nothing new becomes reachable: the shell can already write anywhere the user can.
  - Every write is logged, because each tool call's arguments are, `content` and `patch` included.
- **Behaviour:** the tools offered change for every run, so the first request's `tools[]` differs from before. That's a one-time cache miss, nothing more.
