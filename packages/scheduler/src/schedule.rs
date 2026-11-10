use std::fs;
use std::path::Path;

use croner::Cron;
use croner::parser::{CronParser, Seconds};
use jiff::civil::DateTime;
use jiff::tz::{AmbiguousOffset, TimeZone};
use jiff::{SignedDuration, Span, Timestamp, Zoned};

// Wakes come at least every 60 s, so 90 s leaves 30 s of slack for a loaded machine.
const ON_TIME: SignedDuration = SignedDuration::from_secs(90);

const FIELDS: [&str; 5] = ["minute", "hour", "day-of-month", "month", "day-of-week"];

const MONTHS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

const DAYS: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

#[derive(Clone, Debug)]
pub enum Schedule {
    Cron(Box<Cron>),
    Days(Days),
}

#[derive(Clone, Debug)]
pub struct Days {
    start: DateTime,
    every: i64,
}

#[derive(Clone, Debug)]
pub struct Zone {
    pub name: String,
    pub tz: TimeZone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Running,
    Missed,
}

impl Reason {
    pub fn name(self) -> &'static str {
        match self {
            Reason::Running => "running",
            Reason::Missed => "missed",
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Due {
    Start { slot: Zoned, catching_up: bool },
    Skip { slot: Zoned, reason: Reason },
}

// croner-rust has no @midnight, and takes other words cron doesn't, so the scheduler maps them.
fn nickname(word: &str) -> Option<&'static str> {
    match word {
        "@yearly" | "@annually" => Some("0 0 1 1 *"),
        "@monthly" => Some("0 0 1 * *"),
        "@weekly" => Some("0 0 * * 0"),
        "@daily" | "@midnight" => Some("0 0 * * *"),
        "@hourly" => Some("0 * * * *"),
        _ => None,
    }
}

// croner also takes `?`, `L`, `W`, `#`, a `+` on the day of week, an empty list item and a name
// in the other day field (it reads `JAN` there as Monday), so only what cron takes reaches it.
fn check_field(index: usize, field: &str) -> Result<(), String> {
    let names: &[&str] = match index {
        3 => &MONTHS,
        4 => &DAYS,
        _ => &[],
    };

    for token in field.split([',', '-', '/']) {
        if token.is_empty() {
            return Err(format!("has an empty value in its {} field", FIELDS[index]));
        }

        if token == "*" || token.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }

        if names.contains(&token.to_ascii_uppercase().as_str()) {
            continue;
        }

        return Err(format!(
            "has `{token}` in its {} field, which cron doesn't take there",
            FIELDS[index]
        ));
    }

    Ok(())
}

fn fields(text: &str) -> Result<String, String> {
    let trimmed = text.trim();

    if trimmed.starts_with('@') {
        return nickname(trimmed).map(str::to_string).ok_or_else(|| {
            "isn't one of @yearly, @annually, @monthly, @weekly, @daily, @midnight and @hourly"
                .to_string()
        });
    }

    let fields: Vec<&str> = trimmed.split_whitespace().collect();

    if fields.len() != FIELDS.len() {
        return Err(format!("has {} fields, where cron has 5", fields.len()));
    }

    for (index, field) in fields.iter().enumerate() {
        check_field(index, field)?;
    }

    Ok(fields.join(" "))
}

pub fn parse(text: &str, now: Timestamp) -> Result<Schedule, String> {
    let fields = fields(text)?;
    let cron = CronParser::builder()
        .seconds(Seconds::Disallowed)
        .build()
        .parse(&fields)
        .map_err(|error| format!("doesn't parse: {error}"))?;
    let schedule = Schedule::Cron(Box::new(cron));

    // A pattern that fires in no year fires in no zone either, so UTC answers for every zone.
    if schedule.next_after(&now.to_zoned(TimeZone::UTC)).is_none() {
        return Err("never fires".to_string());
    }

    Ok(schedule)
}

pub fn days(start: DateTime, every: i64, now: Timestamp) -> Result<Schedule, String> {
    let schedule = Schedule::Days(Days { start, every });

    // The series ends at 9999-12-31 in every zone, so UTC answers for all of them.
    if schedule.next_after(&now.to_zoned(TimeZone::UTC)).is_none() {
        return Err("never fires again: its next fire would come after the year 9999".to_string());
    }

    Ok(schedule)
}

// As croner-rust places a fixed time (D57): in a repeated hour at the first pass, and in a skipped
// one at the instant the clocks jump forward, where jiff's `compatible()` would add the skipped hour.
fn place(at: DateTime, zone: &TimeZone) -> Option<Zoned> {
    let ambiguous = zone.to_ambiguous_zoned(at);

    let AmbiguousOffset::Gap { after, .. } = ambiguous.offset() else {
        return ambiguous.earlier().ok();
    };

    // Read with the offset after the gap, the time falls before the jump.
    let before_jump = after.to_timestamp(at).ok()?;
    let jump = zone.following(before_jump).next()?;

    Some(jump.timestamp().to_zoned(zone.clone()))
}

impl Days {
    // Every fire comes from the start, never from the fire before it, so a fire that a DST gap moved
    // moves no other. Past 9999-12-31, jiff's last date, the series ends.
    fn fire(&self, k: i64, zone: &TimeZone) -> Option<Zoned> {
        let offset = Span::new().try_days(k.checked_mul(self.every)?).ok()?;
        let date = self.start.date().checked_add(offset).ok()?;

        place(date.to_datetime(self.start.time()), zone)
    }

    // A fire sits within an hour of its time on its date, so the fires on the dates nearest `at`'s
    // own hold the latest at or before it and the first after it.
    fn around(&self, at: &Zoned) -> impl Iterator<Item = (i64, Zoned)> + '_ {
        let days = i64::from((at.date() - self.start.date()).get_days());
        let nearest = days.div_euclid(self.every);
        let zone = at.time_zone().clone();

        (nearest - 1..=nearest + 1).filter_map(move |k| {
            let k = k.max(0);

            Some((k, self.fire(k, &zone)?))
        })
    }
}

impl Schedule {
    pub fn next_after(&self, after: &Zoned) -> Option<Zoned> {
        match self {
            Schedule::Cron(cron) => cron.find_next_occurrence(after, false).ok(),
            Schedule::Days(days) => days
                .around(after)
                .map(|(_, fire)| fire)
                .find(|fire| fire > after),
        }
    }

    pub fn latest_until(&self, until: &Zoned) -> Option<Zoned> {
        match self {
            Schedule::Cron(cron) => cron.find_previous_occurrence(until, true).ok(),
            Schedule::Days(days) => days
                .around(until)
                .map(|(_, fire)| fire)
                .filter(|fire| fire <= until)
                .last(),
        }
    }

    pub fn fires(&self, after: &Zoned, count: usize) -> Vec<Zoned> {
        match self {
            Schedule::Cron(cron) => cron.iter_after(after.clone()).take(count).collect(),
            Schedule::Days(days) => {
                let Some((first, _)) = days.around(after).find(|(_, fire)| fire > after) else {
                    return Vec::new();
                };

                (first..)
                    .map_while(|k| days.fire(k, after.time_zone()))
                    .take(count)
                    .collect()
            }
        }
    }
}

pub fn with_offset(at: &Zoned) -> String {
    at.timestamp().display_with_offset(at.offset()).to_string()
}

pub fn due(
    schedule: &Schedule,
    zone: &TimeZone,
    last_look: Timestamp,
    now: Timestamp,
    running: bool,
    catch_up: bool,
) -> Option<Due> {
    let slot = schedule.latest_until(&now.to_zoned(zone.clone()))?;

    if slot.timestamp() <= last_look {
        return None;
    }

    if running {
        return Some(Due::Skip {
            slot,
            reason: Reason::Running,
        });
    }

    if now.duration_since(slot.timestamp()) < ON_TIME {
        return Some(Due::Start {
            slot,
            catching_up: false,
        });
    }

    if catch_up {
        return Some(Due::Start {
            slot,
            catching_up: true,
        });
    }

    Some(Due::Skip {
        slot,
        reason: Reason::Missed,
    })
}

pub fn named_zone(name: &str) -> Result<Zone, String> {
    TimeZone::get(name)
        .map(|tz| Zone {
            name: name.to_string(),
            tz,
        })
        .map_err(|_| format!("`{name}` isn't an IANA zone name"))
}

fn utc() -> Zone {
    Zone {
        name: "UTC".to_string(),
        tz: TimeZone::UTC,
    }
}

// A link or a path into a zoneinfo folder names its zone by what follows the folder, as libc and
// jiff read them.
fn zone_in(path_or_name: &str) -> Option<Zone> {
    let name = path_or_name
        .rsplit_once("zoneinfo/")
        .map_or(path_or_name, |(_, name)| name);

    named_zone(name).ok()
}

fn zone_of_tz(value: &str) -> Zone {
    let name = value.strip_prefix(':').unwrap_or(value);

    // As libc and jiff read an empty TZ.
    if name.is_empty() {
        return utc();
    }

    if let Some(zone) = zone_in(name) {
        return zone;
    }

    // A rule such as EST5EDT,M3.2.0,M11.1.0; anything else, as libc reads it, means UTC.
    TimeZone::posix(name)
        .map(|tz| Zone {
            name: name.to_string(),
            tz,
        })
        .unwrap_or_else(|_| utc())
}

// jiff's own lookup keeps its answer for 5 minutes, in which a zone that changed could lose a fire,
// so it serves only where /etc/localtime is a plain file, which names no zone.
fn jiff_system_zone(localtime: &Path) -> Zone {
    let tz = TimeZone::system();
    let name = tz
        .iana_name()
        .map_or_else(|| localtime.display().to_string(), str::to_string);

    Zone { name, tz }
}

pub fn system_zone(tz_variable: Option<&str>, localtime: &Path) -> Zone {
    if let Some(value) = tz_variable {
        return zone_of_tz(value);
    }

    let Ok(target) = fs::read_link(localtime) else {
        return jiff_system_zone(localtime);
    };

    zone_in(&target.to_string_lossy()).unwrap_or_else(|| jiff_system_zone(localtime))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::testing::Scratch;

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    fn zone(name: &str) -> TimeZone {
        TimeZone::get(name).unwrap()
    }

    fn schedule(text: &str) -> Schedule {
        parse(text, at("2026-11-10T13:00:00Z")).unwrap()
    }

    fn refusal(text: &str) -> String {
        parse(text, at("2026-11-10T13:00:00Z")).unwrap_err()
    }

    fn fires(text: &str, zone_name: &str, after: &str, count: usize) -> Vec<String> {
        let after = at(after).to_zoned(zone(zone_name));

        schedule(text)
            .fires(&after, count)
            .iter()
            .map(with_offset)
            .collect()
    }

    fn interval(start: &str, every: i64) -> Schedule {
        days(start.parse().unwrap(), every, at("2026-11-10T13:00:00Z")).unwrap()
    }

    fn fires_of(schedule: &Schedule, zone_name: &str, after: &str, count: usize) -> Vec<String> {
        schedule
            .fires(&at(after).to_zoned(zone(zone_name)), count)
            .iter()
            .map(with_offset)
            .collect()
    }

    fn next(schedule: &Schedule, zone_name: &str, after: &str) -> Option<String> {
        schedule
            .next_after(&at(after).to_zoned(zone(zone_name)))
            .as_ref()
            .map(with_offset)
    }

    fn latest(schedule: &Schedule, zone_name: &str, until: &str) -> Option<String> {
        schedule
            .latest_until(&at(until).to_zoned(zone(zone_name)))
            .as_ref()
            .map(with_offset)
    }

    fn due_at(text: &str, zone_name: &str, look: &str, now: &str) -> Option<(String, bool)> {
        let due = due(
            &schedule(text),
            &zone(zone_name),
            at(look),
            at(now),
            false,
            true,
        )?;

        match due {
            Due::Start { slot, catching_up } => Some((with_offset(&slot), catching_up)),
            Due::Skip { .. } => panic!("expected a start, got {due:?}"),
        }
    }

    #[test]
    fn nicknames_map_to_five_fields() {
        let after = "2026-11-10T13:00:00Z";

        assert_eq!(
            fires("@midnight", "UTC", after, 1),
            ["2026-11-11T00:00:00+00:00"]
        );
        assert_eq!(
            fires("@daily", "UTC", after, 1),
            ["2026-11-11T00:00:00+00:00"]
        );
        assert_eq!(
            fires("@hourly", "UTC", after, 1),
            ["2026-11-10T14:00:00+00:00"]
        );
        assert_eq!(
            fires("@weekly", "UTC", after, 1),
            ["2026-11-15T00:00:00+00:00"]
        );
        assert_eq!(
            fires("@monthly", "UTC", after, 1),
            ["2026-12-01T00:00:00+00:00"]
        );
        assert_eq!(
            fires("@yearly", "UTC", after, 1),
            ["2027-01-01T00:00:00+00:00"]
        );
        assert_eq!(
            fires("@annually", "UTC", after, 1),
            ["2027-01-01T00:00:00+00:00"]
        );
    }

    #[test]
    fn other_words_are_refused() {
        assert!(
            refusal("@reboot").contains("isn't one of @yearly"),
            "{}",
            refusal("@reboot")
        );
        assert!(refusal("@DAILY").contains("isn't one of"));
        assert!(refusal("@daily 7").contains("isn't one of"));
    }

    #[test]
    fn only_five_fields_pass() {
        assert_eq!(refusal("0 0 7 * * *"), "has 6 fields, where cron has 5");
        assert_eq!(
            refusal("0 0 7 * * * 2027"),
            "has 7 fields, where cron has 5"
        );
        assert_eq!(refusal("0 7 * *"), "has 4 fields, where cron has 5");
        assert_eq!(
            fires(" 0  7 * * * ", "UTC", "2026-11-10T13:00:00Z", 1).len(),
            1
        );
    }

    #[test]
    fn syntax_cron_lacks_is_refused() {
        assert_eq!(
            refusal("0 0 L * *"),
            "has `L` in its day-of-month field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("0 0 15W * *"),
            "has `15W` in its day-of-month field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("0 0 ? * MON"),
            "has `?` in its day-of-month field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("0 0 * * 5#3"),
            "has `5#3` in its day-of-week field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("0 0 1 * +MON"),
            "has `+MON` in its day-of-week field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("0 0 * * Monday"),
            "has `Monday` in its day-of-week field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("0 0 * * JAN"),
            "has `JAN` in its day-of-week field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("0 0 * MON *"),
            "has `MON` in its month field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("MON 0 * * *"),
            "has `MON` in its minute field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("0 JAN * * *"),
            "has `JAN` in its hour field, which cron doesn't take there"
        );
        assert_eq!(
            refusal("0 0 1,,2 * *"),
            "has an empty value in its day-of-month field"
        );
        assert_eq!(
            refusal("-5 0 * * *"),
            "has an empty value in its minute field"
        );
        assert!(
            refusal("60 0 * * *").starts_with("doesn't parse:"),
            "{}",
            refusal("60 0 * * *")
        );
    }

    #[test]
    fn names_ranges_lists_and_steps_pass() {
        let after = "2026-11-10T13:00:00Z";

        assert_eq!(
            fires("0 9 * * mon-fri", "UTC", after, 3),
            [
                "2026-11-11T09:00:00+00:00",
                "2026-11-12T09:00:00+00:00",
                "2026-11-13T09:00:00+00:00"
            ]
        );
        assert_eq!(
            fires("*/20 1,3 * dec *", "UTC", after, 4),
            [
                "2026-12-01T01:00:00+00:00",
                "2026-12-01T01:20:00+00:00",
                "2026-12-01T01:40:00+00:00",
                "2026-12-01T03:00:00+00:00"
            ]
        );
        assert_eq!(
            fires("0 0 * Jan-Mar/2 SUN", "UTC", after, 1),
            ["2027-01-03T00:00:00+00:00"]
        );
    }

    #[test]
    fn a_schedule_that_never_fires_is_refused() {
        assert_eq!(refusal("0 0 30 2 *"), "never fires");
        assert_eq!(refusal("0 0 31 4 *"), "never fires");
        assert_eq!(
            fires("0 0 29 2 *", "UTC", "2026-11-10T13:00:00Z", 1),
            ["2028-02-29T00:00:00+00:00"]
        );
    }

    #[test]
    fn either_day_field_matches() {
        let after = "2026-11-24T12:00:00Z";

        assert_eq!(
            fires("0 0 1 * 5", "UTC", after, 3),
            [
                "2026-11-27T00:00:00+00:00",
                "2026-12-01T00:00:00+00:00",
                "2026-12-04T00:00:00+00:00"
            ]
        );
        assert_eq!(
            fires("0 0 */2 * 1", "UTC", after, 4),
            [
                "2026-11-25T00:00:00+00:00",
                "2026-11-27T00:00:00+00:00",
                "2026-11-29T00:00:00+00:00",
                "2026-11-30T00:00:00+00:00"
            ]
        );
    }

    #[test]
    fn the_config_zone_moves_the_fires() {
        assert_eq!(
            fires("0 7 * * *", "America/New_York", "2026-11-10T00:00:00Z", 1),
            ["2026-11-10T07:00:00-05:00"]
        );
        let fire = schedule("0 7 * * *")
            .next_after(&at("2026-11-10T00:00:00Z").to_zoned(zone("America/New_York")))
            .unwrap();
        assert_eq!(fire.timestamp(), at("2026-11-10T12:00:00Z"));
    }

    #[test]
    fn new_york_fixed_times_at_the_2027_transitions() {
        assert_eq!(
            fires("30 2 * * *", "America/New_York", "2027-03-13T12:00:00Z", 2),
            ["2027-03-14T03:00:00-04:00", "2027-03-15T02:30:00-04:00"]
        );
        assert_eq!(
            fires("30 1 * * *", "America/New_York", "2027-11-06T12:00:00Z", 2),
            ["2027-11-07T01:30:00-04:00", "2027-11-08T01:30:00-05:00"]
        );
    }

    #[test]
    fn new_york_intervals_at_the_2027_transitions() {
        assert_eq!(
            fires(
                "*/15 2 * * *",
                "America/New_York",
                "2027-03-13T12:00:00Z",
                1
            ),
            ["2027-03-15T02:00:00-04:00"]
        );
        assert_eq!(
            fires(
                "*/30 1 * * *",
                "America/New_York",
                "2027-11-06T12:00:00Z",
                5
            ),
            [
                "2027-11-07T01:00:00-04:00",
                "2027-11-07T01:30:00-04:00",
                "2027-11-07T01:00:00-05:00",
                "2027-11-07T01:30:00-05:00",
                "2027-11-08T01:00:00-05:00"
            ]
        );
        assert_eq!(
            fires(
                "30 1,2 * * *",
                "America/New_York",
                "2027-11-06T12:00:00Z",
                4
            ),
            [
                "2027-11-07T01:30:00-04:00",
                "2027-11-07T01:30:00-05:00",
                "2027-11-07T02:30:00-05:00",
                "2027-11-08T01:30:00-05:00"
            ]
        );
    }

    #[test]
    fn new_york_at_the_2026_transitions() {
        assert_eq!(
            fires("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z", 2),
            ["2026-03-08T03:00:00-04:00", "2026-03-09T02:30:00-04:00"]
        );
        assert_eq!(
            fires("0 * * * *", "America/New_York", "2026-11-01T04:30:00Z", 3),
            [
                "2026-11-01T01:00:00-04:00",
                "2026-11-01T01:00:00-05:00",
                "2026-11-01T02:00:00-05:00"
            ]
        );
        assert_eq!(
            fires("30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z", 2),
            ["2026-11-01T01:30:00-04:00", "2026-11-02T01:30:00-05:00"]
        );
        assert_eq!(
            fires(
                "*/15 2 * * *",
                "America/New_York",
                "2026-03-07T12:00:00Z",
                1
            ),
            ["2026-03-09T02:00:00-04:00"]
        );
    }

    #[test]
    fn london_at_the_2026_and_2027_transitions() {
        assert_eq!(
            fires("30 1 * * *", "Europe/London", "2026-03-28T12:00:00Z", 2),
            ["2026-03-29T02:00:00+01:00", "2026-03-30T01:30:00+01:00"]
        );
        assert_eq!(
            fires("30 1 * * *", "Europe/London", "2026-10-24T12:00:00Z", 2),
            ["2026-10-25T01:30:00+01:00", "2026-10-26T01:30:00+00:00"]
        );
        assert_eq!(
            fires("*/30 1 * * *", "Europe/London", "2027-10-30T12:00:00Z", 4),
            [
                "2027-10-31T01:00:00+01:00",
                "2027-10-31T01:30:00+01:00",
                "2027-10-31T01:00:00+00:00",
                "2027-10-31T01:30:00+00:00"
            ]
        );
        assert_eq!(
            fires("*/20 1 * * *", "Europe/London", "2027-03-27T12:00:00Z", 1),
            ["2027-03-29T01:00:00+01:00"]
        );
        assert_eq!(
            fires("*/30 1 * * *", "Europe/London", "2026-10-24T12:00:00Z", 4),
            [
                "2026-10-25T01:00:00+01:00",
                "2026-10-25T01:30:00+01:00",
                "2026-10-25T01:00:00+00:00",
                "2026-10-25T01:30:00+00:00"
            ]
        );
        assert_eq!(
            fires("*/20 1 * * *", "Europe/London", "2026-03-28T12:00:00Z", 1),
            ["2026-03-30T01:00:00+01:00"]
        );
        assert_eq!(
            fires("30 1 * * *", "Europe/London", "2027-03-27T12:00:00Z", 1),
            ["2027-03-28T02:00:00+01:00"]
        );
        assert_eq!(
            fires("30 1 * * *", "Europe/London", "2027-10-30T12:00:00Z", 2),
            ["2027-10-31T01:30:00+01:00", "2027-11-01T01:30:00+00:00"]
        );
    }

    #[test]
    fn due_fires_in_a_repeated_hour() {
        let ny = "America/New_York";

        assert_eq!(
            due_at(
                "30 1 * * *",
                ny,
                "2027-11-07T05:00:00Z",
                "2027-11-07T05:30:30Z"
            ),
            Some(("2027-11-07T01:30:00-04:00".to_string(), false))
        );
        assert_eq!(
            due_at(
                "30 1 * * *",
                ny,
                "2027-11-07T05:31:00Z",
                "2027-11-07T06:30:30Z"
            ),
            None
        );
        assert_eq!(
            due_at(
                "*/30 1 * * *",
                ny,
                "2027-11-07T06:29:00Z",
                "2027-11-07T06:30:30Z"
            ),
            Some(("2027-11-07T01:30:00-05:00".to_string(), false))
        );
    }

    #[test]
    fn due_fires_in_a_skipped_hour() {
        let ny = "America/New_York";

        assert_eq!(
            due_at(
                "30 2 * * *",
                ny,
                "2027-03-14T06:59:00Z",
                "2027-03-14T07:00:30Z"
            ),
            Some(("2027-03-14T03:00:00-04:00".to_string(), false))
        );
        assert_eq!(
            due_at(
                "*/15 2 * * *",
                ny,
                "2027-03-14T06:59:00Z",
                "2027-03-14T07:30:00Z"
            ),
            None
        );
    }

    #[test]
    fn a_fire_is_on_time_for_90_seconds() {
        assert_eq!(
            due_at(
                "0 7 * * *",
                "UTC",
                "2026-11-10T06:59:00Z",
                "2026-11-10T07:01:29Z"
            ),
            Some(("2026-11-10T07:00:00+00:00".to_string(), false))
        );
        assert_eq!(
            due_at(
                "0 7 * * *",
                "UTC",
                "2026-11-10T06:59:00Z",
                "2026-11-10T07:01:30Z"
            ),
            Some(("2026-11-10T07:00:00+00:00".to_string(), true))
        );
    }

    #[test]
    fn a_missed_fire_is_skipped_without_catch_up() {
        let daily = schedule("0 7 * * *");
        let utc = TimeZone::UTC;

        let early = due(
            &daily,
            &utc,
            at("2026-11-10T06:00:00Z"),
            at("2026-11-10T07:01:29Z"),
            false,
            false,
        );
        let late = due(
            &daily,
            &utc,
            at("2026-11-10T06:00:00Z"),
            at("2026-11-10T09:00:00Z"),
            false,
            false,
        );

        assert!(
            matches!(
                early,
                Some(Due::Start {
                    catching_up: false,
                    ..
                })
            ),
            "{early:?}"
        );

        let Some(Due::Skip { slot, reason }) = late else {
            panic!("expected a skip, got {late:?}");
        };

        assert_eq!(slot.timestamp(), at("2026-11-10T07:00:00Z"));
        assert_eq!(reason, Reason::Missed);
        assert_eq!(reason.name(), "missed");
    }

    #[test]
    fn several_missed_fires_give_one_run_for_the_latest() {
        assert_eq!(
            due_at(
                "*/30 * * * *",
                "UTC",
                "2026-11-10T06:10:00Z",
                "2026-11-10T09:10:00Z"
            ),
            Some(("2026-11-10T09:00:00+00:00".to_string(), true))
        );
    }

    #[test]
    fn a_fire_while_the_run_is_going_is_skipped() {
        let daily = schedule("0 7 * * *");
        let utc = TimeZone::UTC;

        let on_time = due(
            &daily,
            &utc,
            at("2026-11-10T06:00:00Z"),
            at("2026-11-10T07:00:10Z"),
            true,
            true,
        );
        let missed = due(
            &daily,
            &utc,
            at("2026-11-10T06:00:00Z"),
            at("2026-11-10T09:00:00Z"),
            true,
            true,
        );

        for due in [on_time, missed] {
            let Some(Due::Skip { reason, .. }) = due else {
                panic!("expected a skip, got {due:?}");
            };

            assert_eq!(reason, Reason::Running);
            assert_eq!(reason.name(), "running");
        }
    }

    #[test]
    fn a_fire_at_or_before_the_last_look_is_done() {
        assert_eq!(
            due_at(
                "0 7 * * *",
                "UTC",
                "2026-11-10T07:00:00Z",
                "2026-11-10T07:00:30Z"
            ),
            None
        );
        assert_eq!(
            due_at(
                "0 7 * * *",
                "UTC",
                "2026-11-10T07:00:30Z",
                "2026-11-10T06:59:00Z"
            ),
            None
        );
        assert_eq!(
            due_at(
                "0 7 * * *",
                "UTC",
                "2026-11-10T06:59:59.999Z",
                "2026-11-10T07:00:00Z"
            ),
            Some(("2026-11-10T07:00:00+00:00".to_string(), false))
        );
    }

    #[test]
    fn a_forward_step_catches_the_fire_up() {
        assert_eq!(
            due_at(
                "0 7 * * *",
                "UTC",
                "2026-11-10T06:59:00Z",
                "2026-11-10T09:00:00Z"
            ),
            Some(("2026-11-10T07:00:00+00:00".to_string(), true))
        );
    }

    #[test]
    fn a_day_interval_fires_at_its_start_then_every_n_days() {
        let monthly = interval("2026-11-15T07:00", 30);
        let after = "2026-11-10T12:00:00Z";

        assert_eq!(
            next(&monthly, "Europe/London", after),
            Some("2026-11-15T07:00:00+00:00".to_string())
        );
        assert_eq!(
            fires_of(&monthly, "Europe/London", after, 5),
            [
                "2026-11-15T07:00:00+00:00",
                "2026-12-15T07:00:00+00:00",
                "2027-01-14T07:00:00+00:00",
                "2027-02-13T07:00:00+00:00",
                "2027-03-15T07:00:00+00:00"
            ]
        );
    }

    #[test]
    fn a_day_interval_keeps_its_clock_time_across_a_dst_change() {
        let monthly = interval("2027-03-15T07:00", 30);

        assert_eq!(
            next(&monthly, "Europe/London", "2027-03-15T07:00:00Z"),
            Some("2027-04-14T07:00:00+01:00".to_string())
        );
    }

    #[test]
    fn a_day_interval_in_a_skipped_or_repeated_hour_fires_as_a_fixed_time_does() {
        let ny = "America/New_York";
        let skipped = interval("2027-03-13T02:30", 1);
        let repeated = interval("2027-11-06T01:30", 1);

        assert_eq!(
            fires_of(&skipped, ny, "2027-03-13T00:00:00Z", 3),
            [
                "2027-03-13T02:30:00-05:00",
                "2027-03-14T03:00:00-04:00",
                "2027-03-15T02:30:00-04:00"
            ]
        );
        assert_eq!(
            fires_of(&repeated, ny, "2027-11-06T00:00:00Z", 3),
            [
                "2027-11-06T01:30:00-04:00",
                "2027-11-07T01:30:00-04:00",
                "2027-11-08T01:30:00-05:00"
            ]
        );
        assert_eq!(
            fires_of(&skipped, ny, "2027-03-13T12:00:00Z", 2),
            fires("30 2 * * *", ny, "2027-03-13T12:00:00Z", 2)
        );
        assert_eq!(
            fires_of(&repeated, ny, "2027-11-06T12:00:00Z", 2),
            fires("30 1 * * *", ny, "2027-11-06T12:00:00Z", 2)
        );
    }

    #[test]
    fn around_a_skipped_or_repeated_hour_a_day_interval_agrees_with_cron() {
        let ny = "America/New_York";
        let skipped = interval("2027-03-13T02:30", 1);
        let repeated = interval("2027-11-06T01:30", 1);
        let cases = [
            (
                &skipped,
                schedule("30 2 * * *"),
                [
                    "2027-03-14T06:59:59Z",
                    "2027-03-14T07:00:00Z",
                    "2027-03-14T07:30:00Z",
                ],
            ),
            (
                &repeated,
                schedule("30 1 * * *"),
                [
                    "2027-11-07T05:29:59Z",
                    "2027-11-07T05:30:00Z",
                    "2027-11-07T06:30:00Z",
                ],
            ),
        ];

        assert_eq!(
            latest(&skipped, ny, "2027-03-14T06:59:59Z"),
            Some("2027-03-13T02:30:00-05:00".to_string())
        );
        assert_eq!(
            latest(&skipped, ny, "2027-03-14T07:00:00Z"),
            Some("2027-03-14T03:00:00-04:00".to_string())
        );
        assert_eq!(
            next(&repeated, ny, "2027-11-07T05:30:00Z"),
            Some("2027-11-08T01:30:00-05:00".to_string())
        );
        assert_eq!(
            latest(&repeated, ny, "2027-11-07T06:30:00Z"),
            Some("2027-11-07T01:30:00-04:00".to_string())
        );

        for (days, cron, instants) in &cases {
            for instant in instants {
                assert_eq!(
                    next(days, ny, instant),
                    next(cron, ny, instant),
                    "{instant}"
                );
                assert_eq!(
                    latest(days, ny, instant),
                    latest(cron, ny, instant),
                    "{instant}"
                );
            }
        }
    }

    #[test]
    fn a_day_interval_of_one_day_fires_when_cron_does_all_year() {
        let after = "2027-01-01T12:00:00Z";
        let pairs = [
            ("2027-01-01T00:00", "@daily", "America/New_York"),
            ("2027-01-01T02:30", "30 2 * * *", "America/New_York"),
            ("2027-01-01T01:30", "30 1 * * *", "Europe/London"),
        ];

        for (start, cron, zone_name) in pairs {
            assert_eq!(
                fires_of(&interval(start, 1), zone_name, after, 365),
                fires(cron, zone_name, after, 365),
                "{start} against {cron}"
            );
        }
    }

    #[test]
    fn next_after_is_strict_and_latest_until_inclusive_for_a_day_interval() {
        let monthly = interval("2026-11-15T07:00", 30);
        let london = "Europe/London";

        assert_eq!(
            next(&monthly, london, "2026-12-15T07:00:00Z"),
            Some("2027-01-14T07:00:00+00:00".to_string())
        );
        assert_eq!(
            latest(&monthly, london, "2026-12-15T07:00:00Z"),
            Some("2026-12-15T07:00:00+00:00".to_string())
        );
        assert_eq!(
            fires_of(&monthly, london, "2026-12-15T07:00:00Z", 1),
            ["2027-01-14T07:00:00+00:00"]
        );
        assert_eq!(
            next(&monthly, london, "2026-12-15T06:59:59Z"),
            Some("2026-12-15T07:00:00+00:00".to_string())
        );
        assert_eq!(
            latest(&monthly, london, "2026-12-15T06:59:59Z"),
            Some("2026-11-15T07:00:00+00:00".to_string())
        );
        assert_eq!(
            next(&monthly, london, "2026-12-01T12:00:00Z"),
            Some("2026-12-15T07:00:00+00:00".to_string())
        );
        assert_eq!(
            latest(&monthly, london, "2026-12-01T12:00:00Z"),
            Some("2026-11-15T07:00:00+00:00".to_string())
        );
    }

    #[test]
    fn a_day_interval_has_no_fire_before_its_start() {
        let monthly = interval("2026-11-15T07:00", 30);
        let earliest = Timestamp::MIN.to_zoned(zone("Europe/London"));

        let first = monthly.next_after(&earliest);

        assert_eq!(
            latest(&monthly, "Europe/London", "2026-11-15T06:59:59Z"),
            None
        );
        assert_eq!(
            latest(&monthly, "Europe/London", "2026-11-15T07:00:00Z"),
            Some("2026-11-15T07:00:00+00:00".to_string())
        );
        assert!(monthly.latest_until(&earliest).is_none());
        assert_eq!(
            first.as_ref().map(with_offset),
            Some("2026-11-15T07:00:00+00:00".to_string())
        );
        assert_eq!(
            monthly
                .fires(&earliest, 2)
                .iter()
                .map(with_offset)
                .collect::<Vec<_>>(),
            ["2026-11-15T07:00:00+00:00", "2026-12-15T07:00:00+00:00"]
        );
    }

    #[test]
    fn a_day_interval_ends_with_the_year_9999() {
        let refused = days(
            "2026-01-01T07:00".parse().unwrap(),
            3_000_000,
            at("2026-11-10T13:00:00Z"),
        );
        let last_days = interval("9999-12-29T07:00", 1);
        let past_the_last_date = interval("9999-12-30T07:00", 2);
        let past_any_span = interval("2026-11-15T07:00", i64::MAX);

        assert_eq!(
            refused.unwrap_err(),
            "never fires again: its next fire would come after the year 9999"
        );
        assert_eq!(
            fires_of(&last_days, "UTC", "9999-12-28T00:00:00Z", 5),
            ["9999-12-29T07:00:00+00:00", "9999-12-30T07:00:00+00:00"]
        );
        assert_eq!(
            fires_of(&past_the_last_date, "UTC", "9999-12-29T00:00:00Z", 5),
            ["9999-12-30T07:00:00+00:00"]
        );
        assert_eq!(
            fires_of(&past_any_span, "UTC", "2026-11-10T00:00:00Z", 5),
            ["2026-11-15T07:00:00+00:00"]
        );
        assert_eq!(next(&past_any_span, "UTC", "2026-11-15T07:00:00Z"), None);
        assert_eq!(
            latest(&past_any_span, "UTC", "2030-01-01T00:00:00Z"),
            Some("2026-11-15T07:00:00+00:00".to_string())
        );
    }

    #[test]
    fn a_day_interval_follows_the_zone_it_is_given() {
        let daily = interval("2026-11-15T07:00", 1);

        assert_eq!(
            next(&daily, "Europe/London", "2026-11-16T06:00:00Z"),
            Some("2026-11-16T07:00:00+00:00".to_string())
        );
        assert_eq!(
            next(&daily, "America/New_York", "2026-11-16T06:00:00Z"),
            Some("2026-11-16T07:00:00-05:00".to_string())
        );
    }

    #[test]
    fn a_day_interval_that_has_never_run_catches_up_its_latest_slot() {
        let weekly = interval("2026-11-01T07:00", 7);
        let utc = TimeZone::UTC;
        let never = Timestamp::MIN;

        let missed = due(
            &weekly,
            &utc,
            never,
            at("2026-11-10T09:00:00Z"),
            false,
            true,
        );
        let on_time = due(
            &weekly,
            &utc,
            never,
            at("2026-11-01T07:01:29Z"),
            false,
            true,
        );
        let to_come = due(
            &weekly,
            &utc,
            never,
            at("2026-10-31T09:00:00Z"),
            false,
            true,
        );

        let Some(Due::Start { slot, catching_up }) = missed else {
            panic!("expected a start, got {missed:?}");
        };

        assert_eq!(with_offset(&slot), "2026-11-08T07:00:00+00:00");
        assert!(catching_up);
        assert!(
            matches!(
                on_time,
                Some(Due::Start {
                    catching_up: false,
                    ..
                })
            ),
            "{on_time:?}"
        );
        assert_eq!(to_come, None);
    }

    #[test]
    fn a_zone_name_must_be_known() {
        assert_eq!(named_zone("Europe/London").unwrap().name, "Europe/London");
        assert_eq!(
            named_zone("Mars/Olympus").unwrap_err(),
            "`Mars/Olympus` isn't an IANA zone name"
        );
    }

    #[test]
    fn tz_names_the_system_zone() {
        let localtime = Path::new("/nonexistent/localtime");

        let named = system_zone(Some("America/New_York"), localtime);
        let colon = system_zone(Some(":Europe/London"), localtime);
        let path = system_zone(Some("/usr/share/zoneinfo/America/New_York"), localtime);
        let rule = system_zone(Some("EST5EDT,M3.2.0,M11.1.0"), localtime);
        let empty = system_zone(Some(""), localtime);
        let unknown = system_zone(Some("Mars/Olympus"), localtime);

        assert_eq!(named.name, "America/New_York");
        assert_eq!(named.tz, zone("America/New_York"));
        assert_eq!(colon.name, "Europe/London");
        assert_eq!(path.name, "America/New_York");
        assert_eq!(rule.name, "EST5EDT,M3.2.0,M11.1.0");
        let july = at("2026-07-01T12:00:00Z");
        assert_eq!(
            rule.tz.to_offset(july),
            zone("America/New_York").to_offset(july)
        );
        assert_eq!(empty.name, "UTC");
        assert_eq!(empty.tz, TimeZone::UTC);
        assert_eq!(unknown.name, "UTC");
    }

    #[test]
    fn localtime_links_name_the_system_zone() {
        let scratch = Scratch::new();
        let localtime = scratch.path().join("localtime");
        symlink("/var/db/timezone/zoneinfo/Europe/London", &localtime).unwrap();

        let london = system_zone(None, &localtime);
        fs::remove_file(&localtime).unwrap();
        symlink("../usr/share/zoneinfo/America/New_York", &localtime).unwrap();
        let new_york = system_zone(None, &localtime);

        assert_eq!(london.name, "Europe/London");
        assert_eq!(london.tz, zone("Europe/London"));
        assert_eq!(new_york.name, "America/New_York");
    }

    #[test]
    fn a_plain_file_or_a_link_jiff_must_read_takes_jiffs_zone() {
        let scratch = Scratch::new();
        let plain = scratch.path().join("plain");
        fs::write(&plain, "not read").unwrap();
        let elsewhere = scratch.path().join("elsewhere");
        symlink("/nowhere/London", &elsewhere).unwrap();
        let system = TimeZone::system();
        let expected = |path: &Path| {
            system
                .iana_name()
                .map_or_else(|| path.display().to_string(), str::to_string)
        };

        let from_plain = system_zone(None, &plain);
        let from_link = system_zone(None, &elsewhere);

        assert_eq!(from_plain.name, expected(&plain));
        assert_eq!(from_plain.tz, system);
        assert_eq!(from_link.name, expected(&elsewhere));
    }
}
