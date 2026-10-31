## Context

`add-mcp-servers` (archived 2026-10-30) gave the agent MCP servers, kept as rows in the store and written by `bun run mcp`. Its `add` took one server's `mcpServers` entry as JSON, as an argument or on stdin, and every subcommand reported through the structured logger. `add-mcp-help` (2026-10-31) added a help text, which could only explain that shape. On 2026-10-31 the user found the command made no sense, and chose:

- flags, as `claude mcp add` takes them, rather than a JSON entry;
- default timeouts, overridable;
- plain text for people, rather than log records.

What a run reads (`mcp-client`) is not in question: a server's stored entry, its checks and the run's re-check stay as they are.

## Goals / Non-Goals

**Goals:**
- Add a remote or a local server with one command line, as in other MCP clients, without writing JSON.
- Need no setting but `DATA_DIR`, and print what a person can read.
- Keep the stored format, so that servers already added, and every check of a server, carry over unchanged.

**Non-Goals:**
- Importing a vendor's `mcpServers` snippet whole, which the user didn't choose.
- Changing a server in place: `remove`, then `add`, as before.
- Anything a run does.

## Decisions

### 1. The grammar

```
bun run mcp add <name> <url> [options]                 a remote server
bun run mcp add <name> [options] -- <command> [args…]  a local server
bun run mcp list | get <name> | remove <name> | disable <name> | enable <name> | help
```

- **The transport is the shape of the line.** A URL as the second argument means Streamable HTTP, and `--` followed by a command means stdio, so there is no `--transport` flag. Claude Code needs `--transport http` because its second argument may be either; here a URL must start with `http://` or `https://`, and a command always follows `--`.
- **Everything after `--` belongs to the command,** options included, so `npx -y …` needs no quoting.
- **Options go anywhere before `--`,** as `--option value` or `--option=value`.

| Option | For | Stored as |
|---|---|---|
| `--header 'Name: value'`, repeatable | a remote server | `headers`: the name is the text before the first `:`, the value the text after it, trimmed |
| `--env NAME=value`, repeatable | a local server | `env`; `--env NAME` alone passes the agent's own variable through, as `NAME=${NAME}`, like Docker's `-e NAME` |
| `--cwd <dir>` | a local server | `cwd` |
| `--include-tool <tool>`, `--exclude-tool <tool>`, repeatable | both | `includeTools`, `excludeTools` |
| `--startup-timeout <time>`, `--tool-timeout <time>` | both | `startupTimeoutMs`, `toolTimeoutMs`: 30000 and 120000 unless given |
| `--disabled` | both | the server's flag, beside the entry |

- **Times** are a whole number and a unit, `ms`, `s`, `m` or `h`, as in `90s` or `2m`. A bare number is refused, since nothing in it says whether it means seconds or milliseconds, which is the mistake the old entry's 1,000 ms floor existed to catch.
- **Parsing** uses `node:util`'s `parseArgs`, strict, with `tokens` to find `--`. Repeated options, `--option=value` and the position of `--` came out the same on Bun 1.4.4 and Node 26.12.1 (checked on 2026-10-31). `parseArgs` stops at the first argument it can't read, so an unknown option or an option without its value is reported on its own. Every problem found after that is reported together.
- **An unknown option** is most often a local server's command given without `--`, as in `add playwright npx -y …`, where `-y` is the unknown option. Its error says that the command comes after `--`.

### 2. Flags build the entry that was stored before

`add` turns the flags into the same `mcpServers` entry it stored before, and gives it to `checkEntry`, which checks it as before. It fills in the default timeouts, so every stored entry holds both, and a run needs no defaults of its own. It omits an empty `args`, `env` or `headers`. Objects are built with `Object.fromEntries`, which defines each key as an own property, so `--env __proto__=x` is a variable like any other.

- **Rows from before** keep working, since the stored format hasn't changed. A row holding `title` or `description` loses nothing.
- **Defaults are written when a server is added,** so changing them later leaves existing servers as they are.
- **Errors keep their wording** where `checkEntry` finds the problem, such as a literal secret in a header, a plain-http URL with a reference, or a relative `cwd`. The flags' own problems name the flag, such as a header without `:` or a time without a unit.

### 3. Plain text

- **stdout** carries results:
  - `add`: `Added <name> (<transport>).`, or, with `--disabled`, a line saying runs won't start it until `bun run mcp enable <name>`;
  - `list`: a table of `NAME`, `TRANSPORT`, `TARGET` and `ENABLED` (`yes` or `no`), in name order, padded to the widest value and two spaces apart. The target is the URL, or the command and its arguments, any argument holding a space or a quote written in single quotes. With no servers, it prints one line saying so and how to add one;
  - `get <name>`: the name, then one labelled line per setting (the transport; the URL and each header, or the command with its arguments, each variable and the `cwd`; the filters; both timeouts, in the largest unit that divides them exactly; and whether it's enabled), then how to change it: `remove`, then `add`;
  - `remove`, `disable` and `enable`: one line each.
- **stderr** carries `error: <problem>` lines, one per problem, and `warning: <reason>` lines. Warnings come before the result line, so they aren't missed.
- **Exit codes:** 0 on success; 1 on any problem; 1 for the bare command, which prints the help.
- **`LOG_FORMAT`** is no longer read, and the `migrated` record is dropped: a person has no use for it. `loadMcpConfig` reads `DATA_DIR` alone, with the agent's check of it.
- **Alternative: keep the records.** Rejected by the user. The agent's own output stays records.

### 4. `get`

`list` shows only a server's target, and an entry is no longer something the user writes. So `get <name>` shows the rest, with references as written, as `claude mcp get` does. It ends with how to change the server, since that is `remove` and then `add`.

### 5. The help text

Drafted to fit 80 columns; the implementation may reflow it, but not drop an item the spec names:

```
bun run mcp keeps the MCP servers that each run of the agent connects to.

Usage:
  bun run mcp add <name> <url> [options]                add a remote server
  bun run mcp add <name> [options] -- <command> [args]  add a local server
  bun run mcp list                                      list the servers
  bun run mcp get <name>                                show a server's settings
  bun run mcp remove <name>                             remove a server
  bun run mcp disable <name>                            stop starting it
  bun run mcp enable <name>                             start it again
  bun run mcp help                                      show this text
On Node, bun run mcp:node takes the same subcommands.

Options for add:
  --header 'Name: value'    a remote server's header; repeat it for more
  --env NAME=value          a local server's variable; repeat it for more.
                            --env NAME passes the agent's own NAME through
  --cwd <dir>               a local server's working directory
  --include-tool <tool>     offer only the tools named; repeat it for more
  --exclude-tool <tool>     leave out the tools named; repeat it for more
  --startup-timeout <time>  how long it may take to start: 30s if not given
  --tool-timeout <time>     how long one call may take: 2m if not given
  --disabled                add it, but don't start it yet
A <time> is a whole number and a unit, ms, s, m or h, as in 90s.

A <name> is 1 to 24 letters and digits, in words joined by single - or _
characters. The model sees the server's tools as mcp__<name>__<tool>.

Secrets are never stored. Give a reference to a variable set in .env, in
single quotes, so that your shell leaves it alone:
  bun run mcp add github https://api.githubcopilot.com/mcp/ \
    --header 'Authorization: Bearer ${GITHUB_PAT}'
  bun run mcp add playwright -- npx -y @playwright/mcp@0.0.83

The command needs DATA_DIR, the folder that holds the agent's database, from
the environment or .env. It never contacts a server. The README's "MCP
servers" section has the full rules.
```

### 6. What goes

- **`mcp/json.ts` and its tests:** the strict tokenizer existed for pasted entries. Stored entries are read back by TypeORM's `simple-json`, and `JSON.parse` defines `__proto__` as an own property, which the checks read as such.
- **The entry checks that only a pasted entry could fail.** These are the hints for a wrapper and for other clients' spellings, and the error for a missing timeout. They stay in `checkEntry`, since a hand-edited row can still fail them, but nothing in the command reaches them any more.

### 7. The literal-secret advice

`ADVICE` gains "in single quotes, so that your shell leaves it alone". Without them, `"Bearer ${GITHUB_PAT}"` reaches `add` with the token in place of the reference. The refusal then names the header as holding a literal secret, which is true, and the new words say why it happened.

## Risks / Trade-offs

- [`${NAME}` in double quotes is replaced by the shell] → refused as a literal secret, with advice that names single quotes; the help and the README show single quotes.
- [Scripts that pass an entry as JSON break] → none exist yet. The command arrived a day earlier, and the stored format is unchanged.
- [A vendor's snippet has to be read and turned into flags] → the README shows how for GitHub's remote server and for an `npx` server.
- [Defaults written at `add`] → a later change of default leaves existing servers alone. That is the same as before, when every entry spelt its timeouts out.
- [`parseArgs` reports only the first argument it can't read] → its errors are about typing, which one retry fixes. Every check after that reports together.
