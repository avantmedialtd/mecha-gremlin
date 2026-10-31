## 1. The help text

- [x] 1.1 Write `packages/agent/src/main/mcp-help.ts`, exporting the usage text as one template literal: the five subcommands with their arguments and `-` for stdin; `bun run mcp:node`; the rule for a name; what an entry is, one server's object from inside `mcpServers`, with its fields by transport, the two required timeouts and the filters; references in place of secrets, with the README's GitHub example on stdin; `DATA_DIR` and `LOG_FORMAT`; and the README's "MCP servers" section.

## 2. The command

- [x] 2.1 In `src/main/mcp.ts`, parse `help`, `--help` and `-h`, whatever follows them, and no arguments as a request for help, before the settings are read; write the text with `console.log`; exit with 0 for a request and 1 for no arguments; read no setting and open no store.
- [x] 2.2 End the errors for an unknown subcommand and for a wrong number of arguments with `bun run mcp help explains the command.`

## 3. Tests

- [x] 3.1 In `test/main/mcp.test.ts`, test the four new scenarios of the `mcp-servers` delta (help with no settings, help however it's asked for, no arguments, a wrong number of arguments), and update the tests whose wording changed: the unknown subcommand, and settings and usage reported together.

## 4. Documentation and checks

- [x] 4.1 Update the README: the Layout line for `main`, and `bun run mcp help` in the MCP servers section and in Configuration.
- [x] 4.2 Run `bun run check`, a scoped `bun run mutation` over `src/main/mcp.ts` and `src/main/mcp-help.ts` (100%), and `openspec validate add-mcp-help --strict`, and fix what fails.
