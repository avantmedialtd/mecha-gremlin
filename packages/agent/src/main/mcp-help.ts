// What `bun run mcp help` prints: one screen, for someone who may have nothing configured yet.
// The README's "MCP servers" section holds the rules; this names what they are about.
export const HELP = `bun run mcp keeps the MCP servers that each run of the agent connects to.

Usage: bun run mcp <subcommand>
  add <name> <entry>   add a server; an <entry> of - is read from stdin
  list                 list the servers, in name order
  remove <name>        remove a server
  disable <name>       keep a server, but don't start it
  enable <name>        start it again
  help                 show this text
On Node, bun run mcp:node takes the same subcommands.

A <name> is 1 to 24 letters and digits, in words joined by single - or _
characters. The model sees the server's tools as mcp__<name>__<tool>.

An <entry> is one server's JSON object, as found inside the "mcpServers" map
that vendors publish, without the map around it:
  a local server:    "command", with "args", "env" and "cwd"
  a remote server:   "url", with "headers"
  both:              "startupTimeoutMs" and "toolTimeoutMs", required, in
                     milliseconds; "includeTools", "excludeTools", "disabled"
A secret is given as a reference to a variable set in .env, never as itself.
Give the entry on stdin, so that it stays out of your shell's history:

  bun run mcp add github - <<'EOF'
  {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer \${GITHUB_PAT}" },
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 120000
  }
  EOF

Settings, from the environment or .env: DATA_DIR, the folder that holds the
agent's database, and LOG_FORMAT, pretty or json. The command never contacts a
server. The README's "MCP servers" section has the full rules.`;
