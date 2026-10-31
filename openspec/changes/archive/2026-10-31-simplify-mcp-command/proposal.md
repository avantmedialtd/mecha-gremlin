## Why

`bun run mcp add` takes a hand-written JSON object, an "entry", which `add-mcp-servers` carried over from the configuration file that D29 replaced. To add a server you write JSON in a shell, unwrap it from the vendor's snippet, type the server's name separately, and add two timeouts that no vendor gives; `list` then prints log records rather than something to read. On 2026-10-31, at its first use, the command made no sense to its user, who chose instead: flags, as `claude mcp add` takes them; default timeouts; and plain text for people.

## What Changes

- **BREAKING: `add` takes flags, not an entry.**
  - A remote server is `bun run mcp add <name> <url>`, and a local one is `bun run mcp add <name> -- <command> [args…]`.
  - Options: `--header 'Name: value'`, `--env NAME=value` (or `--env NAME`, which passes the agent's own variable through), `--cwd`, `--include-tool`, `--exclude-tool`, `--startup-timeout`, `--tool-timeout` and `--disabled`.
  - An entry given as JSON, on the command line or on stdin with `-`, is no longer accepted.
- **Default timeouts.** A server starts within 30 s and each call takes at most 2 min, unless `--startup-timeout` or `--tool-timeout` says otherwise; a time is a whole number with a unit, as in `90s`.
- **BREAKING: plain text, not log records.** Results go to stdout for people: `list` prints a table, and the other subcommands one line each. Problems go to stderr as `error:` lines, and warnings as `warning:` lines. The command no longer needs `LOG_FORMAT`; `DATA_DIR` is its only setting.
- **A new subcommand, `get <name>`,** shows one server's settings, since `list` shows only its target.
- **The help text** describes the flags.
- **The refusal of a literal secret** says to put the reference in single quotes, so that the shell leaves it alone.
- **Unchanged:** what is stored for a server (an `mcpServers` entry, with both timeouts), every check of it, and how a run connects. Servers already added keep working.
- **Removed:** the strict JSON tokenizer, `mcp/json.ts`, which only read pasted entries.
- **The README's** "MCP servers" section is rewritten for the flags.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-servers`: "Manage MCP servers with the mcp command" and "Accept an entry in the mcpServers format" are replaced by "Manage MCP servers from the command line", "Describe a server with flags" and "Keep each server as an mcpServers entry"; "Give secrets only as references" and "Check headers, URLs and timeouts" are restated for the flags and the default timeouts.

## Impact

- **`packages/agent`:**
  - `main/mcp.ts`, rewritten around the flags and plain-text output;
  - new helpers in `main/` for the arguments and the output;
  - `main/mcp-help.ts`;
  - `config.ts`'s loader for the command, which reads `DATA_DIR` alone;
  - the literal-secret advice in `mcp/secrets.ts`;
  - `mcp/json.ts` and its tests removed;
  - the command's tests.
- **The repository root:** the README, the Brief's log and `cspell.json`.
- **Not in scope:** importing a vendor's snippet whole; changing a server in place, which stays `remove` and then `add`; checking a server by contacting it; and anything a run does.
