use std::fs::{self, DirBuilder, File};
use std::io;
use std::os::unix::fs::DirBuilderExt as _;
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::Sender;

use jiff::Timestamp;
use jiff::civil::DateTime;
use jiff::tz::TimeZone;
use rustix::process::{Pid, Signal};

use crate::events::{self, Event};
use crate::log::open_private;

// The start in UTC, which sorts by time and holds no colon.
const LOG_TIME: &str = "%Y-%m-%dT%H-%M-%SZ";

// rustix's own names for some of these differ from the system's, such as ABORT for SIGABRT.
const SIGNALS: [(Signal, &str); 20] = [
    (Signal::HUP, "SIGHUP"),
    (Signal::INT, "SIGINT"),
    (Signal::QUIT, "SIGQUIT"),
    (Signal::ILL, "SIGILL"),
    (Signal::TRAP, "SIGTRAP"),
    (Signal::ABORT, "SIGABRT"),
    (Signal::BUS, "SIGBUS"),
    (Signal::FPE, "SIGFPE"),
    (Signal::KILL, "SIGKILL"),
    (Signal::USR1, "SIGUSR1"),
    (Signal::SEGV, "SIGSEGV"),
    (Signal::USR2, "SIGUSR2"),
    (Signal::PIPE, "SIGPIPE"),
    (Signal::ALARM, "SIGALRM"),
    (Signal::TERM, "SIGTERM"),
    (Signal::XCPU, "SIGXCPU"),
    (Signal::XFSZ, "SIGXFSZ"),
    (Signal::VTALARM, "SIGVTALRM"),
    (Signal::PROF, "SIGPROF"),
    (Signal::SYS, "SIGSYS"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    Code(i32),
    Signal(i32),
}

pub fn signal_name(number: i32) -> String {
    SIGNALS
        .iter()
        .find(|(signal, _)| signal.as_raw() == number)
        .map_or_else(|| format!("SIG{number}"), |(_, name)| name.to_string())
}

pub fn ended(status: ExitStatus) -> Ended {
    if let Some(code) = status.code() {
        return Ended::Code(code);
    }

    Ended::Signal(status.signal().unwrap_or_default())
}

impl Ended {
    pub fn status(self) -> String {
        match self {
            Ended::Code(code) => code.to_string(),
            Ended::Signal(signal) => signal_name(signal),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Timeout,
    ExitCode,
    Signal,
    Error,
}

impl Outcome {
    pub fn name(self) -> &'static str {
        match self {
            Outcome::Timeout => "timeout",
            Outcome::ExitCode => "exit-code",
            Outcome::Signal => "signal",
            Outcome::Error => "error",
        }
    }
}

// A run that passed its timeout counts as one whatever it exited with.
pub fn outcome(timed_out: bool, ended: Ended) -> Option<Outcome> {
    if timed_out {
        return Some(Outcome::Timeout);
    }

    match ended {
        Ended::Code(0) => None,
        Ended::Code(_) => Some(Outcome::ExitCode),
        Ended::Signal(_) => Some(Outcome::Signal),
    }
}

pub fn log_name(start: Timestamp) -> String {
    format!("{}.log", start.strftime(LOG_TIME))
}

pub fn start_of(file_name: &str) -> Option<Timestamp> {
    let stem = file_name.strip_suffix(".log")?;
    let datetime = DateTime::strptime(LOG_TIME, stem).ok()?;

    TimeZone::UTC.to_timestamp(datetime).ok()
}

fn logs(dir: &Path) -> Vec<(Timestamp, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut logs: Vec<(Timestamp, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| Some((start_of(entry.file_name().to_str()?)?, entry.path())))
        .collect();
    logs.sort();

    logs
}

pub fn newest_start(dir: &Path) -> Option<Timestamp> {
    logs(dir).into_iter().map(|(start, _)| start).max()
}

pub fn prune(dir: &Path, keep: usize, in_use: &[PathBuf]) {
    let logs = logs(dir);
    let excess = logs.len().saturating_sub(keep);

    for (_, path) in logs.iter().take(excess) {
        if in_use.contains(path) {
            continue;
        }

        // A log that can't be deleted is tried again after the job's next start.
        let _ = fs::remove_file(path);
    }
}

// A run's records hold its task's text and its tools' arguments.
pub fn open_log(dir: &Path, name: &str) -> io::Result<File> {
    DirBuilder::new().recursive(true).mode(0o700).create(dir)?;

    open_private(&dir.join(name))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub argv: Vec<String>,
    pub working_dir: PathBuf,
    // In order, over the scheduler's own environment: a value to set, or None to remove.
    pub env: Vec<(String, Option<String>)>,
}

pub trait Starter {
    fn start(&mut self, id: u64, launch: &Launch, log: File) -> Result<Pid, String>;

    fn signal(&mut self, group: Pid, signal: Signal);
}

pub struct Children {
    events: Sender<Event>,
}

impl Children {
    pub fn new(events: Sender<Event>) -> Children {
        Children { events }
    }
}

impl Starter for Children {
    fn start(&mut self, id: u64, launch: &Launch, log: File) -> Result<Pid, String> {
        // The config refuses an empty command.
        let Some((program, args)) = launch.argv.split_first() else {
            return Err("the command is empty".to_string());
        };

        let stderr = log
            .try_clone()
            .map_err(|error| format!("couldn't share the run's log: {error}"))?;
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(&launch.working_dir)
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(stderr)
            // A timeout or a stop then reaches every process that stays in the run's group.
            .process_group(0);

        for (key, value) in &launch.env {
            match value {
                Some(value) => command.env(key, value),
                None => command.env_remove(key),
            };
        }

        let child = command
            .spawn()
            .map_err(|error| format!("couldn't start {program}: {error}"))?;
        // Taken before the waiter takes the child, and kept as a Pid: as an integer, a mutant that
        // made it 1 would signal kill(-1), every process the scheduler may signal.
        let group = Pid::from_child(&child);
        events::wait_for(child, id, self.events.clone());

        Ok(group)
    }

    fn signal(&mut self, group: Pid, signal: Signal) {
        // A group that has ended since answers ESRCH, which needs nothing done.
        let _ = rustix::process::kill_process_group(group, signal);
    }
}

// A group of 1 is kill(-1), every process the scheduler may signal, so as the agent's sweep
// refuses pid 1 and below, the scheduler signals no group below 2.
pub fn send(starter: &mut dyn Starter, group: Pid, signal: Signal) {
    if group.as_raw_pid() < 2 {
        return;
    }

    starter.signal(group, signal);
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;
    use crate::testing::Scratch;

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[derive(Default)]
    struct Recorder {
        signals: Vec<(i32, Signal)>,
    }

    impl Starter for Recorder {
        fn start(&mut self, _id: u64, _launch: &Launch, _log: File) -> Result<Pid, String> {
            Err("not used".to_string())
        }

        fn signal(&mut self, group: Pid, signal: Signal) {
            self.signals.push((group.as_raw_pid(), signal));
        }
    }

    #[test]
    fn no_signal_reaches_a_group_below_2() {
        let mut recorder = Recorder::default();

        send(&mut recorder, Pid::INIT, Signal::TERM);
        send(&mut recorder, Pid::from_raw(2).unwrap(), Signal::KILL);

        assert_eq!(recorder.signals, [(2, Signal::KILL)]);
    }

    #[test]
    fn signals_have_their_names() {
        assert_eq!(signal_name(Signal::KILL.as_raw()), "SIGKILL");
        assert_eq!(signal_name(Signal::TERM.as_raw()), "SIGTERM");
        assert_eq!(signal_name(Signal::ABORT.as_raw()), "SIGABRT");
        assert_eq!(signal_name(1000), "SIG1000");
    }

    #[test]
    fn an_exit_status_ends_with_a_code_or_a_signal() {
        assert_eq!(ended(ExitStatus::from_raw(3 << 8)), Ended::Code(3));
        assert_eq!(ended(ExitStatus::from_raw(9)), Ended::Signal(9));
        assert_eq!(Ended::Code(3).status(), "3");
        assert_eq!(Ended::Signal(Signal::KILL.as_raw()).status(), "SIGKILL");
    }

    #[test]
    fn what_counts_as_a_failure() {
        assert_eq!(outcome(false, Ended::Code(0)), None);
        assert_eq!(outcome(false, Ended::Code(1)), Some(Outcome::ExitCode));
        assert_eq!(outcome(false, Ended::Signal(9)), Some(Outcome::Signal));
        assert_eq!(outcome(true, Ended::Code(0)), Some(Outcome::Timeout));
        assert_eq!(outcome(true, Ended::Signal(15)), Some(Outcome::Timeout));
        assert_eq!(Outcome::Timeout.name(), "timeout");
        assert_eq!(Outcome::ExitCode.name(), "exit-code");
        assert_eq!(Outcome::Signal.name(), "signal");
        assert_eq!(Outcome::Error.name(), "error");
    }

    #[test]
    fn log_names_hold_the_utc_start() {
        let start = at("2026-11-09T07:00:05.75Z");

        assert_eq!(log_name(start), "2026-11-09T07-00-05Z.log");
        assert_eq!(
            start_of("2026-11-09T07-00-05Z.log"),
            Some(at("2026-11-09T07:00:05Z"))
        );
        assert_eq!(start_of("2026-11-09T07-00-05Z.txt"), None);
        assert_eq!(start_of("2026-11-09T07:00:05Z.log"), None);
        assert_eq!(start_of("notes.log"), None);
    }

    #[test]
    fn the_newest_log_gives_the_last_start() {
        let scratch = Scratch::new();

        for name in [
            "2026-11-08T07-00-00Z.log",
            "2026-11-09T07-00-00Z.log",
            "2026-11-07T07-00-00Z.log",
            "other.txt",
        ] {
            fs::write(scratch.path().join(name), "").unwrap();
        }

        let newest = newest_start(scratch.path());

        assert_eq!(newest, Some(at("2026-11-09T07:00:00Z")));
        assert_eq!(newest_start(&scratch.path().join("missing")), None);
    }

    #[test]
    fn pruning_keeps_the_newest_and_any_log_in_use() {
        let scratch = Scratch::new();
        let names = [
            "2026-11-07T07-00-00Z.log",
            "2026-11-08T07-00-00Z.log",
            "2026-11-09T07-00-00Z.log",
            "2026-11-10T07-00-00Z.log",
        ];

        for name in names {
            fs::write(scratch.path().join(name), "").unwrap();
        }

        fs::write(scratch.path().join("notes.txt"), "").unwrap();
        let in_use = [scratch.path().join(names[0])];

        prune(scratch.path(), 2, &in_use);

        let mut left: Vec<String> = fs::read_dir(scratch.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(left, [names[0], names[2], names[3], "notes.txt"]);
    }

    #[test]
    fn pruning_below_the_count_deletes_nothing() {
        let scratch = Scratch::new();
        fs::write(scratch.path().join("2026-11-07T07-00-00Z.log"), "").unwrap();

        prune(scratch.path(), 1, &[]);

        assert!(scratch.path().join("2026-11-07T07-00-00Z.log").exists());
    }

    #[test]
    fn a_log_and_its_folder_are_private() {
        let scratch = Scratch::new();
        let dir = scratch.path().join("jobs").join("daily");

        drop(open_log(&dir, "2026-11-09T07-00-00Z.log").unwrap());

        let folder = fs::metadata(&dir).unwrap().permissions().mode();
        let file = fs::metadata(dir.join("2026-11-09T07-00-00Z.log"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(folder & 0o777, 0o700);
        assert_eq!(file & 0o777, 0o600);
    }
}
