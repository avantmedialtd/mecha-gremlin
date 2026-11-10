use std::fs::{self, DirBuilder, File};
use std::io::{Read as _, Seek as _, SeekFrom, Write};
use std::os::unix::fs::DirBuilderExt as _;
use std::path::{self, Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use jiff::Timestamp;

use crate::config;
use crate::log::open_private;
use crate::schedule;
use crate::{LOCALTIME, LockError, lock};

pub const LABEL: &str = "local.gremlin-scheduler";

// launchd sends SIGKILL ExitTimeOut seconds after SIGTERM, so it must wait out the scheduler's own
// stop_grace, which ends with SIGKILL to the runs still going.
const EXIT_TIMEOUT_EXTRA: u64 = 15;

const TAIL_LINES: usize = 20;

#[derive(Debug)]
pub struct Answer {
    pub code: i32,
    pub output: String,
}

#[derive(Clone, Copy, Debug)]
pub struct Waits {
    // launchctl(1) doesn't say whether bootout waits for the process to end, so install waits for
    // the data directory's lock, for stop_grace plus this.
    pub lock_extra: Duration,
    pub ready: Duration,
    pub poll: Duration,
}

pub const WAITS: Waits = Waits {
    lock_extra: Duration::from_secs(15),
    ready: Duration::from_secs(10),
    poll: Duration::from_millis(100),
};

pub struct Host<'a> {
    pub system: &'a str,
    pub home: &'a Path,
    pub uid: u32,
    pub exe: &'a Path,
    pub path: Option<&'a str>,
    pub lang: Option<&'a str>,
    pub lc_all: Option<&'a str>,
    pub waits: Waits,
}

pub type Launchctl<'a> = dyn FnMut(&[&str]) -> Result<Answer, String> + 'a;

fn needs_macos(system: &str) -> Result<(), String> {
    if system == "macos" {
        return Ok(());
    }

    Err(format!(
        "this needs macOS, where launchd runs the scheduler, and this system is {system}; the README shows a systemd unit for Linux"
    ))
}

fn escaped(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn plist_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

pub fn plist(
    exe: &Path,
    config: &Path,
    data_dir: &Path,
    environment: &[(&str, &str)],
    exit_timeout: u64,
) -> String {
    let string = |value: &str| format!("<string>{}</string>", escaped(value));
    let data = data_dir.display().to_string();
    let mut text = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n",
    );
    text.push_str(&format!("\t<key>Label</key>\n\t{}\n", string(LABEL)));
    text.push_str("\t<key>ProgramArguments</key>\n\t<array>\n");

    for argument in [
        exe.display().to_string(),
        "run".to_string(),
        "--config".to_string(),
        config.display().to_string(),
        "--data-dir".to_string(),
        data.clone(),
    ] {
        text.push_str(&format!("\t\t{}\n", string(&argument)));
    }

    text.push_str("\t</array>\n");
    // KeepAlive implies RunAtLoad: launchd starts the scheduler at login and again whenever it
    // exits.
    text.push_str("\t<key>KeepAlive</key>\n\t<true/>\n");
    // Without it launchd throttles the job's CPU and I/O, and Standard is the same as leaving it
    // out.
    text.push_str(&format!(
        "\t<key>ProcessType</key>\n\t{}\n",
        string("Interactive")
    ));
    // launchd otherwise starts a job in /.
    text.push_str(&format!(
        "\t<key>WorkingDirectory</key>\n\t{}\n",
        string(&data)
    ));
    // launchd sets only a short PATH and no LANG, and the agent's .env can set neither.
    text.push_str("\t<key>EnvironmentVariables</key>\n\t<dict>\n");

    for (key, value) in environment {
        text.push_str(&format!(
            "\t\t<key>{}</key>\n\t\t{}\n",
            escaped(key),
            string(value)
        ));
    }

    text.push_str("\t</dict>\n");
    // launchd sends stderr to /dev/null unless it is set, which would hide why a start failed.
    text.push_str(&format!(
        "\t<key>StandardErrorPath</key>\n\t{}\n",
        string(&data_dir.join("stderr.log").display().to_string())
    ));
    text.push_str(&format!(
        "\t<key>ExitTimeOut</key>\n\t<integer>{exit_timeout}</integer>\n"
    ));
    text.push_str("</dict>\n</plist>\n");

    text
}

fn environment<'a>(host: &Host<'a>) -> Vec<(&'static str, &'a str)> {
    [
        ("PATH", host.path),
        ("LANG", host.lang),
        ("LC_ALL", host.lc_all),
    ]
    .into_iter()
    .filter_map(|(key, value)| Some((key, value?)))
    .collect()
}

fn launch(launchctl: &mut Launchctl, args: &[&str]) -> Result<(), String> {
    let answer = launchctl(args)?;

    if answer.code == 0 {
        return Ok(());
    }

    Err(format!(
        "launchctl {} failed with {}: {}",
        args.join(" "),
        answer.code,
        answer.output.trim()
    ))
}

fn loaded(launchctl: &mut Launchctl, service: &str) -> Result<bool, String> {
    Ok(launchctl(&["print", service])?.code == 0)
}

fn held(data_dir: &Path) -> String {
    format!("another scheduler is using {}", data_dir.display())
}

fn lock_free(data_dir: &Path) -> Result<bool, String> {
    match lock(data_dir) {
        Ok(_lock) => Ok(true),
        Err(LockError::Held) => Ok(false),
        Err(LockError::Failed(message)) => Err(message),
    }
}

fn wait_for_lock(data_dir: &Path, limit: Duration, poll: Duration) -> Result<(), String> {
    let deadline = Instant::now() + limit;

    loop {
        if lock_free(data_dir)? {
            return Ok(());
        }

        if deadline.saturating_duration_since(Instant::now()).is_zero() {
            return Err(format!(
                "{}, still after {} s, though its agent was booted out",
                held(data_dir),
                limit.as_secs_f64()
            ));
        }

        thread::sleep(poll);
    }
}

fn size(path: &Path) -> u64 {
    fs::metadata(path).map_or(0, |metadata| metadata.len())
}

fn ready_since(log: &Path, offset: u64) -> bool {
    let Ok(mut file) = File::open(log) else {
        return false;
    };

    let mut start = offset;

    // A scheduler that rotated its log as it started began a new file.
    if size(log) < offset {
        start = 0;
    }

    let mut text = String::new();

    if file.seek(SeekFrom::Start(start)).is_err() || file.read_to_string(&mut text).is_err() {
        return false;
    }

    text.contains("\"message\":\"ready\"")
}

fn wait_for_ready(log: &Path, offset: u64, limit: Duration, poll: Duration) -> bool {
    let deadline = Instant::now() + limit;

    loop {
        if ready_since(log, offset) {
            return true;
        }

        if deadline.saturating_duration_since(Instant::now()).is_zero() {
            return false;
        }

        thread::sleep(poll);
    }
}

fn tail(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();

    lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n")
}

pub fn install(
    host: &Host,
    config_path: &Path,
    data_dir: &Path,
    launchctl: &mut Launchctl,
    out: &mut dyn Write,
) -> Result<(), String> {
    needs_macos(host.system)?;
    let config = config::load(config_path, Timestamp::now())?;
    let data_dir =
        path::absolute(data_dir).map_err(|error| format!("{}: {error}", data_dir.display()))?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&data_dir)
        .map_err(|error| format!("couldn't create {}: {error}", data_dir.display()))?;
    // launchd would create it with the umask's mode.
    let stderr_log = data_dir.join("stderr.log");
    open_private(&stderr_log)
        .map_err(|error| format!("couldn't create {}: {error}", stderr_log.display()))?;
    let service = format!("gui/{}/{LABEL}", host.uid);

    if loaded(launchctl, &service)? {
        launch(launchctl, &["bootout", &service])?;
        wait_for_lock(
            &data_dir,
            config.stop_grace + host.waits.lock_extra,
            host.waits.poll,
        )?;
    } else if !lock_free(&data_dir)? {
        return Err(format!(
            "{}, and no agent is loaded; stop it first",
            held(&data_dir)
        ));
    }

    let plist_path = plist_path(host.home);
    let agents = plist_path.parent().unwrap_or(host.home);
    fs::create_dir_all(agents)
        .map_err(|error| format!("couldn't create {}: {error}", agents.display()))?;

    // An install from a second checkout repoints the agent, so it says so.
    if plist_path.exists() {
        let _ = writeln!(out, "Replacing {}.", plist_path.display());
    }

    let environment = environment(host);
    let text = plist(
        host.exe,
        &config.path,
        &data_dir,
        &environment,
        config.stop_grace.as_secs() + EXIT_TIMEOUT_EXTRA,
    );
    fs::write(&plist_path, text)
        .map_err(|error| format!("couldn't write {}: {error}", plist_path.display()))?;
    let _ = writeln!(
        out,
        "The agent runs {} run --config {} --data-dir {}",
        host.exe.display(),
        config.path.display(),
        data_dir.display()
    );

    for (key, value) in &environment {
        let _ = writeln!(out, "with {key}={value}");
    }

    let log = data_dir.join("scheduler.log");
    let offset = size(&log);
    launch(
        launchctl,
        &[
            "bootstrap",
            &format!("gui/{}", host.uid),
            &plist_path.display().to_string(),
        ],
    )?;

    if !wait_for_ready(&log, offset, host.waits.ready, host.waits.poll) {
        return Err(format!(
            "the agent is loaded, but the scheduler wrote no ready record within {} s, and `gremlin-scheduler uninstall` removes it. The end of {}:\n{}",
            host.waits.ready.as_secs_f64(),
            stderr_log.display(),
            tail(&stderr_log)
        ));
    }

    // Under launchd the scheduler gets no TZ, so it reads the zone /etc/localtime names.
    let zone = config
        .zone
        .clone()
        .unwrap_or_else(|| schedule::system_zone(None, Path::new(LOCALTIME)));
    let from = Timestamp::now().to_zoned(zone.tz);
    let _ = writeln!(out, "Installed {}.", plist_path.display());

    for job in &config.jobs {
        if let Some(next) = job.schedule.next_after(&from) {
            let _ = writeln!(
                out,
                "{}: next fire {}",
                job.name,
                schedule::with_offset(&next)
            );
        }
    }

    Ok(())
}

pub fn uninstall(
    host: &Host,
    launchctl: &mut Launchctl,
    out: &mut dyn Write,
) -> Result<(), String> {
    needs_macos(host.system)?;
    let service = format!("gui/{}/{LABEL}", host.uid);
    let plist_path = plist_path(host.home);
    let was_loaded = loaded(launchctl, &service)?;

    if was_loaded {
        launch(launchctl, &["bootout", &service])?;
        let _ = writeln!(out, "Booted out {service}.");
    }

    let had_plist = plist_path.exists();

    if had_plist {
        fs::remove_file(&plist_path)
            .map_err(|error| format!("couldn't delete {}: {error}", plist_path.display()))?;
        let _ = writeln!(out, "Deleted {}.", plist_path.display());
    }

    if !was_loaded && !had_plist {
        let _ = writeln!(
            out,
            "Nothing is installed: no agent is loaded as {LABEL}, and there is no {}.",
            plist_path.display()
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use super::*;
    use crate::testing::Scratch;

    const QUICK: Waits = Waits {
        lock_extra: Duration::from_millis(500),
        ready: Duration::from_secs(1),
        poll: Duration::from_millis(10),
    };

    const READY: &str = "{\"time\":\"2026-11-10T07:00:00.000Z\",\"level\":\"info\",\"message\":\"ready\",\"zone\":\"UTC\",\"jobs\":[]}\n";

    #[derive(Default)]
    struct Fake {
        calls: Vec<String>,
        loaded: bool,
        // The log that a bootstrap writes to, as a scheduler would, and what it writes.
        log: Option<PathBuf>,
        written: Option<&'static str>,
        written_after: Duration,
        // Held as an agent's scheduler would hold it, until a bootout, after this delay.
        lock: Option<File>,
        release_after: Duration,
        keep_lock: bool,
        failing: Option<&'static str>,
    }

    impl Fake {
        fn answer(&mut self, args: &[&str]) -> Result<Answer, String> {
            self.calls.push(args.join(" "));

            if self.failing == Some(args[0]) {
                return Ok(Answer {
                    code: 5,
                    output: "Input/output error\n".to_string(),
                });
            }

            let code = match args[0] {
                "print" if self.loaded => 0,
                "print" => 113,
                "bootout" => {
                    self.loaded = false;
                    let lock = self.lock.take();
                    let delay = self.release_after;

                    if self.keep_lock {
                        self.lock = lock;
                    } else {
                        thread::spawn(move || {
                            thread::sleep(delay);
                            drop(lock);
                        });
                    }

                    0
                }
                "bootstrap" => {
                    self.loaded = true;

                    if let (Some(log), Some(written)) = (self.log.clone(), self.written) {
                        let delay = self.written_after;

                        // Later than the bootstrap, as a scheduler that launchd starts writes it.
                        thread::spawn(move || {
                            thread::sleep(delay);
                            let mut file = open_private(&log).unwrap();
                            file.write_all(written.as_bytes()).unwrap();
                        });
                    }

                    0
                }
                other => panic!("launchctl {other} isn't expected"),
            };

            Ok(Answer {
                code,
                output: String::new(),
            })
        }
    }

    struct Setup {
        _scratch: Scratch,
        home: PathBuf,
        exe: PathBuf,
        data: PathBuf,
        config: PathBuf,
    }

    impl Setup {
        fn new(config: &str) -> Setup {
            let scratch = Scratch::new();
            let home = scratch.path().join("home");
            let data = scratch.path().join("data");
            let config_path = scratch.path().join("scheduler.toml");
            fs::create_dir(&home).unwrap();
            fs::write(&config_path, config).unwrap();

            Setup {
                home,
                exe: scratch.path().join("bin").join("gremlin-scheduler"),
                data,
                config: config_path,
                _scratch: scratch,
            }
        }

        fn host(&self, system: &'static str) -> Host<'_> {
            Host {
                system,
                home: &self.home,
                uid: 501,
                exe: &self.exe,
                path: Some("/opt/bin:/usr/bin"),
                lang: Some("en_GB.UTF-8"),
                lc_all: None,
                waits: QUICK,
            }
        }

        fn plist(&self) -> PathBuf {
            self.home
                .join("Library/LaunchAgents/local.gremlin-scheduler.plist")
        }

        fn fake(&self) -> Fake {
            Fake {
                log: Some(self.data.join("scheduler.log")),
                written: Some(READY),
                ..Fake::default()
            }
        }

        fn install(&self, system: &'static str, fake: &mut Fake) -> (Result<(), String>, String) {
            let mut out = Vec::new();

            let result = install(
                &self.host(system),
                &self.config,
                &self.data,
                &mut |args: &[&str]| fake.answer(args),
                &mut out,
            );

            (result, String::from_utf8(out).unwrap())
        }

        fn uninstall(&self, system: &'static str, fake: &mut Fake) -> (Result<(), String>, String) {
            let mut out = Vec::new();

            let result = uninstall(
                &self.host(system),
                &mut |args: &[&str]| fake.answer(args),
                &mut out,
            );

            (result, String::from_utf8(out).unwrap())
        }

        fn hold_lock(&self) -> File {
            fs::create_dir_all(&self.data).unwrap();

            let Ok(file) = lock(&self.data) else {
                panic!("the lock was taken");
            };

            file
        }
    }

    const CONFIG: &str = "timezone = \"UTC\"\nstop_grace = \"1s\"\ncommand = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n";

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_first_install() {
        let setup = Setup::new(CONFIG);
        let mut fake = Fake {
            written_after: Duration::from_millis(50),
            ..setup.fake()
        };

        let (result, out) = setup.install("macos", &mut fake);

        assert_eq!(result, Ok(()));
        assert_eq!(
            fake.calls,
            [
                "print gui/501/local.gremlin-scheduler".to_string(),
                format!("bootstrap gui/501 {}", setup.plist().display())
            ]
        );
        assert_eq!(mode(&setup.data), 0o700);
        assert_eq!(mode(&setup.data.join("stderr.log")), 0o600);
        let plist = fs::read_to_string(setup.plist()).unwrap();
        assert!(
            plist.contains(&format!("<string>{}</string>", setup.config.display())),
            "{plist}"
        );
        assert!(plist.contains("<integer>16</integer>"), "{plist}");
        assert!(!out.contains("Replacing"), "{out}");
        assert!(
            out.contains(&format!(
                "The agent runs {} run --config {} --data-dir {}",
                setup.exe.display(),
                setup.config.display(),
                setup.data.display()
            )),
            "{out}"
        );
        assert!(
            out.contains("with PATH=/opt/bin:/usr/bin\nwith LANG=en_GB.UTF-8\n"),
            "{out}"
        );
        assert!(
            out.contains(&format!("Installed {}.", setup.plist().display())),
            "{out}"
        );
        assert!(out.contains("daily: next fire "), "{out}");
        assert!(out.trim_end().ends_with("T07:00:00+00:00"), "{out}");
    }

    #[test]
    fn installing_again_boots_out_waits_for_the_lock_and_replaces_the_plist() {
        let setup = Setup::new(CONFIG);
        fs::create_dir_all(setup.plist().parent().unwrap()).unwrap();
        fs::write(setup.plist(), "old").unwrap();
        let mut fake = Fake {
            loaded: true,
            lock: Some(setup.hold_lock()),
            release_after: Duration::from_millis(100),
            ..setup.fake()
        };

        let (result, out) = setup.install("macos", &mut fake);

        assert_eq!(result, Ok(()));
        assert_eq!(
            fake.calls,
            [
                "print gui/501/local.gremlin-scheduler".to_string(),
                "bootout gui/501/local.gremlin-scheduler".to_string(),
                format!("bootstrap gui/501 {}", setup.plist().display())
            ]
        );
        assert!(
            out.starts_with(&format!("Replacing {}.\n", setup.plist().display())),
            "{out}"
        );
        assert_ne!(fs::read_to_string(setup.plist()).unwrap(), "old");
    }

    #[test]
    fn a_config_that_fails_its_check_changes_nothing() {
        let setup = Setup::new(
            "command = [\"/bin/true\"]\n\n[[job]]\nname = \"a\"\nschedul = \"0 7 * * *\"\n",
        );
        let mut fake = setup.fake();

        let (result, _) = setup.install("macos", &mut fake);

        let message = result.unwrap_err();
        assert!(message.contains("unknown field `schedul`"), "{message}");
        assert!(fake.calls.is_empty());
        assert!(!setup.data.exists());
        assert!(!setup.home.join("Library").exists());
    }

    #[test]
    fn a_lock_held_with_no_agent_loaded_fails_at_once() {
        let setup = Setup::new(CONFIG);
        let _lock = setup.hold_lock();
        let mut fake = setup.fake();

        let (result, _) = setup.install("macos", &mut fake);

        assert_eq!(
            result,
            Err(format!(
                "another scheduler is using {}, and no agent is loaded; stop it first",
                setup.data.display()
            ))
        );
        assert_eq!(fake.calls, ["print gui/501/local.gremlin-scheduler"]);
        assert!(!setup.plist().exists());
    }

    #[test]
    fn a_lock_held_past_the_wait_fails_before_loading() {
        let setup = Setup::new(CONFIG);
        let mut fake = Fake {
            loaded: true,
            lock: Some(setup.hold_lock()),
            keep_lock: true,
            ..setup.fake()
        };
        let started = Instant::now();

        let (result, _) = setup.install("macos", &mut fake);

        let waited = started.elapsed();
        assert_eq!(
            result,
            Err(format!(
                "another scheduler is using {}, still after 1.5 s, though its agent was booted out",
                setup.data.display()
            ))
        );
        assert!(waited >= Duration::from_millis(1500), "{waited:?}");
        assert_eq!(
            fake.calls,
            [
                "print gui/501/local.gremlin-scheduler",
                "bootout gui/501/local.gremlin-scheduler"
            ]
        );
        assert!(!setup.plist().exists());
    }

    #[test]
    fn no_ready_record_prints_the_end_of_stderr_log() {
        let setup = Setup::new(CONFIG);
        fs::create_dir_all(&setup.data).unwrap();
        fs::write(setup.data.join("scheduler.log"), READY).unwrap();
        let lines: Vec<String> = (1..=25).map(|number| format!("line {number}")).collect();
        fs::write(setup.data.join("stderr.log"), lines.join("\n")).unwrap();
        let mut fake = Fake {
            written: Some("{\"message\":\"error\"}\n"),
            ..setup.fake()
        };

        let (result, _) = setup.install("macos", &mut fake);

        let message = result.unwrap_err();
        assert!(
            message.starts_with(&format!(
                "the agent is loaded, but the scheduler wrote no ready record within 1 s, and `gremlin-scheduler uninstall` removes it. The end of {}:\nline 6\n",
                setup.data.join("stderr.log").display()
            )),
            "{message}"
        );
        assert!(message.ends_with("\nline 25"), "{message}");
        assert!(fake.calls.last().unwrap().starts_with("bootstrap "));
    }

    #[test]
    fn a_ready_record_from_before_the_load_does_not_count() {
        let setup = Setup::new(CONFIG);
        fs::create_dir_all(&setup.data).unwrap();
        fs::write(setup.data.join("scheduler.log"), READY).unwrap();
        let mut fake = Fake {
            written: None,
            ..setup.fake()
        };

        let (result, _) = setup.install("macos", &mut fake);

        assert!(result.is_err());
    }

    #[test]
    fn a_rotated_log_is_read_from_its_start() {
        let setup = Setup::new(CONFIG);
        fs::create_dir_all(&setup.data).unwrap();
        fs::write(setup.data.join("scheduler.log"), "x".repeat(4096)).unwrap();
        let log = setup.data.join("scheduler.log");

        fs::write(&log, READY).unwrap();

        assert!(ready_since(&log, 4096));
        assert!(!ready_since(&log, READY.len() as u64));
        assert!(!ready_since(&log, READY.len() as u64 - 5));
        assert!(!ready_since(&setup.data.join("missing.log"), 0));
    }

    #[test]
    fn a_launchctl_failure_stops_the_install() {
        let setup = Setup::new(CONFIG);
        let mut fake = Fake {
            failing: Some("bootstrap"),
            ..setup.fake()
        };

        let (result, _) = setup.install("macos", &mut fake);

        assert_eq!(
            result,
            Err(format!(
                "launchctl bootstrap gui/501 {} failed with 5: Input/output error",
                setup.plist().display()
            ))
        );
    }

    #[test]
    fn install_needs_macos() {
        let setup = Setup::new(CONFIG);
        let mut fake = setup.fake();

        let (result, _) = setup.install("linux", &mut fake);

        assert_eq!(
            result,
            Err("this needs macOS, where launchd runs the scheduler, and this system is linux; the README shows a systemd unit for Linux".to_string())
        );
        assert!(fake.calls.is_empty());
        assert!(!setup.data.exists());
        assert!(!setup.home.join("Library").exists());
    }

    #[test]
    fn the_plist_holds_every_key_with_its_values_escaped() {
        let text = plist(
            Path::new("/Users/a&b/.cargo/bin/gremlin-scheduler"),
            Path::new("/Users/a&b/<config>.toml"),
            Path::new("/Users/a&b/data"),
            &[("PATH", "/opt/a&b:/usr/bin"), ("LANG", "en_GB.UTF-8")],
            45,
        );

        assert_eq!(
            text,
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
\t<key>Label</key>
\t<string>local.gremlin-scheduler</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/Users/a&amp;b/.cargo/bin/gremlin-scheduler</string>
\t\t<string>run</string>
\t\t<string>--config</string>
\t\t<string>/Users/a&amp;b/&lt;config&gt;.toml</string>
\t\t<string>--data-dir</string>
\t\t<string>/Users/a&amp;b/data</string>
\t</array>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>WorkingDirectory</key>
\t<string>/Users/a&amp;b/data</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/opt/a&amp;b:/usr/bin</string>
\t\t<key>LANG</key>
\t\t<string>en_GB.UTF-8</string>
\t</dict>
\t<key>StandardErrorPath</key>
\t<string>/Users/a&amp;b/data/stderr.log</string>
\t<key>ExitTimeOut</key>
\t<integer>45</integer>
</dict>
</plist>
"
        );
    }

    #[test]
    fn the_environment_takes_what_is_set() {
        let setup = Setup::new(CONFIG);
        let host = Host {
            path: None,
            lang: Some("C"),
            lc_all: Some("en_US.UTF-8"),
            ..setup.host("macos")
        };

        assert_eq!(
            environment(&host),
            [("LANG", "C"), ("LC_ALL", "en_US.UTF-8")]
        );
    }

    #[test]
    fn uninstalling_a_loaded_agent() {
        let setup = Setup::new(CONFIG);
        fs::create_dir_all(setup.plist().parent().unwrap()).unwrap();
        fs::write(setup.plist(), "plist").unwrap();
        fs::create_dir_all(&setup.data).unwrap();
        let mut fake = Fake {
            loaded: true,
            ..setup.fake()
        };

        let (result, out) = setup.uninstall("macos", &mut fake);

        assert_eq!(result, Ok(()));
        assert_eq!(
            fake.calls,
            [
                "print gui/501/local.gremlin-scheduler",
                "bootout gui/501/local.gremlin-scheduler"
            ]
        );
        assert!(!setup.plist().exists());
        assert!(setup.data.exists());
        assert_eq!(
            out,
            format!(
                "Booted out gui/501/local.gremlin-scheduler.\nDeleted {}.\n",
                setup.plist().display()
            )
        );
    }

    #[test]
    fn uninstalling_a_plist_that_is_not_loaded() {
        let setup = Setup::new(CONFIG);
        fs::create_dir_all(setup.plist().parent().unwrap()).unwrap();
        fs::write(setup.plist(), "plist").unwrap();
        let mut fake = setup.fake();

        let (result, out) = setup.uninstall("macos", &mut fake);

        assert_eq!(result, Ok(()));
        assert_eq!(fake.calls, ["print gui/501/local.gremlin-scheduler"]);
        assert_eq!(out, format!("Deleted {}.\n", setup.plist().display()));
    }

    #[test]
    fn uninstalling_a_loaded_agent_with_no_plist() {
        let setup = Setup::new(CONFIG);
        let mut fake = Fake {
            loaded: true,
            ..setup.fake()
        };

        let (result, out) = setup.uninstall("macos", &mut fake);

        assert_eq!(result, Ok(()));
        assert_eq!(out, "Booted out gui/501/local.gremlin-scheduler.\n");
    }

    #[test]
    fn uninstalling_nothing() {
        let setup = Setup::new(CONFIG);
        let mut fake = setup.fake();

        let (result, out) = setup.uninstall("macos", &mut fake);

        assert_eq!(result, Ok(()));
        assert_eq!(fake.calls, ["print gui/501/local.gremlin-scheduler"]);
        assert_eq!(
            out,
            format!(
                "Nothing is installed: no agent is loaded as local.gremlin-scheduler, and there is no {}.\n",
                setup.plist().display()
            )
        );
    }

    #[test]
    fn uninstall_needs_macos() {
        let setup = Setup::new(CONFIG);
        let mut fake = setup.fake();

        let (result, _) = setup.uninstall("linux", &mut fake);

        assert!(result.unwrap_err().starts_with("this needs macOS"));
        assert!(fake.calls.is_empty());
    }

    #[test]
    fn a_failed_bootout_stops_the_uninstall() {
        let setup = Setup::new(CONFIG);
        fs::create_dir_all(setup.plist().parent().unwrap()).unwrap();
        fs::write(setup.plist(), "plist").unwrap();
        let mut fake = Fake {
            loaded: true,
            failing: Some("bootout"),
            ..setup.fake()
        };

        let (result, _) = setup.uninstall("macos", &mut fake);

        assert_eq!(
            result,
            Err("launchctl bootout gui/501/local.gremlin-scheduler failed with 5: Input/output error".to_string())
        );
        assert!(setup.plist().exists());
    }
}
