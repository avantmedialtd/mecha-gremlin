## Context

- **What a run connects now.** `main.ts` lists the store's servers and passes those whose `disabled` flag is off to `createMcpServers().connect`. `connect` prepares every row before any request (`prepare`: the references, the entry's checks, a saved login), then starts them all in parallel. `collect` turns any failure into the run's, after `close()` ends every server (D33).
- **How the task arrives.** `readTask` (`main/args.ts`) reads a file or `--prompt`, trims the text and returns `{ text, file }` before the store opens. `main.ts` reports its problems with `loadConfig`'s. The text goes to the model verbatim, frontmatter included (D40), and into the `asking` record.
- **The parsers.**
  - `splitFrontmatter` (`core/src/skills.ts`) wants `---` alone on the first line and on a later one, and refuses a text without a block, with SKILL.md's message.
  - `parseYaml` (`@mecha-gremlin/yaml`) uses `Bun.YAML` on Bun and the `yaml` package elsewhere. The two agreed on every case in Brief R23, including the errors for `title: Meeting: Q3 plan`, `author: @someone` and a tab indent. Only the `yaml` package's message names a line and column; `Bun.YAML`'s says "Unexpected token".
- **The instructions.** `main.ts` builds the developer item from `instructions(workDir, fileTools)` and, when skills are loaded, their catalog.
- **Server names** match `NAME` in `mcp/entry.ts`, `^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$`, so no name holds a `?`.
- **The failure messages.**
  - `serverProblem` (`mcp/resolve.ts`) and `failureMessage` (`mcp/servers.ts`) end with "To run without it: bun run mcp disable <name>."
  - `findLogin` (`mcp/bearer.ts`) words a spent login "it needs a new login: bun run mcp login <name>".

## Goals / Non-Goals

**Goals:**
- A task depends only on the servers it names (D44), and can go without those it marks with `?` (D49).
- The model gets the task's body, and never its frontmatter (D45).
- Every mistake in the list caught before any network request, and the frontmatter's own before the store opens, with the configuration's problems (D47).
- A task without a list connects what it connects now.

**Non-Goals:**
- Narrowing a server's tools for one task (Brief Q27).
- A `--mcp` flag.
- TASK.md's other keys (C6, D5). The reader knows `mcp` alone, and warns about the rest (D48).
- Restarting a server that dies mid-session, or telling the model about one (Q23).

## Decisions

- **The frontmatter is read in a module of its own, `main/frontmatter.ts`,** which `readTask` calls for a task file and for `--prompt` alike.
- **One rule for where a block starts and ends.** `core/src/skills.ts` gains `findFrontmatter(text)`, which gives `{ frontmatter, body }`, or `undefined` when the text has no block. That means no first line of exactly `---`, or no later line of exactly `---`. `splitFrontmatter` keeps SKILL.md's refusals, and calls it.
  - **Turned down:** a copy of the split in `agent`, which would drift from SKILL.md's; and refusing a task whose opening `---` is never closed, which is plain Markdown, a horizontal rule.
- **What counts as frontmatter.** The block's lines must parse as a YAML mapping, or be empty, which both parsers read as `null`. A block that parses as anything else, such as a sentence or a list, isn't frontmatter, and the text stays whole.
  - **Turned down:** stripping any block between two `---` lines, which would drop the prose after a horizontal rule; and stripping only a block that holds a key the run reads, which would send a note's `tags` to the model from one file and not from another.
- **Frontmatter that isn't valid YAML fails the run** (D47). The error names the task file, or `--prompt`, says that the frontmatter on lines 2 to N isn't valid YAML, and gives `parseYaml`'s reason, cut at its first line as SKILL.md's is. The line range comes from the split, so it is the same on both runtimes; the reason may add a line and column on Node.
- **`mcp` is the only key read.** Any other gets a `warn` record `frontmatter key ignored` with `key`, in the block's order, logged before `asking` (D48).
- **The list's shape is checked before the store opens.** `mcp` must be a list of strings, each a name that matches `NAME` once a trailing `?` is taken off.
  - **What fails:** a string (`mcp: docs`), `null` (`mcp:`), any other item, and a name given twice, with or without its `?`. The error shows `mcp: [docs]`, and `mcp: []` for no servers.
  - **Turned down:** taking `mcp: docs` as a list of one, a second spelling of the same thing.
- **The body** is the text after the closing line, trimmed. A blank body fails, as a blank task does.
- **`readTask` gives `{ text, file, mcp, ignored }`:**
  - `text`, the body;
  - `mcp`, the list as written, each name with its `?`, or `undefined` without one;
  - `ignored`, the other keys.
- **The servers are chosen in `createMcpServers().connect`,** given every row and the task's list, or `undefined`.
  - **Without a list,** the enabled rows, every one required, as now.
  - **With a list,** the named rows and no others.
    - A name with no row fails the run, pointing at `bun run mcp list`.
    - A required name whose row is disabled fails the run, pointing at `bun run mcp enable <name>`.
    - An optional one is left out, with the reason "it's disabled".

    All of these are found before any network request, and reported with the other servers' problems.
  - **Why `connect`:** it already owns the checks made before any request, and their messages, so `main.ts` stays a caller.
  - **Turned down:** filtering in `main.ts`, which would split the server checks between two modules.
- **An optional server's failure is kept apart.**
  - **Before any request,** `prepare`'s problem for an optional row leaves it out instead of failing the run: a reference that can't resolve, an entry check, or a login to give again.
  - **While connecting,** the results are split by whether the server is optional. Any required failure still closes every server and fails the run, with every required failure's message. An optional failure closes that server alone, its client and its stdio transport, and the run goes on.
  - **Closing one server:** each `Connection` gets its own idempotent close, which the shared close calls for every connection. A left-out server's runs at once, and the shared close then finds it closed.
  - **The reason** is `startFailure`'s text, already redacted of the server's resolved values, without the stderr lines; a check's problem text, for a failure before any request; or "it's disabled".
  - **What `connect` gives:** the tools, as now, and the left-out servers, each a name and a reason, in name order.
- **The model is told in the starting instructions.** When any server was left out, `main.ts` ends the developer item with one more paragraph: "These MCP servers couldn't start, so their tools aren't available:" and each server with its reason, in name order. A run that left none out sends the instructions it sends now.
  - **Why last:** the preamble and the catalog are fixed for a configuration, so the part that can change comes after them, and the prompt cache keeps the rest.
  - **Turned down:** a note in the user input, which would put the run's state into the task; and saying nothing, which leaves a task written to report a missing source unable to tell a server that failed from one it never had.
- **Records.** A left-out server gets a `warn` record `mcp server left out` with `name` and `reason`, in name order among the servers' records, before `asking`. The `asking` record gains `mcp`, the list as written, when the task has one; the logger leaves an undefined field out.
- **D33's messages name a second way to run without a server.** `serverProblem` and `failureMessage` end with `bun run mcp disable <name>`, for every run, and a task `mcp` list that leaves the server out, for one task.
- **The requirement is renamed** "Connect the servers a task chooses before the session", and `servers.test.ts`'s `describe` follows it.

## Risks / Trade-offs

- **[A note whose frontmatter isn't valid YAML, which ran before, now fails]** → The error names the file, the block's lines and the parser's reason. Quoting the value fixes it.
- **[A note's frontmatter no longer reaches the model]** → Whatever the model needs moves to the body, and the README says so.
- **[A misspelt key is ignored, and the run gets every server]** → Its `warn` record names it.
- **[Prose between two horizontal rules at a file's start can parse as a mapping, and is stripped]** → That is how a leading `---` block is usually read; the README says so.
- **[A `?` can hide a broken configuration, run after run]** → Each run logs `mcp server left out` with the reason, and the model is told, so the task's answer can say so.
- **[A left-out server sets off no alert]** → None exists yet (Brief Q1). The record and the answer carry it.
- **[A list copied to a machine whose servers have other names fails]** → The error names the server and `bun run mcp list`.

## Migration Plan

- **No data migration.** A task file without frontmatter runs as before; one with frontmatter loses it from the prompt.
- **Archiving:**
  - The `agent` delta's MODIFIED "Carry out a task through the agent loop, and log the answer" replaces the scenario "Frontmatter is part of the task" with "Frontmatter is stripped from the task". `openspec archive` refuses a MODIFIED block that leaves out a current scenario, so remove that scenario from the main spec first.
  - The `mcp-client` delta renames "Connect every enabled server before the session". The archive puts a renamed requirement after the kept ones, so move it back to the top.
  - Refresh `mcp-client`'s Purpose, which says it connects "every enabled server before the session".

## Open Questions

None that block the change. Brief Q27, narrowing a server's tools for one task, stays open.
