## Context

The agent is a one-shot CLI: from the repository's root, `bun run agent <task file>` reads `.env`, carries out the task, logs structured records to stdout and exits with a code. Nothing starts it on a schedule. The Brief's draft scheduler (4.8) was a tick inside a database-backed daemon, `gremlin serve`; R25 and R26 researched lighter shapes, and the decisions of 2026-11-09 settle this one:

- **D6:** a resident scheduler of its own, started with a config file and a data directory, in place of 4.8's tick over the database.
- **D50:** written in Rust, in `packages/scheduler`, against the settled "TypeScript on Bun" for this package alone.
- **D51:** schedules live in its own TOML config, so it reads no YAML and no store.
- **D52:** a fire missed while the machine slept or was off runs once, for its latest slot, unless the job sets `catch_up = false`.
- **D53:** schedules follow the system's zone unless the config names a `timezone`.
- **D54:** it sleeps at most 60 s between looks at the wall clock.

Constraints: the scheduler stays small ("its functionality will be limited"), runs first on a Mac host under a LaunchAgent and later in Linux containers (Q28), and meets the repository's bar in Rust's tools (C24). It knows nothing of the agent: a job is a command.

## Goals / Non-Goals

**Goals:**
- Start each job's command at its cron schedule's fires, in the config's zone or the system's.
- Behave the same after a sleep, a suspend, a clock step or a restart on macOS and Linux: a missed fire runs once, and a backward step runs nothing twice.
- Keep each run's output, and the scheduler's own record of what it did, in the data directory.
- Bound every run with a timeout, and never start a job twice at once.
- Stay small: one binary of about 1 MB, about 2 MiB resident (R26.3), no async runtime.
- Meet the repository's bar: formatted, linted with warnings denied, tested, and every mutant caught.

**Non-Goals:**
- Knowing the agent: its store, task files, frontmatter or `.env` beyond starting in the folder that holds it.
- The store's migration race when runs start together (R25.5, S13), which a store change fixes.
- The Docker image and compose file (none exist yet), and installing a LaunchAgent or systemd unit from code: the README shows them.
- The operating system's exact wall-clock timers (D54, S15), a zone per job, overlap's `queue` (D16), retries, dependencies between jobs, alerts (Q1, Q30), and showing a run's slot to the model, which the agent would do (Q29).

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
│   ├── main.rs           the command line, the start, the lock and the loop
│   ├── config.rs         reading and checking the TOML config
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

`gremlin-scheduler --config <file> --data-dir <dir>`, both required, each given once. `--help` prints the usage and `--version` the version, each exiting 0. Any other argument, a missing value or a repeated option exits 1 with the usage on stderr. The arguments are parsed by hand; a parser crate isn't worth it for two options.

The start, in order, each failure exiting 1 with its reason on stderr: read and check the config (decision 3); check that the data directory exists and is a directory; take the lock (decision 10); open `scheduler.log`; record `ready` with the zone and each job's next fire; decide at once what fell due (decision 6); then enter the loop. Errors go to stderr until the log is open, and to the log after.

### 3. The config

```toml
timezone = "Europe/London"   # optional: the system's zone without it (D53)
working_dir = "/path/to/mecha-gremlin"
command = ["/path/to/bun", "packages/agent/src/main/main.ts"]
env = { LOG_FORMAT = "json" }
timeout = "1h"
stop_grace = "30s"
keep_runs = 50

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
| `name` | job | required | ASCII letters, digits, `-` and `_`, at least one, unique: it names the job's log folder |
| `schedule` | job | required | five cron fields or a nickname (decision 4) |
| `args` | job | none | added after the command |
| `catch_up` | job | `true` | whether a missed fire runs once (D52) |

- **Strict.** A file that is missing, can't be read or isn't valid TOML, an unknown key, a key in the wrong table, a wrong type, a missing, duplicate or unsafe name, a schedule that doesn't parse or never fires, an unknown zone, an empty `command`, a duration that doesn't parse or is zero, or a `keep_runs` below 1 fails the check, with the key and its line. serde's `deny_unknown_fields` and the toml crate's spans give both.
- **No jobs** is a valid config: the scheduler idles, and a reload to such a config pauses every job.
- **Durations** are a whole number and a unit, `s`, `m` or `h` (`90s`, `30m`, `2h`), parsed by hand.
- **Only `working_dir` is a path the scheduler resolves:** a relative one against the config file's folder, not the working directory, since launchd starts a job in `/` (R25.2). `command` and `args` reach the program as written, so the example's `packages/agent/src/main/main.ts` resolves against `working_dir`.
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

Each run has a deadline, its start plus `timeout`, and the wait counts down to the nearest deadline or pending SIGKILL. At the deadline the run's group gets SIGTERM, and `stop_grace` later SIGKILL if it is still there, recorded as `timed out`. A run keeps the `timeout` and `stop_grace` it started with, whatever a reload changes, so a run of a job a reload removed is still bounded.

The group kill goes through rustix, since the standard library can't signal a process group (R26.3). A run's group is kept as the `Pid` that `Pid::from_child` gives (rustix's `std` feature), taken before the waiter takes the `Child`, and no function returns it as an integer. cargo-mutants replaces an integer-returning body with 0, 1 and -1, and a group of 1 is `kill(-1)`: every process the scheduler may signal, the user's whole session in a test. As the agent's sweep refuses pid 1 and below, the scheduler sends nothing to a group below 2.

### 9. Signals

A thread holds signal-hook's iterator for SIGTERM, SIGINT and SIGHUP, and sends each to the loop.
- **SIGTERM or SIGINT:** record `stopping`, stop starting runs, send SIGTERM to every running group, wait up to `stop_grace` for them to exit, send SIGKILL to the rest, record `stopped` and exit 0. Signals that arrive meanwhile are ignored.
- **SIGHUP:** read and check the config again. A config that passes replaces the old one and records `config reloaded`: running runs go on to their end with their own deadlines, a removed job starts nothing more, a kept job keeps its last look, and a new job's last look is the time of the reload. One that fails records `config refused`, with its reason, and the old one stays.

What stops the scheduler must wait longer than `stop_grace`. launchd sends SIGKILL `ExitTimeOut` seconds after SIGTERM, 20 s by default in its last open-source release, and Docker sends it after its stop grace, 10 s by default (R25.4, R25.5). So the README's LaunchAgent sets `ExitTimeOut`, and its compose example `stop_grace_period`, above `stop_grace`. Under Docker the scheduler would be the main process. It handles SIGTERM itself, and compose's `init: true` reaps orphaned grandchildren.

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
| `error` | `error` | `job` and `reason` |
| `warn` | `clock stepped back` | `from` and `to` |
| `info` | `config reloaded` | `jobs`, as in `ready` |
| `warn` | `config refused` | `reason` |
| `info` | `stopping` | `signal` |
| `info` | `stopped` | none |

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

`.cargo/mutants.toml` sets a `minimum_test_timeout` well above the tests' longest bounded wait. cargo-mutants times a mutant's tests out at 5 times the baseline's, at least 20 s, and counts a timeout as a failure. As with Stryker now, only an equivalent or unreachable mutant may be turned off. Stable Rust has no line-level skip (R26.4), so one mutant is excluded by an `exclude_re` entry in `.cargo/mutants.toml` that matches it alone, with the reason in a comment above it. `#[mutants::skip]` turns off every mutant of a function, so it goes only where all of them are equivalent or unreachable, with the reason on the line above.

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
  - retention, log names, the records' JSON, and the refusal to signal a group below 2.
- **The loop** is tested in-process with an injected clock and a fake that stands in for starting runs: overlap, timeouts, the stop sequence and reload, with no real waiting.
- **The binary's tests** run it for real. A run starts at once, with no wait for a minute, when a test seeds a job's folder with a log whose start is older than the job's latest fire: the start's decision catches it up. They cover:
  - missing, unknown and repeated options, `--help` and `--version`;
  - a bad config and a missing data directory;
  - a held lock, and a start after SIGKILL;
  - a run's output, environment, `GREMLIN_` variables and records;
  - a timeout, and a run that ignores SIGTERM;
  - SIGTERM while idle and with a run going;
  - SIGHUP with a valid and a broken config.
- **Every wait in a test is bounded.** A test that waits for a record or an exit gives up after a deadline and kills the binary. A mutant that hangs the scheduler then fails a test rather than timing out.
- **Mutation testing** must catch every mutant. cargo-mutants makes fewer mutants than Stryker (R26.4), so the tests check literals and whole conditions by hand.

### 16. Where it runs first

On the Mac host, under a LaunchAgent (Q28): the agent runs there today (D18), and the repository has no Docker image yet. The README leads with the plist, loaded with `launchctl bootstrap gui/<uid>`:
- `ProgramArguments`: the built binary's absolute path, `--config` and `--data-dir`;
- `KeepAlive`, which implies `RunAtLoad`, so that launchd starts it at login and again whenever it exits;
- `WorkingDirectory`, the checkout, since launchd otherwise starts a job in `/` (R25.2);
- `EnvironmentVariables` with `PATH` and `LANG`, which launchd doesn't set and `.env` can't (R25.5);
- `ProcessType` set to `Interactive`: without it launchd throttles the job's CPU and I/O, and likely its runs' **[M]**, and `Standard` is the same as leaving it out (R25.2);
- `StandardErrorPath`, so that a start that fails, such as on a config error, says why: launchd sends stderr to `/dev/null` unless it is set, and `KeepAlive` starts the scheduler again, at most once every 10 s (R25.2);
- `ExitTimeOut` above `stop_grace` (decision 9).

A LaunchAgent runs while its user is logged in, since `gui/<uid>` exists only with a GUI login (R25.5). A process launchd starts likely can't reach `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive **[M]** (R25.2), so the README says to keep the checkout, the data directory and every file a task touches outside them, and S11 checks it on a spare Mac. `launchctl kill HUP` rereads the config, and `launchctl bootout` stops the scheduler for good. A systemd user service and a container get shorter notes; the container follows with the image (4.9).

## Risks / Trade-offs

- [A second toolchain, supply chain and pipeline (C24)] → One small crate with eight dependencies, cargo-deny, and a CI job that adds no time to `Check and test`.
- [cargo-mutants is a coarser gate than Stryker, and has no line-level skip (R26.4)] → Tests written against literals and whole conditions; single mutants excluded by `exclude_re`, each with its reason.
- [A mutant that signals a group of 1 would reach every process the user may signal] → The group kept as a `Pid`, never as an integer a function returns, and no signal to a group below 2 (decision 8).
- [A binary built on current Debian needs glibc 2.39 (R26.4)] → Built where it runs: with cargo on a Mac, and on the image's own Debian when the image exists.
- [On macOS, a process launchd starts, and likely its runs, can't reach `~/Documents`, `~/Desktop` or iCloud Drive (R25.2)] → The README says so, and S11 checks it on a spare Mac.
- [If the scheduler itself crashes on macOS, its runs go on: each is in a group of its own, which launchd's kill doesn't reach. The restarted scheduler doesn't know them, so no timeout bounds them, and a job's next fire can start beside one] → A small, tested crate, and `KeepAlive`; under systemd and Docker the runs end with the scheduler.
- [A SIGKILL after `stop_grace` leaves the agent's detached shell commands and MCP servers running (decision 7)] → `stop_grace` above the agent's own cleanup time.
- [launchd's and Docker's own stop timeouts are shorter than `stop_grace`] → The README's examples set `ExitTimeOut` and `stop_grace_period` above it.
- [Up to 60 s late after a wake, and later in Docker Desktop's VM until its clock is next stepped (R26.1)] → Accepted by D54; exact timers can follow (S15).
- [Runs started together on a fresh or migrating data folder fail (R25.5)] → Out of scope here; the README warns until the store's change lands (S13).
- [Schedules follow the system's zone without `timezone`, so a container runs in UTC unless `TZ` is set (D53)] → The README says so.
- [Where `/etc/localtime` is a plain file, jiff's 5-minute cache can delay a zone change, and lose a fire in those minutes] → Rare on macOS and in the official images, where it is a link or `TZ` is set.
- [`scheduler.log` grows without a limit] → A few lines a run; rotation can follow if it matters.
- [croner-rust is young, and fixed real bugs recently (R26.2)] → The newest release pinned in `Cargo.lock`, and DST and day-field tests.

## Migration Plan

Nothing to migrate: the package is new and nothing depends on it. A user builds it with `bun run --filter @mecha-gremlin/scheduler build`, writes a config, and starts it from a LaunchAgent, as the README shows first (decision 16), or from a systemd user service or a container. Removing it means stopping that service and deleting the package.

## Open Questions

- How should a failed run reach the user (Q30, Q1)?
- Would a mode that prints each job's next fires, without running anything, be worth adding?
- Should `scheduler.log` rotate?
