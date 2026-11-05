## Why

Every run connects every enabled MCP server, and under D33 any one that can't start fails the run, so every task depends on every server. A one-line question fails when an unrelated server's login is spent, and the only fix the error offers, `bun run mcp disable`, takes the server from every task. Every server's tool definitions also reach every task: about 21,900 tokens for the 15 servers measured (Brief Q21). A task file names the servers it needs in its frontmatter, as TASK.md's `skills:` list will name its skills, and marks those it can go without, so that a task written to report a missing source gets to (Brief C21, C22, D44–D49).

## What Changes

- **A task file's frontmatter chooses its MCP servers.** A top-level `mcp` list names them, as `bun run mcp list` shows them, and the run connects those and no others. With no list, every enabled server connects, as now; `mcp: []` connects none.
- **BREAKING: the frontmatter is stripped from the task.** A block counts when the trimmed text opens with a `---` line, a later `---` line closes it, and what lies between parses as a YAML mapping or is empty. The body, trimmed, is the task. A block that parses as plain text, as after a horizontal rule, stays in the task. This reverses D40, which sent the frontmatter verbatim. An inline task's text, from `-p`, is read the same way.
- **What fails before the store opens,** reported with the configuration's problems:
  - frontmatter that isn't valid YAML, with the parser's reason and line, where a file holding one ran before;
  - an `mcp` value that isn't a list of names, with a hint showing `mcp: [docs]` or `mcp: []`;
  - a name given twice, with or without its `?`;
  - a task whose body is blank once its frontmatter is stripped.
- **A key the run doesn't read gets a `warn` record,** and is ignored.
- **What fails before any network request:** a listed name the store doesn't hold, pointing at `bun run mcp list`, and a listed server that's disabled, pointing at `bun run mcp enable <name>`.
- **A `?` marks a server the run may go without:** `mcp: [docs, github?]`.
  - **Whatever would fail the run for a required server,** being disabled included, leaves an optional one out instead.
  - **A left-out server gets a `warn` record `mcp server left out`,** and a line in the starting instructions that names it and its reason.
  - **A run whose servers all start sends the instructions it sends now,** and the exit code doesn't change.
- **D33's error names a second way to run without a server:** a task `mcp` list that leaves it out, beside `bun run mcp disable <name>`.
- **The `asking` record gains `mcp`,** the task's list as written, when it has one.
- **The README** describes the list, the marker, and what is stripped and why.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent`: changes two requirements:
  - "Carry out a task through the agent loop, and log the answer": the frontmatter read and stripped, what fails, the servers connected, and the starting instructions' line about left-out servers;
  - "Log each model call and tool call": the `frontmatter key ignored` record, the left-out servers' records, and the `asking` record's `mcp`.
- `mcp-client`: changes three requirements:
  - "Connect every enabled server before the session", renamed "Connect the servers a task chooses before the session": which servers start, the names that fail, optional servers, and the failure's message;
  - "Log each server, and never its secrets": the `mcp server left out` record;
  - "Use a server's login in a run": a spent login, or a refused refresh at the start, leaves an optional server out, and the reference to the renamed requirement.

## Impact

- **`packages/core`:** `src/skills.ts`: a frontmatter split that allows a text without a block, beside the one SKILL.md uses, which refuses it.
- **`packages/agent`:**
  - a new module in `src/main/` that reads a task's frontmatter: the YAML, the list's shape, and the keys it ignores;
  - `src/main/args.ts`: the task's body, list and ignored keys, from a file or from `--prompt`;
  - `src/main/main.ts`: the ignored keys' records, the list passed to the servers, the left-out servers' line in the instructions, and `mcp` in the `asking` record;
  - `src/mcp/servers.ts`: the rows chosen, the names that fail, an optional server's failure kept apart and its server closed alone, and the left-out servers reported;
  - `src/mcp/resolve.ts` and `src/mcp/servers.ts`: the failure messages' second way to run without a server;
  - the tests: `test/main/args.test.ts`, `test/main/main.test.ts`, and `test/mcp/servers.test.ts`, whose `describe` follows the renamed requirement.
- **The repository root:** the README's task-file and MCP sections; the Brief's log.
- **Not in scope:**
  - narrowing a server's tools for one task (Brief Q27);
  - a `--mcp` flag;
  - TASK.md's other keys (Brief C6, D5);
  - restarting a server that dies mid-session (Brief Q23), or telling the model about one.
