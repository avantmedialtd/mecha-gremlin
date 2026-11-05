## 1. The frontmatter

- [ ] 1.1 In `packages/core/src/skills.ts`, add `findFrontmatter(text)`, which gives `{ frontmatter, body }`, or `undefined` when the text has no first line of exactly `---` or no later line of exactly `---`. Rewrite `splitFrontmatter` on it, keeping SKILL.md's refusals and their messages. Test both in `packages/core/test/skills.test.ts`.
- [ ] 1.2 Export `NAME`, the server-name pattern, from `packages/agent/src/mcp/entry.ts`.
- [ ] 1.3 Add `packages/agent/src/main/frontmatter.ts`, which reads a trimmed task's text. The details:
  - **The block:** found with 1.1's `findFrontmatter` and parsed with `parseYaml`. A block that parses as a mapping, or as `null`, is frontmatter; anything else leaves the text whole;
  - **Invalid YAML:** an error naming the task file, or `--prompt`, the lines the block takes, and `parseYaml`'s reason;
  - **`mcp`:** a list of strings, each matching 1.2's `NAME` once a trailing `?` is taken off. A string, `null`, any other item, or a name given twice, with or without its `?`, fails with a hint showing `mcp: [docs]` and `mcp: []`;
  - **Other keys:** returned in the block's order, to be logged;
  - **The body:** the text after the closing line, trimmed. A blank body fails.
- [ ] 1.4 In `packages/agent/src/main/args.ts`, run 1.3's reader on the text from a task file and from `--prompt`, and give `Result<{ text, file, mcp, ignored }, string>`: `text` the body, `mcp` the list as written or `undefined`, `ignored` the other keys.

## 2. Choosing the servers

- [ ] 2.1 In `packages/agent/src/mcp/servers.ts`, give `connect` the task's list, or `undefined`, beside the rows. The details:
  - **Without a list:** the enabled rows, every one required, as now;
  - **With a list:** the named rows and no others. A name with no row fails, naming `bun run mcp list`; a required name whose row is disabled fails, naming `bun run mcp enable <name>`; an optional one is left out, with the reason that it's disabled. All are found before any network request, and reported with the other servers' problems.
- [ ] 2.2 Keep an optional server's failure apart. The details:
  - **Before any request:** a problem `prepare` finds for an optional row leaves the server out, with the problem as its reason;
  - **While connecting:** an optional failure closes that server alone, through an idempotent close of its own, which the shared close also calls, and the run goes on. A required failure still closes every server and fails the run;
  - **The reason:** `startFailure`'s text, redacted, without the stderr lines;
  - **The result:** the tools, as now, and the left-out servers, each a name and a reason, in name order.
- [ ] 2.3 Log a `warn` record `mcp server left out`, with `name` and `reason`, for each left-out server, in name order among the servers' records.
- [ ] 2.4 End `serverProblem` (`packages/agent/src/mcp/resolve.ts`) and `failureMessage` (`packages/agent/src/mcp/servers.ts`) with both ways to run without a server: `bun run mcp disable <name>`, for every run, and a task `mcp` list that leaves it out, for one task.

## 3. The run

- [ ] 3.1 In `packages/agent/src/main/main.ts`, log a `warn` record `frontmatter key ignored`, with `key`, for each ignored key, before `asking`.
- [ ] 3.2 Pass the task's list to `connect`. When servers were left out, end the starting instructions with one paragraph, "These MCP servers couldn't start, so their tools aren't available:", followed by each server and its reason, in name order. Otherwise leave the instructions as they are.
- [ ] 3.3 Add `mcp`, the list as written, to the `asking` record when the task has one.

## 4. Tests

- [ ] 4.1 Test 1.3's reader on its own, in `packages/agent/test/main/frontmatter.test.ts`, and through 1.4 in `test/main/args.test.ts`. Cover the delta's frontmatter scenarios:
  - frontmatter stripped from the task;
  - a block that isn't frontmatter, and an opening line that nothing closes;
  - frontmatter that isn't valid YAML;
  - an `mcp` value that isn't a list of names, and a server named twice;
  - a task that is only frontmatter;
  - frontmatter in an inline task.
- [ ] 4.2 In `test/mcp/servers.test.ts`, rename the `describe` to "Connect the servers a task chooses before the session". Test:
  - a task's list, and an empty list;
  - a name the store doesn't hold, and a listed server that's disabled;
  - an optional server that can't start, one that's disabled, one with an unset reference and one with a spent login;
  - a secret in a left-out server's reason;
  - the `mcp server left out` record's order;
  - the failure message's second way to run without a server.
- [ ] 4.3 In `test/main/main.test.ts`, test:
  - the instructions' paragraph for a left-out server, and the same instructions when every server starts;
  - the `frontmatter key ignored` records;
  - the `asking` record with and without `mcp`;
  - frontmatter in an inline task.

## 5. Documentation and checks

- [ ] 5.1 Update the README:
  - **the task file:** the frontmatter stripped from the task, the `mcp` list and its `?`, what fails, and that a note's frontmatter no longer reaches the model;
  - **"MCP servers":** a task's list in place of "each run connects to every server that isn't disabled", optional servers, the `mcp server left out` record, and the failure message's second way to run without a server.
- [ ] 5.2 Add a line to the Brief's log saying that `choose-task-mcp-servers` carries out D44–D49, by category only.
- [ ] 5.3 Run these, and fix what fails:
  - `bun run check`;
  - a scoped `bun run mutation`, at 100%, over `packages/core/src/skills.ts`, `packages/agent/src/main/frontmatter.ts`, `src/main/args.ts`, `src/main/main.ts`, `src/mcp/servers.ts` and `src/mcp/resolve.ts`;
  - `openspec validate choose-task-mcp-servers --strict`.
