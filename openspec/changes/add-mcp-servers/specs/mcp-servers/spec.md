## ADDED Requirements

### Requirement: Manage MCP servers with the mcp command
`bun run mcp` on Bun, and `bun run mcp:node` on Node, SHALL take one of five subcommands: `add <name> <entry>`, `list`, `remove <name>`, `disable <name>` or `enable <name>`. An `<entry>` of `-` SHALL be read from stdin, which keeps it out of the process list, the shell's history and the command line that `bun run` echoes.

The servers SHALL be kept in the store (`store`) in `DATA_DIR`. The command SHALL need only `DATA_DIR` and `LOG_FORMAT`, checked as the agent checks them, and SHALL report through the structured logger, in that format. When opening the store applied migrations, it SHALL first log the `migrated` record that the agent logs (`agent`). It SHALL make no network request, and SHALL resolve no reference.

On success it SHALL exit with 0. Otherwise it SHALL log an `error` record for each problem and exit with 1: an unknown subcommand, a wrong number of arguments, an unknown name, a name or prefix already in use, an entry that fails its checks, or settings that fail theirs.

The subcommands SHALL do this:
- `add` SHALL check the name and the entry, store the entry as checked, and log an `info` record `mcp server added` with `name` and `transport`;
- `list` SHALL log one `info` record `mcp server` for each server, in name order, with `name`, `transport`, `disabled` and `entry`, or an `info` record `no mcp servers` when there are none;
- `remove` SHALL delete the server, and log an `info` record `mcp server removed` with `name`;
- `disable` and `enable` SHALL set the server's flag, and log an `info` record `mcp server disabled` or `mcp server enabled` with `name`.

#### Scenario: Adding and listing
- **WHEN** `bun run mcp add docs '{"url":"https://docs.example.com/mcp","startupTimeoutMs":30000,"toolTimeoutMs":120000}'` runs, and then `bun run mcp list`
- **THEN** the first exits with 0 after an `mcp server added` record, and the second logs one `mcp server` record with `name` `docs`, `transport` `http`, `disabled` false, and the entry as it was given

#### Scenario: An entry on stdin
- **WHEN** `bun run mcp add docs -` runs with the same entry on stdin
- **THEN** the server is stored as if the entry had been the argument

#### Scenario: Removing
- **WHEN** `bun run mcp remove docs` runs after `docs` was added
- **THEN** it exits with 0 after an `mcp server removed` record, and a later `list` logs `no mcp servers`

#### Scenario: Disabling and enabling
- **WHEN** `disable docs` runs, then `list`, then `enable docs`, then `list`
- **THEN** the first `mcp server` record has `disabled` true, and the second has `disabled` false

#### Scenario: An unknown name
- **WHEN** `bun run mcp remove nope` runs, and no server is named `nope`
- **THEN** it exits with 1, with an error naming `nope`

#### Scenario: A name in use
- **WHEN** `add docs …` runs while a server named `docs` exists
- **THEN** it exits with 1, with an error saying `docs` exists, and the stored entry is unchanged

#### Scenario: An unknown subcommand
- **WHEN** `bun run mcp start` runs
- **THEN** it exits with 1, with an error naming the five subcommands

#### Scenario: The settings it needs
- **WHEN** `DATA_DIR` and `LOG_FORMAT` are valid and no `MODEL_*` setting is set, and then `DATA_DIR` is unset
- **THEN** `list` works the first time, and the second time exits with 1, with an error naming `DATA_DIR`

#### Scenario: A new data folder
- **WHEN** `list` runs with a `DATA_DIR` that holds no database yet
- **THEN** it logs `migrated`, naming the migrations it applied, and then `no mcp servers`

#### Scenario: Offline
- **WHEN** `add` stores an entry whose header references a variable that isn't set
- **THEN** it exits with 0, makes no network request, and the stored entry holds the reference as written

#### Scenario: On Node
- **WHEN** `bun run mcp:node list` runs with the same settings
- **THEN** it gives the same records as `bun run mcp list`

### Requirement: Accept an entry in the mcpServers format
An entry SHALL be one JSON object: one server's entry from inside a `mcpServers` object, in Claude Code's format.
- **stdio** SHALL take:
  - `command`, a required string, which SHALL be a name without a slash or an absolute path once its references are resolved;
  - `args`, an array of strings; `env`, an object of strings;
  - `cwd`, a string, which SHALL be an absolute path once its references are resolved.

  `add` SHALL check a `command` or `cwd` that holds no reference, and a run checks the resolved ones (`mcp-client`).
- **Streamable HTTP** SHALL take `url`, a required string, and `headers`, an object of strings.
- **Both** SHALL take:
  - `includeTools` and `excludeTools`, non-empty arrays of distinct names, with no name in both;
  - `startupTimeoutMs` and `toolTimeoutMs`, both required;
  - `disabled`, a boolean, which `add` takes as the server's starting flag and SHALL leave out of the stored entry;
  - `title` and `description`, which are stored and not used.
- **The transport** SHALL be the entry's `type`: `stdio`, or `http` and its alias `streamable-http`.
  - Without a `type`, `command` SHALL mean stdio and `url` Streamable HTTP, and an entry with both or neither SHALL be refused.
  - `sse` SHALL be refused as deprecated. A field of the other transport SHALL be refused.
- **No control characters.** `command`, each argument, each `env` name and value, and `cwd` SHALL hold no control character; a NUL in a spawned value makes both runtimes print it whole (R18.1).
- **Unknown fields** SHALL be refused.
  - A field that another client spells differently gets a hint: `timeout`, `enabled`, `required`, `environment`, `serverUrl`, `httpUrl`, `enabled_tools`, `disabled_tools` and their like.
  - So does a pasted wrapper. An entry with a field `mcpServers`, `servers`, `mcp` or `context_servers`, or whose only field holds an object with `command` or `url`, SHALL be refused with a hint: give one server's object from inside it, and its name as the first argument.
- **The JSON** SHALL be strict: no comments, no trailing commas, and no key repeated in one object.
  - Objects SHALL be built without a prototype, and fields, `env` names and header names SHALL be read as own properties.
  - A syntax error SHALL be reported with its line and column, and SHALL NOT quote the entry's text.
  - Every problem with an entry SHALL be reported, each in its own `error` record, in one run of the command.
  - A missing timeout's error SHALL give an example of both, such as `"startupTimeoutMs": 30000` and `"toolTimeoutMs": 120000`.

#### Scenario: A stdio entry
- **WHEN** the entry is `{"command":"npx","args":["-y","@playwright/mcp@0.0.83"],"startupTimeoutMs":30000,"toolTimeoutMs":120000}`
- **THEN** `add` stores it, and logs `transport` `stdio`

#### Scenario: A URL without a type
- **WHEN** the entry has a `url` and no `type`
- **THEN** `add` stores it, and logs `transport` `http`

#### Scenario: SSE
- **WHEN** the entry's `type` is `sse`
- **THEN** it's refused, with an error saying the SSE transport is deprecated and naming Streamable HTTP

#### Scenario: Both kinds, or neither
- **WHEN** the entry has both `command` and `url`, and then neither
- **THEN** both are refused, each with an error saying an entry has `command` or `url`

#### Scenario: A name in both filters
- **WHEN** `includeTools` and `excludeTools` both name `b`
- **THEN** it's refused, with an error naming `b`

#### Scenario: Disabled at the start
- **WHEN** `add docs` is given an entry with `"disabled": true`, then `enable docs` runs, then `list`
- **THEN** the record has `disabled` false and an `entry` without `disabled`, and a run starts `docs`

#### Scenario: A pasted wrapper
- **WHEN** the entry is `{"mcpServers":{"docs":{"url":"https://docs.example.com/mcp"}}}`
- **THEN** it's refused, with an error saying to give the object inside `mcpServers`, and the name as the first argument

#### Scenario: Another client's spelling
- **WHEN** the entry has `"timeout": 30`
- **THEN** it's refused, with an error naming `timeout` and pointing to `startupTimeoutMs` and `toolTimeoutMs`

#### Scenario: A missing timeout
- **WHEN** the entry has no `startupTimeoutMs`
- **THEN** it's refused, with an error naming `startupTimeoutMs` and giving an example of both timeouts

#### Scenario: A repeated key
- **WHEN** the entry gives `url` twice
- **THEN** it's refused, with an error naming `url` as repeated, and giving the line and column of the second

#### Scenario: Text that isn't quoted
- **WHEN** the entry isn't valid JSON, and the text at the error is `sk-secret123`
- **THEN** the error gives the line and column, and `sk-secret123` appears in no record

#### Scenario: Keys that name Object's own members
- **WHEN** the entry has a field `constructor`, and then an `env` variable named `__proto__`
- **THEN** the first is refused as an unknown field, and the second is checked and stored like any other name

#### Scenario: A relative path
- **WHEN** `command` is `./server`, and then `cwd` is `servers/docs`
- **THEN** both are refused, each with an error saying the path must be absolute

#### Scenario: A control character
- **WHEN** an argument holds a NUL
- **THEN** it's refused, with an error naming the argument and not quoting it

#### Scenario: Every problem at once
- **WHEN** the entry has an unknown field, a negative `toolTimeoutMs` and a URL with a fragment
- **THEN** one run of `add` logs an `error` record for each of the three, and stores nothing

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
  - An entry SHALL refer to the agent's environment with `${NAME}` or `${env:NAME}`, where `NAME` matches `[A-Za-z_][A-Za-z0-9_]*`. `$$` SHALL stand for one `$`.
  - References SHALL be allowed in `command`, in each of `args`, in `env` values, in `cwd`, in header values, and in a `url`'s path and query, but not in its scheme, userinfo, host or port.
  - Any other `$`, and any reference elsewhere, SHALL be refused, with a hint: there are no defaults, no editor variables and no bare `$NAME`.
  - `MODEL_API_KEY` SHALL NOT be referenced.
  - `add` SHALL store references as written; a run resolves them (`mcp-client`).
- **Credential slots.** A slot SHALL hold a reference when its name has a word, after splitting at `-`, `_`, `.` and lower-to-upper case changes, from: `KEY`, `KEYS`, `APIKEY`, `TOKEN`, `TOKENS`, `SECRET`, `SECRETS`, `PASSWORD`, `PASSWORDS`, `PASSWD`, `PASS`, `PASSPHRASE`, `PAT`, `AUTH`, `AUTHORIZATION`, `CREDENTIAL`, `CREDENTIALS` or `COOKIE`.
  - A slot is an `env` name, a header name, a URL's query parameter, an argument after an `--option` with such a name, or the text after `=` in such an `--option=value` argument.
  - A number, `true`, `false` or `none` is exempt, and so is a slot whose name's last word is `PATH`, `FILE` or `DIR`.
- **Text shaped like a secret** SHALL be refused anywhere in an entry. It is one of these prefixes, at the start of a string or after a character other than a letter or a digit, followed by at least 16 characters from `[A-Za-z0-9_-]` (for `AKIA`, 16 uppercase letters or digits): `ghp_`, `github_pat_`, `glpat-`, `xoxb-`, `xoxp-`, `xoxa-`, `sk-`, `sk_live_`, `rk_live_`, `ntn_`, `lin_api_` or `AKIA`. A `Bearer` or `Basic` credential written out, a JSON Web Token, a PEM private key, and userinfo in a URL SHALL be refused too.
- **Messages** SHALL name what is refused, and SHALL NOT quote a refused value. The refusal of a literal secret SHALL say to give it as a reference set in `.env`, and that a secret typed on a command line is in the shell's history and should be changed.
- **References in arguments.** `add` SHALL store an entry whose credential slot in `args` holds a reference, with a `warn` record `mcp server secret in arguments`. The record says that a run puts the value in the process list, which every local user can read, and that `env` keeps it out, if the server reads one.

#### Scenario: A header from the environment
- **WHEN** the entry's headers are `{"Authorization":"Bearer ${DOCS_TOKEN}"}`
- **THEN** `add` stores them as written

#### Scenario: A literal token
- **WHEN** the entry's headers are `{"Authorization":"Bearer abc123def"}`
- **THEN** it's refused, with an error naming the `Authorization` header and saying to give it as a reference, and `abc123def` appears in no record

#### Scenario: A credential variable
- **WHEN** the entry's `env` is `{"API_KEY":"abc"}`, and then `{"API_KEY":"${API_KEY}"}`
- **THEN** the first is refused, and the second is stored

#### Scenario: Settings that aren't secrets
- **WHEN** the entry's `env` is `{"MAX_TOKENS":"4096","AUTH_TYPE":"none","PRIVATE_KEY_PATH":"/home/me/key.pem"}`
- **THEN** it's stored

#### Scenario: A key in an option
- **WHEN** an argument is `--api-key=abc123def`
- **THEN** it's refused, with an error naming `--api-key`, and `abc123def` appears in no record

#### Scenario: Prefixes inside ordinary words
- **WHEN** the entry runs `npx -y task-master-ai@0.30.0 --disk-cache`
- **THEN** it's stored

#### Scenario: A token's shape
- **WHEN** an argument is `ghp_` followed by 36 letters and digits
- **THEN** it's refused, with an error naming the argument and not quoting it

#### Scenario: A reference in the arguments
- **WHEN** the entry's `args` are `["--api-key","${KEY}"]`
- **THEN** it's stored, with an `mcp server secret in arguments` record

#### Scenario: A default or a bare variable
- **WHEN** an `env` value is `${TOKEN:-abc123}`, and then `$HOME/x`
- **THEN** both are refused: the first with an error saying defaults aren't supported, in which `abc123` doesn't appear, and the second with a hint to write `${HOME}`

#### Scenario: A literal dollar
- **WHEN** an argument is `$$5`
- **THEN** it's stored as written, and a run passes the argument `$5`

#### Scenario: The model's key
- **WHEN** a header value is `Bearer ${MODEL_API_KEY}`
- **THEN** it's refused, with an error naming `MODEL_API_KEY`

#### Scenario: Userinfo
- **WHEN** the URL is `https://user:pw@docs.example.com/mcp`
- **THEN** it's refused, and `pw` appears in no record

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
- **Timeouts.** `startupTimeoutMs` and `toolTimeoutMs` SHALL be whole numbers from 1,000 to 2,147,483,647.

#### Scenario: A reserved header
- **WHEN** the headers hold `Mcp-Session-Id`, and then `content-type`
- **THEN** each is refused, with an error naming the header

#### Scenario: A control character in a header
- **WHEN** a header value holds a line feed
- **THEN** it's refused, with an error naming the header

#### Scenario: A character beyond Latin-1
- **WHEN** a header value holds `€`
- **THEN** it's refused, with an error naming the header

#### Scenario: A bad port
- **WHEN** the URL is `https://docs.example.com:6000/mcp`
- **THEN** it's refused, with an error naming the port

#### Scenario: Plain HTTP with a reference
- **WHEN** the URL is `http://127.0.0.1:8080/mcp` with a header holding a reference, and then `http://docs.example.com/s/${DOCS_SECRET}/mcp`
- **THEN** both are refused, and `http://127.0.0.1:8080/mcp` with no reference anywhere is stored

#### Scenario: Seconds for milliseconds
- **WHEN** `toolTimeoutMs` is 30, and then 2147483648
- **THEN** both are refused, with an error giving the range

### Requirement: Warn about unpinned packages
`add` SHALL store an entry whose `command`'s file name is `npx`, `bunx`, `uvx` or `docker` and whose package or image isn't pinned to an exact version, and SHALL log a `warn` record `mcp server unpinned` with `name`, saying that a run may start a version published later. The cases are:
- an npm package without `@` and an exact version, so a dist-tag such as `@latest`, or a range such as `@^1`, doesn't pin it;
- a `uvx` package without `==` or `@` and an exact version;
- an image with no digest, and with no tag other than `latest`.

#### Scenario: An npm package
- **WHEN** the entry runs `npx -y @playwright/mcp`, then `npx -y @playwright/mcp@latest`, then `npx -y @playwright/mcp@0.0.83`
- **THEN** all three are stored; the first two log `mcp server unpinned`, and the third doesn't

#### Scenario: A Python package and images
- **WHEN** the entry runs `uvx mcp-server-fetch`, then `docker run -i --rm ghcr.io/example/server`, then `docker run -i --rm ghcr.io/example/server@sha256:` followed by 64 hexadecimal digits
- **THEN** each is stored; the first two log `mcp server unpinned`, and the third doesn't
