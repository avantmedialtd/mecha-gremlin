mod config;
mod events;
mod install;
mod log;
mod runs;
mod schedule;

use std::collections::BTreeMap;
use std::env;
use std::fs::{File, TryLockError};
use std::io;
use std::path::{self, Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use jiff::{Timestamp, Zoned};
use rustix::process::{Pid, Signal};
use serde_json::{Value, json};
use signal_hook::consts::SIGHUP;

use crate::config::{Config, Job};
use crate::events::Event;
use crate::install::{Answer, Host};
use crate::log::{Level, Log, time};
use crate::runs::{Children, Ended, Launch, Outcome, Starter};
use crate::schedule::{Due, Schedule, Zone};

const USAGE: &str = "Usage:
  gremlin-scheduler run --config <file> --data-dir <dir>
  gremlin-scheduler check --config <file>
  gremlin-scheduler install --config <file> --data-dir <dir>
  gremlin-scheduler uninstall
  gremlin-scheduler --help
  gremlin-scheduler --version
";

pub const LOCALTIME: &str = "/etc/localtime";

// A notification takes seconds, and a hung one mustn't linger.
const ON_FAILURE_LIMIT: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq)]
enum Invocation {
    Run { config: PathBuf, data_dir: PathBuf },
    Check { config: PathBuf },
    Install { config: PathBuf, data_dir: PathBuf },
    Uninstall,
    Help,
    Version,
}

fn options<'a>(
    arguments: &'a [String],
    takes: &[&'static str],
) -> Result<BTreeMap<&'static str, &'a str>, String> {
    let mut found = BTreeMap::new();
    let mut remaining = arguments.iter();

    while let Some(argument) = remaining.next() {
        let Some(name) = takes.iter().find(|name| **name == argument) else {
            return Err(format!("`{argument}` isn't an option it takes"));
        };

        let Some(value) = remaining.next().filter(|value| !value.starts_with('-')) else {
            return Err(format!("{name} needs a value"));
        };

        if found.insert(*name, value.as_str()).is_some() {
            return Err(format!("{name} is given twice"));
        }
    }

    for name in takes {
        if !found.contains_key(name) {
            return Err(format!("{name} is missing"));
        }
    }

    Ok(found)
}

fn parse(arguments: &[String]) -> Result<Invocation, String> {
    let Some((first, rest)) = arguments.split_first() else {
        return Err("no subcommand is given".to_string());
    };

    let takes: &[&'static str] = match first.as_str() {
        "--help" if rest.is_empty() => return Ok(Invocation::Help),
        "--version" if rest.is_empty() => return Ok(Invocation::Version),
        "run" | "install" => &["--config", "--data-dir"],
        "check" => &["--config"],
        "uninstall" => &[],
        other => return Err(format!("`{other}` isn't a subcommand")),
    };

    let found = options(rest, takes)?;
    let path = |name: &str| PathBuf::from(found.get(name).copied().unwrap_or_default());

    match first.as_str() {
        "run" => Ok(Invocation::Run {
            config: path("--config"),
            data_dir: path("--data-dir"),
        }),
        "install" => Ok(Invocation::Install {
            config: path("--config"),
            data_dir: path("--data-dir"),
        }),
        "check" => Ok(Invocation::Check {
            config: path("--config"),
        }),
        _ => Ok(Invocation::Uninstall),
    }
}

pub enum LockError {
    Held,
    Failed(String),
}

// The kernel drops the lock when the process dies, however it dies, so a crash leaves nothing to
// clean up.
pub fn lock(data_dir: &Path) -> Result<File, LockError> {
    let path = data_dir.join("lock");
    let file = log::open_private(&path)
        .map_err(|error| LockError::Failed(format!("couldn't open {}: {error}", path.display())))?;

    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(LockError::Held),
        Err(TryLockError::Error(error)) => Err(LockError::Failed(format!(
            "couldn't lock {}: {error}",
            path.display()
        ))),
    }
}

pub struct ZoneSource {
    tz: Option<String>,
    localtime: PathBuf,
}

fn zone_of(config: &Config, source: &ZoneSource) -> Zone {
    config
        .zone
        .clone()
        .unwrap_or_else(|| schedule::system_zone(source.tz.as_deref(), &source.localtime))
}

// A run that starts late is named for when it started, so a restart doesn't run it again. Without a
// log, a cron job doesn't run its past, and a day interval counts every slot since its start as
// unseen, so its latest that has passed runs once (D59).
fn first_look(data_dir: &Path, job: &Job, now: Timestamp) -> Timestamp {
    if let Some(start) = runs::newest_start(&data_dir.join("jobs").join(&job.name)) {
        return start;
    }

    if matches!(job.schedule, Schedule::Days(_)) {
        return Timestamp::MIN;
    }

    now
}

fn tenths(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 10.0).round() / 10.0
}

fn command_failure(outcome: Outcome, ended: Ended) -> String {
    match outcome {
        Outcome::Timeout => format!(
            "on_failure ran past its 60 s and was stopped; it ended with {}",
            ended.status()
        ),
        Outcome::ExitCode => format!("on_failure exited with code {}", ended.status()),
        Outcome::Signal | Outcome::Error => format!("on_failure ended by {}", ended.status()),
    }
}

// A run past its deadline, or an on_failure command past its 60 s, has its own SIGKILL due
// stop_grace after its SIGTERM, which the stop mustn't delay.
fn first_kill(pending: Option<(Duration, Signal)>, stop_at: Duration) -> Duration {
    let Some((at, signal)) = pending else {
        return stop_at;
    };

    if signal != Signal::KILL {
        return stop_at;
    }

    at.min(stop_at)
}

enum Kind {
    Run {
        on_failure: Option<Vec<String>>,
        launch: Launch,
    },
    Command,
}

struct Tracked {
    id: u64,
    job: String,
    group: Pid,
    log: PathBuf,
    started: Duration,
    grace: Duration,
    next_signal: Option<(Duration, Signal)>,
    timed_out: bool,
    kind: Kind,
}

struct Failed<'a> {
    job: &'a str,
    command: &'a [String],
    run: &'a Launch,
    outcome: Outcome,
    status: String,
    log: &'a Path,
    grace: Duration,
}

pub struct Scheduler<S: Starter> {
    config: Config,
    data_dir: PathBuf,
    // Parallel to config.jobs. A last look never moves back, so a backward clock step runs
    // nothing twice.
    looks: Vec<Timestamp>,
    tracked: Vec<Tracked>,
    ids: u64,
    previous_wake: Timestamp,
    zone: Zone,
    stop_at: Option<Duration>,
    log: Log,
    starter: S,
    source: ZoneSource,
}

impl<S: Starter> Scheduler<S> {
    fn new(
        config: Config,
        data_dir: PathBuf,
        log: Log,
        starter: S,
        source: ZoneSource,
        now: Timestamp,
    ) -> Scheduler<S> {
        let looks = config
            .jobs
            .iter()
            .map(|job| first_look(&data_dir, job, now))
            .collect();
        let zone = zone_of(&config, &source);

        Scheduler {
            config,
            data_dir,
            looks,
            tracked: Vec::new(),
            ids: 0,
            previous_wake: now,
            zone,
            stop_at: None,
            log,
            starter,
            source,
        }
    }

    fn record(&mut self, now: Timestamp, level: Level, message: &str, fields: &[(&str, Value)]) {
        self.log.record(now, level, message, fields);
    }

    fn jobs_field(&self, now: Timestamp) -> Value {
        let from = now.to_zoned(self.zone.tz.clone());

        self.config
            .jobs
            .iter()
            .map(|job| {
                json!({
                    "name": job.name,
                    "next": job.schedule.next_after(&from).map(|next| time(next.timestamp())),
                })
            })
            .collect()
    }

    fn ready(&mut self, now: Timestamp) {
        let fields = [
            ("zone", json!(self.zone.name)),
            ("jobs", self.jobs_field(now)),
        ];
        self.record(now, Level::Info, "ready", &fields);
    }

    fn next_id(&mut self) -> u64 {
        self.ids += 1;

        self.ids
    }

    fn running(&self, job: &str) -> bool {
        self.tracked
            .iter()
            .any(|process| process.job == job && matches!(process.kind, Kind::Run { .. }))
    }

    fn logs_in_use(&self) -> Vec<PathBuf> {
        self.tracked
            .iter()
            .map(|process| process.log.clone())
            .collect()
    }

    fn start_on_failure(&mut self, failed: Failed, now: Timestamp, mono: Duration) {
        let mut env = failed.run.env.clone();
        env.push((
            "GREMLIN_RESULT".to_string(),
            Some(failed.outcome.name().to_string()),
        ));
        env.push(("GREMLIN_STATUS".to_string(), Some(failed.status)));
        env.push((
            "GREMLIN_LOG".to_string(),
            Some(failed.log.display().to_string()),
        ));
        let launch = Launch {
            argv: failed.command.to_vec(),
            working_dir: failed.run.working_dir.clone(),
            env,
        };
        let id = self.next_id();
        let started = log::open_private(failed.log)
            .map_err(|error| format!("couldn't open {}: {error}", failed.log.display()))
            .and_then(|file| self.starter.start(id, &launch, file));

        match started {
            Ok(group) => self.tracked.push(Tracked {
                id,
                job: failed.job.to_string(),
                group,
                log: failed.log.to_path_buf(),
                started: mono,
                grace: failed.grace,
                next_signal: Some((mono.saturating_add(ON_FAILURE_LIMIT), Signal::TERM)),
                timed_out: false,
                kind: Kind::Command,
            }),
            Err(reason) => {
                let fields = [
                    ("job", json!(failed.job)),
                    (
                        "reason",
                        json!(format!("on_failure couldn't start: {reason}")),
                    ),
                ];
                self.record(now, Level::Error, "error", &fields);
            }
        }
    }

    fn start_run(
        &mut self,
        job: &Job,
        slot: &Zoned,
        catching_up: bool,
        now: Timestamp,
        mono: Duration,
    ) {
        let dir = self.data_dir.join("jobs").join(&job.name);
        let name = runs::log_name(now);
        let path = dir.join(&name);
        let mut env: Vec<(String, Option<String>)> = job
            .env
            .iter()
            .map(|(key, value)| (key.clone(), Some(value.clone())))
            .collect();
        env.push(("GREMLIN_JOB".to_string(), Some(job.name.clone())));
        env.push((
            "GREMLIN_SLOT".to_string(),
            Some(schedule::with_offset(slot)),
        ));
        env.push((
            "GREMLIN_CATCH_UP".to_string(),
            catching_up.then(|| "1".to_string()),
        ));
        let launch = Launch {
            argv: job.argv.clone(),
            working_dir: job.working_dir.clone(),
            env,
        };
        let id = self.next_id();
        let started = runs::open_log(&dir, &name)
            .map_err(|error| format!("couldn't open {}: {error}", path.display()))
            .and_then(|log| self.starter.start(id, &launch, log));

        match started {
            Ok(group) => {
                let fields = [
                    ("job", json!(job.name)),
                    ("slot", json!(time(slot.timestamp()))),
                    ("pid", json!(group.as_raw_pid())),
                    ("log", json!(format!("jobs/{}/{name}", job.name))),
                ];
                self.record(now, Level::Info, "started", &fields);
                self.tracked.push(Tracked {
                    id,
                    job: job.name.clone(),
                    group,
                    log: path,
                    started: mono,
                    grace: self.config.stop_grace,
                    next_signal: Some((mono.saturating_add(job.timeout), Signal::TERM)),
                    timed_out: false,
                    kind: Kind::Run {
                        on_failure: job.on_failure.clone(),
                        launch,
                    },
                });
            }
            Err(reason) => {
                let fields = [("job", json!(job.name)), ("reason", json!(reason))];
                self.record(now, Level::Error, "error", &fields);

                if let Some(command) = &job.on_failure {
                    let failed = Failed {
                        job: &job.name,
                        command,
                        run: &launch,
                        outcome: Outcome::Error,
                        status: reason,
                        log: &path,
                        grace: self.config.stop_grace,
                    };
                    self.start_on_failure(failed, now, mono);
                }
            }
        }

        runs::prune(&dir, self.config.keep_runs, &self.logs_in_use());
    }

    fn decide(&mut self, now: Timestamp, mono: Duration) {
        if self.stop_at.is_some() {
            return;
        }

        self.zone = zone_of(&self.config, &self.source);

        if now < self.previous_wake {
            let fields = [
                ("from", json!(time(self.previous_wake))),
                ("to", json!(time(now))),
            ];
            self.record(now, Level::Warn, "clock stepped back", &fields);
        }

        let decisions: Vec<(Job, Due)> = self
            .config
            .jobs
            .iter()
            .zip(&self.looks)
            .filter_map(|(job, look)| {
                let running = self.running(&job.name);
                let due = schedule::due(
                    &job.schedule,
                    &self.zone.tz,
                    *look,
                    now,
                    running,
                    job.catch_up,
                )?;

                Some((job.clone(), due))
            })
            .collect();

        for (job, due) in decisions {
            match due {
                Due::Start { slot, catching_up } => {
                    self.start_run(&job, &slot, catching_up, now, mono)
                }
                Due::Skip { slot, reason } => {
                    let fields = [
                        ("job", json!(job.name)),
                        ("slot", json!(time(slot.timestamp()))),
                        ("reason", json!(reason.name())),
                    ];
                    self.record(now, Level::Info, "skipped", &fields);
                }
            }
        }

        for look in &mut self.looks {
            *look = (*look).max(now);
        }

        self.previous_wake = now;
    }

    fn exited(&mut self, id: u64, ended: Ended, now: Timestamp, mono: Duration) {
        let Some(index) = self.tracked.iter().position(|process| process.id == id) else {
            return;
        };

        let process = self.tracked.remove(index);
        let outcome = runs::outcome(process.timed_out, ended);

        let Kind::Run { on_failure, launch } = process.kind else {
            if let Some(outcome) = outcome {
                let fields = [
                    ("job", json!(process.job)),
                    ("reason", json!(command_failure(outcome, ended))),
                ];
                self.record(now, Level::Error, "error", &fields);
            }

            return;
        };

        let ending = match ended {
            Ended::Code(code) => ("code", json!(code)),
            Ended::Signal(signal) => ("signal", json!(runs::signal_name(signal))),
        };

        let fields = [
            ("job", json!(process.job)),
            ending,
            (
                "seconds",
                json!(tenths(mono.saturating_sub(process.started))),
            ),
        ];
        self.record(now, Level::Info, "exited", &fields);

        // A run that ends while the scheduler stops was stopped by it.
        if self.stop_at.is_some() {
            return;
        }

        let (Some(outcome), Some(command)) = (outcome, on_failure) else {
            return;
        };

        let failed = Failed {
            job: &process.job,
            command: &command,
            run: &launch,
            outcome,
            status: ended.status(),
            log: &process.log,
            grace: process.grace,
        };
        self.start_on_failure(failed, now, mono);
    }

    fn signal_due(&mut self, now: Timestamp, mono: Duration) {
        let mut timed_out = Vec::new();

        for process in &mut self.tracked {
            let Some((at, signal)) = process.next_signal else {
                continue;
            };

            if mono < at {
                continue;
            }

            runs::send(&mut self.starter, process.group, signal);

            if signal == Signal::KILL {
                process.next_signal = None;
                continue;
            }

            process.next_signal = Some((mono.saturating_add(process.grace), Signal::KILL));
            process.timed_out = true;

            if matches!(process.kind, Kind::Run { .. }) {
                timed_out.push((process.job.clone(), process.group));
            }
        }

        for (job, group) in timed_out {
            let fields = [("job", json!(job)), ("pid", json!(group.as_raw_pid()))];
            self.record(now, Level::Warn, "timed out", &fields);
        }
    }

    fn reload(&mut self, now: Timestamp) {
        let config = match config::load(&self.config.path, now) {
            Ok(config) => config,
            Err(reason) => {
                self.record(
                    now,
                    Level::Warn,
                    "config refused",
                    &[("reason", json!(reason))],
                );
                return;
            }
        };

        self.looks = config
            .jobs
            .iter()
            .map(|job| {
                let kept = self.config.jobs.iter().position(|old| old.name == job.name);

                if let Some(index) = kept {
                    return self.looks[index];
                }

                // A new job with a log starts from the reload: only a day interval that has never
                // run looks back (D59).
                if runs::newest_start(&self.data_dir.join("jobs").join(&job.name)).is_some() {
                    return now;
                }

                first_look(&self.data_dir, job, now)
            })
            .collect();
        self.config = config;
        self.zone = zone_of(&self.config, &self.source);
        let fields = [("jobs", self.jobs_field(now))];
        self.record(now, Level::Info, "config reloaded", &fields);
    }

    fn stop(&mut self, signal: i32, now: Timestamp, mono: Duration) {
        self.record(
            now,
            Level::Info,
            "stopping",
            &[("signal", json!(runs::signal_name(signal)))],
        );

        let stop_at = mono.saturating_add(self.config.stop_grace);
        self.stop_at = Some(stop_at);

        for process in &mut self.tracked {
            runs::send(&mut self.starter, process.group, Signal::TERM);
            process.next_signal = Some((first_kill(process.next_signal, stop_at), Signal::KILL));
        }
    }

    fn handle(&mut self, event: Event, now: Timestamp, mono: Duration) {
        match event {
            Event::Exited { id, ended } => self.exited(id, ended, now, mono),
            // A stop ignores every signal that comes after it.
            Event::Signal(_) if self.stop_at.is_some() => {}
            Event::Signal(SIGHUP) => self.reload(now),
            Event::Signal(signal) => self.stop(signal, now, mono),
        }
    }

    fn next_fire(&self) -> Option<Timestamp> {
        if self.stop_at.is_some() {
            return None;
        }

        self.config
            .jobs
            .iter()
            .zip(&self.looks)
            .filter_map(|(job, look)| {
                job.schedule
                    .next_after(&look.to_zoned(self.zone.tz.clone()))
            })
            .map(|next| next.timestamp())
            .min()
    }

    fn wait(&self, now: Timestamp, mono: Duration) -> Duration {
        let signal = self
            .tracked
            .iter()
            .filter_map(|process| process.next_signal.map(|(at, _)| at))
            .min();

        events::wait_time(now, self.next_fire(), mono, signal)
    }

    fn finished(&self, mono: Duration) -> bool {
        let Some(stop_at) = self.stop_at else {
            return false;
        };

        self.tracked.is_empty() || mono >= stop_at
    }

    fn stopped(&mut self, now: Timestamp) {
        self.record(now, Level::Info, "stopped", &[]);
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("gremlin-scheduler: {message}");
    ExitCode::FAILURE
}

fn finish(result: Result<(), String>) -> ExitCode {
    let Err(message) = result else {
        return ExitCode::SUCCESS;
    };

    fail(&message)
}

fn check_text(config: &Config, zone: &Zone, now: Timestamp) -> String {
    let from = now.to_zoned(zone.tz.clone());
    let mut text = format!("Zone: {}\n", zone.name);

    for job in &config.jobs {
        text.push_str(&format!("\n{}\n", job.name));

        for fire in job.schedule.fires(&from, 5) {
            text.push_str(&format!("  {}\n", schedule::with_offset(&fire)));
        }
    }

    text
}

fn system_source() -> ZoneSource {
    ZoneSource {
        tz: env::var("TZ").ok(),
        localtime: PathBuf::from(LOCALTIME),
    }
}

fn check(config_path: &Path) -> Result<(), String> {
    let now = Timestamp::now();
    let config = config::load(config_path, now)?;
    print!(
        "{}",
        check_text(&config, &zone_of(&config, &system_source()), now)
    );

    Ok(())
}

fn data_directory(dir: &Path) -> Result<PathBuf, String> {
    let dir = path::absolute(dir).map_err(|error| format!("{}: {error}", dir.display()))?;

    if !dir.is_dir() {
        return Err(format!(
            "the data directory {} doesn't exist or isn't a directory",
            dir.display()
        ));
    }

    Ok(dir)
}

fn serve(mut scheduler: Scheduler<Children>, events: &Receiver<Event>) -> ExitCode {
    let start = Instant::now();
    // Decided before the first wait, so that a fire missed while the scheduler was stopped runs
    // at once.
    scheduler.decide(Timestamp::now(), start.elapsed());

    loop {
        let wait = scheduler.wait(Timestamp::now(), start.elapsed());

        if let Ok(event) = events.recv_timeout(wait) {
            scheduler.handle(event, Timestamp::now(), start.elapsed());
        }

        // Fires count on the wall clock, read at every wake, and deadlines on the monotonic one,
        // which a clock step doesn't move.
        let (now, mono) = (Timestamp::now(), start.elapsed());
        scheduler.decide(now, mono);
        scheduler.signal_due(now, mono);

        if scheduler.finished(mono) {
            scheduler.stopped(now);
            return ExitCode::SUCCESS;
        }
    }
}

fn run(config_path: &Path, data_dir: &Path) -> Result<ExitCode, String> {
    let config = config::load(config_path, Timestamp::now())?;
    let data_dir = data_directory(data_dir)?;
    // Held for the process's life.
    let _lock = lock(&data_dir).map_err(|error| match error {
        LockError::Held => format!("another scheduler is using {}", data_dir.display()),
        LockError::Failed(message) => message,
    })?;
    let log = Log::open(&data_dir, log::ROTATE_AT).map_err(|error| {
        format!(
            "couldn't open {}: {error}",
            data_dir.join("scheduler.log").display()
        )
    })?;
    let (sender, events) = mpsc::channel();
    events::watch_signals(sender.clone())?;
    let now = Timestamp::now();
    let mut scheduler = Scheduler::new(
        config,
        data_dir,
        log,
        Children::new(sender),
        system_source(),
        now,
    );
    scheduler.ready(now);

    Ok(serve(scheduler, &events))
}

// A test that called this would load a LaunchAgent into the launchd of the machine running it, so
// none does; S11 checks it on a spare Mac.
#[mutants::skip]
fn install_here(config: &Path, data_dir: &Path) -> ExitCode {
    let mut launchctl = |arguments: &[&str]| {
        Command::new("/bin/launchctl")
            .args(arguments)
            .output()
            .map(|output| Answer {
                code: output.status.code().unwrap_or(-1),
                output: format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ),
            })
            .map_err(|error| format!("couldn't run /bin/launchctl: {error}"))
    };

    let home = PathBuf::from(env::var_os("HOME").unwrap_or_default());

    let exe = match env::current_exe() {
        Ok(exe) => exe,
        Err(error) => return fail(&format!("couldn't find this binary's path: {error}")),
    };

    let (path, lang, lc_all) = (
        env::var("PATH").ok(),
        env::var("LANG").ok(),
        env::var("LC_ALL").ok(),
    );
    let host = Host {
        system: env::consts::OS,
        home: &home,
        uid: rustix::process::getuid().as_raw(),
        exe: &exe,
        path: path.as_deref(),
        lang: lang.as_deref(),
        lc_all: lc_all.as_deref(),
        waits: install::WAITS,
    };

    finish(install::install(
        &host,
        config,
        data_dir,
        &mut launchctl,
        &mut io::stdout(),
    ))
}

// A test that called this would remove a LaunchAgent from the launchd of the machine running it,
// so none does; S11 checks it on a spare Mac.
#[mutants::skip]
fn uninstall_here() -> ExitCode {
    let mut launchctl = |arguments: &[&str]| {
        Command::new("/bin/launchctl")
            .args(arguments)
            .output()
            .map(|output| Answer {
                code: output.status.code().unwrap_or(-1),
                output: format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ),
            })
            .map_err(|error| format!("couldn't run /bin/launchctl: {error}"))
    };

    let home = PathBuf::from(env::var_os("HOME").unwrap_or_default());
    let host = Host {
        system: env::consts::OS,
        home: &home,
        uid: rustix::process::getuid().as_raw(),
        exe: Path::new(""),
        path: None,
        lang: None,
        lc_all: None,
        waits: install::WAITS,
    };

    finish(install::uninstall(&host, &mut launchctl, &mut io::stdout()))
}

fn main() -> ExitCode {
    let arguments: Vec<String> = env::args_os()
        .skip(1)
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();

    match parse(&arguments) {
        Err(reason) => {
            eprint!("gremlin-scheduler: {reason}\n\n{USAGE}");
            ExitCode::FAILURE
        }
        Ok(Invocation::Help) => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Invocation::Version) => {
            println!("gremlin-scheduler {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Ok(Invocation::Check { config }) => finish(check(&config)),
        Ok(Invocation::Run { config, data_dir }) => {
            run(&config, &data_dir).unwrap_or_else(|message| fail(&message))
        }
        Ok(Invocation::Install { config, data_dir }) => install_here(&config, &data_dir),
        Ok(Invocation::Uninstall) => uninstall_here(),
    }
}

#[cfg(test)]
mod testing {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::{env, fs, process};

    static COUNT: AtomicU64 = AtomicU64::new(0);

    pub struct Scratch {
        path: PathBuf,
    }

    impl Scratch {
        pub fn new() -> Scratch {
            let count = COUNT.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!("gremlin-scheduler-{}-{count}", process::id()));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();

            Scratch { path }
        }

        pub fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::testing::Scratch;

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    fn secs(seconds: f64) -> Duration {
        Duration::from_secs_f64(seconds)
    }

    fn strings(arguments: &[&str]) -> Vec<String> {
        arguments
            .iter()
            .map(|argument| argument.to_string())
            .collect()
    }

    #[derive(Debug, Clone)]
    struct Start {
        launch: Launch,
    }

    #[derive(Default)]
    struct Fake {
        starts: Vec<Start>,
        signals: Vec<(i32, Signal)>,
        refuse: Option<String>,
        pid: Option<i32>,
    }

    impl Starter for Fake {
        fn start(&mut self, id: u64, launch: &Launch, log: File) -> Result<Pid, String> {
            drop(log);

            if self.refuse.as_deref() == launch.argv.first().map(String::as_str) {
                return Err(format!(
                    "couldn't start {}: No such file or directory",
                    launch.argv[0]
                ));
            }

            let pid = self.pid.unwrap_or(100 + i32::try_from(id).unwrap());
            self.starts.push(Start {
                launch: launch.clone(),
            });

            Ok(Pid::from_raw(pid).unwrap())
        }

        fn signal(&mut self, group: Pid, signal: Signal) {
            self.signals.push((group.as_raw_pid(), signal));
        }
    }

    struct Bench {
        scratch: Scratch,
        scheduler: Scheduler<Fake>,
    }

    impl Bench {
        fn new(config: &str, now: &str) -> Bench {
            Bench::seeded(config, now, &[])
        }

        fn seeded(config: &str, now: &str, logs: &[(&str, &str)]) -> Bench {
            let scratch = Scratch::new();
            let path = scratch.path().join("scheduler.toml");
            let data = scratch.path().join("data");
            fs::write(&path, config).unwrap();
            fs::create_dir(&data).unwrap();

            for (job, name) in logs {
                let dir = data.join("jobs").join(job);
                fs::create_dir_all(&dir).unwrap();
                fs::write(dir.join(name), "").unwrap();
            }

            let config = config::load(&path, at(now)).unwrap();
            let log = Log::open(&data, log::ROTATE_AT).unwrap();
            let source = ZoneSource {
                tz: None,
                localtime: scratch.path().join("localtime"),
            };
            let scheduler = Scheduler::new(config, data, log, Fake::default(), source, at(now));

            Bench { scratch, scheduler }
        }

        fn records(&self) -> Vec<Value> {
            let text = fs::read_to_string(self.data().join("scheduler.log")).unwrap_or_default();

            text.lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }

        fn messages(&self) -> Vec<String> {
            self.records()
                .iter()
                .map(|record| record["message"].as_str().unwrap().to_string())
                .collect()
        }

        fn last(&self, message: &str) -> Value {
            self.records()
                .into_iter()
                .rev()
                .find(|record| record["message"] == message)
                .unwrap_or_else(|| panic!("no {message} record in {:?}", self.messages()))
        }

        fn data(&self) -> PathBuf {
            self.scratch.path().join("data")
        }

        fn rewrite(&self, config: &str) {
            fs::write(self.scratch.path().join("scheduler.toml"), config).unwrap();
        }

        fn decide(&mut self, now: &str, mono: f64) {
            self.scheduler.decide(at(now), secs(mono));
            self.scheduler.signal_due(at(now), secs(mono));
        }

        fn exit(&mut self, id: u64, ended: Ended, now: &str, mono: f64) {
            self.scheduler
                .handle(Event::Exited { id, ended }, at(now), secs(mono));
        }

        fn signal(&mut self, signal: Signal, now: &str, mono: f64) {
            self.scheduler
                .handle(Event::Signal(signal.as_raw()), at(now), secs(mono));
        }

        fn starts(&self) -> &[Start] {
            &self.scheduler.starter.starts
        }

        fn env(&self, index: usize) -> Vec<(String, Option<String>)> {
            self.starts()[index].launch.env.clone()
        }
    }

    fn value_of(env: &[(String, Option<String>)], key: &str) -> Option<String> {
        env.iter()
            .rev()
            .find(|(name, _)| name == key)
            .and_then(|(_, value)| value.clone())
    }

    const MINUTELY: &str = "timezone = \"UTC\"\nstop_grace = \"5s\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"minutely\"\nschedule = \"* * * * *\"\ntimeout = \"10m\"\n";

    const NO_JOBS: &str = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\n";

    const WEEKLY: &str = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"weekly\"\nstart = 2026-11-01T07:00\nevery = \"7d\"\n";

    #[test]
    fn arguments_take_each_subcommands_options() {
        assert_eq!(
            parse(&strings(&[
                "run",
                "--config",
                "c.toml",
                "--data-dir",
                "data"
            ])),
            Ok(Invocation::Run {
                config: PathBuf::from("c.toml"),
                data_dir: PathBuf::from("data"),
            })
        );
        assert_eq!(
            parse(&strings(&[
                "install",
                "--data-dir",
                "data",
                "--config",
                "c.toml"
            ])),
            Ok(Invocation::Install {
                config: PathBuf::from("c.toml"),
                data_dir: PathBuf::from("data"),
            })
        );
        assert_eq!(
            parse(&strings(&["check", "--config", "c.toml"])),
            Ok(Invocation::Check {
                config: PathBuf::from("c.toml")
            })
        );
        assert_eq!(parse(&strings(&["uninstall"])), Ok(Invocation::Uninstall));
        assert_eq!(parse(&strings(&["--help"])), Ok(Invocation::Help));
        assert_eq!(parse(&strings(&["--version"])), Ok(Invocation::Version));
    }

    #[test]
    fn anything_else_is_refused() {
        let refusal = |arguments: &[&str]| parse(&strings(arguments)).unwrap_err();

        assert_eq!(refusal(&[]), "no subcommand is given");
        assert_eq!(refusal(&["start"]), "`start` isn't a subcommand");
        assert_eq!(
            refusal(&["--config", "c", "--data-dir", "d"]),
            "`--config` isn't a subcommand"
        );
        assert_eq!(refusal(&["run", "--config", "c"]), "--data-dir is missing");
        assert_eq!(refusal(&["run", "--data-dir", "d"]), "--config is missing");
        assert_eq!(
            refusal(&["run", "--config", "c", "--data-dir", "d", "--verbose"]),
            "`--verbose` isn't an option it takes"
        );
        assert_eq!(
            refusal(&["run", "--config", "a", "--config", "b", "--data-dir", "d"]),
            "--config is given twice"
        );
        assert_eq!(refusal(&["run", "--config"]), "--config needs a value");
        assert_eq!(
            refusal(&["run", "--config", "--data-dir", "d"]),
            "--config needs a value"
        );
        assert_eq!(
            refusal(&["check", "--config", "c", "--data-dir", "d"]),
            "`--data-dir` isn't an option it takes"
        );
        assert_eq!(
            refusal(&["uninstall", "--config", "c"]),
            "`--config` isn't an option it takes"
        );
        assert_eq!(
            refusal(&["run", "stray"]),
            "`stray` isn't an option it takes"
        );
        assert_eq!(refusal(&["--help", "run"]), "`--help` isn't a subcommand");
        assert_eq!(
            refusal(&["--version", "x"]),
            "`--version` isn't a subcommand"
        );
        assert_eq!(
            refusal(&["run", "--help"]),
            "`--help` isn't an option it takes"
        );
    }

    #[test]
    fn a_held_lock_is_refused() {
        let scratch = Scratch::new();

        let Ok(_held) = lock(scratch.path()) else {
            panic!("the first lock failed");
        };

        let second = lock(scratch.path());

        assert!(matches!(second, Err(LockError::Held)));
        assert!(matches!(
            lock(&scratch.path().join("missing")),
            Err(LockError::Failed(_))
        ));
    }

    #[test]
    fn the_data_directory_must_exist() {
        let scratch = Scratch::new();
        let file = scratch.path().join("file");
        fs::write(&file, "").unwrap();

        let missing = data_directory(&scratch.path().join("missing")).unwrap_err();
        let not_a_folder = data_directory(&file).unwrap_err();

        assert_eq!(
            missing,
            format!(
                "the data directory {} doesn't exist or isn't a directory",
                scratch.path().join("missing").display()
            )
        );
        assert!(
            not_a_folder.contains(&file.display().to_string()),
            "{not_a_folder}"
        );
        assert_eq!(
            data_directory(scratch.path()),
            Ok(scratch.path().to_path_buf())
        );
    }

    #[test]
    fn check_prints_the_zone_and_each_jobs_next_5_fires() {
        let scratch = Scratch::new();
        let path = scratch.path().join("scheduler.toml");
        fs::write(
            &path,
            "timezone = \"America/New_York\"\ncommand = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n\n[[job]]\nname = \"hourly\"\nschedule = \"@hourly\"\n",
        )
        .unwrap();
        let now = at("2026-11-10T13:00:00Z");
        let config = config::load(&path, now).unwrap();
        let zone = zone_of(&config, &system_source());

        let text = check_text(&config, &zone, now);

        assert_eq!(
            text,
            "Zone: America/New_York

daily
  2026-11-11T07:00:00-05:00
  2026-11-12T07:00:00-05:00
  2026-11-13T07:00:00-05:00
  2026-11-14T07:00:00-05:00
  2026-11-15T07:00:00-05:00

hourly
  2026-11-10T09:00:00-05:00
  2026-11-10T10:00:00-05:00
  2026-11-10T11:00:00-05:00
  2026-11-10T12:00:00-05:00
  2026-11-10T13:00:00-05:00
"
        );
    }

    #[test]
    fn tenths_round_seconds() {
        assert_eq!(tenths(secs(2.04)), 2.0);
        assert_eq!(tenths(secs(2.06)), 2.1);
        assert_eq!(tenths(secs(0.0)), 0.0);
    }

    #[test]
    fn ready_names_the_zone_and_each_jobs_next_fire() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T07:00:30Z");

        bench.scheduler.ready(at("2026-11-10T07:00:30Z"));

        let ready = bench.last("ready");
        assert_eq!(ready["level"], "info");
        assert_eq!(ready["zone"], "UTC");
        assert_eq!(
            ready["jobs"],
            json!([{ "name": "minutely", "next": "2026-11-10T07:01:00.000Z" }])
        );
    }

    #[test]
    fn no_jobs_is_ready_and_idle() {
        let mut bench = Bench::new(
            "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\n",
            "2026-11-10T07:00:30Z",
        );

        bench.scheduler.ready(at("2026-11-10T07:00:30Z"));
        bench.decide("2026-11-10T07:05:00Z", 270.0);

        assert_eq!(bench.last("ready")["jobs"], json!([]));
        assert!(bench.starts().is_empty());
        assert_eq!(
            bench
                .scheduler
                .wait(at("2026-11-10T07:05:00Z"), secs(270.0)),
            secs(60.0)
        );
    }

    #[test]
    fn a_new_job_waits_for_its_next_fire() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T07:00:30Z");

        bench.decide("2026-11-10T07:00:30Z", 0.0);
        let wait = bench.scheduler.wait(at("2026-11-10T07:00:30Z"), secs(0.0));
        bench.decide("2026-11-10T07:01:00Z", 30.0);

        assert_eq!(wait, secs(30.0));
        assert_eq!(bench.starts().len(), 1);
    }

    #[test]
    fn a_start_runs_what_fell_due_since_the_newest_log() {
        let config = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n";
        let mut bench = Bench::seeded(
            config,
            "2026-11-09T09:00:00Z",
            &[("daily", "2026-11-08T07-00-00Z.log")],
        );

        bench.decide("2026-11-09T09:00:00Z", 0.0);

        let started = bench.last("started");
        assert_eq!(started["slot"], "2026-11-09T07:00:00.000Z");
        assert_eq!(
            value_of(&bench.env(0), "GREMLIN_CATCH_UP"),
            Some("1".to_string())
        );
    }

    #[test]
    fn a_run_gets_its_command_folder_and_environment() {
        let config = "timezone = \"Europe/London\"\nworking_dir = \"/tmp/w\"\ncommand = [\"/bin/sh\", \"-c\", \"pwd\", \"run\"]\nenv = { A = \"1\", B = \"top\", GREMLIN_SLOT = \"x\", GREMLIN_CATCH_UP = \"1\" }\n\n[[job]]\nname = \"digest\"\nschedule = \"0 7 * * *\"\nargs = [\"tasks/a.md\"]\nenv = { B = \"job\" }\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:00Z");

        bench.decide("2026-11-10T07:00:05Z", 65.0);

        let start = &bench.starts()[0];
        assert_eq!(
            start.launch.argv,
            ["/bin/sh", "-c", "pwd", "run", "tasks/a.md"]
        );
        assert_eq!(start.launch.working_dir, Path::new("/tmp/w"));
        let env = &start.launch.env;
        assert_eq!(value_of(env, "A"), Some("1".to_string()));
        assert_eq!(value_of(env, "B"), Some("job".to_string()));
        assert_eq!(value_of(env, "GREMLIN_JOB"), Some("digest".to_string()));
        assert_eq!(
            value_of(env, "GREMLIN_SLOT"),
            Some("2026-11-10T07:00:00+00:00".to_string())
        );
        assert_eq!(env.last(), Some(&("GREMLIN_CATCH_UP".to_string(), None)));
        let started = bench.last("started");
        assert_eq!(started["job"], "digest");
        assert_eq!(started["slot"], "2026-11-10T07:00:00.000Z");
        assert_eq!(started["pid"], 101);
        assert_eq!(started["log"], "jobs/digest/2026-11-10T07-00-05Z.log");
        assert_eq!(started["time"], "2026-11-10T07:00:05.000Z");
    }

    #[test]
    fn a_run_that_catches_up_knows_it() {
        let config = "timezone = \"America/New_York\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"digest\"\nschedule = \"0 7 * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T11:00:00Z");

        bench.decide("2026-11-10T16:12:00Z", 1.0);

        let env = bench.env(0);
        assert_eq!(
            value_of(&env, "GREMLIN_SLOT"),
            Some("2026-11-10T07:00:00-05:00".to_string())
        );
        assert_eq!(
            env.last(),
            Some(&("GREMLIN_CATCH_UP".to_string(), Some("1".to_string())))
        );
    }

    #[test]
    fn a_fire_while_the_run_is_going_is_skipped() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T06:59:30Z");

        bench.decide("2026-11-10T07:00:00Z", 30.0);
        bench.decide("2026-11-10T07:01:00Z", 90.0);
        bench.exit(1, Ended::Code(0), "2026-11-10T07:01:30Z", 120.0);
        bench.decide("2026-11-10T07:02:00Z", 150.0);

        assert_eq!(
            bench.messages(),
            ["started", "skipped", "exited", "started"]
        );
        let skipped = bench.last("skipped");
        assert_eq!(skipped["job"], "minutely");
        assert_eq!(skipped["slot"], "2026-11-10T07:01:00.000Z");
        assert_eq!(skipped["reason"], "running");
        let exited = bench.last("exited");
        assert_eq!(exited["code"], 0);
        assert_eq!(exited["seconds"], 90.0);
    }

    #[test]
    fn a_missed_fire_skipped_without_catch_up() {
        let config = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\non_failure = [\"/bin/notify\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\ncatch_up = false\n";
        let mut bench = Bench::new(config, "2026-11-10T06:00:00Z");

        bench.decide("2026-11-10T09:00:00Z", 1.0);

        assert_eq!(bench.messages(), ["skipped"]);
        assert_eq!(bench.last("skipped")["reason"], "missed");
        assert!(bench.starts().is_empty());
    }

    #[test]
    fn a_timeout_sends_sigterm_then_sigkill_after_the_grace() {
        let config = "timezone = \"UTC\"\nstop_grace = \"3s\"\ncommand = [\"/bin/run\"]\non_failure = [\"/bin/notify\"]\n\n[[job]]\nname = \"slow\"\nschedule = \"0 7 * * *\"\ntimeout = \"2s\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:00Z");

        bench.decide("2026-11-10T07:00:00Z", 10.0);
        let before = bench.scheduler.wait(at("2026-11-10T07:00:00Z"), secs(10.0));
        bench.decide("2026-11-10T07:00:01.999Z", 11.999);
        let untouched = bench.scheduler.starter.signals.clone();
        bench.decide("2026-11-10T07:00:02Z", 12.0);
        let after_term = bench.scheduler.wait(at("2026-11-10T07:00:02Z"), secs(12.0));
        bench.decide("2026-11-10T07:00:04.9Z", 14.9);
        let before_kill = bench.scheduler.starter.signals.clone();
        bench.decide("2026-11-10T07:00:05Z", 15.0);
        bench.decide("2026-11-10T07:00:06Z", 16.0);
        bench.exit(
            1,
            Ended::Signal(Signal::KILL.as_raw()),
            "2026-11-10T07:00:06Z",
            16.0,
        );

        assert_eq!(before, secs(2.0));
        assert!(untouched.is_empty());
        assert_eq!(after_term, secs(3.0));
        assert_eq!(before_kill, [(101, Signal::TERM)]);
        assert_eq!(
            bench.scheduler.starter.signals[..2],
            [(101, Signal::TERM), (101, Signal::KILL)]
        );
        let timed_out = bench.last("timed out");
        assert_eq!(timed_out["level"], "warn");
        assert_eq!(timed_out["job"], "slow");
        assert_eq!(timed_out["pid"], 101);
        let exited = bench.last("exited");
        assert_eq!(exited["signal"], "SIGKILL");
        assert_eq!(exited["seconds"], 6.0);
        assert_eq!(bench.starts().len(), 2);
        let env = bench.env(1);
        assert_eq!(
            value_of(&env, "GREMLIN_RESULT"),
            Some("timeout".to_string())
        );
        assert_eq!(
            value_of(&env, "GREMLIN_STATUS"),
            Some("SIGKILL".to_string())
        );
    }

    #[test]
    fn on_failure_gets_the_runs_environment_and_its_result() {
        let config = "timezone = \"UTC\"\nworking_dir = \"/srv\"\ncommand = [\"/bin/run\"]\nenv = { A = \"1\" }\non_failure = [\"/bin/notify\", \"now\"]\n\n[[job]]\nname = \"digest\"\nschedule = \"* * * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:30Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.exit(1, Ended::Code(1), "2026-11-10T07:00:03Z", 3.0);
        bench.decide("2026-11-10T07:01:00Z", 60.0);
        bench.exit(
            3,
            Ended::Signal(Signal::SEGV.as_raw()),
            "2026-11-10T07:01:01Z",
            61.0,
        );

        assert_eq!(bench.starts().len(), 4);
        let command = &bench.starts()[1].launch;
        assert_eq!(command.argv, ["/bin/notify", "now"]);
        assert_eq!(command.working_dir, Path::new("/srv"));
        assert_eq!(value_of(&command.env, "A"), Some("1".to_string()));
        assert_eq!(
            value_of(&command.env, "GREMLIN_JOB"),
            Some("digest".to_string())
        );
        assert_eq!(
            value_of(&command.env, "GREMLIN_SLOT"),
            Some("2026-11-10T07:00:00+00:00".to_string())
        );
        assert_eq!(
            value_of(&command.env, "GREMLIN_RESULT"),
            Some("exit-code".to_string())
        );
        assert_eq!(
            value_of(&command.env, "GREMLIN_STATUS"),
            Some("1".to_string())
        );
        let log = bench.data().join("jobs/digest/2026-11-10T07-00-00Z.log");
        assert_eq!(
            value_of(&command.env, "GREMLIN_LOG"),
            Some(log.display().to_string())
        );
        let signalled = &bench.starts()[3].launch;
        assert_eq!(
            value_of(&signalled.env, "GREMLIN_RESULT"),
            Some("signal".to_string())
        );
        assert_eq!(
            value_of(&signalled.env, "GREMLIN_STATUS"),
            Some("SIGSEGV".to_string())
        );
    }

    #[test]
    fn a_run_that_cannot_start_is_an_error_and_starts_on_failure() {
        let config = "timezone = \"UTC\"\ncommand = [\"/missing/program\"]\non_failure = [\"/bin/notify\"]\n\n[[job]]\nname = \"broken\"\nschedule = \"* * * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:30Z");
        bench.scheduler.starter.refuse = Some("/missing/program".to_string());

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.decide("2026-11-10T07:01:00Z", 60.0);

        let error = bench.last("error");
        assert_eq!(error["level"], "error");
        assert_eq!(error["job"], "broken");
        assert_eq!(
            error["reason"],
            "couldn't start /missing/program: No such file or directory"
        );
        assert_eq!(bench.messages(), ["error", "error"]);
        let command = &bench.starts()[0].launch;
        assert_eq!(
            value_of(&command.env, "GREMLIN_RESULT"),
            Some("error".to_string())
        );
        assert_eq!(
            value_of(&command.env, "GREMLIN_STATUS"),
            Some("couldn't start /missing/program: No such file or directory".to_string())
        );
        let log = bench.data().join("jobs/broken/2026-11-10T07-00-00Z.log");
        assert_eq!(
            value_of(&command.env, "GREMLIN_LOG"),
            Some(log.display().to_string())
        );
        assert!(log.exists());
        assert_eq!(bench.starts().len(), 2);
    }

    #[test]
    fn no_on_failure_after_a_success_or_for_a_job_that_turns_it_off() {
        let config = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\non_failure = [\"/bin/notify\"]\n\n[[job]]\nname = \"fine\"\nschedule = \"* * * * *\"\n\n[[job]]\nname = \"off\"\nschedule = \"* * * * *\"\non_failure = []\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:30Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.exit(1, Ended::Code(0), "2026-11-10T07:00:01Z", 1.0);
        bench.exit(2, Ended::Code(1), "2026-11-10T07:00:01Z", 1.0);

        assert_eq!(bench.starts().len(), 2);
    }

    #[test]
    fn a_failing_on_failure_is_an_error() {
        let config = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\non_failure = [\"/bin/notify\"]\n\n[[job]]\nname = \"digest\"\nschedule = \"* * * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:30Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.exit(1, Ended::Code(1), "2026-11-10T07:00:01Z", 1.0);
        bench.exit(2, Ended::Code(2), "2026-11-10T07:00:02Z", 2.0);
        bench.exit(2, Ended::Code(2), "2026-11-10T07:00:02Z", 2.0);

        assert_eq!(bench.messages(), ["started", "exited", "error"]);
        let error = bench.last("error");
        assert_eq!(error["job"], "digest");
        assert_eq!(error["reason"], "on_failure exited with code 2");
        assert_eq!(bench.starts().len(), 2);
    }

    #[test]
    fn on_failure_gets_60_seconds() {
        let config = "timezone = \"UTC\"\nstop_grace = \"5s\"\ncommand = [\"/bin/run\"]\non_failure = [\"/bin/notify\"]\n\n[[job]]\nname = \"digest\"\nschedule = \"0 7 * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:00Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.exit(1, Ended::Code(1), "2026-11-10T07:00:10Z", 10.0);
        bench.decide("2026-11-10T07:01:09.9Z", 69.9);
        let early = bench.scheduler.starter.signals.clone();
        bench.decide("2026-11-10T07:01:10Z", 70.0);
        bench.decide("2026-11-10T07:01:15Z", 75.0);
        bench.exit(
            2,
            Ended::Signal(Signal::KILL.as_raw()),
            "2026-11-10T07:01:15Z",
            75.0,
        );

        assert!(early.is_empty());
        assert_eq!(
            bench.scheduler.starter.signals,
            [(102, Signal::TERM), (102, Signal::KILL)]
        );
        assert!(
            bench
                .records()
                .iter()
                .all(|record| record["message"] != "timed out")
        );
        let error = bench.last("error");
        assert_eq!(error["job"], "digest");
        assert_eq!(
            error["reason"],
            "on_failure ran past its 60 s and was stopped; it ended with SIGKILL"
        );
    }

    #[test]
    fn on_failure_ended_by_a_signal_or_that_cannot_start() {
        let config = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\non_failure = [\"/missing/notify\"]\n\n[[job]]\nname = \"digest\"\nschedule = \"* * * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:30Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.exit(1, Ended::Code(1), "2026-11-10T07:00:01Z", 1.0);
        bench.exit(
            2,
            Ended::Signal(Signal::TERM.as_raw()),
            "2026-11-10T07:00:02Z",
            2.0,
        );
        bench.scheduler.starter.refuse = Some("/missing/notify".to_string());
        bench.decide("2026-11-10T07:01:00Z", 60.0);
        bench.exit(3, Ended::Code(1), "2026-11-10T07:01:01Z", 61.0);

        let errors: Vec<Value> = bench
            .records()
            .into_iter()
            .filter(|record| record["message"] == "error")
            .map(|record| record["reason"].clone())
            .collect();
        assert_eq!(
            errors,
            [
                json!("on_failure ended by SIGTERM"),
                json!(
                    "on_failure couldn't start: couldn't start /missing/notify: No such file or directory"
                )
            ]
        );
    }

    #[test]
    fn a_run_keeps_its_timeout_and_on_failure_across_a_reload() {
        let config = "timezone = \"UTC\"\nstop_grace = \"1s\"\ncommand = [\"/bin/run\"]\non_failure = [\"/bin/first\"]\n\n[[job]]\nname = \"digest\"\nschedule = \"0 7 * * *\"\ntimeout = \"1h\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:00Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.rewrite("timezone = \"UTC\"\nstop_grace = \"9s\"\ncommand = [\"/bin/run\"]\non_failure = [\"/bin/second\"]\n\n[[job]]\nname = \"digest\"\nschedule = \"0 7 * * *\"\ntimeout = \"2s\"\n");
        bench.signal(Signal::HUP, "2026-11-10T07:00:01Z", 1.0);
        bench.decide("2026-11-10T07:00:03Z", 3.0);
        let after_reload = bench.scheduler.starter.signals.clone();
        bench.decide("2026-11-10T08:00:00Z", 3600.0);
        bench.decide("2026-11-10T08:00:01Z", 3601.0);
        bench.exit(
            1,
            Ended::Signal(Signal::KILL.as_raw()),
            "2026-11-10T08:00:01Z",
            3601.0,
        );

        assert!(after_reload.is_empty());
        assert_eq!(
            bench.scheduler.starter.signals,
            [(101, Signal::TERM), (101, Signal::KILL)]
        );
        assert_eq!(bench.starts()[1].launch.argv, ["/bin/first"]);
    }

    #[test]
    fn a_reload_swaps_the_config_and_keeps_kept_jobs_last_looks() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T07:00:20Z");

        bench.decide("2026-11-10T07:00:30Z", 10.0);
        bench.rewrite(&format!(
            "{MINUTELY}\n[[job]]\nname = \"added\"\nschedule = \"* * * * *\"\n"
        ));
        bench.signal(Signal::HUP, "2026-11-10T07:01:10Z", 50.0);
        bench.decide("2026-11-10T07:01:20Z", 60.0);
        bench.decide("2026-11-10T07:02:00Z", 100.0);

        let reloaded = bench.last("config reloaded");
        assert_eq!(reloaded["level"], "info");
        assert_eq!(
            reloaded["jobs"],
            json!([
                { "name": "minutely", "next": "2026-11-10T07:02:00.000Z" },
                { "name": "added", "next": "2026-11-10T07:02:00.000Z" }
            ])
        );
        let starts: Vec<(String, String)> = bench
            .starts()
            .iter()
            .map(|start| {
                (
                    value_of(&start.launch.env, "GREMLIN_JOB").unwrap(),
                    value_of(&start.launch.env, "GREMLIN_SLOT").unwrap(),
                )
            })
            .collect();
        assert_eq!(
            starts,
            [
                (
                    "minutely".to_string(),
                    "2026-11-10T07:01:00+00:00".to_string()
                ),
                ("added".to_string(), "2026-11-10T07:02:00+00:00".to_string())
            ]
        );
    }

    #[test]
    fn a_removed_job_starts_nothing_more_but_its_run_goes_on() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T06:59:30Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.rewrite("timezone = \"UTC\"\ncommand = [\"/bin/run\"]\n");
        bench.signal(Signal::HUP, "2026-11-10T07:00:30Z", 30.0);
        bench.decide("2026-11-10T07:05:00Z", 300.0);
        bench.decide("2026-11-10T07:10:00Z", 600.0);

        assert_eq!(bench.starts().len(), 1);
        assert_eq!(bench.scheduler.starter.signals, [(101, Signal::TERM)]);
        assert_eq!(bench.last("config reloaded")["jobs"], json!([]));
    }

    #[test]
    fn a_refused_reload_keeps_the_old_config() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T06:59:30Z");

        bench.rewrite(&format!("{MINUTELY}schedul = \"0 7 * * *\"\n"));
        bench.signal(Signal::HUP, "2026-11-10T06:59:40Z", 10.0);
        bench.decide("2026-11-10T07:00:00Z", 30.0);

        let refused = bench.last("config refused");
        assert_eq!(refused["level"], "warn");
        assert!(
            refused["reason"]
                .as_str()
                .unwrap()
                .contains("unknown field `schedul`"),
            "{refused}"
        );
        assert_eq!(bench.starts().len(), 1);
    }

    #[test]
    fn the_stop_signals_runs_and_commands_and_waits_for_them() {
        let config = "timezone = \"UTC\"\nstop_grace = \"4s\"\ncommand = [\"/bin/run\"]\non_failure = [\"/bin/notify\"]\n\n[[job]]\nname = \"a\"\nschedule = \"* * * * *\"\n\n[[job]]\nname = \"b\"\nschedule = \"* * * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:30Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.exit(2, Ended::Code(1), "2026-11-10T07:00:01Z", 1.0);
        bench.signal(Signal::INT, "2026-11-10T07:00:02Z", 2.0);
        bench.signal(Signal::HUP, "2026-11-10T07:00:02Z", 2.0);
        bench.signal(Signal::TERM, "2026-11-10T07:00:02Z", 2.0);
        let finished_early = bench.scheduler.finished(secs(2.0));
        let wait = bench.scheduler.wait(at("2026-11-10T07:00:02Z"), secs(2.0));
        bench.exit(1, Ended::Code(1), "2026-11-10T07:00:03Z", 3.0);
        bench.decide("2026-11-10T07:01:00Z", 5.9);
        let before_kill = bench.scheduler.starter.signals.clone();
        bench.decide("2026-11-10T07:01:00Z", 6.0);

        assert!(!finished_early);
        assert_eq!(wait, secs(4.0));
        assert_eq!(before_kill, [(101, Signal::TERM), (103, Signal::TERM)]);
        assert_eq!(bench.scheduler.starter.signals[2..], [(103, Signal::KILL)]);
        assert!(bench.scheduler.finished(secs(6.0)));
        assert_eq!(bench.starts().len(), 3);
        let stopping = bench.last("stopping");
        assert_eq!(stopping["signal"], "SIGINT");
        assert_eq!(
            bench
                .records()
                .iter()
                .filter(|record| record["message"] == "stopping")
                .count(),
            1
        );
        assert!(
            bench
                .records()
                .iter()
                .all(|record| record["message"] != "config reloaded")
        );
        bench.scheduler.stopped(at("2026-11-10T07:01:00Z"));
        assert_eq!(bench.messages().last().unwrap(), "stopped");
    }

    #[test]
    fn an_idle_stop_is_finished_at_once() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T06:59:30Z");

        let running = bench.scheduler.finished(secs(1.0));
        bench.signal(Signal::TERM, "2026-11-10T06:59:31Z", 1.0);

        assert!(!running);
        assert!(bench.scheduler.finished(secs(1.0)));
        assert_eq!(bench.last("stopping")["signal"], "SIGTERM");
        assert_eq!(bench.scheduler.next_fire(), None);
    }

    #[test]
    fn a_stop_waits_for_a_run_until_its_grace() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T06:59:30Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.signal(Signal::TERM, "2026-11-10T07:00:10Z", 10.0);

        assert!(!bench.scheduler.finished(secs(14.9)));
        assert!(bench.scheduler.finished(secs(15.0)));
    }

    #[test]
    fn the_stop_keeps_a_sigkill_that_comes_before_its_own() {
        let config = "timezone = \"UTC\"\nstop_grace = \"5s\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"short\"\nschedule = \"0 7 * * *\"\ntimeout = \"2s\"\n\n[[job]]\nname = \"middle\"\nschedule = \"0 7 * * *\"\ntimeout = \"4s\"\n\n[[job]]\nname = \"long\"\nschedule = \"0 7 * * *\"\ntimeout = \"10m\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:00Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.decide("2026-11-10T07:00:02Z", 2.0);
        bench.signal(Signal::TERM, "2026-11-10T07:00:03Z", 3.0);
        bench.decide("2026-11-10T07:00:04Z", 4.0);
        bench.decide("2026-11-10T07:00:06.9Z", 6.9);
        let before_its_own = bench.scheduler.starter.signals.clone();
        bench.decide("2026-11-10T07:00:07Z", 7.0);
        bench.decide("2026-11-10T07:00:07.9Z", 7.9);
        let before_the_stops = bench.scheduler.starter.signals.clone();
        bench.decide("2026-11-10T07:00:08Z", 8.0);

        // short is in its grace when the stop comes, middle's deadline would fall before the stop's
        // SIGKILL, and long's after it.
        assert_eq!(
            before_its_own,
            [
                (101, Signal::TERM),
                (101, Signal::TERM),
                (102, Signal::TERM),
                (103, Signal::TERM)
            ]
        );
        assert_eq!(before_the_stops[4..], [(101, Signal::KILL)]);
        assert_eq!(
            bench.scheduler.starter.signals[5..],
            [(102, Signal::KILL), (103, Signal::KILL)]
        );
    }

    #[test]
    fn retention_keeps_the_newest_logs() {
        let config = "timezone = \"UTC\"\nkeep_runs = 2\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"minutely\"\nschedule = \"* * * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:30Z");

        for (index, minute) in ["00", "01", "02"].iter().enumerate() {
            let mono = 60.0 * index as f64;
            bench.decide(&format!("2026-11-10T07:{minute}:00Z"), mono);
            bench.exit(
                index as u64 + 1,
                Ended::Code(0),
                &format!("2026-11-10T07:{minute}:01Z"),
                mono + 1.0,
            );
        }

        let mut logs: Vec<String> = fs::read_dir(bench.data().join("jobs/minutely"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        logs.sort();
        assert_eq!(
            logs,
            ["2026-11-10T07-01-00Z.log", "2026-11-10T07-02-00Z.log"]
        );
    }

    #[test]
    fn a_log_still_written_to_is_never_pruned() {
        let config = "timezone = \"UTC\"\nkeep_runs = 1\ncommand = [\"/bin/run\"]\non_failure = [\"/bin/notify\"]\n\n[[job]]\nname = \"a\"\nschedule = \"* * * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:30Z");
        let jobs = bench.data().join("jobs/a");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.exit(1, Ended::Code(1), "2026-11-10T07:00:30Z", 30.0);
        bench.decide("2026-11-10T07:01:00Z", 60.0);
        let kept = jobs.join("2026-11-10T07-00-00Z.log").exists();
        bench.exit(2, Ended::Code(0), "2026-11-10T07:01:10Z", 70.0);
        bench.exit(3, Ended::Code(0), "2026-11-10T07:01:20Z", 80.0);
        bench.decide("2026-11-10T07:02:00Z", 120.0);

        assert!(kept);
        assert!(!jobs.join("2026-11-10T07-00-00Z.log").exists());
        assert!(!jobs.join("2026-11-10T07-01-00Z.log").exists());
        assert!(jobs.join("2026-11-10T07-02-00Z.log").exists());
    }

    #[test]
    fn no_signal_goes_to_a_group_below_2() {
        let config = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"a\"\nschedule = \"0 7 * * *\"\ntimeout = \"1s\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:00Z");
        bench.scheduler.starter.pid = Some(1);

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.decide("2026-11-10T07:00:05Z", 5.0);
        bench.signal(Signal::TERM, "2026-11-10T07:00:06Z", 6.0);
        bench.decide("2026-11-10T07:00:40Z", 40.0);

        assert!(bench.scheduler.starter.signals.is_empty());
        assert_eq!(bench.last("timed out")["pid"], 1);
    }

    #[test]
    fn the_system_zone_is_read_at_every_wake() {
        let config =
            "command = [\"/bin/run\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:00:00Z");
        let localtime = bench.scratch.path().join("localtime");
        symlink("/usr/share/zoneinfo/Europe/London", &localtime).unwrap();

        bench.decide("2026-11-10T07:00:10Z", 10.0);
        bench.exit(1, Ended::Code(0), "2026-11-10T07:00:20Z", 20.0);
        fs::remove_file(&localtime).unwrap();
        symlink("/usr/share/zoneinfo/America/New_York", &localtime).unwrap();
        bench.decide("2026-11-10T08:00:00Z", 3600.0);
        bench.decide("2026-11-10T12:00:10Z", 18010.0);

        let slots: Vec<String> = bench
            .starts()
            .iter()
            .map(|start| value_of(&start.launch.env, "GREMLIN_SLOT").unwrap())
            .collect();
        assert_eq!(
            slots,
            ["2026-11-10T07:00:00+00:00", "2026-11-10T07:00:00-05:00"]
        );
        assert_eq!(value_of(&bench.env(1), "GREMLIN_CATCH_UP"), None);
    }

    #[test]
    fn a_backward_step_is_recorded_and_runs_nothing_twice() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T06:59:30Z");

        bench.decide("2026-11-10T07:00:00Z", 0.0);
        bench.exit(1, Ended::Code(0), "2026-11-10T07:00:20Z", 20.0);
        bench.decide("2026-11-10T07:00:30Z", 30.0);
        bench.decide("2026-11-10T07:00:30Z", 30.0);
        bench.decide("2026-11-10T06:59:00Z", 60.0);
        bench.decide("2026-11-10T07:00:20Z", 140.0);
        bench.decide("2026-11-10T07:01:00Z", 180.0);

        let stepped: Vec<Value> = bench
            .records()
            .into_iter()
            .filter(|record| record["message"] == "clock stepped back")
            .collect();
        assert_eq!(stepped.len(), 1);
        assert_eq!(stepped[0]["level"], "warn");
        assert_eq!(stepped[0]["from"], "2026-11-10T07:00:30.000Z");
        assert_eq!(stepped[0]["to"], "2026-11-10T06:59:00.000Z");
        assert_eq!(bench.starts().len(), 2);
        assert_eq!(
            value_of(&bench.env(1), "GREMLIN_SLOT"),
            Some("2026-11-10T07:01:00+00:00".to_string())
        );
    }

    #[test]
    fn a_forward_step_runs_the_fire_once_as_missed() {
        let config = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:00Z");

        bench.decide("2026-11-10T09:00:00Z", 60.0);
        bench.decide("2026-11-10T09:01:00Z", 120.0);

        assert_eq!(bench.starts().len(), 1);
        assert_eq!(
            value_of(&bench.env(0), "GREMLIN_CATCH_UP"),
            Some("1".to_string())
        );
    }

    #[test]
    fn a_day_interval_that_has_never_run_catches_up_its_latest_slot_at_the_start() {
        let mut bench = Bench::new(WEEKLY, "2026-11-10T09:00:00Z");

        let wait = bench.scheduler.wait(at("2026-11-10T09:00:00Z"), secs(0.0));
        bench.decide("2026-11-10T09:00:00Z", 0.0);
        bench.decide("2026-11-10T09:01:00Z", 60.0);

        assert_eq!(wait, Duration::ZERO);
        assert_eq!(bench.messages(), ["started"]);
        assert_eq!(bench.last("started")["slot"], "2026-11-08T07:00:00.000Z");
        let env = bench.env(0);
        assert_eq!(
            value_of(&env, "GREMLIN_SLOT"),
            Some("2026-11-08T07:00:00+00:00".to_string())
        );
        assert_eq!(value_of(&env, "GREMLIN_CATCH_UP"), Some("1".to_string()));
    }

    #[test]
    fn a_day_interval_that_has_never_run_skips_its_latest_slot_without_catch_up() {
        let mut bench = Bench::new(
            &format!("{WEEKLY}catch_up = false\n"),
            "2026-11-10T09:00:00Z",
        );

        bench.decide("2026-11-10T09:00:00Z", 0.0);
        let next = bench.scheduler.next_fire();
        bench.decide("2026-11-15T07:00:00Z", 424_800.0);

        assert_eq!(bench.messages(), ["skipped", "started"]);
        let skipped = bench.last("skipped");
        assert_eq!(skipped["slot"], "2026-11-08T07:00:00.000Z");
        assert_eq!(skipped["reason"], "missed");
        assert_eq!(next, Some(at("2026-11-15T07:00:00Z")));
        assert_eq!(bench.last("started")["slot"], "2026-11-15T07:00:00.000Z");
        assert_eq!(value_of(&bench.env(0), "GREMLIN_CATCH_UP"), None);
    }

    #[test]
    fn a_day_interval_whose_start_is_to_come_waits_for_it() {
        let config = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"refresh\"\nstart = 2026-11-15T07:00\nevery = \"30d\"\n";
        let mut bench = Bench::new(config, "2026-11-10T09:00:00Z");

        bench.scheduler.ready(at("2026-11-10T09:00:00Z"));
        bench.decide("2026-11-10T09:00:00Z", 0.0);
        bench.decide("2026-11-15T06:59:59Z", 424_799.0);
        let before = bench.starts().len();
        bench.decide("2026-11-15T07:00:03Z", 424_803.0);

        assert_eq!(
            bench.last("ready")["jobs"],
            json!([{ "name": "refresh", "next": "2026-11-15T07:00:00.000Z" }])
        );
        assert_eq!(before, 0);
        assert_eq!(bench.messages(), ["ready", "started"]);
        assert_eq!(bench.last("started")["slot"], "2026-11-15T07:00:00.000Z");
        assert_eq!(value_of(&bench.env(0), "GREMLIN_CATCH_UP"), None);
    }

    #[test]
    fn a_day_interval_run_on_time_knows_its_slot() {
        let config = "timezone = \"Europe/London\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"refresh\"\nstart = 2026-11-15T07:00\nevery = \"30d\"\n";
        let mut bench = Bench::seeded(
            config,
            "2026-12-15T06:59:00Z",
            &[("refresh", "2026-11-15T07-00-01Z.log")],
        );

        bench.decide("2026-12-15T07:00:03Z", 63.0);

        let env = bench.env(0);
        assert_eq!(
            value_of(&env, "GREMLIN_SLOT"),
            Some("2026-12-15T07:00:00+00:00".to_string())
        );
        assert_eq!(env.last(), Some(&("GREMLIN_CATCH_UP".to_string(), None)));
    }

    #[test]
    fn a_day_interval_with_a_log_starts_from_it() {
        let mut ran = Bench::seeded(
            WEEKLY,
            "2026-11-10T09:00:00Z",
            &[("weekly", "2026-11-08T07-00-02Z.log")],
        );
        let mut missed = Bench::seeded(
            WEEKLY,
            "2026-11-10T09:00:00Z",
            &[("weekly", "2026-11-01T07-00-02Z.log")],
        );

        ran.decide("2026-11-10T09:00:00Z", 0.0);
        missed.decide("2026-11-10T09:00:00Z", 0.0);

        assert!(ran.starts().is_empty());
        assert_eq!(missed.last("started")["slot"], "2026-11-08T07:00:00.000Z");
    }

    #[test]
    fn a_new_cron_job_beside_a_new_day_interval_still_waits() {
        let config = format!("{WEEKLY}\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n");
        let mut bench = Bench::new(&config, "2026-11-10T09:00:00Z");

        bench.decide("2026-11-10T09:00:00Z", 0.0);

        assert_eq!(bench.messages(), ["started"]);
        assert_eq!(bench.last("started")["job"], "weekly");
        assert_eq!(
            bench.scheduler.next_fire(),
            Some(at("2026-11-11T07:00:00Z"))
        );
    }

    #[test]
    fn a_day_interval_added_by_a_reload_catches_up_at_once() {
        let mut bench = Bench::new(NO_JOBS, "2026-11-10T08:00:00Z");

        bench.decide("2026-11-10T08:00:00Z", 0.0);
        bench.rewrite(WEEKLY);
        bench.signal(Signal::HUP, "2026-11-10T09:00:00Z", 3600.0);
        bench.decide("2026-11-10T09:00:00Z", 3600.0);

        assert_eq!(
            bench.last("config reloaded")["jobs"],
            json!([{ "name": "weekly", "next": "2026-11-15T07:00:00.000Z" }])
        );
        assert_eq!(bench.messages(), ["config reloaded", "started"]);
        assert_eq!(bench.last("started")["slot"], "2026-11-08T07:00:00.000Z");
        assert_eq!(
            value_of(&bench.env(0), "GREMLIN_CATCH_UP"),
            Some("1".to_string())
        );
    }

    #[test]
    fn a_day_interval_with_a_log_added_by_a_reload_starts_from_the_reload() {
        let mut bench = Bench::seeded(
            NO_JOBS,
            "2026-11-10T08:00:00Z",
            &[("weekly", "2026-11-01T07-00-02Z.log")],
        );

        bench.rewrite(WEEKLY);
        bench.signal(Signal::HUP, "2026-11-10T09:00:00Z", 3600.0);
        bench.decide("2026-11-10T09:00:00Z", 3600.0);

        assert_eq!(bench.messages(), ["config reloaded"]);
        assert_eq!(
            bench.scheduler.next_fire(),
            Some(at("2026-11-15T07:00:00Z"))
        );
    }

    #[test]
    fn a_day_interval_follows_the_system_zone() {
        let config = "command = [\"/bin/run\"]\n\n[[job]]\nname = \"daily\"\nstart = 2026-11-15T07:00\nevery = \"1d\"\n";
        let mut bench = Bench::new(config, "2026-11-15T06:00:00Z");
        let localtime = bench.scratch.path().join("localtime");
        symlink("/usr/share/zoneinfo/Europe/London", &localtime).unwrap();

        bench.decide("2026-11-15T06:00:00Z", 0.0);
        bench.decide("2026-11-15T07:00:10Z", 3610.0);
        bench.exit(1, Ended::Code(0), "2026-11-15T07:00:20Z", 3620.0);
        fs::remove_file(&localtime).unwrap();
        symlink("/usr/share/zoneinfo/America/New_York", &localtime).unwrap();
        bench.decide("2026-11-15T08:00:00Z", 7200.0);
        bench.decide("2026-11-15T12:00:10Z", 21610.0);

        let slots: Vec<String> = bench
            .starts()
            .iter()
            .map(|start| value_of(&start.launch.env, "GREMLIN_SLOT").unwrap())
            .collect();
        assert_eq!(
            slots,
            ["2026-11-15T07:00:00+00:00", "2026-11-15T07:00:00-05:00"]
        );
        assert_eq!(value_of(&bench.env(1), "GREMLIN_CATCH_UP"), None);
    }

    #[test]
    fn the_wait_counts_down_to_the_next_fire_and_the_nearest_signal() {
        let config = "timezone = \"UTC\"\ncommand = [\"/bin/run\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\ntimeout = \"45s\"\n\n[[job]]\nname = \"later\"\nschedule = \"20 7 * * *\"\n";
        let mut bench = Bench::new(config, "2026-11-10T06:59:00Z");

        let idle = bench.scheduler.wait(at("2026-11-10T06:59:40Z"), secs(40.0));
        bench.decide("2026-11-10T07:00:00Z", 60.0);
        let running = bench.scheduler.wait(at("2026-11-10T07:00:00Z"), secs(60.0));
        bench.exit(1, Ended::Code(0), "2026-11-10T07:00:10Z", 70.0);
        let next_fire = bench
            .scheduler
            .wait(at("2026-11-10T07:19:50Z"), secs(1250.0));

        assert_eq!(idle, secs(20.0));
        assert_eq!(running, secs(45.0));
        assert_eq!(next_fire, secs(10.0));
    }

    #[test]
    fn an_exit_nothing_tracks_is_ignored() {
        let mut bench = Bench::new(MINUTELY, "2026-11-10T06:59:30Z");

        bench.exit(42, Ended::Code(1), "2026-11-10T06:59:40Z", 10.0);

        assert!(bench.records().is_empty());
    }

    #[test]
    fn command_failures_name_on_failure() {
        assert_eq!(
            command_failure(Outcome::ExitCode, Ended::Code(2)),
            "on_failure exited with code 2"
        );
        assert_eq!(
            command_failure(Outcome::Signal, Ended::Signal(9)),
            "on_failure ended by SIGKILL"
        );
        assert_eq!(
            command_failure(Outcome::Timeout, Ended::Code(0)),
            "on_failure ran past its 60 s and was stopped; it ended with 0"
        );
    }
}
