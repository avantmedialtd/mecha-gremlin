## Why

Nothing starts the agent on a schedule, though running unattended on a schedule is why the project exists (Brief, Part 1). D6 and D50–D54 settle the scheduler: a resident Rust process of its own, `packages/scheduler`, started with a TOML config of its jobs and a data directory for its own log and theirs (C23, C24). Its schedules live in that config alone (D51), so it reads no YAML and no store, and needs nothing from the TypeScript side but the command it runs.

## What Changes

- Add `packages/scheduler`, a Rust package whose binary, `gremlin-scheduler`, has four subcommands: `run --config <file> --data-dir <dir>`, the scheduler itself; `check --config <file>`, which checks a config and prints each job's next 5 fires without running anything; and `install` and `uninstall`, which set it up under launchd and remove it.
- **The config, in TOML.** At the top, defaults: an optional `timezone`, `working_dir`, `command`, `env`, `timeout`, `stop_grace`, `keep_runs` and `on_failure`. Then one `[[job]]` table per job: its `name`, its `schedule`, the `args` it adds to the command, and optional `command`, `working_dir`, `env`, `timeout`, `catch_up` and `on_failure` of its own. A file that isn't valid TOML, a key it doesn't know, a schedule that doesn't parse, an unknown zone or a duplicate name fails the start.
- **Schedules** are five cron fields, with `*`, lists, ranges, steps and three-letter names, or a nickname such as `@daily`, read in the config's `timezone`, or in the system's when it names none (D53). Where croner takes more, such as `L`, `W`, `#` or a seconds field, the scheduler refuses it, so that a schedule means what it means to cron.
- **Settled by this design:** it takes the Brief's recommendation for D12, croner-rust, the newest release, pinned in `Cargo.lock`, with DST and day-field tests.
- **Waiting.** The scheduler decides at once when it starts, then sleeps until the earliest next fire or pending signal to a run, never longer than 60 s, reads the wall clock and the zone, and starts each job that fell due since the last look (D54). A backward clock step runs nothing twice.
- **Missed fires.** A job whose fires passed while the machine slept or was off runs once, for the latest slot; `catch_up = false` makes it skip them. After a restart, the last start comes from the job's newest log (D52).
- **Runs.** Each run is the command plus the job's `args`, a child in its own process group, started in the working directory with the scheduler's environment and the config's `env`. It also gets `GREMLIN_JOB`, `GREMLIN_SLOT`, the fire it runs for, and `GREMLIN_CATCH_UP=1` when it catches up a missed one (Q29). A job's next fire while its run is still going is skipped and logged. A run past its `timeout` gets SIGTERM, to its whole group, and SIGKILL after `stop_grace`.
- **On failure.** A run that exits with a code other than 0, ends by a signal, passes its timeout or can't start starts the job's `on_failure` command, or the top level's, with the run's environment and `GREMLIN_RESULT`, `GREMLIN_STATUS` and `GREMLIN_LOG`, so that a script of the user's can send the news wherever it should go (Q30). The command gets 60 s, and its own failure is logged.
- **The data directory** holds `scheduler.log`, the scheduler's own records as JSON lines shaped like the agent's, which becomes `scheduler.log.1` at 10 MiB; a lock, so that one scheduler serves a data directory; and `jobs/<name>/<start>.log`, each run's output, mode 0600, keeping the newest `keep_runs`.
- **Signals.** SIGTERM and SIGINT stop new runs, pass SIGTERM to the running ones, wait up to `stop_grace`, and exit 0. SIGHUP rereads the config, and keeps the old one when the new one fails its checks.
- **Setup under launchd.** `gremlin-scheduler install --config <file> --data-dir <dir>` checks the config and writes `~/Library/LaunchAgents/local.gremlin-scheduler.plist`, which runs this binary's `run` with `KeepAlive`, `ProcessType` `Interactive`, the shell's `PATH` and `LANG`, a `stderr.log` in the data directory and an `ExitTimeOut` above `stop_grace`. It loads the plist with `launchctl bootstrap` and waits for the scheduler's `ready` record. `uninstall` boots the agent out and deletes the plist (D55). Their `launchctl` calls go through a runner that tests fake, so that no test touches the machine's launchd.
- **The quality bar, in Rust's tools:** rustfmt, clippy with warnings denied, `cargo test`, and cargo-mutants, run under the repository's memory guard, which fails on any mutant that survives or times out. A `package.json` makes the package `@mecha-gremlin/scheduler`, whose scripts run cargo: `bun run check` runs its checks, and `bun run mutation:scheduler` its mutation testing. A CI job of its own runs the checks on Linux and macOS, and cargo-mutants and an advisory check on Linux.
- Pin the toolchain in `rust-toolchain.toml`; keep `target/` and cargo-mutants' `mutants.out` out of git and out of Stryker's sandbox; and document the scheduler in the README: its config and data directory, and setting it up on a Mac, where it runs first (Q28), with `cargo install` and `gremlin-scheduler install`, with shorter notes for a systemd user service and a container.

## Capabilities

### New Capabilities

- `scheduler`: the Rust scheduler's command line, config, schedules and zone, wait loop, catch-up, overlap, runs and their timeouts, the command a failed run starts, its own log and the runs' logs and their retention, the lock, its signals, and its setup under launchd.

### Modified Capabilities

- `dev-checks`: `bun run check` and CI also run the scheduler's format check, lint and tests, on Linux and macOS; `bun run mutation:scheduler` and CI run its mutation testing, which fails on any mutant that survives or times out; no test touches the machine's launchd; and CI checks its dependencies for advisories.

## Impact

- A new package, `packages/scheduler`: the repository's first Rust code. D50 makes Rust its language, against the settled "TypeScript on Bun", for this package alone; the agent is unchanged.
- Dependencies from crates.io: croner for schedules, jiff for zones, toml and serde for the config, serde_json for the log, signal-hook for signals, rustix for process groups, and `mutants` for its skip attribute. No async runtime, SQLite or YAML.
- Developers and CI need rustup, and cargo-mutants for mutation testing; the pinned toolchain installs itself. A binary built on current Debian needs glibc 2.39 or later (R26.4).
- The repository root: `package.json`'s `check` and `mutation:scheduler` scripts, `bun.lock`, `.gitignore`, `cspell.json`, `stryker.config.mjs`, the README, the CI workflow and the Brief.
- Not in scope: the migration race when runs start together on a fresh or migrating data folder (R25.5, S13), a change to the store of its own; the Docker image and compose file, which don't exist yet, since the scheduler runs on a Mac host first (Q28); installing a systemd unit from code; the operating system's exact wall-clock timers (D54, S15); showing a run's slot to the model, a change to the agent (Q29); the agent's own alerts, and where its results go (Q1); a zone per job; overlap's `queue` (D16); retries; and dependencies between jobs.
