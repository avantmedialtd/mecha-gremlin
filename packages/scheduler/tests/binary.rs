use std::fs::{self, DirBuilder, File};
use std::os::unix::fs::{DirBuilderExt as _, PermissionsExt as _};
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use rustix::process::{Pid, Signal};
use serde_json::Value;

const BINARY: &str = env!("CARGO_BIN_EXE_gremlin-scheduler");

// Every wait gives up after this and kills the scheduler, so that a mutant that hangs it fails a
// test rather than timing out.
const PATIENCE: Duration = Duration::from_secs(10);

const POLL: Duration = Duration::from_millis(20);

// Older than any schedule's latest fire, so the start's decision runs the job at once.
const OLD_LOG: &str = "2020-01-01T00-00-00Z.log";

static COUNT: AtomicU64 = AtomicU64::new(0);

struct Scratch {
    path: PathBuf,
}

impl Scratch {
    fn new() -> Scratch {
        let count = COUNT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gremlin-scheduler-binary-{}-{count}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();

        Scratch { path }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn records(data: &Path) -> Vec<Value> {
    let text = fs::read_to_string(data.join("scheduler.log")).unwrap_or_default();

    text.lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn messages(data: &Path) -> Vec<String> {
    records(data)
        .iter()
        .map(|record| record["message"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn mode(path: &Path) -> u32 {
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();

    names
}

struct Process {
    child: Child,
    reaped: bool,
}

impl Process {
    // In a group of its own, so that the cleanup's SIGKILL reaches it and whatever it left in its
    // group, and nothing of the test's.
    fn spawn(command: &mut Command, stdout: &Path, stderr: &Path) -> Process {
        let child = command
            .stdin(Stdio::null())
            .stdout(File::create(stdout).unwrap())
            .stderr(File::create(stderr).unwrap())
            .process_group(0)
            .spawn()
            .unwrap();

        Process {
            child,
            reaped: false,
        }
    }

    fn pid(&self) -> Pid {
        Pid::from_child(&self.child)
    }

    fn signal(&self, signal: Signal) {
        rustix::process::kill_process(self.pid(), signal).unwrap();
    }

    fn try_exit(&mut self) -> Option<ExitStatus> {
        let status = self.child.try_wait().unwrap()?;
        self.reaped = true;

        Some(status)
    }

    fn wait_exit(&mut self) -> ExitStatus {
        let deadline = Instant::now() + PATIENCE;

        loop {
            if let Some(status) = self.try_exit() {
                return status;
            }

            assert!(
                Instant::now() < deadline,
                "the process didn't exit within {PATIENCE:?}"
            );
            thread::sleep(POLL);
        }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // A reaped pid may be someone else's by now.
        if self.reaped {
            return;
        }

        let pid = self.pid();
        assert!(pid.as_raw_pid() > 1);
        let _ = rustix::process::kill_process_group(pid, Signal::KILL);
        let _ = self.child.wait();
    }
}

struct Fixture {
    scratch: Scratch,
    config: PathBuf,
    data: PathBuf,
}

struct Ran {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

impl Fixture {
    fn new(config: &str) -> Fixture {
        let scratch = Scratch::new();
        let path = scratch.path.join("scheduler.toml");
        let data = scratch.path.join("data");
        fs::write(&path, config).unwrap();
        fs::create_dir(&data).unwrap();

        Fixture {
            config: path,
            data,
            scratch,
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.scratch.path.join(name)
    }

    // As the scheduler creates the folder, which keeps a folder's mode as it finds it.
    fn seed(&self, job: &str) {
        let dir = self.data.join("jobs").join(job);
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .unwrap();
        fs::write(dir.join(OLD_LOG), "").unwrap();
    }

    fn rewrite(&self, config: &str) {
        fs::write(&self.config, config).unwrap();
    }

    fn command(&self, arguments: &[&str]) -> Command {
        let mut command = Command::new(BINARY);
        command.args(arguments).current_dir(&self.scratch.path);

        command
    }

    fn ran(&self, arguments: &[&str]) -> Ran {
        let (stdout, stderr) = (self.path("cli.out"), self.path("cli.err"));
        let mut process = Process::spawn(&mut self.command(arguments), &stdout, &stderr);

        let status = process.wait_exit();

        Ran {
            status,
            stdout: fs::read_to_string(stdout).unwrap(),
            stderr: fs::read_to_string(stderr).unwrap(),
        }
    }

    fn start_with(&self, data: &Path, configure: impl FnOnce(&mut Command)) -> Scheduler {
        let mut command = self.command(&[
            "run",
            "--config",
            self.config.to_str().unwrap(),
            "--data-dir",
            data.to_str().unwrap(),
        ]);
        configure(&mut command);
        let count = COUNT.fetch_add(1, Ordering::Relaxed);
        let stderr = self.path(&format!("scheduler-{count}.err"));
        let process = Process::spawn(
            &mut command,
            &self.path(&format!("scheduler-{count}.out")),
            &stderr,
        );

        Scheduler {
            process,
            data: data.to_path_buf(),
            stderr,
        }
    }

    fn start(&self) -> Scheduler {
        self.start_with(&self.data, |_| {})
    }

    fn job_log(&self, job: &str) -> PathBuf {
        let dir = self.data.join("jobs").join(job);
        let name = listing(&dir)
            .into_iter()
            .find(|name| name != OLD_LOG)
            .unwrap_or_else(|| panic!("{job} has no run log"));

        dir.join(name)
    }

    fn wait_for_log(&self, job: &str, text: &str) -> String {
        let deadline = Instant::now() + PATIENCE;

        loop {
            let dir = self.data.join("jobs").join(job);
            let found = listing(&dir)
                .into_iter()
                .filter(|name| name != OLD_LOG)
                .map(|name| fs::read_to_string(dir.join(name)).unwrap_or_default())
                .find(|log| log.contains(text));

            if let Some(log) = found {
                return log;
            }

            assert!(Instant::now() < deadline, "{job}'s log never held {text:?}");
            thread::sleep(POLL);
        }
    }
}

struct Scheduler {
    process: Process,
    data: PathBuf,
    stderr: PathBuf,
}

impl Scheduler {
    fn wait_for(&mut self, what: &str, test: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + PATIENCE;

        loop {
            if let Some(record) = records(&self.data).into_iter().find(|record| test(record)) {
                return record;
            }

            if let Some(status) = self.process.try_exit() {
                panic!(
                    "the scheduler exited with {status} before {what}: {:?}, stderr {:?}",
                    messages(&self.data),
                    fs::read_to_string(&self.stderr).unwrap_or_default()
                );
            }

            assert!(
                Instant::now() < deadline,
                "no {what} within {PATIENCE:?}: {:?}",
                messages(&self.data)
            );
            thread::sleep(POLL);
        }
    }

    fn wait_for_message(&mut self, message: &str) -> Value {
        self.wait_for(message, |record| record["message"] == message)
    }

    fn wait_for_job(&mut self, message: &str, job: &str) -> Value {
        self.wait_for(&format!("{message} for {job}"), |record| {
            record["message"] == message && record["job"] == job
        })
    }
}

// A seeded job whose next fire is next year runs once, as a catch-up, and no other fire comes
// while the test runs.
fn one_run(command: &str, stop_grace: &str, timeout: &str) -> String {
    format!(
        "timezone = \"UTC\"\nstop_grace = \"{stop_grace}\"\ncommand = [\"/bin/sh\", \"-c\", {command:?}]\n\n[[job]]\nname = \"job\"\nschedule = \"0 0 1 1 *\"\ntimeout = \"{timeout}\"\n"
    )
}

fn usage_refused(ran: &Ran) {
    assert_eq!(ran.status.code(), Some(1), "{}", ran.stderr);
    assert!(ran.stderr.contains("Usage:"), "{}", ran.stderr);
    assert!(
        ran.stderr.contains("--config <file> --data-dir <dir>"),
        "{}",
        ran.stderr
    );
    assert!(ran.stdout.is_empty(), "{}", ran.stdout);
}

#[test]
fn a_missing_or_unknown_subcommand_is_refused() {
    let fixture = Fixture::new("command = [\"/bin/true\"]\n");
    let data = fixture.data.to_str().unwrap();
    let config = fixture.config.to_str().unwrap();

    let missing = fixture.ran(&["--config", config, "--data-dir", data]);
    let unknown = fixture.ran(&["start", "--config", config, "--data-dir", data]);
    let nothing = fixture.ran(&[]);

    usage_refused(&missing);
    usage_refused(&unknown);
    usage_refused(&nothing);
    assert!(
        unknown
            .stderr
            .starts_with("gremlin-scheduler: `start` isn't a subcommand\n"),
        "{}",
        unknown.stderr
    );
    assert!(listing(&fixture.data).is_empty());
}

#[test]
fn missing_unknown_and_repeated_options_are_refused() {
    let fixture = Fixture::new("command = [\"/bin/true\"]\n");
    let data = fixture.data.to_str().unwrap();
    let config = fixture.config.to_str().unwrap();

    let missing = fixture.ran(&["run", "--config", config]);
    let unknown = fixture.ran(&["run", "--config", config, "--data-dir", data, "--verbose"]);
    let repeated = fixture.ran(&[
        "run",
        "--config",
        config,
        "--config",
        config,
        "--data-dir",
        data,
    ]);
    let checked = fixture.ran(&["check", "--config", config, "--data-dir", data]);

    usage_refused(&missing);
    assert!(
        missing.stderr.contains("--data-dir is missing"),
        "{}",
        missing.stderr
    );
    usage_refused(&unknown);
    usage_refused(&repeated);
    usage_refused(&checked);
    assert!(listing(&fixture.data).is_empty());
}

#[test]
fn help_and_version_go_to_stdout() {
    let fixture = Fixture::new("");

    let help = fixture.ran(&["--help"]);
    let version = fixture.ran(&["--version"]);

    assert_eq!(help.status.code(), Some(0));
    assert!(
        help.stdout
            .starts_with("Usage:\n  gremlin-scheduler run --config <file> --data-dir <dir>\n"),
        "{}",
        help.stdout
    );
    assert!(
        help.stdout.contains("gremlin-scheduler uninstall\n"),
        "{}",
        help.stdout
    );
    assert!(help.stderr.is_empty());
    assert_eq!(version.status.code(), Some(0));
    assert_eq!(
        version.stdout,
        format!("gremlin-scheduler {}\n", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn check_prints_the_fires_and_writes_nothing() {
    let fixture = Fixture::new(
        "timezone = \"America/New_York\"\ncommand = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n",
    );
    let before = listing(&fixture.scratch.path);

    let ran = fixture.ran(&["check", "--config", fixture.config.to_str().unwrap()]);

    assert_eq!(ran.status.code(), Some(0), "{}", ran.stderr);
    let lines: Vec<&str> = ran.stdout.lines().collect();
    assert_eq!(lines[..3], ["Zone: America/New_York", "", "daily"]);
    assert_eq!(lines.len(), 8, "{}", ran.stdout);
    assert!(
        lines[3..].iter().all(|line| {
            line.starts_with("  ")
                && (line.ends_with("T07:00:00-05:00") || line.ends_with("T07:00:00-04:00"))
        }),
        "{}",
        ran.stdout
    );
    let after: Vec<String> = listing(&fixture.scratch.path)
        .into_iter()
        .filter(|name| !name.starts_with("cli."))
        .collect();
    assert_eq!(after, before);
    assert!(listing(&fixture.data).is_empty());
}

#[test]
fn check_refuses_a_broken_config() {
    let fixture = Fixture::new(
        "command = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedul = \"0 7 * * *\"\n",
    );

    let ran = fixture.ran(&["check", "--config", fixture.config.to_str().unwrap()]);

    assert_eq!(ran.status.code(), Some(1));
    assert!(
        ran.stderr.contains("line 5: unknown field `schedul`"),
        "{}",
        ran.stderr
    );
    assert!(ran.stdout.is_empty());
}

#[test]
fn a_bad_config_or_data_directory_starts_nothing() {
    let fixture = Fixture::new(
        "command = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedul = \"0 7 * * *\"\n",
    );
    let file = fixture.path("file");
    fs::write(&file, "").unwrap();
    let good = fixture.path("good.toml");
    fs::write(&good, "command = [\"/bin/true\"]\n").unwrap();
    let missing = fixture.path("missing");

    let bad_config = fixture.ran(&[
        "run",
        "--config",
        fixture.config.to_str().unwrap(),
        "--data-dir",
        fixture.data.to_str().unwrap(),
    ]);
    let no_data = fixture.ran(&[
        "run",
        "--config",
        good.to_str().unwrap(),
        "--data-dir",
        missing.to_str().unwrap(),
    ]);
    let file_data = fixture.ran(&[
        "run",
        "--config",
        good.to_str().unwrap(),
        "--data-dir",
        file.to_str().unwrap(),
    ]);

    assert_eq!(bad_config.status.code(), Some(1));
    assert!(
        bad_config.stderr.contains(&format!(
            "{}: line 5: unknown field `schedul`",
            fixture.config.display()
        )),
        "{}",
        bad_config.stderr
    );
    assert!(listing(&fixture.data).is_empty());
    assert_eq!(no_data.status.code(), Some(1));
    assert!(
        no_data.stderr.contains(&missing.display().to_string()),
        "{}",
        no_data.stderr
    );
    assert!(!missing.exists());
    assert_eq!(file_data.status.code(), Some(1));
    assert!(
        file_data.stderr.contains(&file.display().to_string()),
        "{}",
        file_data.stderr
    );
}

#[test]
fn a_clean_start_records_ready() {
    let fixture = Fixture::new(
        "timezone = \"UTC\"\ncommand = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n",
    );
    let mut scheduler = fixture.start();

    let ready = scheduler.wait_for_message("ready");

    assert_eq!(ready["zone"], "UTC");
    assert_eq!(ready["jobs"][0]["name"], "daily");
    assert!(
        ready["jobs"][0]["next"]
            .as_str()
            .unwrap()
            .ends_with("T07:00:00.000Z"),
        "{ready}"
    );
    assert!(scheduler.process.try_exit().is_none());
    assert_eq!(mode(&fixture.data.join("scheduler.log")), 0o600);
    assert_eq!(mode(&fixture.data.join("lock")), 0o600);
}

#[test]
fn one_scheduler_per_data_directory_until_it_dies() {
    let fixture = Fixture::new("timezone = \"UTC\"\ncommand = [\"/bin/true\"]\n");
    let mut first = fixture.start();
    first.wait_for_message("ready");

    let mut second = fixture.start();
    let refused = second.process.wait_exit();
    first.process.signal(Signal::KILL);
    first.process.wait_exit();
    let mut third = fixture.start();
    third.wait_for("a second ready", |_| {
        messages(&fixture.data)
            .iter()
            .filter(|message| *message == "ready")
            .count()
            == 2
    });

    assert_eq!(refused.code(), Some(1));
    let stderr = fs::read_to_string(&second.stderr).unwrap();
    assert_eq!(
        stderr,
        format!(
            "gremlin-scheduler: another scheduler is using {}\n",
            fixture.data.display()
        )
    );
}

#[test]
fn a_full_log_is_rotated_at_the_start() {
    let fixture = Fixture::new("timezone = \"UTC\"\ncommand = [\"/bin/true\"]\n");
    fs::write(
        fixture.data.join("scheduler.log"),
        vec![b'x'; 10 * 1024 * 1024],
    )
    .unwrap();
    fs::write(fixture.data.join("scheduler.log.1"), "older\n").unwrap();
    let mut scheduler = fixture.start();

    scheduler.wait_for_message("ready");

    assert_eq!(
        fs::metadata(fixture.data.join("scheduler.log.1"))
            .unwrap()
            .len(),
        10 * 1024 * 1024
    );
    let text = fs::read_to_string(fixture.data.join("scheduler.log")).unwrap();
    assert!(text.starts_with("{\"time\":"), "{text}");
    assert!(
        text.lines()
            .next()
            .unwrap()
            .contains("\"message\":\"ready\""),
        "{text}"
    );
    assert_eq!(mode(&fixture.data.join("scheduler.log")), 0o600);
}

#[test]
fn a_log_below_10_mib_stays() {
    let fixture = Fixture::new("timezone = \"UTC\"\ncommand = [\"/bin/true\"]\n");
    let mut seeded = vec![b'x'; 10 * 1024 * 1024 - 1];
    *seeded.last_mut().unwrap() = b'\n';
    fs::write(fixture.data.join("scheduler.log"), &seeded).unwrap();
    let mut scheduler = fixture.start();

    scheduler.wait_for_message("ready");

    assert!(!fixture.data.join("scheduler.log.1").exists());
    let size = fs::metadata(fixture.data.join("scheduler.log"))
        .unwrap()
        .len();
    assert!(size > 10 * 1024 * 1024, "{size}");
}

#[test]
fn a_run_gets_its_command_folder_environment_and_slot() {
    let fixture = Fixture::new("");
    let work = fixture.path("work");
    fs::create_dir(&work).unwrap();
    fixture.rewrite(
        r#"timezone = "UTC"
working_dir = "work"
command = ["/bin/sh", "-c", "pwd -P; echo out-$A-$B-$OUTSIDE; echo err >&2; echo job=$GREMLIN_JOB slot=$GREMLIN_SLOT catch=${GREMLIN_CATCH_UP-unset}; echo args=$0 $1; exit 3", "run"]
env = { A = "1", B = "top", GREMLIN_CATCH_UP = "1" }

[[job]]
name = "digest"
schedule = "* * * * *"
args = ["tasks/a.md"]
env = { B = "job" }

[[job]]
name = "yearly"
schedule = "0 0 1 1 *"
"#,
    );
    fixture.seed("digest");
    fixture.seed("yearly");
    let mut scheduler = fixture.start_with(&fixture.data, |command| {
        command.env("OUTSIDE", "yes");
    });

    let started = scheduler.wait_for_job("started", "digest");
    let exited = scheduler.wait_for_job("exited", "digest");
    scheduler.wait_for_job("exited", "yearly");

    let log_path = fixture.job_log("digest");
    let log = fs::read_to_string(&log_path).unwrap();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(lines[0], work.canonicalize().unwrap().display().to_string());
    assert!(log.contains("out-1-job-yes\n"), "{log}");
    assert!(log.contains("err\n"), "{log}");
    let slot = started["slot"].as_str().unwrap();
    assert!(slot.ends_with(":00.000Z"), "{started}");
    let gremlin_slot = format!("{}+00:00", &slot[..19]);
    assert!(
        log.contains(&format!("job=digest slot={gremlin_slot} catch=unset\n")),
        "{log}"
    );
    assert!(log.contains("args=run tasks/a.md\n"), "{log}");
    assert_eq!(
        started["log"],
        format!(
            "jobs/digest/{}",
            log_path.file_name().unwrap().to_str().unwrap()
        )
    );
    assert!(started["pid"].as_i64().unwrap() > 1, "{started}");
    assert_eq!(started["level"], "info");
    assert_eq!(exited["code"], 3);
    assert!(exited["seconds"].as_f64().unwrap() >= 0.0, "{exited}");
    assert_eq!(mode(&log_path), 0o600);
    assert_eq!(mode(log_path.parent().unwrap()), 0o700);
    let yearly = fs::read_to_string(fixture.job_log("yearly")).unwrap();
    assert!(yearly.contains("job=yearly slot="), "{yearly}");
    assert!(yearly.contains(" catch=1\n"), "{yearly}");
}

#[test]
fn a_failed_run_starts_on_failure_and_a_good_one_does_not() {
    let fixture = Fixture::new(
        r#"timezone = "UTC"
command = ["/bin/sh", "-c", "exit 1"]
on_failure = ["/bin/sh", "-c", "echo failed: $GREMLIN_JOB $GREMLIN_RESULT $GREMLIN_STATUS; echo log=$GREMLIN_LOG"]

[[job]]
name = "digest"
schedule = "0 0 1 1 *"

[[job]]
name = "fine"
schedule = "0 0 1 1 *"
command = ["/bin/sh", "-c", "echo fine; exit 0"]
"#,
    );
    fixture.seed("digest");
    fixture.seed("fine");
    let mut scheduler = fixture.start();

    scheduler.wait_for_job("exited", "digest");
    scheduler.wait_for_job("exited", "fine");
    let log = fixture.wait_for_log("digest", "failed: digest exit-code 1\n");
    thread::sleep(Duration::from_millis(300));

    let path = fixture.job_log("digest");
    assert!(log.contains(&format!("log={}\n", path.display())), "{log}");
    assert_eq!(
        fs::read_to_string(fixture.job_log("fine")).unwrap(),
        "fine\n"
    );
    assert!(
        !messages(&fixture.data).contains(&"error".to_string()),
        "{:?}",
        messages(&fixture.data)
    );
}

#[test]
fn a_program_that_does_not_exist_is_an_error() {
    let fixture = Fixture::new(
        "timezone = \"UTC\"\ncommand = [\"/nonexistent/program\"]\n\n[[job]]\nname = \"broken\"\nschedule = \"0 0 1 1 *\"\n",
    );
    fixture.seed("broken");
    let mut scheduler = fixture.start();

    let error = scheduler.wait_for_job("error", "broken");

    assert_eq!(error["level"], "error");
    assert!(
        error["reason"]
            .as_str()
            .unwrap()
            .starts_with("couldn't start /nonexistent/program: "),
        "{error}"
    );
    thread::sleep(Duration::from_millis(100));
    assert!(scheduler.process.try_exit().is_none());
}

fn gone(pid: Pid) -> bool {
    let deadline = Instant::now() + PATIENCE;

    loop {
        if rustix::process::test_kill_process(pid).is_err() {
            return true;
        }

        if Instant::now() >= deadline {
            return false;
        }

        thread::sleep(POLL);
    }
}

#[test]
fn a_timeout_sends_sigterm_to_the_runs_group() {
    let fixture = Fixture::new(&one_run("sleep 30 & echo $!; wait", "1s", "1s"));
    fixture.seed("job");
    let mut scheduler = fixture.start();

    let started = scheduler.wait_for_job("started", "job");
    let timed_out = scheduler.wait_for_job("timed out", "job");
    let exited = scheduler.wait_for_job("exited", "job");

    assert_eq!(timed_out["level"], "warn");
    assert_eq!(timed_out["pid"], started["pid"]);
    assert_eq!(exited["signal"], "SIGTERM");
    let log = fs::read_to_string(fixture.job_log("job")).unwrap();
    let sleep: i32 = log.trim().parse().unwrap();
    assert!(
        gone(Pid::from_raw(sleep).unwrap()),
        "the run's sleep is still there"
    );
}

#[test]
fn a_run_that_ignores_sigterm_gets_sigkill_after_the_grace() {
    let fixture = Fixture::new(&one_run("trap '' TERM; sleep 30", "1s", "1s"));
    fixture.seed("job");
    let mut scheduler = fixture.start();

    scheduler.wait_for_job("timed out", "job");
    let exited = scheduler.wait_for_job("exited", "job");

    assert_eq!(exited["signal"], "SIGKILL");
    assert!(exited["seconds"].as_f64().unwrap() >= 2.0, "{exited}");
}

#[test]
fn sigterm_while_idle_stops_the_scheduler() {
    let fixture =
        Fixture::new("timezone = \"UTC\"\nstop_grace = \"30s\"\ncommand = [\"/bin/true\"]\n");
    let mut scheduler = fixture.start();
    scheduler.wait_for_message("ready");

    scheduler.process.signal(Signal::TERM);
    let status = scheduler.process.wait_exit();

    assert_eq!(status.code(), Some(0));
    assert_eq!(messages(&fixture.data), ["ready", "stopping", "stopped"]);
    assert_eq!(records(&fixture.data)[1]["signal"], "SIGTERM");
}

fn stopped_with_a_run_going(signal: Signal, name: &str) {
    let fixture = Fixture::new(&one_run(
        "trap 'echo got-term; exit 0' TERM; echo started; sleep 30 & wait",
        "30s",
        "1h",
    ));
    fixture.seed("job");
    let mut scheduler = fixture.start();
    scheduler.wait_for_job("started", "job");
    fixture.wait_for_log("job", "started\n");

    scheduler.process.signal(signal);
    let status = scheduler.process.wait_exit();

    assert_eq!(status.code(), Some(0));
    assert_eq!(
        messages(&fixture.data),
        ["ready", "started", "stopping", "exited", "stopped"]
    );
    assert_eq!(records(&fixture.data)[2]["signal"], name);
    assert_eq!(records(&fixture.data)[3]["code"], 0);
    assert!(
        fs::read_to_string(fixture.job_log("job"))
            .unwrap()
            .contains("got-term\n")
    );
}

#[test]
fn sigint_with_a_run_going_stops_the_run_first() {
    stopped_with_a_run_going(Signal::INT, "SIGINT");
}

#[test]
fn sigterm_with_a_run_going_stops_the_run_first() {
    stopped_with_a_run_going(Signal::TERM, "SIGTERM");
}

#[test]
fn sighup_rereads_the_config() {
    let config = "timezone = \"UTC\"\ncommand = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n";
    let fixture = Fixture::new(config);
    let mut scheduler = fixture.start();
    scheduler.wait_for_message("ready");

    fixture.rewrite(&format!(
        "{config}\n[[job]]\nname = \"added\"\nschedule = \"* * * * *\"\n"
    ));
    scheduler.process.signal(Signal::HUP);
    let reloaded = scheduler.wait_for_message("config reloaded");
    fixture.rewrite(&format!("{config}schedul = \"0 8 * * *\"\n"));
    scheduler.process.signal(Signal::HUP);
    let refused = scheduler.wait_for_message("config refused");

    let names: Vec<&str> = reloaded["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|job| job["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["daily", "added"]);
    assert!(
        refused["reason"]
            .as_str()
            .unwrap()
            .contains("unknown field `schedul`"),
        "{refused}"
    );
    assert!(scheduler.process.try_exit().is_none());
}
