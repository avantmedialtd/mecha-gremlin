## Why

A run takes its task from its arguments, joined with spaces. A long or multi-line task, the kind worth keeping in a Markdown file, has to go through the shell as `"$(cat task.md)"`. Unquoted, the shell splits it into words and its lines are lost; quoted, it is still bound by the system's limit on arguments (Brief R19). Taking the task from a file by default, with a flag for a short one typed inline, makes the file the normal way and keeps the inline one a flag away (Brief C19, D39 and D40).

## What Changes

- **BREAKING: the argument is a task file.** `bun run agent <file>` sends the file's text as the task, trimmed and otherwise verbatim, frontmatter included. Any text file will do; the extension isn't checked. A relative path resolves against the directory the agent starts in, which under `bun run` is the repository's root. `bun run agent 'Say hi'` now looks for a file named `Say hi`, and the error names `--prompt`.
- **`--prompt <task>`, or `-p <task>`,** gives the task inline, as one argument, trimmed.
- **One way at a time.** No task, a file and `--prompt` together, two files, `--prompt` twice, or an unknown option fails, with an error that names both forms.
- **A task file must be text the model may read.** One that can't be read, is binary (a NUL byte in its first 8 KiB, the test `read` uses) or holds only whitespace fails. So does one the file tools refuse, a `.env` file or a file in the data folder, so that a slip of the shell's completion can't send secrets to the provider and print them in the log.
- **Before anything else.** Like today's missing task, these problems are reported with the configuration's, before the store opens and before any network request.
- **The `asking` record** keeps the task's text, and gains `taskFile`, the task file's absolute path, when the task came from a file.
- **The README, CI's start-up check on Node, and the tests** give the task with `-p` where they gave it inline.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent`: changes two requirements:
  - "Carry out a task through the agent loop, and log the answer": where the task comes from, and what fails before any request;
  - "Log each model call and tool call": the `asking` record's `taskFile`.

## Impact

- **`packages/agent`:**
  - `src/main/args.ts`: the task from a file or from `--prompt`;
  - `src/main/main.ts`: reads the task before the store opens, reports its problems with the configuration's, and logs `taskFile`;
  - `src/main/mcp-args.ts`: its strict parsing, with a lenient pass that names the option it refused, moves to a module both commands use;
  - `src/tools/read.ts`: its binary probe is shared with the task file;
  - the tests: `test/main/main.test.ts`, whose runs give their task with `-p`; the parser's own tests; and `test/config/explicit-config.test.ts`, whose task test moves to them.
- **The repository root:** the README's usage, its examples and "Running with servers"; the start-up check in `.github/workflows/ci.yml`; the Brief's log, C19, D39 and D40.
- **Not in scope:**
  - reading the task from stdin, which `-` could name later;
  - a size cap on the task file, which waits on the Brief's Q25;
  - reading TASK.md's frontmatter (Brief C6, D5);
  - a help text for the agent's command.
