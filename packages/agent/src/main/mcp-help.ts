// What `bun run mcp help` prints: one screen, for someone who may have nothing configured yet.
// The README's "MCP servers" section holds the rules; this names what they are about.
export const HELP = `bun run mcp keeps the MCP servers that each run of the agent connects to.

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
  bun run mcp add github https://api.githubcopilot.com/mcp/ \\
    --header 'Authorization: Bearer \${GITHUB_PAT}'
  bun run mcp add playwright -- npx -y @playwright/mcp@0.0.83

The command needs DATA_DIR, the folder that holds the agent's database, from
the environment or .env. It never contacts a server. The README's "MCP
servers" section has the full rules.`;
