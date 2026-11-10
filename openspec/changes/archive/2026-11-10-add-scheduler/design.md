## Context

The agent is a one-shot CLI: from the repository's root, `bun run agent <task file>` reads `.env`, carries out the task, logs structured records to stdout and exits with a code. Nothing starts it on a schedule. The Brief's draft scheduler (4.8) was a tick inside a database-backed daemon, `gremlin serve`; R25 and R26 researched lighter shapes, and the decisions of 2026-11-09 settle this one:

- **D6:** a resident scheduler of its own, started with a config file and a data directory, in place of 4.8's tick over the database.
- **D50:** written in Rust, in `packages/scheduler`, against the settled "TypeScript on Bun" for this package alone.
- **D51:** schedules live in its own TOML config, so it reads no YAML and no store.
- **D52:** a fire missed while the machine slept or was off runs once, for its latest slot, unless the job sets `catch_up = false`.
- **D53:** schedules follow the system's zone unless the config names a `timezone`.
- **D54:** it sleeps at most 60 s between looks at the wall clock.

The answers and the decision of 2026-11-10 settle the rest:
- **Q28:** it runs on the Mac host first, under a LaunchAgent (decision 16).
- **Q29:** each run is told its job, its slot and whether it catches up, through its environment (decision 7).
- **Q30:** a failed run starts the job's `on_failure` command (decision 17).
- **D55:** `gremlin-scheduler install` writes and loads its LaunchAgent, and `uninstall` removes it (decision 16).

Constraints: the scheduler stays small ("its functionality will be limited"), runs first on a Mac host under a LaunchAgent and later in Linux containers (Q28), and meets the repository's bar in Rust's tools (C24). It knows nothing of the agent: a job is a command.

## Goals / Non-Goals

**Goals:**
- Start each job's command at its cron schedule's fires, in the config's zone or the system's.
- Behave the same after a sleep, a suspend, a clock step or a restart on macOS and Linux: a missed fire runs once, and a backward step runs nothing twice.
- Keep each run's output, and the scheduler's own record of what it did, in the data directory.
- Bound every run with a timeout, and never start a job twice at once.
- Tell the user when a run fails, through a command of their own (Q30).
- Stay small: one binary of about 1 MB, about 2 MiB resident (R26.3), no async runtime.
- Meet the repository's bar: formatted, linted with warnings denied, tested, and every mutant caught.

**Non-Goals:**
- Knowing the agent: its store, task files, frontmatter or `.env` beyond starting in the folder that holds it.
- The store's migration race when runs start together (R25.5, S13), which a store change fixes.
- The Docker image and compose file (none exist yet), and installing a systemd unit from code: the README shows one.
- The operating system's exact wall-clock timers (D54, S15), a zone per job, overlap's `queue` (D16), retries, dependencies between jobs, the agent's own alerts and where its results go (Q1), and showing a run's slot to the model, which the agent would do (Q29).

## Decisions

### 1. A Rust package of its own, inside the Bun workspace

```
packages/scheduler/
├── package.json          @mecha-gremlin/scheduler, private: scripts that run cargo
├── Cargo.toml            the gremlin-scheduler binary, edition 2024
├── Cargo.lock
├── rust-toolchain.toml   the pinned toolchain, with rustfmt and clippy
├── deny.toml             cargo-deny: advisories
├── .cargo/mutants.toml   cargo-mutants: timeouts, and single-mutant exclusions
├── src/
│   ├── main.rs           the subcommands, the start, the lock and the loop
│   ├── config.rs         reading and checking the TOML config
│   ├── install.rs        install and uninstall: the LaunchAgent's plist, and launchctl
│   ├── schedule.rs       schedules, the zone, and what fell due
│   ├── runs.rs           starting runs, their logs, timeouts and retention
│   ├── events.rs         the channel that signals, run exits and the capped wait share
│   └── log.rs            scheduler.log's records
└── tests/                the binary's start, lock, runs, signals and reload
```

The package lives under `packages/`, as asked, and a `package.json` keeps it an `@mecha-gremlin/*` workspace package whose scripts run cargo (decision 13). The crate is a binary only, with modules and no `mod.rs` files, enforced by `clippy::mod_module_files`, the counterpart of the no-index rule. Unit tests sit beside the code in `#[cfg(test)]` modules, as Rust has them, and `tests/` runs the built binary.

The repository's style rules carry over where they translate: a blank line before and after every block, and before a `return` that follows other statements; an early return in place of a conditional final value; and comments that say only why. rustfmt can't enforce the blank-line rules on stable, so review does (R26.4).

Alternatives: `crates/` beside `packages/` with a root Cargo workspace, as Turborepo and Biome lay it out (R26.4). With one crate, a root `Cargo.toml` adds files at the root for nothing, and D50 asked for `packages/`.

### 2. The command line

Four subcommands, each option given once:

```
gremlin-scheduler run --config <file> --data-dir <dir>
gremlin-scheduler check --config <file>
gremlin-scheduler install --config <file> --data-dir <dir>
gremlin-scheduler uninstall
```

`--help` prints the usage and `--version` the version, each exiting 0. A missing or unknown subcommand, a missing option or value, a repeated option, an option the subcommand doesn't take, or any other argument exits 1 with the usage on stderr. With four forms, subcommands keep each form's options apart, as the agent's `bun run mcp` does (D55). The arguments are parsed by hand; a parser crate isn't worth it for two options.

`check` checks the config as `run` does, prints the zone and each job's next 5 fires in ISO 8601 with the zone's offset, and exits 0, or 1 with the check's message on stderr. It takes no data directory and no lock, writes no file and starts no run, so it can run beside a running scheduler: before a reload, whose refusal otherwise shows only in `scheduler.log`, and to see what a schedule means across DST and the either-day rule (decision 4). supercronic's `-test` only says that a crontab is valid (R26.2), and R25.2 read calendars with `systemd-analyze calendar`.

`install` and `uninstall` set the scheduler up under launchd and remove it (decision 16).

`run` is the scheduler itself. Its start, in order, each failure exiting 1 with its reason on stderr: read and check the config (decision 3); check that the data directory exists and is a directory; take the lock (decision 10); open `scheduler.log`; record `ready` with the zone and each job's next fire; decide at once what fell due (decision 6); then enter the loop. Errors go to stderr until the log is open, and to the log after.

### 3. The config

```toml
timezone = "Europe/London"   # optional: the system's zone without it (D53)
working_dir = "/path/to/mecha-gremlin"
command = ["/path/to/bun", "packages/agent/src/main/main.ts"]
env = { LOG_FORMAT = "json" }
timeout = "1h"
stop_grace = "30s"
keep_runs = 50
on_failure = ["/path/to/notify-failure.sh"]

[[job]]
name = "daily-summary"
schedule = "0 7 * * *"
args = ["tasks/daily-summary.md"]
timeout = "30m"

[[job]]
name = "issue-digest"
schedule = "*/30 9-18 * * 1-5"
args = ["tasks/issue-digest.md"]
catch_up = false
```

| Key | Where | Default | Meaning |
|---|---|---|---|
| `timezone` | top | the system's zone | an IANA zone name |
| `working_dir` | top, job | the config file's folder | where a run starts; relative to the config file's folder |
| `command` | top, job | none: one of the two must set it | the program and its first arguments |
| `env` | top, job | none | variables added to the scheduler's environment; a job's over the top's |
| `timeout` | top, job | `1h` | how long a run may take |
| `stop_grace` | top | `30s` | how long a run gets between SIGTERM and SIGKILL |
| `keep_runs` | top | `50` | how many run logs a job keeps |
| `on_failure` | top, job | none | a command run after a run fails (decision 17); `[]` means none, so a job can turn off the top's |
| `name` | job | required | ASCII letters, digits, `-` and `_`, at least one, unique: it names the job's log folder |
| `schedule` | job | required | five cron fields or a nickname (decision 4) |
| `args` | job | none | added after the command |
| `catch_up` | job | `true` | whether a missed fire runs once (D52) |

- **Strict.** A file that is missing, can't be read or isn't valid TOML, an unknown key, a key in the wrong table, a wrong type, a missing, duplicate or unsafe name, a schedule that doesn't parse or never fires, an unknown zone, an empty `command`, a duration that doesn't parse or is zero, or a `keep_runs` below 1 fails the check, with the key and its line. serde's `deny_unknown_fields` and the toml crate's spans give both.
- **No jobs** is a valid config: the scheduler idles, and a reload to such a config pauses every job.
- **Durations** are a whole number and a unit, `s`, `m` or `h` (`90s`, `30m`, `2h`), parsed by hand.
- **Only `working_dir` is a path the scheduler resolves:** a relative one against the config file's folder, not the working directory, since launchd starts a job in `/` (R25.2). `command`, `args` and `on_failure` reach the program as written, so the example's `packages/agent/src/main/main.ts` resolves against `working_dir`.
- **`timeout` has a default.** Nothing else bounds a whole agent run (R25.5), and an hour covers the slowest browsing tasks measured. A job that needs longer sets its own.
- **`stop_grace` defaults to 30 s,** since the agent's cleanup after SIGTERM takes up to about 28 s, or 29 with a command running, worked out from its code's constants: MCP servers close in up to 16 s, then the sweep's `ps` gets up to 10 s and its group a 2 s grace (R25.5).

Alternatives: YAML or JSON (D51 chose TOML: comments, and serde reads it with no parity to keep); a crontab-like file (per-job options would need syntax of their own).

### 4. Schedules and the zone

As D12 recommends, croner (croner-rust, the newest release) parses each schedule, built with `CronParser::builder()` and `Seconds::Disallowed`, so that only five fields pass (the plain `Cron::from_str` takes six and seven). Before croner sees it:
- **Nicknames** are mapped by the scheduler to their five fields: `@yearly` and `@annually` to `0 0 1 1 *`, `@monthly` to `0 0 1 * *`, `@weekly` to `0 0 * * 0`, `@daily` and `@midnight` to `0 0 * * *`, and `@hourly` to `0 * * * *`. croner-rust has no `@midnight`, and any other `@` word, `@reboot` included, fails.
- **Only cron's syntax passes:** digits, `*`, `,`, `-`, `/` and three-letter month and day names, in either case. croner's `?`, `L`, `W`, `#` and a `+` on the day of week fail, and so do full names, which croner refuses anyway.

A pattern that can never fire, such as `0 0 30 2 *`, fails the check when croner finds no next occurrence.

When both day fields are restricted, a day matches when either matches. "Restricted" means anything but a literal `*`, as croner and Bun read it: `0 0 */2 * 1` fires on odd days and on Mondays, where Vixie cron and cronie, which count any field starting with `*` as unrestricted, fire only on Mondays that fall on odd days (R25.1, R26.2).

At a DST change, croner's rule holds (R25.3). A schedule with a single value in both its minute and hour fields is fixed-time: it fires once in a repeated hour, at the first pass, and at the end of a skipped hour. Any other schedule is an interval: it fires in both passes of a repeated hour, and not at all for the times a skipped hour removes.

**The zone** is the config's `timezone`, looked up in jiff's database when the config is checked, or the system's, read again at every wake: the `TZ` variable when set, else the zone name that `/etc/localtime` links to, looked up with `TimeZone::get`. jiff's own `TimeZone::system()` caches its answer for 5 minutes, and a zone change in those minutes could lose a fire, so the scheduler uses it only where `/etc/localtime` is a plain file. Then a change shows within 5 minutes (D53).

Alternatives: a matcher of our own, which would need its own DST tests (R25.3). croner-rust gave the same fires as croner 11 on every valid pattern R26.4 tried, except where croner 11.0.0's February bug skips (R26.2).

### 5. The wait loop

```
at the start: each job's last look = its newest log's start, or now; decide (below)

loop {
    timeout = min(earliest next fire, earliest pending signal to a run, now + 60 s) - now
    events.recv_timeout(timeout)  → handle a signal or a run's exit, if one came
    decide:
        now  = wall clock
        zone = config's timezone, else the system's
        if now < previous wake: record "clock stepped back"
        for each job, its latest fire after its last look and at or before now:
            start it, skip it or catch it up (decision 6)
        each job's last look = max(its last look, now); previous wake = now
    send each signal that has fallen due to a run (decision 8)
}
```

One thread runs the loop and waits on a std `mpsc` channel with `recv_timeout`. Other threads send to it: one for signals (decision 9) and one waiter per run, which blocks in `Child::wait` and sends the exit. The loop decides once at the start, before its first wait, so that a fire missed while the scheduler was stopped runs at once.

**Fires count on the wall clock; a run's deadlines on the monotonic clock.** `recv_timeout` counts on a clock that stops in sleep and suspend, which the 60 s cap bounds: every wake reads the wall clock again (R26.1). A run's timeout and its grace count `Instant`s, so time the machine spends asleep doesn't count against a run, and a clock step doesn't move a deadline. An idle scheduler wakes once a minute, about 16 ms of CPU a day (R26.1).

**A last look never moves back.** After a backward step, a job starts nothing until the wall clock passes its last look again, so no fire runs twice. The cost, which R25.3 names, is that after a large step back a job stays silent until the clock catches up. Re-planning from the new time instead, as systemd does, would run those fires again (R26.1).

Alternatives: tokio, whose timer wheel parks about three times per 60 s sleep and adds a runtime (R26.3); the operating system's wall-clock timers, which D54 leaves for later (S15).

### 6. Due, missed and caught up

At each decision, each job's latest fire after its last look and at or before now is the only one that counts; earlier fires in that interval are dropped, so any number of them gives one run.
- **On time,** when seen less than 90 s after it: the job starts. Wakes come at least every 60 s, so 90 s leaves 30 s of slack for a loaded machine.
- **Missed,** when seen 90 s or more after it: the fire fell while the scheduler wasn't running, or the machine slept or was suspended. The job runs once, unless it sets `catch_up = false`, which records `skipped` with the reason `missed` (D52).
- **Running:** a fire, on time or missed, that comes while the job's previous run is still going records `skipped` with the reason `running` (decision 7).

At the start, each job's last look is the start time of its newest run log, read from the log's name, or the scheduler's start time for a job with none, so that a new job doesn't run its past. Reading the last start from the logs keeps the scheduler free of any other state. A run that starts late is named for when it started, so a restart doesn't run it again.

### 7. Runs and their logs

A run is `command` plus `args`, started with `std::process::Command`:
- in `working_dir`, so that the agent finds `.env` there;
- with the scheduler's own environment, then the top `env`, then the job's;
- with three variables of its own over all of those (Q29): `GREMLIN_JOB`, the job's name; `GREMLIN_SLOT`, the fire it runs for, in ISO 8601 with the zone's UTC offset, `2026-11-10T07:00:00+00:00`; and `GREMLIN_CATCH_UP`, `1` when it catches up a missed fire, and removed otherwise. Kubernetes records a Job's slot the same way, in RFC 3339 in the CronJob's zone (R25.5). The agent's shell tool passes none of them on to the model's commands, so showing them to the model is a change to the agent of its own;
- in its own process group (`process_group(0)`), so that a timeout or a stop reaches every process that stays in it;
- with stdin from `/dev/null`, and stdout and stderr both appended to `jobs/<name>/<start>.log`.

`<start>` is the UTC start time, `2026-11-09T07-00-00Z`, which sorts by time and holds no colon. The job's folder is created with mode 0700 and the log with 0600, since a run's records hold its task's text and tools' arguments (R25.5). A run that can't start, such as a missing program, records `error`, and the job keeps its schedule.

After each start, the job's oldest logs beyond `keep_runs` are deleted, never a running one's. A job whose run is still going skips its next fire and records `skipped` with the reason `running`, as C6's `overlap: skip` and most single-host schedulers do (R25.4).

The agent puts its shell commands and stdio MCP servers in sessions of their own (`detached: true`), so its run's group holds the agent and little else. SIGTERM reaches those processes through the agent's own cleanup, which `stop_grace` leaves time for. A SIGKILL after the grace ends the agent but leaves them running.

### 8. Timeouts

Each run has a deadline, its start plus `timeout`, and the wait counts down to the nearest deadline or pending SIGKILL. At the deadline the run's group gets SIGTERM, and `stop_grace` later SIGKILL if it is still there, recorded as `timed out`. A run keeps the `timeout`, `stop_grace` and `on_failure` it started with, whatever a reload changes, so a run of a job a reload removed is still bounded.

The group kill goes through rustix, since the standard library can't signal a process group (R26.3). A run's group is kept as the `Pid` that `Pid::from_child` gives (rustix's `std` feature), taken before the waiter takes the `Child`, and no function returns it as an integer. cargo-mutants replaces an integer-returning body with 0, 1 and -1, and a group of 1 is `kill(-1)`: every process the scheduler may signal, the user's whole session in a test. As the agent's sweep refuses pid 1 and below, the scheduler sends nothing to a group below 2.

### 9. Signals

A thread holds signal-hook's iterator for SIGTERM, SIGINT and SIGHUP, and sends each to the loop.
- **SIGTERM or SIGINT:** record `stopping`, stop starting runs and `on_failure` commands, send SIGTERM to every running group, theirs included, wait up to `stop_grace` for them to exit, send SIGKILL to the rest, record `stopped` and exit 0. Signals that arrive meanwhile are ignored.
- **SIGHUP:** read and check the config again. A config that passes replaces the old one and records `config reloaded`: running runs go on to their end with their own deadlines, a removed job starts nothing more, a kept job keeps its last look, and a new job's last look is the time of the reload. One that fails records `config refused`, with its reason, and the old one stays.

What stops the scheduler must wait longer than `stop_grace`. launchd sends SIGKILL `ExitTimeOut` seconds after SIGTERM, 20 s by default in its last open-source release and "system-defined" in macOS 27.2's launchd.plist(5), and Docker sends it after its stop grace, 10 s by default (R25.4, R25.5). So the plist `install` writes sets `ExitTimeOut` 15 s above `stop_grace` (decision 16), and the README's compose example sets `stop_grace_period` above it. Under Docker the scheduler would be the main process. It handles SIGTERM itself, and compose's `init: true` reaps orphaned grandchildren.

### 10. One scheduler per data directory

The scheduler opens `<data-dir>/lock`, created with mode 0600, and holds an exclusive lock on it with the standard library's `File::try_lock` for as long as it runs. The kernel drops the lock when the process dies, so a crash leaves nothing to clean up. A held lock fails the start with "another scheduler is using <data-dir>".

### 11. scheduler.log

The scheduler appends one JSON object per line to `<data-dir>/scheduler.log`, created with mode 0600: `time` in ISO 8601 UTC, `level`, `message`, then fields, as the agent's JSON records are, with U+007F to U+009F escaped as they are (structured-log). A time in a field is written as `time` is.

| Level | Message | Fields |
|---|---|---|
| `info` | `ready` | `zone`, and `jobs`: each job's `name` and `next` fire |
| `info` | `started` | `job`, `slot`, `pid`, and `log`: the run log's path in the data directory |
| `info` | `exited` | `job`, `code` or `signal` (a name, such as `SIGKILL`), and `seconds`, to a tenth |
| `info` | `skipped` | `job`, `slot`, and `reason`: `running` or `missed` |
| `warn` | `timed out` | `job` and `pid` |
| `error` | `error` | `job` and `reason`: a run that couldn't start, or an `on_failure` command that failed |
| `warn` | `clock stepped back` | `from` and `to` |
| `info` | `config reloaded` | `jobs`, as in `ready` |
| `warn` | `config refused` | `reason` |
| `info` | `stopping` | `signal` |
| `info` | `stopped` | none |

**Rotation.** Before each record, when `scheduler.log` has reached 10 MiB, the scheduler renames it to `scheduler.log.1`, replacing an earlier one, and starts a new file with mode 0600, so that the data directory stays bounded as `keep_runs` bounds the job logs. A run writes about 300 bytes, so 10 MiB holds about four months of a job every 5 minutes. The scheduler counts the bytes it writes from the file's size at open, so it needs no `stat` per record. Nothing reads the log back, since last looks come from the job logs' names, so rotation loses only old records. If the rename fails, it keeps writing to the open file.

Alternatives: no rotation, at about 30 MB a year for a job every 5 minutes; and reopening the file at each record so that newsyslog or logrotate can rename it, which needs a system entry, and on a Mac root.

### 12. Crates

The newest release of each, with only the features the code uses:
- croner, with its `jiff` feature and without its default `chrono`;
- jiff, with `std`, `tz-system` and `tzdb-zoneinfo`;
- toml, serde with `derive`, and serde_json;
- signal-hook;
- rustix, with `process` and `std`;
- `mutants`, whose `#[mutants::skip]` must be a regular dependency, since it marks code that isn't a test (R26.4).

No async runtime, no argument parser, no logging crate. cargo-deny checks them for advisories, beside `bun audit`.

### 13. Checks, in the repository's scripts

The package's `package.json` scripts:
- `check`: `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, then `cargo test --locked`;
- `mutation`: cargo-mutants under the repository's memory guard, `bun ../../test/memory-guard.ts cargo mutants`, as `bun run mutation` runs Stryker. A mutant can make a loop endless while it keeps what each turn makes, and Rust's heap has no limit either. It exits non-zero on any mutant that survives or times out;
- `build`: `cargo build --release --locked`.

The root's `check` runs the scheduler's `check` after the TypeScript checks, and the root gains `mutation:scheduler`, which runs its `mutation`. `rust-toolchain.toml` pins the newest stable Rust with rustfmt and clippy. rustup installs it on first use, from the folder cargo runs in (R26.4), and it moves with the repository's newest-version rule. cargo-mutants itself is installed with `cargo install --locked cargo-mutants`.

`.cargo/mutants.toml` sets a `minimum_test_timeout` well above the tests' longest bounded wait. cargo-mutants times a mutant's tests out at 5 times the baseline's, at least 20 s, and counts a timeout as a failure. As with Stryker now, only an equivalent or unreachable mutant may be turned off. Stable Rust has no line-level skip (R26.4), so one mutant is excluded by an `exclude_re` entry in `.cargo/mutants.toml` that matches it alone, with the reason in a comment above it. `#[mutants::skip]` turns off every mutant of a function, so it goes only where all of them are equivalent or unreachable, with the reason on the line above. The one exception is the two functions that hand `install` and `uninstall` the real `launchctl` and home directory: a test that called them would change the launchd of the machine running it, so no test does, and they carry `#[mutants::skip]` with that reason (decision 16).

`target/` and `mutants.out*/`, cargo-mutants' reports, go into `.gitignore`: the reports fail oxfmt and CSpell, and `lock.json` records the host's name and user. Stryker copies every file it doesn't ignore into its sandbox, `.gitignore` or not, so `stryker.config.mjs` ignores `/packages/scheduler`, where a build leaves over 100 MB in `target/`. oxfmt formats the package's `package.json` and TOML files as it does the other packages' files, and CSpell checks its Rust; it treats `Cargo.lock` as a generated lock file.

### 14. CI

A job of its own, `Scheduler`, beside `Check and test`:
- on `ubuntu-latest` and `macos-latest`: the format check, clippy and the tests, since the scheduler runs on Mac hosts and in Linux containers;
- on `ubuntu-latest`: cargo-mutants, which fails the job on a mutant that survives or times out, and `cargo deny check advisories`, report only, with `continue-on-error: true` as `bun audit` has. Both tools come from a SHA-pinned `taiki-e/install-action`.

It keeps the workflow's rules: the `if:` that builds a same-repository PR only through its branch's push, `persist-credentials: false`, actions pinned to SHAs, no dependency cache, and a `timeout-minutes` of its own. Its steps run in `packages/scheduler` (`defaults.run.working-directory`), where cargo finds the crate and rustup the pinned toolchain, which downloads in each job in about 10 s (R26.4). A change to the workflow is pushed through gh's credential, since the keychain's token can't push workflow files.

### 15. Tests

- **Unit tests** cover:
  - every check of the config, and its defaults;
  - durations, names, the nicknames and the refused syntax;
  - due and missed fires on fixed timestamps, in Europe/London and America/New_York at their 2026 and 2027 transitions, for fixed-time and interval schedules;
  - the 90 s boundary, the backward step, the start from the newest log and a new job;
  - the zone read from `TZ` and from `/etc/localtime`;
  - `check`'s fires at a fixed time;
  - retention, log names, the records' JSON, and the refusal to signal a group below 2;
  - `install` and `uninstall` against a temporary home and a fake runner, on any system: a first install, installing again, a broken config, a held lock, no `ready` record, a system that isn't macOS, the plist's keys and escaping, and `uninstall` with and without an agent.
- **The loop** is tested in-process with an injected clock and a fake that stands in for starting runs: overlap, timeouts, the `on_failure` command and its 60 s limit, the stop sequence and reload, with no real waiting.
- **The binary's tests** run it for real. A run starts at once, with no wait for a minute, when a test seeds a job's folder with a log whose start is older than the job's latest fire: the start's decision catches it up. They cover:
  - missing and unknown subcommands, missing, unknown and repeated options, `--help` and `--version`;
  - `check` on a valid and a broken config, writing nothing;
  - a bad config and a missing data directory;
  - a held lock, and a start after SIGKILL;
  - a run's output, environment, `GREMLIN_` variables and records;
  - an `on_failure` command after a run that exits 1, and none after one that exits 0;
  - a timeout, and a run that ignores SIGTERM;
  - SIGTERM while idle and with a run going;
  - SIGHUP with a valid and a broken config.

  They never run `install` or `uninstall`, which would change the launchd of the machine running them (decision 16).
- **Every wait in a test is bounded.** A test that waits for a record or an exit gives up after a deadline and kills the binary. A mutant that hangs the scheduler then fails a test rather than timing out.
- **Mutation testing** must catch every mutant. cargo-mutants makes fewer mutants than Stryker (R26.4), so the tests check literals and whole conditions by hand.

### 16. Where it runs first, and `install`

On the Mac host, under a LaunchAgent (Q28): the agent runs there today (D18), and the repository has no Docker image yet. `gremlin-scheduler install --config <file> --data-dir <dir>` sets it up, as asked (D55), and `gremlin-scheduler uninstall` removes it.

`install` takes these steps in order, and a failure at any of them exits 1 with its reason:
1. It refuses on any system but macOS, pointing to the README's systemd unit.
2. It checks the config as `check` does.
3. It creates the data directory with mode 0700 if it doesn't exist, and `stderr.log` in it with mode 0600, since launchd would create that file with the umask's mode (R25.5).
4. It boots out an agent already loaded as `local.gremlin-scheduler`, found with `launchctl print`, and then waits, up to `stop_grace` plus 15 s, until the data directory's lock is free, since launchctl(1) doesn't say whether `bootout` waits for the process to end. A lock held with no agent loaded, such as by a scheduler started in a terminal, fails the install at once, and so does one still held after the wait, before anything is loaded.
5. It writes `~/Library/LaunchAgents/local.gremlin-scheduler.plist`, creating the folder if needed. When a plist is already there, it says that it replaces it and prints what the agent now runs, so that an install from a second checkout repoints the agent loudly, not silently (R25.5).
6. It loads the plist with `launchctl bootstrap gui/<uid>`.
7. It waits up to 10 s for a `ready` record written after the load, then prints the plist's path and each job's next fire. Without one, it prints the end of `stderr.log`, says that the agent is loaded and `uninstall` removes it, and exits 1.

The plist is written by hand, with `&`, `<` and `>` escaped, so no plist crate is needed:
- `Label`: `local.gremlin-scheduler`, so one scheduler is installed per user, and `install` again replaces it;
- `ProgramArguments`: the absolute path of the binary `install` runs as, from `current_exe`, then `run`, `--config` and `--data-dir`, with absolute paths, since a plist expands neither `~` nor `$HOME`;
- `KeepAlive`, which implies `RunAtLoad`, so that launchd starts it at login and again whenever it exits;
- `WorkingDirectory`: the data directory, since launchd otherwise starts a job in `/` (R25.2), and runs start in their own `working_dir` anyway;
- `EnvironmentVariables`: the `PATH` and `LANG`, and `LC_ALL` when set, that `install` runs with. launchd sets only a short `PATH` and no `LANG`, and `.env` can set neither (R25.5), while runs, their shell commands and their MCP servers need both. `install` prints them, and running it from another shell takes that shell's;
- `ProcessType`: `Interactive`. Without it launchd throttles the job's CPU and I/O, and likely its runs' **[M]**, and `Standard` is the same as leaving it out (R25.2);
- `StandardErrorPath`: the data directory's `stderr.log`, so that a start that fails, such as on a config edited since, says why: launchd sends stderr to `/dev/null` unless it is set, and `KeepAlive` starts the scheduler again, at most once every 10 s (R25.2);
- `ExitTimeOut`: `stop_grace` plus 15 s (decision 9). A later change to `stop_grace` needs `install` again.

`uninstall` boots the agent out if it is loaded and deletes its plist, printing what it removed, and leaves the config and the data directory. With nothing installed it says so and exits 0. It refuses on any system but macOS.

**No test touches the real launchd.** `install` and `uninstall` take the system's name, the home directory, the user's id, the binary's path, the environment, the waits' limits and a runner for `launchctl` as arguments. Tests give them a temporary home and a fake runner that records each call and answers as `launchctl` would, on Linux as on macOS, where cargo-mutants runs. Two small functions hand them the real ones: `/bin/launchctl` by its absolute path, `HOME`, rustix's `getuid` and `current_exe`. A test that called them would load or remove a LaunchAgent on the machine running it, as R25.5 warns, so no test calls them, the binary's tests never run `install` or `uninstall`, and cargo-mutants skips those two functions (decision 13). S11 checks the real install on a spare Mac.

A LaunchAgent runs while its user is logged in, since `gui/<uid>` exists only with a GUI login (R25.5). A process launchd starts likely can't reach `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive **[M]** (R25.2), so the README says to keep the binary, the config, the data directory and every file a task touches outside them, and S11 checks it. The README installs the binary with `cargo install --path . --locked` in `packages/scheduler`, where rustup finds the pinned toolchain, into `~/.cargo/bin`, so that the plist names a path that a rebuild or `cargo clean` in the checkout doesn't touch. It shows `launchctl kill SIGHUP gui/<uid>/local.gremlin-scheduler`, which rereads the config, and `launchctl print`, which shows the agent's state. A systemd user service and a container get shorter notes, written by hand; the container follows with the image (4.9).

Alternatives: the README's plist alone, as this design first had it, which leaves every key for the user to get right; one label per data directory, which allows several installed schedulers at the cost of naming each; and `install` copying the binary to a folder of its own, which `cargo install` already does.

### 17. A command when a run fails

A run that fails starts its job's `on_failure` command, or the top level's (Q30). A run fails when it exits with a code other than 0, ends by a signal, passes its timeout or can't start. It keeps the `on_failure` it started with, as it keeps its timeout, and `on_failure = []` means none, so that a job can turn off the top level's.

The command starts as a run does: in the run's working directory and a process group of its own, with stdin from `/dev/null` and its output appended to the run's log, after the run's own. Its environment is the run's, `GREMLIN_JOB`, `GREMLIN_SLOT` and `GREMLIN_CATCH_UP` included, and three more variables, shaped like the `$MONITOR_*` variables that systemd 251 and later give an `OnFailure=` handler (R25.4):
- `GREMLIN_RESULT`: `timeout` for a run that passed its timeout, whatever it then exited with; otherwise `exit-code`, `signal`, or `error` for a run that couldn't start;
- `GREMLIN_STATUS`: the exit code, the signal's name, such as `SIGKILL`, or the reason the run couldn't start, as the `exited` and `error` records give them;
- `GREMLIN_LOG`: the run log's absolute path, so that the command can quote its tail.

What the command does with them is the user's choice: a notification, a mail or a message to a phone. The scheduler knows no service, and a script can hold back repeats when a job fails at every fire, as OpenClaw's alerts wait for 2 failures in a row (R25.4).

The command gets 60 s, then SIGTERM to its group and SIGKILL `stop_grace` later, through the function that signals runs (decision 8): a notification takes seconds, and a hung one mustn't linger. It doesn't count as the job's run, so it delays no fire. When it fails in any of the four ways, the scheduler records `error` with the job and a reason that names `on_failure`, and runs nothing more for it. A run that exits 0, a skipped fire, and a run that ends while the scheduler stops start no command, and the stop signals commands still going as it signals runs (decision 9).

A dead-man's switch for the scheduler itself, Q1's other half, needs no feature: a job that pings an outside check every few minutes stops pinging when the scheduler stops.

Alternatives: the log alone, which leaves a failure at 3am unseen until someone looks; a command after every run, which would also carry success pings, though a ping job does that; and built-in mail or webhooks, which bring a service's settings into the scheduler, as ofelia's mail and Slack options do (R25.4).

## Risks / Trade-offs

- [A second toolchain, supply chain and pipeline (C24)] → One small crate with eight dependencies, cargo-deny, and a CI job that adds no time to `Check and test`.
- [cargo-mutants is a coarser gate than Stryker, and has no line-level skip (R26.4)] → Tests written against literals and whole conditions; single mutants excluded by `exclude_re`, each with its reason.
- [A mutant that signals a group of 1 would reach every process the user may signal] → The group kept as a `Pid`, never as an integer a function returns, and no signal to a group below 2 (decision 8).
- [A binary built on current Debian needs glibc 2.39 (R26.4)] → Built where it runs: with cargo on a Mac, and on the image's own Debian when the image exists.
- [On macOS, a process launchd starts, and likely its runs, can't reach `~/Documents`, `~/Desktop` or iCloud Drive (R25.2)] → The README says so, and S11 checks it on a spare Mac.
- [If the scheduler itself crashes on macOS, its runs go on: each is in a group of its own, which launchd's kill doesn't reach. The restarted scheduler doesn't know them, so no timeout bounds them, and a job's next fire can start beside one] → A small, tested crate, and `KeepAlive`; under systemd and Docker the runs end with the scheduler.
- [A SIGKILL after `stop_grace` leaves the agent's detached shell commands and MCP servers running (decision 7)] → `stop_grace` above the agent's own cleanup time.
- [launchd's and Docker's own stop timeouts are shorter than `stop_grace`] → `install` sets `ExitTimeOut` above it, and the README's compose example `stop_grace_period`.
- [`install` and `uninstall` change the user's launchd, which no test may touch] → They take a runner and a home directory, which tests fake; only two small functions hand them the real ones, and cargo-mutants skips those two; S11 checks the real install on a spare Mac.
- [`install` copies `PATH` from the shell it runs in, which may hold entries a run doesn't need, or lack ones it does] → It prints what it wrote, and `install` from another shell takes that shell's.
- [One label per user, so an install from a second checkout repoints the agent (R25.5)] → `install` says that it replaces the plist, and prints what the agent now runs.
- [Up to 60 s late after a wake, and later in Docker Desktop's VM until its clock is next stepped (R26.1)] → Accepted by D54; exact timers can follow (S15).
- [Runs started together on a fresh or migrating data folder fail (R25.5)] → Out of scope here; the README warns until the store's change lands (S13).
- [Schedules follow the system's zone without `timezone`, so a container runs in UTC unless `TZ` is set (D53)] → The README says so.
- [Where `/etc/localtime` is a plain file, jiff's 5-minute cache can delay a zone change, and lose a fire in those minutes] → Rare on macOS and in the official images, where it is a link or `TZ` is set.
- [`on_failure` runs at every failure, so a job that fails at every fire notifies at every fire] → The command decides what to send, and can hold back repeats.
- [A broken `on_failure` command hides failures] → Its failure is an `error` record in `scheduler.log`, and the run's log holds its output.
- [Rotation keeps 10–20 MiB of records, so a scheduler with a job every minute keeps weeks of them, not years] → Enough to see recent failures; `scheduler.log.1` can be copied elsewhere to keep more.
- [croner-rust is young, and fixed real bugs recently (R26.2)] → The newest release pinned in `Cargo.lock`, and DST and day-field tests.

## Migration Plan

Nothing to migrate: the package is new and nothing depends on it. On a Mac, a user installs the binary with `cargo install --path . --locked` in `packages/scheduler`, writes a config, checks it with `gremlin-scheduler check`, and runs `gremlin-scheduler install` (decision 16). On Linux, a systemd user service or a container starts `gremlin-scheduler run`, as the README shows. Removing it means `gremlin-scheduler uninstall` and `cargo uninstall gremlin-scheduler`.

## Open Questions

None left. Q28, Q29 and Q30, and the change's own two questions, were answered on 2026-11-10: where it runs first (decision 16), the variables a run gets (decision 7), the command a failed run starts (decision 17), `check` (decision 2) and the log's rotation (decision 11).
