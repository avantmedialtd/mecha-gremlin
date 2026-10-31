## 1. The command's arguments

- [x] 1.1 Write the argument reading in `packages/agent/src/main/`, with `node:util`'s `parseArgs`, strict and with `tokens`:
  - the subcommands and their operands, `get <name>` included;
  - `add`'s two forms, a URL or `--` and a command, with everything after `--` kept as given;
  - the options, `--option=value` included, and which kind of server each is for;
  - `--header 'Name: value'` split at the first `:`, `--env NAME=value` at the first `=`, and `--env NAME` as `NAME=${NAME}`;
  - times with a unit, `ms`, `s`, `m` or `h`, from 1 s to 2,147,483,647 ms, and the defaults of 30 s and 2 min.

  An argument that can't be read is reported on its own, an unknown option with the hint that a local server's command comes after `--`. Every other problem is reported together, naming its flag. Usage errors end by naming `bun run mcp help`.
- [x] 1.2 Build the server's entry from the flags with `Object.fromEntries`, both timeouts in it, and no empty `args`, `env` or `headers`. Then hand it to `checkEntry`, whose problems and warnings come back as they are.

## 2. The output

- [x] 2.1 Write the plain-text output:
  - the result lines of `add`, with `--disabled` too, and of `remove`, `disable` and `enable`;
  - the `list` table, padded to the widest value and two spaces apart, with an argument that holds a space or a quote written in single quotes, and the line for no servers;
  - the `get` view: labelled lines, references as written, both timeouts in the largest unit that divides them exactly, and how to change the server;
  - `error: ` and `warning: ` lines on stderr, warnings before the result.

## 3. The command

- [x] 3.1 Rewrite `src/main/mcp.ts` around 1 and 2:
  - help first, as now;
  - `DATA_DIR` alone, with no logger and no `migrated` line;
  - the six subcommands;
  - exit codes as the delta says.
- [x] 3.2 In `config.ts`, have `loadMcpConfig` read `DATA_DIR` alone, with the agent's check of it.
- [x] 3.3 In `mcp/secrets.ts`, have `ADVICE` say to give the reference in single quotes, so that the shell leaves it alone.
- [x] 3.4 Rewrite `src/main/mcp-help.ts` from the design's draft, within 80 columns.
- [x] 3.5 Remove `src/mcp/json.ts` and `test/mcp/json.test.ts`. Have the tests in `test/mcp/entry.test.ts` that used `parseJson` build their values directly, with `JSON.parse` where a key such as `__proto__` must be an own property.

## 4. Tests

- [x] 4.1 Test every scenario of the `mcp-servers` delta, on both runtimes:
  - rewrite `test/main/mcp.test.ts` to read stdout and stderr;
  - test the arguments and the output helpers on their own;
  - keep the test that `bun run mcp:node` prints what `bun run mcp` prints.
- [x] 4.2 Update `test/config/config.test.ts` for `loadMcpConfig`.

## 5. Documentation and checks

- [x] 5.1 Rewrite the README's "MCP servers" section for the flags:
  - adding a remote and a local server, the options and their defaults, and how a time is written;
  - references in single quotes, and what double quotes do;
  - `--env NAME`;
  - GitHub's snippet turned into flags;
  - `list`, `get`, `remove`, `disable` and `enable`.

  Configuration: the command needs `DATA_DIR` alone.
- [x] 5.2 Add a 2026-10-31 line to the Brief's log: the command takes flags, has default timeouts, prints plain text, and gains `get`.
- [x] 5.3 Add new words to `cspell.json`, then run:
  - `bun run check`;
  - a scoped `bun run mutation` over every source file this change touches, at 100%, with every timeout looked at;
  - `openspec validate simplify-mcp-command --strict`.

  Fix what fails.
