# mcp-servers Specification

## Purpose
The `mcp` command, `bun run mcp` or `bun run mcp:node`, which adds MCP servers from flags, and lists, shows, removes, disables and enables them in the store, logs in to them and out (`mcp-login`), printing plain text, and explains itself with `help`; and the checks a server's settings must pass, kept as an entry in the `mcpServers` format: its fields, the server's name, references to secrets, headers, URLs, timeouts and pinning.
## Requirements
### Requirement: Name each server so its tools can be told apart
A server's name SHALL match `^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$`, and SHALL be 1–24 characters long. Its prefix, which its tools' names take (`mcp-client`), SHALL be the name lowercased, with `-` turned to `_`. `add` SHALL refuse a name already in use, and a name whose prefix another server has, naming that server.

#### Scenario: A name and its prefix
- **WHEN** a server is added as `Context7-docs`
- **THEN** its prefix is `context7_docs`

#### Scenario: Names that aren't allowed
- **WHEN** `add` is given `aws.docs`, `-x`, `a__b`, `a_` and a name of 25 characters
- **THEN** each is refused, with an error naming the rule

#### Scenario: A prefix in use
- **WHEN** a server named `github-api` exists, and `add github_api …` runs
- **THEN** it's refused, with an error saying its tools would share the prefix `github_api` with `github-api`

### Requirement: Give secrets only as references
- **References.**
  - A server's settings SHALL refer to the agent's environment with `${NAME}` or `${env:NAME}`, where `NAME` matches `[A-Za-z_][A-Za-z0-9_]*`. `$$` SHALL stand for one `$`.
  - References SHALL be allowed in the command, in each of its arguments, in `--env` values, in `--cwd`, in header values, and in a URL's path and query, but not in its scheme, userinfo, host or port.
  - Any other `$`, and any reference elsewhere, SHALL be refused, with a hint: there are no defaults, no editor variables and no bare `$NAME`.
  - `MODEL_API_KEY` SHALL NOT be referenced.
  - `add` SHALL store references as written; a run resolves them (`mcp-client`).
- **Credential slots.** A slot SHALL hold a reference when its name has a word, after splitting at `-`, `_`, `.` and lower-to-upper case changes, from: `KEY`, `KEYS`, `APIKEY`, `TOKEN`, `TOKENS`, `SECRET`, `SECRETS`, `PASSWORD`, `PASSWORDS`, `PASSWD`, `PASS`, `PASSPHRASE`, `PAT`, `AUTH`, `AUTHORIZATION`, `CREDENTIAL`, `CREDENTIALS` or `COOKIE`.
  - A slot is an `--env` variable's name, a header's name, a URL's query parameter, an argument of the command after an `--option` with such a name, or the text after `=` in such an `--option=value` argument.
  - A number, `true`, `false` or `none` is exempt, and so is a slot whose name's last word is `PATH`, `FILE` or `DIR`.
- **Text shaped like a secret** SHALL be refused anywhere in a server's settings. It is one of these prefixes, at the start of a string or after a character other than a letter or a digit, followed by at least 16 characters from `[A-Za-z0-9_-]` (for `AKIA`, 16 uppercase letters or digits): `ghp_`, `github_pat_`, `glpat-`, `xoxb-`, `xoxp-`, `xoxa-`, `sk-`, `sk_live_`, `rk_live_`, `ntn_`, `lin_api_` or `AKIA`. A `Bearer` or `Basic` credential written out, a JSON Web Token, a PEM private key, and userinfo in a URL SHALL be refused too.
- **Messages** SHALL name what is refused, and SHALL NOT quote a refused value. The refusal of a literal secret SHALL say to give it as a reference to a variable set in `.env`, in single quotes so that the shell leaves it alone, and that a secret typed on a command line is in the shell's history and should be changed.
- **References in arguments.** `add` SHALL store a server whose credential slot in the command's arguments holds a reference, with a warning that a run puts the value in the process list, which every local user can read, and that `--env` keeps it out, if the server reads one.

#### Scenario: A header from the environment
- **WHEN** `add docs https://docs.example.com/mcp --header 'Authorization: Bearer ${DOCS_TOKEN}'` runs
- **THEN** the server is stored with that header as written

#### Scenario: A literal token
- **WHEN** the header is given as `--header 'Authorization: Bearer abc123def'`
- **THEN** it's refused, with an error naming the `Authorization` header and saying to give it as a reference, in single quotes, and `abc123def` appears in no output

#### Scenario: A credential variable
- **WHEN** a local server is added with `--env API_KEY=abc`, then with `--env 'API_KEY=${API_KEY}'`, then with `--env API_KEY`
- **THEN** the first is refused, and the other two are each stored with `API_KEY` set to `${API_KEY}`

#### Scenario: Settings that aren't secrets
- **WHEN** a local server is added with `--env MAX_TOKENS=4096 --env AUTH_TYPE=none --env PRIVATE_KEY_PATH=/home/me/key.pem`
- **THEN** it's stored

#### Scenario: A key in an option
- **WHEN** an argument of the command is `--api-key=abc123def`
- **THEN** it's refused, with an error naming `--api-key`, and `abc123def` appears in no output

#### Scenario: Prefixes inside ordinary words
- **WHEN** a local server is added with `-- npx -y task-master-ai@0.30.0 --disk-cache`
- **THEN** it's stored

#### Scenario: A token's shape
- **WHEN** an argument of the command is `ghp_` followed by 36 letters and digits
- **THEN** it's refused, with an error naming the argument and not quoting it

#### Scenario: A reference in the arguments
- **WHEN** a local server is added with `-- server --api-key '${KEY}'`
- **THEN** it's stored, with a warning that a run puts the value in the process list

#### Scenario: A default or a bare variable
- **WHEN** a local server is given `--env 'TOKEN=${TOKEN:-abc123}'`, and then `--env 'DIR=$HOME/x'`
- **THEN** both are refused: the first with an error saying defaults aren't supported, in which `abc123` doesn't appear, and the second with a hint to write `${HOME}`

#### Scenario: A literal dollar
- **WHEN** an argument of the command is `$$5`
- **THEN** it's stored as written, and a run passes the argument `$5`

#### Scenario: The model's key
- **WHEN** a header is given as `--header 'Authorization: Bearer ${MODEL_API_KEY}'`
- **THEN** it's refused, with an error naming `MODEL_API_KEY`

#### Scenario: Userinfo
- **WHEN** the URL is `https://user:pw@docs.example.com/mcp`
- **THEN** it's refused, and `pw` appears in no output

#### Scenario: A reference in the host
- **WHEN** the URL is `https://${DOCS_HOST}/mcp`
- **THEN** it's refused, with an error saying a reference may appear only in a URL's path and query

### Requirement: Check headers, URLs and timeouts
- **Headers.**
  - A header name SHALL be an RFC 9110 token, and unique ignoring case.
  - `Accept`, `Content-Type`, `Content-Length`, `Host`, `Connection`, `Transfer-Encoding`, `Last-Event-ID`, `DPoP` and every name starting `Mcp-` SHALL be refused.
  - A header value SHALL be non-empty, and SHALL hold no control character other than tab, and no character above U+00FF.
- **URLs.**
  - A URL SHALL be `http` or `https`, with no userinfo and no fragment, and its port SHALL NOT be on the fetch standard's bad-port list.
  - Plain `http` SHALL be refused when a header or the URL holds a reference, whatever the host: Bun's fetch sends even a loopback request through `HTTP_PROXY` (R18.1).
- **Timeouts.** A server's `startupTimeoutMs` and `toolTimeoutMs` SHALL be whole numbers of milliseconds from 1,000 to 2,147,483,647. `add` SHALL store 30,000 and 120,000 when `--startup-timeout` and `--tool-timeout` aren't given ("Describe a server with flags").

#### Scenario: A reserved header
- **WHEN** a header is given as `--header 'Mcp-Session-Id: x'`, and then as `--header 'content-type: text/plain'`
- **THEN** each is refused, with an error naming the header

#### Scenario: A control character in a header
- **WHEN** a header's value holds a line feed
- **THEN** it's refused, with an error naming the header

#### Scenario: A character beyond Latin-1
- **WHEN** a header's value holds `€`
- **THEN** it's refused, with an error naming the header

#### Scenario: A bad port
- **WHEN** the URL is `https://docs.example.com:6000/mcp`
- **THEN** it's refused, with an error naming the port

#### Scenario: Plain HTTP with a reference
- **WHEN** the URL is `http://127.0.0.1:8080/mcp` with a header holding a reference, and then `http://docs.example.com/s/${DOCS_SECRET}/mcp`
- **THEN** both are refused, and `http://127.0.0.1:8080/mcp` with no reference anywhere is stored

#### Scenario: Seconds for milliseconds
- **WHEN** `--tool-timeout` is `500ms`, and then `600h`
- **THEN** both are refused, with an error giving the range

### Requirement: Warn about unpinned packages
`add` SHALL store a server whose command's file name is `npx`, `bunx`, `uvx` or `docker` and whose package or image isn't pinned to an exact version, and SHALL print a warning naming the package or image, saying that a run may start a version published later. The cases are:
- an npm package without `@` and an exact version, so a dist-tag such as `@latest`, or a range such as `@^1`, doesn't pin it;
- a `uvx` package without `==` or `@` and an exact version;
- an image with no digest, and with no tag other than `latest`.

#### Scenario: An npm package
- **WHEN** a local server is added with `-- npx -y @playwright/mcp`, then with `-- npx -y @playwright/mcp@latest`, then with `-- npx -y @playwright/mcp@0.0.83`
- **THEN** all three are stored; the first two print a warning that the package isn't pinned, and the third doesn't

#### Scenario: A Python package and images
- **WHEN** a local server is added with `-- uvx mcp-server-fetch`, then with `-- docker run -i --rm ghcr.io/example/server`, then with `-- docker run -i --rm ghcr.io/example/server@sha256:` followed by 64 hexadecimal digits
- **THEN** each is stored; the first two print a warning that the package or image isn't pinned, and the third doesn't

### Requirement: Manage MCP servers from the command line
`bun run mcp` on Bun, and `bun run mcp:node` on Node, SHALL take one of these subcommands:
- `add <name> <url> [options]` and `add <name> [options] -- <command> [args…]` ("Describe a server with flags");
- `list`;
- `get <name>`;
- `remove <name>`, `disable <name>` and `enable <name>`;
- `login <name> [options]` and `logout <name>` (`mcp-login`);
- `help`, `--help` or `-h`.

The servers SHALL be kept in the store (`store`) in `DATA_DIR`, which SHALL be the only setting the command reads, checked as the agent checks it. The command SHALL make no network request and resolve no reference, except `login`, which reaches the server and its authorization server, and resolves the server's references as a run does (`mcp-login`).

**Output.** The command SHALL write plain text for people, not log records:
- its results to stdout;
- each problem to stderr, as a line beginning `error: `, and each warning as a line beginning `warning: `, before any result.

It SHALL exit with 0 on success. Otherwise, having reported every problem it found, it SHALL exit with 1. The problems are:
- an unknown subcommand or option, or a wrong number of arguments;
- an unknown name, or a name or prefix already in use;
- settings for a server that fail their checks;
- a `DATA_DIR` that fails its check.

The errors for an unknown subcommand, an unknown option and a wrong number of arguments SHALL end by naming `bun run mcp help`.

**The subcommands** SHALL do this:
- `add` SHALL check the name and the server's settings, store the server, and print `Added <name> (<transport>).`; with `--disabled`, it SHALL also say that runs won't start the server until `bun run mcp enable <name>`.
- `list` SHALL print a table with a header row, `NAME`, `TRANSPORT`, `TARGET` and `ENABLED`, and one row per server, in name order: its transport, `http` or `stdio`; its URL, or its command and arguments; and `yes` or `no`. With no servers, it SHALL print one line saying there are none and how to add one.
- `get` SHALL print the server's name, and then one labelled line per setting, with references as written: its transport; its URL and each header, or its command and arguments, each variable and its working directory; its filters; both timeouts, in the largest of `h`, `m`, `s` and `ms` that divides them exactly; for a Streamable HTTP server, its login: `yes`, `no` or `needs a new login`; and whether it's enabled. It SHALL end with how to change it: `remove`, then `add`.
- `remove` SHALL delete the server and its saved logins, and print `Removed <name>.`
- `disable` and `enable` SHALL set the server's flag, and print `Disabled <name>.` or `Enabled <name>.`, the first saying that runs won't start it.

**Help.** `help`, `--help` and `-h`, whatever follows them, and no arguments at all, SHALL print one usage text to stdout, needing no setting and opening no store. The text SHALL give:
- the subcommands, with both forms of `add`, and `login` and `logout`;
- each option of `add`, with the default timeouts and how a time is written, and each option of `login`;
- the rule for a name;
- references in place of secrets, in single quotes, with an example;
- `DATA_DIR`;
- `bun run mcp:node`;
- the README section that explains the rest.

A request for help SHALL exit with 0, and no arguments SHALL exit with 1.

#### Scenario: Adding and listing
- **WHEN** `bun run mcp add docs https://docs.example.com/mcp` runs, and then `bun run mcp list`
- **THEN** the first exits with 0 after printing `Added docs (http).`, and the second prints a header row of `NAME`, `TRANSPORT`, `TARGET` and `ENABLED`, then a row of `docs`, `http`, `https://docs.example.com/mcp` and `yes`

#### Scenario: Showing one server
- **WHEN** `add docs https://docs.example.com/mcp --header 'Authorization: Bearer ${DOCS_TOKEN}' --tool-timeout 5m` runs, and then `get docs`
- **THEN** `get` prints the URL, the header with its reference as written, a startup timeout of `30s`, a tool timeout of `5m`, that the server is enabled, and how to change it

#### Scenario: A local server in the table
- **WHEN** `add files -- npx -y @modelcontextprotocol/server-filesystem@2.1.0 '/srv/my data'` runs, and then `list`
- **THEN** the row's target is `npx -y @modelcontextprotocol/server-filesystem@2.1.0 '/srv/my data'`

#### Scenario: Removing
- **WHEN** `bun run mcp remove docs` runs after `docs` was added
- **THEN** it exits with 0 after printing `Removed docs.`, and a later `list` prints that there are no MCP servers

#### Scenario: Disabling and enabling
- **WHEN** `disable docs` runs, then `list`, then `enable docs`, then `list`
- **THEN** the first table's row for `docs` ends with `no`, and the second's with `yes`

#### Scenario: An unknown name
- **WHEN** `bun run mcp remove nope` runs, and no server is named `nope`
- **THEN** it exits with 1, prints nothing to stdout, and prints to stderr one line beginning `error: ` and naming `nope`

#### Scenario: A name in use
- **WHEN** `add docs …` runs while a server named `docs` exists
- **THEN** it exits with 1, with an error saying `docs` exists and that changing it is `remove`, then `add`, and the stored server is unchanged

#### Scenario: An unknown subcommand
- **WHEN** `bun run mcp start` runs
- **THEN** it exits with 1, with an error naming the subcommands and `bun run mcp help`

#### Scenario: A wrong number of arguments
- **WHEN** `bun run mcp list extra` runs, and then `bun run mcp get`
- **THEN** each exits with 1, with an error saying what the subcommand takes and naming `bun run mcp help`

#### Scenario: The setting it needs
- **WHEN** `DATA_DIR` is valid and no other setting is set, `LOG_FORMAT` included, and then `DATA_DIR` is unset
- **THEN** `list` works the first time, and the second time exits with 1, printing `error: DATA_DIR is required.`

#### Scenario: A new data folder
- **WHEN** `list` runs with a `DATA_DIR` that holds no database yet
- **THEN** it creates `db.sqlite` there, and prints only that there are no MCP servers and how to add one

#### Scenario: Offline
- **WHEN** `add` stores a server whose header references a variable that isn't set
- **THEN** it exits with 0, makes no network request, and the stored header holds the reference as written

#### Scenario: On Node
- **WHEN** `bun run mcp:node list` runs with the same settings
- **THEN** it prints the same as `bun run mcp list`

#### Scenario: Help
- **WHEN** `bun run mcp help` runs with no `DATA_DIR` set
- **THEN** it exits with 0, and its output names both forms of `add`, `list`, `get`, `remove`, `disable`, `enable`, `--header`, `--env`, `--cwd`, `--include-tool`, `--exclude-tool`, `--startup-timeout`, `--tool-timeout`, `--disabled`, `login`, `logout`, `--client-id`, `30s`, `2m`, `'Authorization: Bearer ${GITHUB_PAT}'`, `DATA_DIR`, `mcp:node` and the README

#### Scenario: Help, however it's asked for
- **WHEN** `--help` runs, then `-h`, then `help add`
- **THEN** each prints the same text as `help`, exits with 0, and creates no database

#### Scenario: No arguments
- **WHEN** `bun run mcp` runs with no arguments
- **THEN** it prints the same text as `help`, and exits with 1

#### Scenario: Showing a login
- **WHEN** `get docs` runs before `docs` is logged in, after it's logged in, and after its refresh was refused
- **THEN** its `Login` line reads `no`, then `yes`, then `needs a new login`

### Requirement: Describe a server with flags
`add` SHALL take a server's name, and then either a URL, for a Streamable HTTP server, or `--` followed by a command and its arguments, for a stdio server.
- **The URL** SHALL begin with `http://` or `https://`.
- **Everything after `--`** SHALL be the command and its arguments, as given, options included.
- **Options** SHALL come before `--`, before or after the name and the URL, each as `--option value` or `--option=value`:
  - `--header 'Name: value'`, repeatable, for a Streamable HTTP server: the header's name is the text before the first `:`, and its value the text after it, without the spaces around it;
  - `--env NAME=value`, repeatable, for a stdio server: the variable's name is the text before the first `=`. `--env NAME`, without `=`, SHALL pass the agent's variable through, as `NAME=${NAME}`;
  - `--cwd <dir>`, for a stdio server;
  - `--include-tool <tool>` and `--exclude-tool <tool>`, repeatable, for either;
  - `--startup-timeout <time>` and `--tool-timeout <time>`, for either: a whole number and a unit, `ms`, `s`, `m` or `h`, from 1 s to 2,147,483,647 ms. Without them, the server SHALL get 30 s to start and 2 min for each call;
  - `--disabled`, for either, which adds the server disabled.
- **Refused:**
  - both a URL and `--`, or neither, or a second argument that isn't a URL;
  - an option for the other kind of server;
  - an unknown option, with a hint that a local server's command and its own options come after `--`;
  - an option without its value;
  - a header without `:`, or a variable without a name;
  - a time without a unit, or outside the range.

  An argument that can't be read, such as an unknown option or an option without its value, SHALL be reported on its own. Every other problem SHALL be reported together, and nothing stored.

`add` SHALL build the server's entry from the flags ("Keep each server as an mcpServers entry"), and check it.

#### Scenario: A remote server
- **WHEN** `add github https://api.githubcopilot.com/mcp/ --header 'Authorization: Bearer ${GITHUB_PAT}'` runs
- **THEN** a Streamable HTTP server is stored, with that URL and header, a `startupTimeoutMs` of 30000 and a `toolTimeoutMs` of 120000

#### Scenario: A local server
- **WHEN** `add playwright -- npx -y @playwright/mcp@0.0.83` runs
- **THEN** a stdio server is stored, with the command `npx` and the arguments `-y` and `@playwright/mcp@0.0.83`

#### Scenario: The command's own options
- **WHEN** `add tool -- server --header x --env y` runs
- **THEN** the server's arguments are `--header`, `x`, `--env` and `y`, and it has no headers and no variables

#### Scenario: Options before the name
- **WHEN** `add --tool-timeout 5m docs https://docs.example.com/mcp` runs, and then `add --tool-timeout=5m docs2 https://docs.example.com/mcp`
- **THEN** both servers are stored with a `toolTimeoutMs` of 300000

#### Scenario: A variable passed through
- **WHEN** `add gh --env GITHUB_TOKEN --env LOG_LEVEL=info -- server` runs
- **THEN** the server's `GITHUB_TOKEN` is `${GITHUB_TOKEN}`, and its `LOG_LEVEL` is `info`

#### Scenario: Times
- **WHEN** `--startup-timeout 90s --tool-timeout 10m` is given, and then `--tool-timeout 30`
- **THEN** the first server is stored with 90000 and 600000, and the second is refused, with an error saying a time needs a unit, as in `30s`

#### Scenario: A command without --
- **WHEN** `add playwright npx -y @playwright/mcp@0.0.83` runs
- **THEN** it's refused, with an error naming `-y` and saying that a local server's command comes after `--`

#### Scenario: Not a URL
- **WHEN** `add docs docs.example.com/mcp` runs
- **THEN** it's refused, with an error saying that a remote server's URL begins with `https://`, and that a local server's command comes after `--`

#### Scenario: Both kinds, or neither
- **WHEN** `add docs https://docs.example.com/mcp -- server` runs, and then `add docs`
- **THEN** both are refused, each with an error saying that `add` takes a URL or, after `--`, a command

#### Scenario: An option for the other kind
- **WHEN** a remote server is added with `--env A=1`, and a local one with `--header 'A: b'`
- **THEN** both are refused, each with an error naming the option and the kind of server it's for

#### Scenario: An option without its value
- **WHEN** `add docs https://docs.example.com/mcp --header` runs
- **THEN** it's refused, with an error naming `--header`

#### Scenario: Disabled at the start
- **WHEN** `add docs https://docs.example.com/mcp --disabled` runs, and then `list`
- **THEN** the first says runs won't start `docs` until it's enabled, the row's `ENABLED` is `no`, and a run doesn't start it

#### Scenario: Filters
- **WHEN** `--include-tool a --include-tool b` is given, and then `--include-tool b --exclude-tool b`
- **THEN** the first server is stored with `includeTools` `["a","b"]`, and the second is refused, with an error naming `b`

#### Scenario: Every problem at once
- **WHEN** `add 'my docs' https://docs.example.com/mcp --tool-timeout 30 --header Authorization` runs
- **THEN** it exits with 1 after an error for each of the name, the time and the header, and stores nothing

### Requirement: Keep each server as an mcpServers entry
What `add` stores for a server, and what a run checks again (`mcp-client`), SHALL be one server's entry in Claude Code's `mcpServers` format:
- **stdio:** `command`, and `args`, `env` and `cwd` when given;
- **Streamable HTTP:** `url`, and `headers` when given;
- **both:** `includeTools` and `excludeTools` when given, and `startupTimeoutMs` and `toolTimeoutMs`, which every stored entry holds.

The server's name, prefix and flag SHALL be kept beside its entry, not in it. A stored entry SHALL pass these checks, which `add` applies to the entry it builds, and a run to every enabled one:
- **The transport.** The entry's `type` when it has one: `stdio`, `http` or `streamable-http`. Otherwise `command` means stdio and `url` Streamable HTTP. An entry with both or neither, or with `type` `sse`, is refused.
- **Paths.** Once its references are resolved, `command` SHALL be a name without a slash or an absolute path, and `cwd` an absolute path.
- **No control characters** in `command`, an argument, an `env` name or value, or `cwd`: a NUL in a spawned value makes both runtimes print it whole (R18.1).
- **Fields.** No field but these, and `title` and `description`, which are kept and not used, read as the entry's own properties. Variables' and headers' names SHALL be read as own properties too.
- **Filters.** `includeTools` and `excludeTools` SHALL be non-empty arrays of distinct names, with no name in both.
- **Timeouts.** Both SHALL be present.

#### Scenario: The stored entry
- **WHEN** `add docs https://docs.example.com/mcp` runs
- **THEN** the stored entry is `{"url":"https://docs.example.com/mcp","startupTimeoutMs":30000,"toolTimeoutMs":120000}`, and the server's flag is kept beside it

#### Scenario: A row written by hand
- **WHEN** one enabled server's stored entry holds a field `timeout`, and another's has no `toolTimeoutMs`, both written into the database by hand
- **THEN** a run fails before any server starts, with an error naming each server and its problem

#### Scenario: Keys that name Object's own members
- **WHEN** a local server is added with `--env __proto__=x`, and an enabled server's stored entry holds a field `constructor`, written by hand
- **THEN** the first variable is checked and stored like any other, and a run refuses the second entry, naming `constructor`

#### Scenario: A relative path
- **WHEN** a local server is added with `-- ./server`, and then with `--cwd servers/docs`
- **THEN** both are refused, each with an error saying the path must be absolute

#### Scenario: A control character
- **WHEN** an argument of the command holds U+0001
- **THEN** it's refused, with an error naming the argument and not quoting it

