use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::ops::Range;
use std::path::{self, Path, PathBuf};
use std::time::Duration;

use jiff::Timestamp;
use jiff::civil::DateTime;
use serde::Deserialize;
use toml::Spanned;
use toml::value::Datetime;

use crate::schedule::{self, Schedule, Zone};

// Nothing else bounds a whole agent run, and an hour covers the slowest browsing tasks measured.
const TIMEOUT: Duration = Duration::from_secs(60 * 60);

// The agent's own cleanup after SIGTERM takes up to about 29 s.
const STOP_GRACE: Duration = Duration::from_secs(30);

const KEEP_RUNS: usize = 50;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Top {
    timezone: Option<Spanned<String>>,
    working_dir: Option<String>,
    command: Option<Spanned<Vec<String>>>,
    env: Option<BTreeMap<String, String>>,
    timeout: Option<Spanned<String>>,
    stop_grace: Option<Spanned<String>>,
    keep_runs: Option<Spanned<i64>>,
    on_failure: Option<Vec<String>>,
    #[serde(default)]
    job: Vec<Spanned<JobTable>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JobTable {
    name: Spanned<String>,
    schedule: Option<Spanned<String>>,
    start: Option<Spanned<Datetime>>,
    every: Option<Spanned<String>>,
    #[serde(default)]
    args: Vec<String>,
    command: Option<Spanned<Vec<String>>>,
    working_dir: Option<String>,
    env: Option<BTreeMap<String, String>>,
    timeout: Option<Spanned<String>>,
    catch_up: Option<bool>,
    on_failure: Option<Vec<String>>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub path: PathBuf,
    pub zone: Option<Zone>,
    pub stop_grace: Duration,
    pub keep_runs: usize,
    pub jobs: Vec<Job>,
}

#[derive(Clone, Debug)]
pub struct Job {
    pub name: String,
    pub schedule: Schedule,
    pub argv: Vec<String>,
    pub working_dir: PathBuf,
    pub env: BTreeMap<String, String>,
    pub timeout: Duration,
    pub catch_up: bool,
    pub on_failure: Option<Vec<String>>,
}

fn line_of(text: &str, offset: usize) -> usize {
    let before = &text.as_bytes()[..offset.min(text.len())];

    before.iter().filter(|byte| **byte == b'\n').count() + 1
}

struct Source<'a> {
    path: &'a Path,
    text: &'a str,
}

impl Source<'_> {
    fn at(&self, span: Option<Range<usize>>, message: &str) -> String {
        let Some(span) = span else {
            return format!("{}: {message}", self.path.display());
        };

        format!(
            "{}: line {}: {message}",
            self.path.display(),
            line_of(self.text, span.start)
        )
    }

    fn duration(
        &self,
        key: &str,
        value: Option<&Spanned<String>>,
        default: Duration,
    ) -> Result<Duration, String> {
        let Some(value) = value else {
            return Ok(default);
        };

        duration(value.get_ref()).ok_or_else(|| {
            self.at(
                Some(value.span()),
                &format!(
                    "`{key}` must be a whole number above 0 followed by s, m or h, such as 90s, 30m or 2h, not `{}`",
                    value.get_ref()
                ),
            )
        })
    }

    fn command(&self, command: &Spanned<Vec<String>>) -> Result<(), String> {
        if command.get_ref().is_empty() {
            return Err(self.at(Some(command.span()), "`command` can't be empty"));
        }

        Ok(())
    }

    fn schedule(&self, table: &Spanned<JobTable>, now: Timestamp) -> Result<Schedule, String> {
        let job = table.get_ref();
        let name = job.name.get_ref();
        let beside = |key: &str, span: Range<usize>| {
            self.at(
                Some(span),
                &format!(
                    "the job `{name}` has `{key}` beside `schedule`: a job takes `schedule`, or `start` and `every`"
                ),
            )
        };

        match (&job.schedule, &job.start, &job.every) {
            (Some(schedule), None, None) => {
                schedule::parse(schedule.get_ref(), now).map_err(|reason| {
                    self.at(
                        Some(schedule.span()),
                        &format!(
                            "the job `{name}` has the schedule `{}`, which {reason}",
                            schedule.get_ref()
                        ),
                    )
                })
            }
            (None, Some(start), Some(every)) => self.interval(name, start, every, now),
            (Some(_), Some(start), _) => Err(beside("start", start.span())),
            (Some(_), None, Some(every)) => Err(beside("every", every.span())),
            (None, Some(start), None) => Err(self.at(
                Some(start.span()),
                &format!("the job `{name}` has `start` without `every`"),
            )),
            (None, None, Some(every)) => Err(self.at(
                Some(every.span()),
                &format!("the job `{name}` has `every` without `start`"),
            )),
            (None, None, None) => Err(self.at(
                Some(table.span()),
                &format!(
                    "the job `{name}` has no schedule: it needs `schedule`, or `start` and `every`"
                ),
            )),
        }
    }

    fn interval(
        &self,
        name: &str,
        start: &Spanned<Datetime>,
        every: &Spanned<String>,
        now: Timestamp,
    ) -> Result<Schedule, String> {
        let Some(from) = local(start.get_ref()) else {
            return Err(self.at(
                Some(start.span()),
                &format!(
                    "`start` must be a date and a time without an offset, such as 2026-11-15T07:00, not `{}`",
                    start.get_ref()
                ),
            ));
        };

        let Some(count) = days(every.get_ref()) else {
            return Err(self.at(
                Some(every.span()),
                &format!(
                    "`every` must be a whole number of days above 0 followed by d, such as 30d, not `{}`",
                    every.get_ref()
                ),
            ));
        };

        schedule::days(from, count, now).map_err(|reason| {
            self.at(
                Some(every.span()),
                &format!(
                    "the job `{name}`, every {count} days from {}, {reason}",
                    start.get_ref()
                ),
            )
        })
    }
}

// toml checks each field's range, but takes a leap second, :60, which jiff refuses.
fn local(datetime: &Datetime) -> Option<DateTime> {
    let (Some(date), Some(time), None) = (datetime.date, datetime.time, datetime.offset) else {
        return None;
    };

    let small = |value: u8| i8::try_from(value).ok();

    DateTime::new(
        i16::try_from(date.year).ok()?,
        small(date.month)?,
        small(date.day)?,
        small(time.hour)?,
        small(time.minute)?,
        small(time.second.unwrap_or(0))?,
        i32::try_from(time.nanosecond.unwrap_or(0)).ok()?,
    )
    .ok()
}

// A day in `every` is a calendar day, so the duration grammar of `timeout` and `stop_grace` keeps
// no `d` (D57).
fn days(text: &str) -> Option<i64> {
    let number = text.strip_suffix('d')?;

    // parse() would take a leading `+` too.
    if !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    let count: i64 = number.parse().ok()?;

    if count == 0 {
        return None;
    }

    Some(count)
}

pub fn duration(text: &str) -> Option<Duration> {
    let (number, unit) = text.split_at_checked(text.len().checked_sub(1)?)?;

    let seconds: u64 = match unit {
        "s" => 1,
        "m" => 60,
        "h" => 60 * 60,
        _ => return None,
    };

    // parse() would take a leading `+` too.
    if !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }

    let count: u64 = number.parse().ok()?;

    if count == 0 {
        return None;
    }

    count.checked_mul(seconds).map(Duration::from_secs)
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("a job's `name` can't be empty".to_string());
    }

    if !valid_name(name) {
        return Some(format!(
            "the job name `{name}` may hold only ASCII letters, digits, `-` and `_`"
        ));
    }

    None
}

pub fn load(path: &Path, now: Timestamp) -> Result<Config, String> {
    // A relative working_dir resolves against the config file's folder, whatever folder the
    // scheduler runs in: launchd starts its jobs in `/`.
    let path = path::absolute(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("{}: couldn't read it: {error}", path.display()))?;
    let source = Source {
        path: &path,
        text: &text,
    };
    let top: Top =
        toml::from_str(&text).map_err(|error| source.at(error.span(), error.message()))?;
    let folder = path.parent().unwrap_or(Path::new("/"));
    let zone = top
        .timezone
        .as_ref()
        .map(|name| {
            schedule::named_zone(name.get_ref())
                .map_err(|reason| source.at(Some(name.span()), &format!("`timezone`: {reason}")))
        })
        .transpose()?;

    if let Some(command) = &top.command {
        source.command(command)?;
    }

    let timeout = source.duration("timeout", top.timeout.as_ref(), TIMEOUT)?;
    let stop_grace = source.duration("stop_grace", top.stop_grace.as_ref(), STOP_GRACE)?;
    let keep_runs = top
        .keep_runs
        .as_ref()
        .map(|count| {
            usize::try_from(*count.get_ref())
                .ok()
                .filter(|count| *count >= 1)
                .ok_or_else(|| {
                    source.at(
                        Some(count.span()),
                        &format!("`keep_runs` must be at least 1, not {}", count.get_ref()),
                    )
                })
        })
        .transpose()?
        .unwrap_or(KEEP_RUNS);
    let top_dir = top
        .working_dir
        .as_ref()
        .map_or_else(|| folder.to_path_buf(), |dir| folder.join(dir));
    let top_env = top.env.unwrap_or_default();
    let mut names = HashSet::new();
    let mut jobs = Vec::new();

    for table in &top.job {
        let job = table.get_ref();
        let name = job.name.get_ref();

        if let Some(problem) = name_problem(name) {
            return Err(source.at(Some(job.name.span()), &problem));
        }

        if !names.insert(name.clone()) {
            return Err(source.at(
                Some(job.name.span()),
                &format!("two jobs are named `{name}`"),
            ));
        }

        let schedule = source.schedule(table, now)?;

        let Some(command) = job.command.as_ref().or(top.command.as_ref()) else {
            return Err(source.at(
                Some(table.span()),
                &format!("the job `{name}` has no `command`, and the top level sets none"),
            ));
        };

        source.command(command)?;
        let timeout = source.duration("timeout", job.timeout.as_ref(), timeout)?;
        let mut env = top_env.clone();
        env.extend(job.env.clone().unwrap_or_default());
        let on_failure = job
            .on_failure
            .as_ref()
            .or(top.on_failure.as_ref())
            .filter(|command| !command.is_empty())
            .cloned();

        jobs.push(Job {
            name: name.clone(),
            schedule,
            argv: [command.get_ref().as_slice(), job.args.as_slice()].concat(),
            working_dir: job
                .working_dir
                .as_ref()
                .map_or_else(|| top_dir.clone(), |dir| folder.join(dir)),
            env,
            timeout,
            catch_up: job.catch_up.unwrap_or(true),
            on_failure,
        });
    }

    Ok(Config {
        path,
        zone,
        stop_grace,
        keep_runs,
        jobs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::Scratch;

    fn now() -> Timestamp {
        "2026-11-10T13:00:00Z".parse().unwrap()
    }

    fn write(scratch: &Scratch, text: &str) -> PathBuf {
        let path = scratch.path().join("scheduler.toml");
        fs::write(&path, text).unwrap();

        path
    }

    fn loaded(text: &str) -> Config {
        let scratch = Scratch::new();
        let path = write(&scratch, text);

        load(&path, now()).unwrap()
    }

    fn refusal(text: &str) -> String {
        let scratch = Scratch::new();
        let path = write(&scratch, text);
        let message = load(&path, now()).unwrap_err();
        let prefix = format!("{}: ", path.display());

        assert!(
            message.starts_with(&prefix),
            "{message} doesn't name {prefix}"
        );

        message[prefix.len()..].to_string()
    }

    const DAILY: &str =
        "command = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n";

    #[test]
    fn the_defaults() {
        let scratch = Scratch::new();
        let path = write(&scratch, DAILY);

        let config = load(&path, now()).unwrap();

        assert_eq!(config.path, path);
        assert!(config.zone.is_none());
        assert_eq!(config.stop_grace, Duration::from_secs(30));
        assert_eq!(config.keep_runs, 50);
        let job = &config.jobs[0];
        assert_eq!(job.name, "daily");
        assert_eq!(job.argv, ["/bin/true"]);
        assert_eq!(job.working_dir, scratch.path());
        assert!(job.env.is_empty());
        assert_eq!(job.timeout, Duration::from_secs(3600));
        assert!(job.catch_up);
        assert_eq!(job.on_failure, None);
    }

    #[test]
    fn every_key_is_read() {
        let config = loaded(
            r#"
timezone = "America/New_York"
working_dir = "/srv/repo"
command = ["/usr/bin/env", "bun"]
env = { A = "1", B = "top" }
timeout = "2h"
stop_grace = "90s"
keep_runs = 3
on_failure = ["/bin/notify"]

[[job]]
name = "first-job_1"
schedule = "@daily"
args = ["tasks/a.md", "--x"]
env = { B = "job", C = "3" }
timeout = "30m"
catch_up = false

[[job]]
name = "second"
schedule = "*/5 * * * *"
command = ["/bin/other"]
working_dir = "/elsewhere"
on_failure = ["/bin/own", "arg"]
"#,
        );

        assert_eq!(config.zone.as_ref().unwrap().name, "America/New_York");
        assert_eq!(config.stop_grace, Duration::from_secs(90));
        assert_eq!(config.keep_runs, 3);

        let [first, second] = config.jobs.as_slice() else {
            panic!("expected two jobs");
        };

        assert_eq!(first.name, "first-job_1");
        assert_eq!(first.argv, ["/usr/bin/env", "bun", "tasks/a.md", "--x"]);
        assert_eq!(first.working_dir, Path::new("/srv/repo"));
        assert_eq!(
            first.env.iter().collect::<Vec<_>>(),
            [
                (&"A".to_string(), &"1".to_string()),
                (&"B".to_string(), &"job".to_string()),
                (&"C".to_string(), &"3".to_string())
            ]
        );
        assert_eq!(first.timeout, Duration::from_secs(30 * 60));
        assert!(!first.catch_up);
        assert_eq!(first.on_failure, Some(vec!["/bin/notify".to_string()]));
        assert_eq!(second.argv, ["/bin/other"]);
        assert_eq!(second.working_dir, Path::new("/elsewhere"));
        assert_eq!(second.timeout, Duration::from_secs(2 * 60 * 60));
        assert!(second.catch_up);
        assert_eq!(
            second.env.iter().collect::<Vec<_>>(),
            [
                (&"A".to_string(), &"1".to_string()),
                (&"B".to_string(), &"top".to_string())
            ]
        );
        assert_eq!(
            second.on_failure,
            Some(vec!["/bin/own".to_string(), "arg".to_string()])
        );
    }

    #[test]
    fn no_jobs_is_valid() {
        let config = loaded("command = [\"/bin/true\"]\n");

        assert!(config.jobs.is_empty());
    }

    #[test]
    fn an_empty_on_failure_means_none() {
        let config = loaded(
            "command = [\"/bin/true\"]\non_failure = [\"/bin/notify\"]\n\n[[job]]\nname = \"off\"\nschedule = \"0 7 * * *\"\non_failure = []\n",
        );
        let top_off = loaded(
            "command = [\"/bin/true\"]\non_failure = []\n\n[[job]]\nname = \"a\"\nschedule = \"0 7 * * *\"\n",
        );

        assert_eq!(config.jobs[0].on_failure, None);
        assert_eq!(top_off.jobs[0].on_failure, None);
    }

    #[test]
    fn a_relative_working_dir_resolves_against_the_config_folder() {
        let scratch = Scratch::new();
        let folder = scratch.path().join("gremlin");
        fs::create_dir(&folder).unwrap();
        let path = folder.join("scheduler.toml");
        fs::write(
            &path,
            "working_dir = \"../repo\"\ncommand = [\"bin/run\"]\n\n[[job]]\nname = \"a\"\nschedule = \"0 7 * * *\"\nargs = [\"tasks/a.md\"]\n\n[[job]]\nname = \"b\"\nschedule = \"0 7 * * *\"\nworking_dir = \"sub\"\n",
        )
        .unwrap();

        let config = load(&path, now()).unwrap();

        assert_eq!(config.jobs[0].working_dir, folder.join("../repo"));
        assert_eq!(config.jobs[0].argv, ["bin/run", "tasks/a.md"]);
        assert_eq!(config.jobs[1].working_dir, folder.join("sub"));
    }

    #[test]
    fn a_relative_config_path_is_made_absolute() {
        let path = Path::new("no-such-folder-here/scheduler.toml");

        let message = load(path, now()).unwrap_err();

        let absolute = std::env::current_dir().unwrap().join(path);
        assert!(
            message.starts_with(&format!("{}: couldn't read it:", absolute.display())),
            "{message}"
        );
    }

    #[test]
    fn a_missing_file() {
        let scratch = Scratch::new();
        let path = scratch.path().join("missing.toml");

        let message = load(&path, now()).unwrap_err();

        assert!(
            message.starts_with(&format!("{}: couldn't read it:", path.display())),
            "{message}"
        );
    }

    #[test]
    fn a_file_that_is_not_toml() {
        let message = refusal("command = [\"/bin/true\"]\n\n[[job]\nname = \"a\"\n");

        assert!(message.starts_with("line 3: "), "{message}");
    }

    #[test]
    fn unknown_keys_and_keys_in_the_wrong_table() {
        let job = refusal(
            "command = [\"/bin/true\"]\n\n[[job]]\nname = \"a\"\nschedul = \"0 7 * * *\"\n",
        );
        let top = refusal("name = \"a\"\n");
        let misplaced = refusal(
            "command = [\"/bin/true\"]\n\n[[job]]\nname = \"a\"\nschedule = \"0 7 * * *\"\nstop_grace = \"1s\"\n",
        );

        assert!(job.starts_with("line 5: unknown field `schedul`"), "{job}");
        assert!(top.starts_with("line 1: unknown field `name`"), "{top}");
        assert!(
            misplaced.starts_with("line 6: unknown field `stop_grace`"),
            "{misplaced}"
        );
    }

    #[test]
    fn a_value_of_the_wrong_type() {
        let message = refusal("command = \"/bin/true\"\n");

        assert!(message.starts_with("line 1: invalid type"), "{message}");
    }

    #[test]
    fn a_job_without_a_name_or_schedule() {
        let unnamed = refusal("command = [\"/bin/true\"]\n\n[[job]]\nschedule = \"0 7 * * *\"\n");
        let unscheduled = refusal("command = [\"/bin/true\"]\n\n[[job]]\nname = \"a\"\n");

        assert!(unnamed.contains("missing field `name`"), "{unnamed}");
        assert_eq!(
            unscheduled,
            "line 3: the job `a` has no schedule: it needs `schedule`, or `start` and `every`"
        );
    }

    #[test]
    fn both_kinds_of_schedule_in_one_config() {
        let config = loaded(
            r#"
timezone = "Europe/London"
command = ["/bin/true"]

[[job]]
name = "daily"
schedule = "0 7 * * *"

[[job]]
name = "refresh"
start = 2026-11-15T07:00
every = "30d"

[[job]]
name = "begun"
start = 2026-01-01T07:00
every = "30d"

[[job]]
name = "exact"
start = 2026-11-15T07:00:30.25
every = "1d"
"#,
        );
        let from = now().to_zoned(config.zone.as_ref().unwrap().tz.clone());
        let fires = |job: &Job| -> Vec<String> {
            job.schedule
                .fires(&from, 2)
                .iter()
                .map(schedule::with_offset)
                .collect()
        };

        let [daily, refresh, begun, exact] = config.jobs.as_slice() else {
            panic!("expected four jobs");
        };

        assert_eq!(
            fires(daily),
            ["2026-11-11T07:00:00+00:00", "2026-11-12T07:00:00+00:00"]
        );
        assert_eq!(
            fires(refresh),
            ["2026-11-15T07:00:00+00:00", "2026-12-15T07:00:00+00:00"]
        );
        assert_eq!(
            fires(begun),
            ["2026-11-27T07:00:00+00:00", "2026-12-27T07:00:00+00:00"]
        );
        assert_eq!(
            fires(exact),
            [
                "2026-11-15T07:00:30.25+00:00",
                "2026-11-16T07:00:30.25+00:00"
            ]
        );
    }

    #[test]
    fn a_day_intervals_keys_apart_or_beside_schedule() {
        let job = |keys: &str| {
            refusal(&format!(
                "command = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\n{keys}\n"
            ))
        };

        assert_eq!(
            job("schedule = \"0 7 * * *\"\nevery = \"30d\""),
            "line 6: the job `daily` has `every` beside `schedule`: a job takes `schedule`, or `start` and `every`"
        );
        assert_eq!(
            job("schedule = \"0 7 * * *\"\nstart = 2026-11-15T07:00\nevery = \"30d\""),
            "line 6: the job `daily` has `start` beside `schedule`: a job takes `schedule`, or `start` and `every`"
        );
        assert_eq!(
            job("start = 2026-11-15T07:00"),
            "line 5: the job `daily` has `start` without `every`"
        );
        assert_eq!(
            job("start = 2026-11-15"),
            "line 5: the job `daily` has `start` without `every`"
        );
        assert_eq!(
            job("every = \"30d\""),
            "line 5: the job `daily` has `every` without `start`"
        );
        assert_eq!(
            job(""),
            "line 3: the job `daily` has no schedule: it needs `schedule`, or `start` and `every`"
        );
    }

    #[test]
    fn a_start_is_a_date_and_a_time_without_an_offset() {
        let start = |value: &str| {
            refusal(&format!(
                "command = [\"/bin/true\"]\n\n[[job]]\nname = \"refresh\"\nstart = {value}\nevery = \"0d\"\n"
            ))
        };

        for value in [
            "2026-11-15",
            "07:00",
            "2026-11-15T07:00Z",
            "2026-11-15T07:00-05:00",
            "2026-12-31T23:59:60",
        ] {
            assert_eq!(
                start(value),
                format!(
                    "line 5: `start` must be a date and a time without an offset, such as 2026-11-15T07:00, not `{value}`"
                )
            );
        }

        let quoted = start("\"2026-11-15T07:00\"");

        assert!(
            quoted.starts_with(
                "line 5: invalid type: string \"2026-11-15T07:00\", expected a TOML datetime"
            ),
            "{quoted}"
        );
    }

    #[test]
    fn every_is_a_whole_number_of_days() {
        let every = |value: &str| {
            refusal(&format!(
                "command = [\"/bin/true\"]\n\n[[job]]\nname = \"refresh\"\nstart = 2026-11-15T07:00\nevery = \"{value}\"\n"
            ))
        };

        for value in ["30", "0d", "+30d", "30 d", "4w"] {
            assert_eq!(
                every(value),
                format!(
                    "line 6: `every` must be a whole number of days above 0 followed by d, such as 30d, not `{value}`"
                )
            );
        }
    }

    #[test]
    fn day_counts() {
        assert_eq!(days("30d"), Some(30));
        assert_eq!(days("1d"), Some(1));
        assert_eq!(days("9223372036854775807d"), Some(i64::MAX));
        assert_eq!(days("0d"), None);
        assert_eq!(days("30"), None);
        assert_eq!(days("+30d"), None);
        assert_eq!(days("30 d"), None);
        assert_eq!(days("4w"), None);
        assert_eq!(days("30D"), None);
        assert_eq!(days("d"), None);
        assert_eq!(days(""), None);
        assert_eq!(days("99999999999999999999d"), None);
    }

    #[test]
    fn a_day_interval_with_no_fire_after_now_names_the_job() {
        let message = refusal(
            "command = [\"/bin/true\"]\n\n[[job]]\nname = \"refresh\"\nstart = 2026-01-01T07:00\nevery = \"3000000d\"\n",
        );

        assert_eq!(
            message,
            "line 6: the job `refresh`, every 3000000 days from 2026-01-01T07:00, never fires again: its next fire would come after the year 9999"
        );
    }

    #[test]
    fn a_job_without_a_command() {
        let message = refusal("\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n");

        assert_eq!(
            message,
            "line 2: the job `daily` has no `command`, and the top level sets none"
        );
    }

    #[test]
    fn an_empty_command() {
        let top = refusal("command = []\n");
        let job = refusal(
            "command = [\"/bin/true\"]\n\n[[job]]\nname = \"a\"\nschedule = \"0 7 * * *\"\ncommand = []\n",
        );

        assert_eq!(top, "line 1: `command` can't be empty");
        assert_eq!(job, "line 6: `command` can't be empty");
    }

    #[test]
    fn names_that_cannot_name_a_folder() {
        let job = |name: &str| {
            format!(
                "command = [\"/bin/true\"]\n\n[[job]]\nname = \"{name}\"\nschedule = \"0 7 * * *\"\n"
            )
        };

        assert_eq!(
            refusal(&job("daily/summary")),
            "line 4: the job name `daily/summary` may hold only ASCII letters, digits, `-` and `_`"
        );
        assert_eq!(
            refusal(&job("café")),
            "line 4: the job name `café` may hold only ASCII letters, digits, `-` and `_`"
        );
        assert_eq!(
            refusal(&job("a.b")),
            "line 4: the job name `a.b` may hold only ASCII letters, digits, `-` and `_`"
        );
        assert_eq!(refusal(&job("")), "line 4: a job's `name` can't be empty");
        assert_eq!(
            refusal(
                "command = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 7 * * *\"\n\n[[job]]\nname = \"daily\"\nschedule = \"0 8 * * *\"\n"
            ),
            "line 8: two jobs are named `daily`"
        );
    }

    #[test]
    fn a_name_is_letters_digits_dashes_and_underscores() {
        assert!(valid_name("Az09-_"));
        assert!(valid_name("-"));
        assert!(valid_name("_"));
        assert!(!valid_name(""));
        assert!(!valid_name("a b"));
        assert!(!valid_name("a/b"));
    }

    #[test]
    fn a_schedule_that_does_not_parse_names_the_job() {
        let message = refusal(
            "command = [\"/bin/true\"]\n\n[[job]]\nname = \"daily\"\nschedule = \"0 0 L * *\"\n",
        );

        assert_eq!(
            message,
            "line 5: the job `daily` has the schedule `0 0 L * *`, which has `L` in its day-of-month field, which cron doesn't take there"
        );
    }

    #[test]
    fn an_unknown_zone() {
        let message = refusal("timezone = \"Mars/Olympus\"\ncommand = [\"/bin/true\"]\n");

        assert_eq!(
            message,
            "line 1: `timezone`: `Mars/Olympus` isn't an IANA zone name"
        );
    }

    #[test]
    fn durations() {
        assert_eq!(duration("90s"), Some(Duration::from_secs(90)));
        assert_eq!(duration("30m"), Some(Duration::from_secs(1800)));
        assert_eq!(duration("2h"), Some(Duration::from_secs(7200)));
        assert_eq!(duration("1s"), Some(Duration::from_secs(1)));
        assert_eq!(duration("0s"), None);
        assert_eq!(duration("30 minutes"), None);
        assert_eq!(duration("+5m"), None);
        assert_eq!(duration("1.5h"), None);
        assert_eq!(duration("5"), None);
        assert_eq!(duration("5d"), None);
        assert_eq!(duration("5S"), None);
        assert_eq!(duration("s"), None);
        assert_eq!(duration(""), None);
        assert_eq!(duration("5é"), None);
        assert_eq!(duration("99999999999999999999h"), None);
        assert_eq!(duration("9999999999999999999h"), None);
    }

    #[test]
    fn a_bad_duration_or_count_names_the_key() {
        let bad = |line: &str| refusal(&format!("command = [\"/bin/true\"]\n{line}\n"));

        assert_eq!(
            bad("timeout = \"30 minutes\""),
            "line 2: `timeout` must be a whole number above 0 followed by s, m or h, such as 90s, 30m or 2h, not `30 minutes`"
        );
        assert_eq!(
            bad("stop_grace = \"0s\""),
            "line 2: `stop_grace` must be a whole number above 0 followed by s, m or h, such as 90s, 30m or 2h, not `0s`"
        );
        assert_eq!(
            bad("keep_runs = 0"),
            "line 2: `keep_runs` must be at least 1, not 0"
        );
        assert_eq!(
            bad("keep_runs = -3"),
            "line 2: `keep_runs` must be at least 1, not -3"
        );
        assert_eq!(
            loaded("command = [\"/bin/true\"]\nkeep_runs = 1\n").keep_runs,
            1
        );
        assert_eq!(
            refusal(
                "command = [\"/bin/true\"]\n\n[[job]]\nname = \"a\"\nschedule = \"0 7 * * *\"\ntimeout = \"0s\"\n"
            ),
            "line 6: `timeout` must be a whole number above 0 followed by s, m or h, such as 90s, 30m or 2h, not `0s`"
        );
    }

    #[test]
    fn lines_count_from_one() {
        assert_eq!(line_of("a\nb\nc", 0), 1);
        assert_eq!(line_of("a\nb\nc", 2), 2);
        assert_eq!(line_of("a\nb\nc", 4), 3);
        assert_eq!(line_of("a\nb", 99), 2);
    }
}
