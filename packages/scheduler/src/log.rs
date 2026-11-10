use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::ops::RangeInclusive;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};

use jiff::Timestamp;
use serde_json::Value;

// A run writes about 300 bytes of records, so this holds about four months of a job every five
// minutes.
pub const ROTATE_AT: u64 = 10 * 1024 * 1024;

const NAME: &str = "scheduler.log";

const ROTATED: &str = "scheduler.log.1";

// JSON escapes U+0000 to U+001F but leaves DEL and the C1 controls as they are, and a terminal can
// read one of those as the start of an escape sequence. The agent's records escape them too.
const UNESCAPED: RangeInclusive<char> = '\u{7f}'..='\u{9f}';

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}

// As JavaScript's toISOString writes the agent's record times.
pub fn time(at: Timestamp) -> String {
    format!("{at:.3}")
}

// The mode applies only when the file is created, so an existing file keeps its own.
pub fn open_private(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
}

fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len());

    for character in text.chars() {
        if UNESCAPED.contains(&character) {
            out.push_str(&format!("\\u{:04x}", u32::from(character)));
        } else {
            out.push(character);
        }
    }

    out
}

pub fn line(now: Timestamp, level: Level, message: &str, fields: &[(&str, Value)]) -> String {
    let mut line = format!(
        "{{\"time\":{},\"level\":{},\"message\":{}",
        Value::from(time(now)),
        Value::from(level.name()),
        Value::from(message),
    );

    for (key, value) in fields {
        line.push_str(&format!(",{}:{value}", Value::from(*key)));
    }

    line.push_str("}\n");

    escaped(&line)
}

pub struct Log {
    path: PathBuf,
    file: File,
    // Counted from the file's size at open, so that a record needs no stat.
    written: u64,
    cap: u64,
}

impl Log {
    pub fn open(dir: &Path, cap: u64) -> io::Result<Log> {
        let path = dir.join(NAME);
        let file = open_private(&path)?;
        let written = file.metadata()?.len();

        Ok(Log {
            path,
            file,
            written,
            cap,
        })
    }

    fn rotate_when_full(&mut self) {
        if self.written < self.cap {
            return;
        }

        // Nothing reads the log back, so a rename that fails only means writing on in this file.
        if fs::rename(&self.path, self.path.with_file_name(ROTATED)).is_err() {
            return;
        }

        if let Ok(file) = open_private(&self.path) {
            self.file = file;
            self.written = 0;
        }
    }

    pub fn record(
        &mut self,
        now: Timestamp,
        level: Level,
        message: &str,
        fields: &[(&str, Value)],
    ) {
        self.rotate_when_full();
        let line = line(now, level, message, fields);
        // The scheduler keeps running when its log can't take a record, as on a full disk.
        let _ = self.file.write_all(line.as_bytes());
        self.written += line.len() as u64;
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;

    use serde_json::json;

    use super::*;
    use crate::testing::Scratch;

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn a_record_holds_its_time_level_message_and_fields_in_order() {
        let fields = [
            ("job", json!("daily")),
            ("pid", json!(42)),
            ("jobs", json!([{ "name": "a", "next": "x" }])),
        ];

        let line = line(
            at("2026-11-10T07:00:05.25Z"),
            Level::Warn,
            "started",
            &fields,
        );

        assert_eq!(
            line,
            "{\"time\":\"2026-11-10T07:00:05.250Z\",\"level\":\"warn\",\"message\":\"started\",\
             \"job\":\"daily\",\"pid\":42,\"jobs\":[{\"name\":\"a\",\"next\":\"x\"}]}\n"
        );
    }

    #[test]
    fn times_have_milliseconds() {
        assert_eq!(time(at("2026-11-09T07:00:00Z")), "2026-11-09T07:00:00.000Z");
        assert_eq!(
            time(at("2026-11-09T07:00:00.123456Z")),
            "2026-11-09T07:00:00.123Z"
        );
    }

    #[test]
    fn each_level_has_its_name() {
        let now = at("2026-11-10T07:00:00Z");

        let info = line(now, Level::Info, "m", &[]);
        let error = line(now, Level::Error, "m", &[]);

        assert!(info.contains("\"level\":\"info\""), "{info}");
        assert!(error.contains("\"level\":\"error\""), "{error}");
    }

    #[test]
    fn control_characters_are_escaped() {
        let now = at("2026-11-10T07:00:00Z");

        let line = line(
            now,
            Level::Error,
            "error",
            &[("reason", json!("a\u{1b}b\u{9b}c\u{7e}\u{7f}\u{9f}\u{a0}"))],
        );

        assert!(
            line.contains("a\\u001bb\\u009bc\u{7e}\\u007f\\u009f\u{a0}"),
            "{line}"
        );
        assert!(!line.contains('\u{1b}'));
        assert!(!line.contains('\u{9b}'));
        let parsed: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed["reason"], "a\u{1b}b\u{9b}c\u{7e}\u{7f}\u{9f}\u{a0}");
    }

    #[test]
    fn a_new_log_has_mode_0600_and_takes_lines() {
        let scratch = Scratch::new();
        let mut log = Log::open(scratch.path(), ROTATE_AT).unwrap();

        log.record(at("2026-11-10T07:00:00Z"), Level::Info, "ready", &[]);
        log.record(at("2026-11-10T07:00:01Z"), Level::Info, "stopped", &[]);

        let path = scratch.path().join("scheduler.log");
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.ends_with("\"message\":\"stopped\"}\n"), "{text}");
    }

    #[test]
    fn the_log_rotates_once_it_reaches_its_cap() {
        let scratch = Scratch::new();
        let now = at("2026-11-10T07:00:00Z");
        let size = line(now, Level::Info, "one", &[]).len() as u64;
        fs::write(scratch.path().join("scheduler.log.1"), "older\n").unwrap();
        let mut log = Log::open(scratch.path(), 2 * size).unwrap();

        log.record(now, Level::Info, "one", &[]);
        log.record(now, Level::Info, "two", &[]);
        log.record(now, Level::Info, "six", &[]);

        let rotated = fs::read_to_string(scratch.path().join("scheduler.log.1")).unwrap();
        let current = fs::read_to_string(scratch.path().join("scheduler.log")).unwrap();
        assert_eq!(rotated.lines().count(), 2, "{rotated}");
        assert!(
            rotated.contains("\"one\"") && rotated.contains("\"two\""),
            "{rotated}"
        );
        assert_eq!(current.lines().count(), 1, "{current}");
        assert!(current.contains("\"six\""), "{current}");
        let mode = fs::metadata(scratch.path().join("scheduler.log"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_log_below_its_cap_stays() {
        let scratch = Scratch::new();
        let now = at("2026-11-10T07:00:00Z");
        let size = line(now, Level::Info, "one", &[]).len() as u64;
        let mut log = Log::open(scratch.path(), 2 * size + 1).unwrap();

        log.record(now, Level::Info, "one", &[]);
        log.record(now, Level::Info, "two", &[]);
        log.record(now, Level::Info, "six", &[]);

        let current = fs::read_to_string(scratch.path().join("scheduler.log")).unwrap();
        assert_eq!(current.lines().count(), 3, "{current}");
        assert!(!scratch.path().join("scheduler.log.1").exists());
    }

    #[test]
    fn the_size_at_open_counts_toward_the_cap() {
        let scratch = Scratch::new();
        let now = at("2026-11-10T07:00:00Z");
        fs::write(scratch.path().join("scheduler.log"), "0123456789").unwrap();
        let mut log = Log::open(scratch.path(), 10).unwrap();

        log.record(now, Level::Info, "ready", &[]);

        let rotated = fs::read_to_string(scratch.path().join("scheduler.log.1")).unwrap();
        let current = fs::read_to_string(scratch.path().join("scheduler.log")).unwrap();
        assert_eq!(rotated, "0123456789");
        assert!(current.contains("\"ready\""), "{current}");
    }

    #[test]
    fn a_rename_that_fails_writes_on_in_the_open_file() {
        let scratch = Scratch::new();
        let now = at("2026-11-10T07:00:00Z");
        let blocker = scratch.path().join("scheduler.log.1");
        fs::create_dir(&blocker).unwrap();
        fs::write(blocker.join("kept"), "").unwrap();
        let mut log = Log::open(scratch.path(), 1).unwrap();

        log.record(now, Level::Info, "one", &[]);
        log.record(now, Level::Info, "two", &[]);

        let current = fs::read_to_string(scratch.path().join("scheduler.log")).unwrap();
        assert_eq!(current.lines().count(), 2, "{current}");
    }
}
