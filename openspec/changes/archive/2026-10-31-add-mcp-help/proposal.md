## Why

`bun run mcp` has no help. `--help`, `-h`, `help` and no arguments at all each give one `error` record naming the five subcommands, and only after `DATA_DIR` and `LOG_FORMAT` have passed their checks. Someone meeting the command learns nothing about what an `<entry>` is, that `-` reads it from stdin, that both timeouts are required, how a secret is given, or which settings the command needs. Its first use, on 2026-10-31, stalled on exactly this.

## What Changes

- **A usage text.** `bun run mcp help`, `--help` and `-h`, whatever follows them, and `bun run mcp` with no arguments, write one screen of plain text to stdout: the five subcommands and their arguments, `-` for stdin, `bun run mcp:node`, the rule for a name, what an entry is and its fields by transport, the two required timeouts and the filters, references in place of secrets with an example entry on stdin, the two settings, and where the README explains the rest.
  - It is plain text whatever `LOG_FORMAT` is, needs no setting and opens no store, so it works before anything is configured.
  - A request for help exits with 0; no arguments exits with 1, as before.
- **Errors point to it.** The error for an unknown subcommand or a wrong number of arguments ends by naming `bun run mcp help`.
- **The README** names `bun run mcp help`, and its layout lists the help text's module.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-servers`: "Manage MCP servers with the mcp command" gains the help request, its text, its exit codes and the pointer in the usage errors.

## Impact

- **`packages/agent`:** `src/main/mcp-help.ts`, new, holding the text; `src/main/mcp.ts`, which parses the request before it reads the settings; `test/main/mcp.test.ts`.
- **The repository root:** the README.
- **Not in scope:** help for one subcommand (`bun run mcp help add`), which prints the same text; a `check` subcommand that contacts a server; and any change to the entry's checks or their messages, which name their problem already.
