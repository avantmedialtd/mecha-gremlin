# mecha-gremlin

A self-hosted, scheduled agent runner, in early development. The design and its open decisions live in [`Brief.md`](Brief.md). Changes go through OpenSpec, under `openspec/`.

## Layout

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@mecha-gremlin/core`: stateless, provider-independent types and functions. `model-call`, `history` and `statistics` define Gremlin's call, native replay and typed provider statistics contracts. `tools` defines tools through any [Standard Schema](https://standardschema.dev) library and validates their arguments. `skills` checks a SKILL.md and renders the skills catalog and a skill's activation, `output` caps a command's output as it streams in, and `patch` parses and applies Codex's V4A patches. Core depends on neither model SDK. |
| [`packages/yaml`](packages/yaml) | `@mecha-gremlin/yaml`: `parseYaml`, which uses Bun's built-in parser, `Bun.YAML`, on Bun, and the [`yaml`](https://www.npmjs.com/package/yaml) package elsewhere. The two give the same values for everything frontmatter uses. |
| [`packages/process`](packages/process) | `@mecha-gremlin/process`: `spawnProcess`, which uses `Bun.spawn` on Bun and `node:child_process` elsewhere, and gives the process the same shape on both: its pid, a stream to write to its stdin when asked for one, its output as web streams, a promise of how it exited, and `unref()`. |
| [`packages/store`](packages/store) | `@mecha-gremlin/store`: the data folder's SQLite database, through [TypeORM](https://typeorm.io) and [better-sqlite3](https://www.npmjs.com/package/better-sqlite3), the same on Bun and Node. `store` opens `db.sqlite` in a given folder, sets its pragmas and runs its migrations, and runs every query on a store after the one before it. `credential` keeps OAuth credentials, with a lease for their refresh, and `mcp-server` keeps the MCP servers' definitions. |
| [`packages/agent`](packages/agent) | `@mecha-gremlin/agent`: the agent. It carries out a task in an agent loop, with a shell, file tools, skills and MCP servers' tools, and opens the store in its data folder. It runs on Bun or Node. |

Inside `packages/agent/src`, the code is grouped by concern:
- `main`: the entry points, `main.ts` for a run and `mcp.ts` for the `mcp` command, and their helpers: a run's arguments and task file, log fields and failure messages; the command's arguments, times, output and help text, in `mcp-args.ts`, `mcp-time.ts`, `mcp-output.ts` and `mcp-help.ts`; and the strict parsing of options that both use, which names the option it refuses, in `options.ts`;
- `config`;
- `model`: model choice, LM Studio's model list, and the Responses and Anthropic Messages adapters;
- `session`: the agent loop, as a session that yields each step's result;
- `skills`: finding and reading the skills `SKILLS_PATH` lists;
- `exec`: running a command, its environment, and stopping a session's processes at the end;
- `tools`: `read`, `write`, `edit`, `apply_patch`, `shell` and `activate_skill`;
- `mcp`: MCP servers: the checks of an entry, the stdio transport, connecting to the servers, and their tools and results;
- `log`: the structured logger.

`yaml` and `process` choose their implementation once, when each module loads, from the global object: Bun's when `globalThis.Bun` is defined, the other one otherwise. The agent reads skills' frontmatter with `yaml`, and runs commands and `ps` with `process`.

At the top, [`test`](test) holds the signal guard, a Vitest setup file for every package's tests (see Develop).

No package has index files: every import names the file it uses. The `package.json` of `core`, `yaml`, `process` and `store` exports each module by name, so the agent imports `@mecha-gremlin/core/model-call`, `@mecha-gremlin/store/store` and so on. The tests mirror the folders.

## Prerequisites

- [Bun](https://bun.com) 1.4.4 or later. Bun 1.4.3's install runs node-gyp for better-sqlite3, which fails without Python, make and a C++ toolchain.
- [Node.js](https://nodejs.org) 26 or later, for `bun run agent:node` and `bun run test:node`, and so for `bun run check`.
- A configured model: [LM Studio](https://lmstudio.ai), an OpenAI Responses endpoint, or the direct Claude API. For LM Studio, start the server (`lms server start`) and load the **named** model (`lms load <model>`, or load one in the app). The agent never loads a model on demand. A browsing task needs more context than LM Studio's default: see [Set up for browsing](#set-up-for-browsing).
- For browsing with the example skill, [playwright-cli](https://www.npmjs.com/package/@playwright/cli) and [Google Chrome](https://www.google.com/chrome/).

## Run

Install dependencies, then put the required settings for your provider in a local `.env` file (see [Configuration](#configuration)). A task is required on every run; no browsing task runs by default.

```sh
bun install
```

Then:

```sh
WORK_DIR=. bun run agent task.md                                           # the task in a file
WORK_DIR=. bun run agent -p 'Which runtime does README.md describe?'       # a short task, inline
WORK_DIR=. bun run agent:node -p 'Which runtime does README.md describe?'  # the same, on Node
```

`task.md` stands for a file of yours that holds the task, such as a Markdown note. The other two ask about this repository's README, so `WORK_DIR=.` points them at it; a setting on the command line overrides `.env`.

The command is `bun run agent <file>`, or `bun run agent --prompt <task>`, on Bun, and `bun run agent:node` with the same arguments and settings on Node. It takes the task from one of:
- **a task file,** its one argument: the file's text, trimmed and otherwise as written, frontmatter included, whatever its extension. A relative path starts from the directory the agent starts in, which under `bun run` is the repository's root, wherever you type the command, as `WORK_DIR` does. An absolute path always works;
- **`--prompt <task>`, or `-p <task>`:** the task inline, as one argument, trimmed.

A run fails before any network request, and says why along with any problem in the settings, when it gets no task, a task file and `--prompt` together, more than one task file, `--prompt` twice, or an option it doesn't know; the error names both ways to give the task. A task file fails too when it can't be read, is blank, or is binary, with a NUL byte in its first 8 KiB, as `read` tests.

**Quote `-p`'s value,** in single quotes unless it holds one. Unquoted, the shell splits it into words, and `-p` takes only the first of them, leaving the rest as task files. The shell also reads `?`, `*`, `&`, `;`, `!` and `$` itself: in zsh, macOS's default shell, an unquoted `?` stops the command with "no matches found" before Bun runs. A task file needs no quoting, whatever it holds.

The model carries out the task with its tools, offered in this order: `read`; `write` and `edit`, or `apply_patch` in their place when `FILE_TOOLS` is `apply-patch`; `shell`; `activate_skill` when skills are loaded; and then the tools of the MCP servers you have added, sorted by name (see [MCP servers](#mcp-servers)). The loop runs until it answers, for at most the configured `MAX_STEPS`. A question about a file usually takes two steps: one to read it and one to answer. A browsing task takes many more, about two for each page action. On a local 27B model, a model call took from 15 seconds to about 2 minutes in testing, growing with the size of what the model reads.

Everything is logged to stdout as structured records, one per line:
- the skills loaded, and any that couldn't be;
- the migrations applied to the database, when there are any;
- each MCP server the run connected to, in name order: the tools it offers, their definitions' size and a hash of its tool list, after any tools it dropped;
- the task, with its file's absolute path when it came from one, the run's ID, the working directory and the data folder;
- each model call's provider-specific statistics, including reported usage, cache counts and rate-limit headers, even when a call fails;
- each tool call and its result;
- the answer;
- a change to an MCP server's tools during the session, which the next run takes up;
- the processes stopped when the session ends, if there were any;
- errors.

With `LOG_FORMAT=pretty`, records are formatted for reading. A model-call line includes the provider's statistics rather than only a few common token counts:

```text
22:02:03 INFO  model call step=1 providerStats={"provider":"openai","usage":{"kind":"partial","value":{"input_tokens":812,"output_tokens":48}},"rateLimits":{}} seconds=9.2
```

`LOG_FORMAT=json` writes each record as a JSON object instead, with its time in ISO 8601. Usage is marked `complete`, `partial` or `unavailable`; absent counts aren't turned into zero. Claude leaves out the usage fields that don't apply to a reply, so its complete usage shows only those it reported. Claude input counts distinguish uncached input, cache writes and cache reads. Its total input is the sum of those three; Responses input already includes cached input. Thinking and reasoning tokens are included in output tokens.

### The file tools

`read` reads UTF-8 text files. It pages through a file by line: `offset` is the first line to read, from 1, and `limit` the most lines. Each call returns at most 32 KiB in whole lines, with a note giving the `offset` to continue from. A single line longer than that is cut, and the rest of it can be seen only through the shell.

The model writes and changes files with one of two sets of tools, which `FILE_TOOLS` chooses. The two are never offered together:

- **`write-edit`:** `write` creates or replaces a whole file, creating missing directories, and `edit` replaces exact text in a file. Its `old_string` must occur exactly once, unless `replace_all` is set.
- **`apply-patch`:** `apply_patch` takes a patch in the V4A format of OpenAI's Codex, which adds, updates, moves and deletes files. It finds the lines to change leniently, as Codex does, and changes nothing unless the whole patch applies.

A path is relative to the working directory, `WORK_DIR`, or absolute. The four tools take it wherever it points: outside the working directory, through a symbolic link, into a skill's directory or the data folder, or to an `.env` file. They reach whatever your account can, as the shell does, and refuse only what doesn't depend on where a file is:

- a directory, and for `read`, a binary file, with a NUL byte in its first 8 KiB;
- replacing a file larger than 32 KiB, the most one read returns, since the model may not have read all of it: `write` refuses it, and so does `apply_patch` when it adds a file or moves one onto it;
- changing a file with `edit` or `apply_patch` when it is larger than 10 MiB, holds a NUL byte, or isn't valid UTF-8;
- a patch that names a file twice, or that doesn't apply whole.

Every refusal goes back to the model as the tool's output, so the model can explain it or try something else. To bound what the tools can reach, and the shell with them, run the agent in a container.

### The shell

`shell` runs a command with `bash -c` on this computer, as you, in the working directory. (The workspace container comes later, in M1.)

- **Each call is a fresh shell:** `cd` and variables don't carry over, and stdin is closed.
- **A command gets 120 seconds.** Then its process group gets SIGTERM, and SIGKILL 2 seconds later.
- **Each output stream keeps its first and last 16 KiB.** When it cuts, the model is told how to see the rest: write the output to a file, then read it a part at a time with `read`, search it with `grep`, or print a part with `sed -n` or `tail -c`.
- **Background jobs end with the command,** once bash has exited and the command's output has closed, or after a second. A process that leaves the command's process group keeps running, as playwright-cli's browser does.
- **The session's processes are stopped when it ends,** whether it answers, fails, or gets Ctrl-C, SIGTERM or a hangup. Every command carries the run's ID in `GREMLIN_RUN_ID`, and every process that `ps` shows carrying it gets SIGTERM, then SIGKILL 2 seconds later. A match that looks wrong, more than 32 processes, pid 1 or below, or the agent's own process or its parent, gets no signal at all, and the log says why; so does a `ps` that can't show environments or takes over 10 seconds. Signals are ignored while the processes are stopped. On macOS, `ps` hides the environment of Apple's own programs, and if the agent's process is killed with SIGKILL nothing is stopped: playwright-cli's browser then closes after 15 minutes idle.
- **The environment is built from scratch:** `PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG` and `LC_ALL` from yours, fixed values against prompts, pagers and colour codes, the run's ID, and a playwright-cli session of the run's own.

**What the shell can reach: anything your account can.** A model steered by a web page can read your files, run programs and send data out. Building the environment from scratch keeps your other variables, and `.env`'s, out of what commands inherit and print by accident, such as an environment dump or a log. It doesn't stop a command that goes looking: `ps -E -p $PPID` shows the agent process's own environment on macOS, and `.env` is a readable file. Run it attended, against sites you choose.

### The data folder

The agent keeps a SQLite database, `db.sqlite`, in the data folder that `DATA_DIR` names. Its first table holds OAuth credentials for MCP servers, which `bun run mcp login` saves: client registrations and tokens, in plain text. Give the agent a data folder of its own, outside the working directory, or at least in a path git ignores.

- **Its files.** Every run opens the database before any network request, creating `db.sqlite` when it's missing, and applies the migrations that haven't run yet, logging their names in a `migrated` record. A new `db.sqlite` gets mode 0600, so only you can read it, and SQLite gives the same mode to the `db.sqlite-wal` and `db.sqlite-shm` files it keeps beside it while the database is open. An existing `db.sqlite` keeps its mode. When the agent ends, unless SIGKILL ends it, it closes the database, which folds `db.sqlite-wal` back into `db.sqlite` and removes both. `.gitignore` keeps `*.sqlite` files and those beside them out of git.
- **A local file system.** SQLite's locks work only on a local file system, so the data folder must never be on a network share. In Docker, it is a named volume, never a bind mount on Docker Desktop for macOS, where SQLite's locks fail and a commit can be lost.
- **Copying it.** Copy the database with SQL's `VACUUM INTO`, which writes a consistent copy even while the agent is using it, as in `sqlite3 db.sqlite "VACUUM INTO 'copy.sqlite'"`. Never copy `db.sqlite` alone: while the database is open, its latest commits are in `db.sqlite-wal`.
- **Where it runs.** better-sqlite3 13 ships prebuilt binaries for x64 and arm64. On Linux, they need glibc 2.34 or later, which Debian 11 and RHEL 8 are too old for, or musl, as on Alpine.
- **The tools can reach it.** A command can read and write the database as it can anything else your account can, and the file tools reach the folder too, though `read` refuses the database as a binary file.
- **MCP servers.** It also holds the definitions of the MCP servers that `bun run mcp` adds, with references to secrets but no secrets. Since the shell can change them, one run can choose the servers a later run starts, as it could already change a crontab or a shell profile.

### MCP servers

The agent can use the tools of [MCP](https://modelcontextprotocol.io) servers: local servers, which a run starts and talks to over stdio, and remote ones, which it reaches over Streamable HTTP. The `mcp` command keeps their definitions in the data folder, and each run connects to every server that isn't disabled before its first model call. A remote server that needs a login gets one from `bun run mcp login`. MCP resources and prompts aren't supported, and an image a tool returns is described to the model but not shown. `bun run mcp help` summarises this section at the terminal, and needs no setting.

**Adding a server.** `bun run mcp add` takes the server's name, and then its URL, for a remote server, or `--` and its command, for a local one, as `claude mcp add` does. A remote server, whose header holds a reference to a variable:

```sh
bun run mcp add docs https://docs.example.com/mcp --header 'Authorization: Bearer ${DOCS_TOKEN}'
```

A local server, pinned to an exact version, so that a later run doesn't start whatever was published since:

```sh
bun run mcp add playwright -- npx -y @playwright/mcp@0.0.83
```

The URL begins with `https://` or `http://`. Everything after `--` is the command and its arguments, as given, their own options included, so `-y` needs no quoting. The options of `add` come before `--`, before or after the name and the URL, as `--option value` or `--option=value`:

| Option | For | Gives |
|---|---|---|
| `--header 'Name: value'` | a remote server | A header: its name is the text before the first `:`, and its value the text after it, without the spaces around it. Repeat it for more. |
| `--env NAME=value` | a local server | A variable, named by the text before the first `=`. `--env NAME` alone passes the agent's own `NAME` through, as `NAME=${NAME}`, as Docker's `-e NAME` does. Repeat it for more. |
| `--cwd <dir>` | a local server | Its working directory, an absolute path. |
| `--include-tool <tool>` | either | A tool to offer, and only the tools named are offered; a run fails when the server doesn't list one of them. Repeat it for more. |
| `--exclude-tool <tool>` | either | A tool to leave out. Repeat it for more. |
| `--startup-timeout <time>` | either | How long it may take to start, which covers the handshake and its whole tool list: 30s unless given. |
| `--tool-timeout <time>` | either | How long one call may take, however much progress the server reports: 2m unless given. |
| `--disabled` | either | Adds it, but runs don't start it until `bun run mcp enable <name>`. |

A `<time>` is a whole number and a unit, `ms`, `s`, `m` or `h`, as in `90s` or `2m`, from 1s to 2,147,483,647 ms, about 24 days. A bare number is refused, since nothing in it says whether it counts seconds or milliseconds. `add` also refuses an option for the other kind of server, such as `--env` for a remote one, and an option it doesn't know: a local server's command, with its own options, comes after `--`. An argument that can't be read, such as an unknown option or an option without its value, is reported on its own; every other problem is reported together, and nothing is stored until there are none.

**From a vendor's snippet.** GitHub's guide to its remote server gives an entry wrapped in `mcpServers`, with a placeholder for a personal access token:

```json
{
    "mcpServers": {
        "github": {
            "type": "http",
            "url": "https://api.githubcopilot.com/mcp/",
            "headers": { "Authorization": "Bearer YOUR_GITHUB_PAT" }
        }
    }
}
```

The server's name comes first, its `url` second, and each of its `headers` becomes a `--header`, with the placeholder turned into the reference `${GITHUB_PAT}`, in single quotes; then set `GITHUB_PAT` to your token in `.env`:

```sh
bun run mcp add github https://api.githubcopilot.com/mcp/ \
    --header 'Authorization: Bearer ${GITHUB_PAT}'
```

A local server's `command` and `args` become the words after `--`, and each of its `env` variables an `--env`. The `type` needs no flag: a URL, or a command after `--`, says which kind of server it is.

- **Single quotes.** They keep the shell from reading `${GITHUB_PAT}`. In double quotes, the shell puts the variable's value in its place before `add` sees it, and `add` refuses the header as a literal secret, whether that value is your token or nothing at all. Never type a real token into the command: `add` refuses a literal secret anyway, and a token typed on a command line is in your shell's history, so change it.
- **Secrets in `--env`, not in the command's arguments.** A run puts a server's arguments in the process list, which every local user can read, while its environment is readable only by you. `add` warns of a reference in an argument whose option names a credential, such as `--api-key`.
- **`$` in `.env`.** Bun's `.env` loader expands `$NAME` and `${NAME}` in a value, even in single quotes, and Node's `--env-file` doesn't: a secret that holds `$` reads differently on each runtime.
- **Listing and changing.** `bun run mcp list` prints a table of the servers, in name order: each one's name, its transport, `http` or `stdio`, its URL or its command, and whether it's enabled. `bun run mcp get <name>` shows one server's settings, with references as written, both timeouts and, for a remote server, whether it's logged in. `bun run mcp remove <name>` deletes a server, with its login, and `bun run mcp disable <name>` and `bun run mcp enable <name>` turn one off and on. To change a server, remove it and add it again. `bun run mcp:node` does the same on Node.
- **What it prints.** Results go to stdout, as plain text. Each problem goes to stderr, on a line beginning `error:`, and each warning on a line beginning `warning:`, before the result. The command exits with 1 when it reports a problem. Only `login` contacts a server, and resolves references.

**What is stored.** `add` keeps each server as one entry in Claude Code's `mcpServers` format, built from the flags, and checks it; each run checks it again. The server's name, and whether it's disabled, are kept beside the entry.

- **stdio:** `command`, a name without a slash or an absolute path; `args`; `env`; and `cwd`, an absolute path.
- **Streamable HTTP:** `url`, which is `https`, or `http` only when nothing in the entry holds a reference, since Bun's `fetch` sends even a request to `127.0.0.1` through `HTTP_PROXY`, headers included; and `headers`.
- **Both:** `includeTools` and `excludeTools`, which name tools as the server lists them, never the same tool in both; and `startupTimeoutMs` and `toolTimeoutMs`, in milliseconds, which every entry holds, since `add` writes the defaults in. A field without a value is left out. A server added before the flags may also hold `type`, `title` and `description`, which are kept. A run refuses an entry with any other field, as a row written into the database by hand might hold.
- **References.** `${NAME}` and `${env:NAME}` refer to the agent's environment, and `$$` stands for `$`. They may appear in the command, its arguments, `--env` values, `--cwd`, header values, and the path and query of a URL; there are no defaults, and no bare `$NAME`. A run resolves them, and an unset or blank variable fails it. `MODEL_API_KEY` can't be referenced.
- **No literal secrets.** A variable, a header, a query parameter or an option whose name says it holds a credential, such as `API_KEY`, `Authorization` or `--token`, must hold a reference, unless its value is a number, `true`, `false` or `none`, or its name's last word is `PATH`, `FILE` or `DIR`, as in `PRIVATE_KEY_PATH`, which may hold a plain path. Text shaped like a token, a written-out `Bearer` credential, a JSON Web Token, a private key and a password in a URL are refused anywhere.
- **Tool names.** The model sees a tool as `mcp__<server>__<tool>`: the server's name lowercased, with `-` as `_`, and the tool's name in snake_case, with any other character as `_`. A name over 64 characters, or one that two tools would share, ends in a hash of the server's and the tool's names instead.
- **`PATH`.** A run finds a stdio command in the absolute directories of the server's `PATH`. Under a scheduler, `PATH` is short, so give the command's absolute path, or give the server a `PATH` with `--env`.

**Logging in.** A remote server that answers 401 needs a login, through OAuth's authorization code flow with PKCE. `bun run mcp login` gives it one:

```sh
bun run mcp login docs
```

- **The address to open.** The login first sends the server an initialize without a token, with the server's own headers, and finds its OAuth metadata where the 401's `WWW-Authenticate` says, or else at the well-known URLs. It registers a client with the authorization server that names, asking for the scope the 401 names unless `--scope` gives one, and prints an address to open in a browser, where you sign in. The browser then comes back to the login, which listens on `127.0.0.1` alone, on a port the system picks. The login checks the redirect's `state`, saves the login, and lists the server's tools with the new token, to show it works: `Logged in to docs: 2 tools.` It waits 5 minutes for the browser.
- **Over SSH.** When the browser runs on another machine, the address it ends on, on `127.0.0.1`, doesn't load. Copy that whole address from the browser's address bar, paste it into the terminal where the login waits, and press Enter: it counts as the browser's coming back.
- **A client of your own.** Most authorization servers let the login register a client itself, as `mecha-gremlin`. One that doesn't, such as GitHub's, needs a client you've registered with it, whose redirect URI is an `http` address on `127.0.0.1` or `localhost`, with a free port of your choosing, such as `http://127.0.0.1:8765/callback`: the login's error names the authorization server, and the command to run. Give the client's ID with `--client-id`, its secret, if it has one, with `--client-secret`, as a reference in single quotes, and, with `--redirect-uri`, the redirect URI it registered, which it needs: the login listens on that port, and sends the redirect URI as given, since some authorization servers accept no other, port included. For GitHub's server, a personal access token through `--header` is simpler.

  ```sh
  bun run mcp login docs --client-id docs-agent --client-secret '${DOCS_CLIENT_SECRET}' \
      --redirect-uri http://127.0.0.1:8765/callback
  ```

- **The scope.** `--scope 'read write'` asks for those scopes in place of the ones the server lists.
- **Logging in again.** A later login uses the client the last one saved, and its redirect URI: a client of your own is saved with the redirect URI it was used with, so `bun run mcp login docs` needs no options, and `--client-id` with the same ID takes that redirect URI too. When that redirect URI's port is taken, the login listens on another, and registers a client for it, in place of the saved one; with an authorization server that can't register clients, it fails instead, naming the port. Its tokens replace the old ones.
- **Logging out.** `bun run mcp logout <name>` deletes a server's login, and `remove` deletes it with the server. Neither revokes the tokens at the authorization server.
- **Where the tokens are.** The client, its secret, the tokens and what the login discovered are kept in `db.sqlite` in the data folder: mode 0600, but not encrypted, and the shell can read them, as it can the rest of the database. Nothing the command prints holds a code, a token, a code verifier or a client secret, and runs redact a server's tokens and client secret as they redact its references.
- **In a run.** Each request to the server carries its access token, in place of an `Authorization` header of its own. A token that expires within 5 minutes is refreshed before the server's first request, and a request the server answers with 401 is sent once more, after a refresh. Runs refresh a login one at a time, so that two runs at once never send the same refresh token: an authorization server that rotates them revokes the whole login when one comes back.
- **Needs a new login.** When the authorization server refuses a refresh, the login is spent: `bun run mcp get <name>` shows `needs a new login`, and every run fails at that server, before any request, until `bun run mcp login <name>` gives it a new one. A refresh that fails otherwise, as when the authorization server doesn't answer within 25 seconds, keeps the tokens and fails only that run.

**Running with servers.**

- **Check a new server** with a short run, such as `bun run agent -p 'Say hi'`, and look at its `mcp server` record: the tools it offers, their definitions' size in bytes, and a hash of its tool list, which changes when the list does.
- **A server that fails, fails every run**, before the first model call, with its error and the last lines of its stderr, until it's fixed or disabled with `bun run mcp disable <name>`.
- **Where stdio servers run.** A server runs in its `cwd`, or else in a directory made for the run in the OS's temporary directory, holding only an empty `node_modules`, so that npm reads no `.npmrc` above it: not one the file tools wrote into the working directory. It can't keep out one a shell command writes to `~/.npmrc`. When the run ends, each server gets end-of-file, then SIGTERM, then SIGKILL, with the process groups its children lead, such as a browser's.
- **Untrusted text.** Tool descriptions and results reach the model as text the server wrote, which may try to steer it. Add servers you trust, and offer only the tools you need with `--include-tool`.
- **Context.** Every tool's definition is sent with every model call: the tools of the fifteen servers measured in the Brief's R18.2 came to about 21,900 tokens, against about 700 for the built-in tools. A server's own flags, and `--include-tool`, keep the list short.

### Skills

A skill is a folder with a `SKILL.md`, in the [Agent Skills](https://agentskills.io) format. `SKILLS_PATH` lists the directories that hold skills, separated by `:` as in `PATH`: each of their subdirectories with a `SKILL.md` is a skill. Nothing else is searched, so skills written for other agents stay out unless you list them. The model sees each skill's name and description, loads a skill's instructions with `activate_skill`, and reads the skill's other files with `read`.

For example, to browse with Microsoft's playwright-cli skill, which ships with the CLI and drives Google Chrome:

```sh
npm install -g @playwright/cli
mkdir -p ~/gremlin-work
WORK_DIR=~/gremlin-work SKILLS_PATH=$(npm root -g)/@playwright/cli/skills \
    bun run agent -p 'Use the playwright-cli skill to find the title of https://example.com'
```

### Set up for browsing

- **Load the model with at least 32k of context.** The skill's instructions are about 4k tokens, and one page's snapshot can be 8k, while LM Studio loads models with 8k unless told otherwise: `lms load <model> --context-length 32768`, then check the loaded context with `lms ps`.
- **Give the agent a working directory of its own,** outside the repository, such as `~/gremlin-work` above. Commands run there, and playwright-cli writes its snapshots there, in `.playwright-cli/`. `WORK_DIR` is required; in this repository, `.playwright/` and `.playwright-cli/` are gitignored.
- **Turn on LM Studio's token auth:** "Require Authentication" in its server settings, with one of its tokens in `.env` as `MODEL_API_KEY`. It keeps other local processes and web pages away from LM Studio's API, though not this shell.
- **Keep keys in `.env`, not on the command line,** where a command could read them with `ps -E -p $PPID`. Neither this nor a dedicated `WORK_DIR` stops a command that goes looking.

## Configuration

Settings come from the environment, and from a local `.env` file, which is gitignored. Each value is trimmed, and a blank one counts as unset.
- **On Bun,** `.env` is read along with `.env.local`, and a file for `NODE_ENV` (`.env.development` when it's unset).
- **On Node,** only `.env` is read, through the `--env-file-if-exists` flag in `agent:node`. Without a `.env`, Node prints ".env not found. Continuing without it." to stderr, and carries on.

The `mcp` command needs only `DATA_DIR`, and `bun run mcp help` needs no setting at all (see [MCP servers](#mcp-servers)).

There are no implicit provider, model or operational settings. The Claude cache policy below is the only new provider default. Missing or invalid settings are reported together before networking.

| Variable | Required | Meaning |
|---|---|---|
| `MODEL_PROVIDER` | Yes | `lmstudio`, `openai` or `anthropic` |
| `MODEL_BASE_URL` | Yes | HTTP(S) base URL. Responses examples: `http://127.0.0.1:1234/v1` or `https://api.openai.com/v1`. For Claude, use `https://api.anthropic.com` or a proxy prefix: the SDK appends `/v1/messages` itself. |
| `MODEL_API_KEY` | Yes | Provider API key or LM Studio token. With LM Studio authentication off, any explicitly supplied nonempty value works. |
| `MODEL` | Yes | The model to use; LM Studio verifies this key or instance ID is already loaded. |
| `MODEL_REASONING_EFFORT` | Yes | Responses: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Anthropic: `low`, `medium`, `high`, `xhigh`, `max`. Check that the selected model supports the value. |
| `MODEL_MAX_OUTPUT_TOKENS` | Anthropic only | Positive safe integer in decimal digits, sent as Claude's per-call `max_tokens`. Rejected for Responses providers. |
| `ANTHROPIC_WORKSPACE_ID` | No | Optional Anthropic workspace ID for a key that needs one. |
| `LOG_FORMAT` | Yes | `pretty` or `json`. |
| `WORK_DIR` | Yes | Existing directory for the shell and file tools. A relative path resolves against the current directory; the real path is used. |
| `DATA_DIR` | Yes | Existing directory for the agent's database (see [The data folder](#the-data-folder)). A relative path resolves against the current directory; the real path is used. |
| `MAX_STEPS` | Yes | Maximum model calls in a session, a positive whole number. The old name `MAX_TURNS` is rejected. |
| `FILE_TOOLS` | Yes | `write-edit` or `apply-patch` (see [The file tools](#the-file-tools)). |
| `SKILLS_PATH` | No | Skill roots separated by `:`. If absent, no skills are loaded and no other directory is searched. |

For example, with LM Studio already serving a loaded model, a `.env` can contain:

```dotenv
MODEL_PROVIDER=lmstudio
MODEL_BASE_URL=http://127.0.0.1:1234/v1
MODEL_API_KEY=replace-with-your-lm-studio-token
MODEL=your-loaded-model
MODEL_REASONING_EFFORT=none
MAX_STEPS=30
FILE_TOOLS=write-edit
LOG_FORMAT=pretty
WORK_DIR=/absolute/path/to/existing/workdir
DATA_DIR=/absolute/path/to/existing/data-folder
```

For the direct Claude API, replace the provider-specific lines with an Anthropic API key and a model available to your account, and keep the explicit operational settings above, `WORK_DIR` and `DATA_DIR` included:

```dotenv
MODEL_PROVIDER=anthropic
MODEL_BASE_URL=https://api.anthropic.com
MODEL_API_KEY=replace-with-your-anthropic-api-key
MODEL=claude-sonnet-4-6
MODEL_REASONING_EFFORT=medium
MODEL_MAX_OUTPUT_TOKENS=4096
```

Claude uses the native Messages API, not a Claude subscription or an OpenAI compatibility endpoint. Every request enables automatic five-minute prompt caching; cache writes can cost more, and a hit depends on prompt length, prefix matching and cache lifetime. The agent reports the actual cache usage instead of promising a hit. Each request also asks for Claude's cache diagnostics against the previous reply, so a model call's `diagnostics` names what changed when the cache couldn't reuse that request's prefix; `null` means nothing did, or it is the first call. Tool schemas retain their constraints and are validated locally; Anthropic strict-tool mode is not enabled. Signed thinking and other native assistant blocks stay in the session's in-memory history, and a session cannot switch providers. History is not persisted to a database.

**Migrating:** Existing `.env` files must now supply every required setting, `DATA_DIR` included, and every invocation must supply a task. LM Studio no longer selects its first loaded model. Consumers of the old OpenAI-shaped core `callModel`, `toInput`, `toOutputItem`, `toFunctionTool` and `classify` exports must use Gremlin's provider-neutral core types and the agent's provider adapters instead. No persisted history migration is needed.

## Develop

```sh
bun run test           # unit tests (Vitest) on Bun; no LM Studio needed. test:watch for watch mode
bun run test:node      # every test again, on Node
bun run typecheck      # tsc --noEmit over the whole workspace
bun run lint           # oxlint, with type information; warnings fail too
bun run spellcheck     # CSpell, over code and docs alike
bun run format         # oxfmt: 4-space indentation, single quotes; format:check only checks
bun run check          # format:check, lint, spellcheck, typecheck, test and test:node, as CI would run them
bun run mutation       # Stryker mutation testing on Bun, which fails below 100%; report in reports/mutation/
```

- **Formatting.** oxfmt formats code and config files. Markdown, `openspec/`, `.claude/` and `.opencode/` are excluded in `.oxfmtrc.json`, so prose documents and generated command files keep their layout.
- **Spelling.** CSpell checks every file git doesn't ignore, except `bun.lock` and the command files OpenSpec generates under `.claude/commands/` and `.opencode/`.
  - It accepts American and British spellings.
  - Its TypeScript, Node, npm, full-stack, shell, Python, SQL and Docker dictionaries apply to every file, not only to their own file types, since the docs and config talk about code too.
  - A word it doesn't know goes in `words` in `cspell.json`. A token that isn't a word, such as a test string or a cluster of command-line flags, goes in `ignoreWords`.
- **Tests run on Bun and on Node,** the two runtimes the app runs on. `bun run test` runs every test on Bun, and `bun run test:node` runs them all again on Node.
  - Each script names its runtime in `TEST_RUNTIME`, and one of the agent's tests, `runtime.test.ts`, fails unless the tests run on the runtime it names, so it also fails for tests run without a script. Vitest's and Stryker's command-line scripts start Node, so `test`, `test:watch` and `mutation` start them with `--bun`.
  - `test:node`, and so `check`, needs Node 26: without Node, Bun stands in for `node`, and the runtime test fails.
  - `yaml` and `process` export both of their implementations, so the tests run each on the runtime that has it: the Node ones on both runtimes, and the Bun ones on Bun. Node's run reports the Bun ones as skipped. Mutation testing runs on Bun, where both run.
  - Three workarounds keep the tests and mutation testing working on Bun. Each is commented where it's applied:
    - `vitest.config.ts` inlines `zod`: under Bun, Vitest's own import of `zod` comes back without its `z` export. The line can go once the tests pass on Bun without it.
    - `bun run mutation` preloads `stryker.preload.ts`, for a Bun bug ([oven-sh/bun#41151](https://github.com/oven-sh/bun/issues/41151)) that otherwise stops Stryker loading its Vitest runner. The file and the `--preload` flag go once the bug is fixed.
    - `stryker.config.mjs` gives Stryker's Vitest runner `related: false`: under Bun, it finds no test files related to the mutated files, so no test would run. Per-test coverage still picks the tests each mutant runs. The option can go once the runner finds those files under Bun.
- **Lint rules beyond oxlint's defaults.** Every if/loop body needs braces (`curly`), and a `let` that is never reassigned must be a `const` (`prefer-const`). Functions are arrow functions assigned to a `const` (`func-style`, `prefer-arrow-callback`); a generator, which can't be an arrow, is a `function*` expression. A `const` can't be used before its line has run, so everything is defined before it's used (`no-use-before-define`): helpers come first, and a file reads bottom-up. Object types are `type` aliases, never interfaces (`typescript/consistent-type-definitions`).
- **Functions never change their arguments.**
  - A parameter can't be reassigned, nor its properties assigned (`no-param-reassign`).
  - Every typed parameter must be readonly all the way down (`typescript/prefer-readonly-parameter-types`), so TypeScript rejects a write or a `push` through it. The code's own object types are readonly for that reason.
  - Types from other packages can't always be made readonly, so `.oxlintrc.json` allows them by name or a narrow adapter boundary exempts them inline.
- **Linting uses type information,** through `oxlint-tsgolint`. That also turns on the type-aware rules in the enabled categories, such as `no-floating-promises`. Two of them are adjusted:
  - Tests may use type assertions (`no-unsafe-type-assertion` is off there), since they build malformed values on purpose.
  - `consistent-return` is off: TypeScript's `noImplicitReturns` checks the same thing, and knows when a switch covers every case.
- **The packages' boundaries are enforced by the linter,** through overrides in `.oxlintrc.json`.
  - `core` may not touch `process`, `Bun` or `console`.
  - `yaml`, `process` and `store` may not touch `process` or `console`: they report only through their results, and a spawned process gets only the environment it's given.
- **Every mutant must be caught.**
  - Stryker fails below a 100% mutation score, so a new branch or message needs a test that would notice it changing.
  - A mutant that behaves exactly like the original code, or sits in code that can't run, is usually better removed by simplifying the code.
  - Where the code can't reasonably change, a `// Stryker disable next-line` comment turns the mutant off, with the reason on the line above. There are ten: `main.ts`' final `throw`; the `yaml` package's log level, where `''` behaves exactly like `'error'`; two for the sweep's `ps`: its process group, since it lists the same processes from any group, and its working directory, since `''` means the current one, which works the same while it exists; the check that narrows an MCP tool's input schema to an object, which `isSpecType.Tool` has already made; the sort of MCP servers and tools by name, where `<=` sorts as `<` does, since no two names are equal; the empty fallback for a stdio MCP server's working directory, never used, since the run's directory is made before such a server starts; the readers a stdio server's close waits for, which have ended by then, since cancelling a reader settles its read at once; how much of a file `read` reads for its binary test, since the test looks at the first 8 KiB alone, and reading more would only take longer; and the login's closing of its listener's connections, which only Node's `close()` needs, since Bun's ends them itself and mutation testing runs on Bun.
- **Tests fake the app's globals.** The app reads the environment, `fetch`, the clock and `console` directly, with nothing injected. Tests fake them with `vi.stubEnv`, `vi.stubGlobal` and `vi.spyOn`, and Vitest undoes every fake after each test. Importing `main.ts` runs it, so its tests import it only after faking, and never statically.
- **Tests start real processes, and a guard checks every signal they send.** The shell's and the sweep's tests run real commands, on Bun and on Node, and assert outcomes and signals, never elapsed time. [`test/signal-guard.ts`](test/signal-guard.ts), a Vitest setup file that Stryker never mutates, wraps `process.kill`. It refuses, and fails the test for, a signal that could reach pid 0, -1 or 1, the test process or its parent, or a process the test file can't vouch for: one it started, one carrying a run ID it registered, or a descendant of either. So even a mutant that widens the sweep's match can't reach your own processes. Processes a test leaves carry a fresh random run ID, and end on their own after 30 seconds at most.

## CI

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) builds every pushed branch, and pull requests from forks. It runs two jobs:

1. **Check and test:**
   - a frozen install, then the format check, lint, spell check and typecheck;
   - the tests on Bun (failures are annotated on the PR), then the whole suite again on Node;
   - the agent, started on Node against a port where nothing listens, with a data folder in the runner's temporary directory. It opens the store and runs the migrations first, then must exit with 1, saying it can't reach LM Studio. The tests load the code through Vite, so this is the one check that Node itself loads it;
   - `bun audit`, report only: the step shows as failed when there are advisories, but the job still passes.
2. **Mutation testing:** once the checks pass, Stryker runs on Bun and uploads its HTML report as the `mutation-report` artifact. The job fails if any mutant survives. It sets up only Bun, not Node.

Actions are pinned to commit SHAs, and there is deliberately no dependency cache shared between builds.
