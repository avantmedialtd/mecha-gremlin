## ADDED Requirements

### Requirement: A job can run every N days from a start date
A job SHALL be able to give, in place of `schedule`, a `start`, a TOML local date-time with or without seconds, such as `2026-11-15T07:00`, and an `every`, a whole number of days above 0 followed by `d`, such as `30d`. Its fires SHALL be the start and every N days after it: fire k SHALL be the start's date plus k × N calendar days, at the start's time of day, for every k from 0, each computed from the start and never from the fire before it. They SHALL be read in the zone schedules are read in (Requirement: Schedules and the zone), so a fire keeps its local time across a DST change and follows a change of the system's zone. At a DST change a fire SHALL fire once in a repeated hour, at the first pass, and at the end of a skipped hour. A day interval's fires SHALL be decided, caught up, skipped, logged and shown by `check` as a cron schedule's are, and their runs SHALL get the same variables (Requirement: A missed fire runs once). A day interval with no fire after now SHALL fail the check.

#### Scenario: Every 30 days
- **WHEN** the zone is Europe/London, a job named `refresh` has `start = 2026-11-15T07:00` and `every = "30d"`, and `check` runs at 2026-11-10T12:00Z
- **THEN** stdout names `refresh` and gives `2026-11-15T07:00:00+00:00`, `2026-12-15T07:00:00+00:00`, `2027-01-14T07:00:00+00:00`, `2027-02-13T07:00:00+00:00` and `2027-03-15T07:00:00+00:00`

#### Scenario: The same clock time across a DST change
- **WHEN** the zone is Europe/London, and a job has `start = 2027-03-15T07:00` and `every = "30d"`
- **THEN** its fire after the start is `2027-04-14T07:00:00+01:00`, at 07:00 as before, not 08:00

#### Scenario: A start in a DST gap and a repeated hour
- **WHEN** the zone is America/New_York, one job has `start = 2027-03-13T02:30` and `every = "1d"`, and another has `start = 2027-11-06T01:30` and `every = "1d"`
- **THEN** the first fires at `2027-03-13T02:30:00-05:00`, `2027-03-14T03:00:00-04:00` and `2027-03-15T02:30:00-04:00`, and the second fires once on 2027-11-07, at `2027-11-07T01:30:00-04:00`, and next at `2027-11-08T01:30:00-05:00`

#### Scenario: A start still to come
- **WHEN** the zone is UTC, a job with `start = 2026-11-15T07:00` and `every = "30d"` has no run log, and the scheduler starts at 2026-11-10T09:00Z
- **THEN** the `ready` record gives the job's `next` as 2026-11-15T07:00:00Z, and the job doesn't run before then

#### Scenario: A run on time knows its slot
- **WHEN** a job with `start = 2026-11-15T07:00` and `every = "30d"`, in the zone Europe/London, starts on time at 2026-12-15T07:00:03Z
- **THEN** its run's environment holds `GREMLIN_SLOT=2026-12-15T07:00:00+00:00`, and no `GREMLIN_CATCH_UP`

#### Scenario: The system's zone changes
- **WHEN** the config names no `timezone`, a job has `start = 2026-11-15T07:00` and `every = "1d"`, and the system's zone changes from Europe/London to America/New_York while the scheduler runs
- **THEN** the job fires at 07:00 London time before the change, and at 07:00 New York time from the first wake after it

#### Scenario: A day interval that never fires again
- **WHEN** a job has `start = 2026-01-01T07:00` and `every = "3000000d"`, and the check runs on 2026-11-10
- **THEN** the check fails, naming the job, since its next fire would come after the year 9999

## MODIFIED Requirements

### Requirement: The config is checked before anything runs
The config SHALL be TOML. Its top level SHALL take `timezone`, `working_dir`, `command`, `env`, `timeout`, `stop_grace`, `keep_runs` and `on_failure`, and one `[[job]]` table per job; a config with no jobs SHALL be valid, and the scheduler SHALL idle. A job SHALL take `name`, `schedule`, `start`, `every`, `args`, `command`, `working_dir`, `env`, `timeout`, `catch_up` and `on_failure`. A job SHALL have a `name`; either a `schedule`, or a `start` and an `every` (Requirement: A job can run every N days from a start date); and a `command` of its own or the top level's. The defaults SHALL be: the system's zone, the config file's folder as `working_dir`, `timeout` `1h`, `stop_grace` `30s`, `keep_runs` 50, `catch_up` true and no `on_failure`. An empty `on_failure` SHALL mean none, so that a job can turn off the top level's. A relative `working_dir` SHALL resolve against the config file's folder; `command`, `args` and `on_failure` SHALL reach the program as written.

The check SHALL fail, before any run, on:
- a config file that is missing, can't be read or isn't valid TOML;
- a key the config doesn't know, or a key in the wrong table;
- a value of the wrong type;
- a job without a name, a schedule or a command, where a `start` and an `every` together count as a schedule;
- a job with a `schedule` beside a `start` or an `every`, or with one of `start` and `every` without the other;
- a `start` that is a TOML local date or local time alone, or a date-time with an offset;
- an `every` that isn't a whole number above 0 followed by `d`;
- a day interval with no fire after now (Requirement: A job can run every N days from a start date);
- a name that is empty, holds anything but ASCII letters, digits, `-` and `_`, or that two jobs share;
- an empty `command`;
- a schedule that doesn't parse, uses syntax cron doesn't have, or can never fire (Requirement: Schedules and the zone);
- a `timezone` that isn't an IANA zone name;
- a duration that isn't a whole number followed by `s`, `m` or `h`, or that is zero;
- a `keep_runs` below 1.

A failed check at the start SHALL exit 1, and its message SHALL name the file, and the key and its line when there is one.

#### Scenario: An unknown key
- **WHEN** a job holds `schedul = "0 7 * * *"`
- **THEN** the scheduler exits 1 without starting a run, and the message names `schedul` and its line

#### Scenario: A file that isn't valid TOML
- **WHEN** the config file holds `[[job]` on its third line
- **THEN** the scheduler exits 1, and the message names the file and line 3

#### Scenario: A job without a command
- **WHEN** neither the top level nor the job `daily` sets `command`
- **THEN** the scheduler exits 1, and the message names the job `daily`

#### Scenario: A name that can't name a folder
- **WHEN** two jobs are named `daily`, or a job is named `daily/summary`, `café` or the empty string
- **THEN** the scheduler exits 1, and the message names the name

#### Scenario: A bad duration or count
- **WHEN** `timeout` is `30 minutes` or `0s`, or `keep_runs` is 0
- **THEN** the scheduler exits 1, and the message names the key

#### Scenario: The defaults
- **WHEN** the config holds only a top-level `command` and one job with a `name` and a `schedule`
- **THEN** the scheduler starts, reads the schedule in the system's zone, starts the job's runs in the config file's folder, and gives each run an hour, a 30 s stop grace and catch-up, keeping 50 logs

#### Scenario: No jobs
- **WHEN** the config holds a top-level `command` and no `[[job]]`
- **THEN** the scheduler starts, its `ready` record's `jobs` is empty, and it starts no run

#### Scenario: A relative working directory
- **WHEN** the config at `/etc/gremlin/scheduler.toml` sets `working_dir = "../repo"`
- **THEN** runs start in `/etc/repo`, whatever folder the scheduler was started in

#### Scenario: A day interval's keys apart or together
- **WHEN** a job holds `schedule = "0 7 * * *"` and `every = "30d"`, or `start = 2026-11-15T07:00` without `every`, or `every = "30d"` without `start`
- **THEN** the scheduler exits 1, and the message names the job and the key

#### Scenario: A start or an every that's wrong
- **WHEN** a job's `start` is `2026-11-15`, `07:00`, `2026-11-15T07:00Z` or the string `"2026-11-15T07:00"`, or its `every` is `30`, `0d`, `+30d`, `30 d` or `4w`
- **THEN** the scheduler exits 1, and the message names the key and its line

### Requirement: A missed fire runs once
At each decision, for each job, the scheduler SHALL take the job's latest fire after its last look and at or before now, and SHALL drop any earlier fire in that interval. That fire SHALL be on time when seen less than 90 s after it, and missed when seen 90 s or more after it. An on-time fire SHALL start the job. A missed fire SHALL start the job once, unless the job sets `catch_up = false`, in which case the scheduler SHALL record `skipped` with the reason `missed`. A fire, on time or missed, that comes while the job's previous run is still going SHALL be recorded as `skipped` with the reason `running` instead. After each decision a job's last look SHALL become now, unless now is earlier. At the start, a job's last look SHALL be the start time of its newest run log. For a job with no log, it SHALL be the scheduler's start time, except for a day interval (Requirement: A job can run every N days from a start date), whose last look SHALL be just before its first fire, so that its latest fire that has passed is missed.

#### Scenario: Asleep through one fire
- **WHEN** a `0 7 * * *` job's last look is 06:00, and the machine sleeps until 09:00
- **THEN** at the wake the job runs once, and its `started` record's `slot` is 07:00

#### Scenario: Asleep through several fires
- **WHEN** a `*/30 * * * *` job's last look is 06:10, and the machine sleeps until 09:10
- **THEN** at the wake the job runs once, for the 09:00 slot

#### Scenario: The 90-second boundary
- **WHEN** a job that sets `catch_up = false` has its 07:00 fire seen at 07:01:29, and another such job has its 07:00 fire seen at 07:01:30
- **THEN** the first job runs, as on time, and the second records `skipped` with the reason `missed`

#### Scenario: A job that skips missed fires
- **WHEN** a job that sets `catch_up = false` had its 07:00 fire missed, and the machine wakes at 09:00
- **THEN** the job doesn't run, and a `skipped` record gives its `job`, the `slot` 07:00 and the `reason` `missed`

#### Scenario: A missed fire while a run is going
- **WHEN** a job's run started before the machine slept is still going at the wake, and the job's fire was missed during the sleep
- **THEN** the scheduler records `skipped` with the reason `running`, and starts nothing for that fire

#### Scenario: After a restart
- **WHEN** the zone is UTC, a `0 7 * * *` job's newest run log is `2026-11-08T07-00-00Z.log`, and the scheduler starts at 2026-11-09T09:00Z
- **THEN** at the start, before its first wait, the job runs once, and its `started` record's `slot` is 2026-11-09T07:00:00Z

#### Scenario: A new job
- **WHEN** a `0 7 * * *` job has no run log, and the scheduler starts at 09:00
- **THEN** the job doesn't run until 07:00 the next day

#### Scenario: A day interval that has never run
- **WHEN** the zone is UTC, a job with `start = 2026-11-01T07:00` and `every = "7d"` has no run log, and the scheduler starts at 2026-11-10T09:00Z
- **THEN** at the start, before its first wait, the job runs once, its `started` record's `slot` is 2026-11-08T07:00:00Z, and its run's environment holds `GREMLIN_CATCH_UP=1`

#### Scenario: A day interval that has never run, and skips missed fires
- **WHEN** the zone is UTC, a job with `start = 2026-11-01T07:00`, `every = "7d"` and `catch_up = false` has no run log, and the scheduler starts at 2026-11-10T09:00Z
- **THEN** the job doesn't run, a `skipped` record gives its `slot` 2026-11-08T07:00:00Z and the `reason` `missed`, and its next run is at 2026-11-15T07:00:00Z

### Requirement: SIGHUP rereads the config
On SIGHUP the scheduler SHALL read and check the config again. A config that passes SHALL replace the old one and be recorded as `config reloaded`: runs already going SHALL go on to their end, each with its own deadline; a job no longer in the config SHALL start nothing more; a job still in it SHALL keep its last look; and a new job's last look SHALL be the time of the reload, except for a day interval with no run log, whose last look SHALL be just before its first fire (Requirement: A missed fire runs once). A config that fails SHALL be recorded as `config refused`, with its reason, and the old config SHALL stay in force.

#### Scenario: A job added
- **WHEN** a `* * * * *` job is added to the config, and the scheduler gets SIGHUP
- **THEN** a `config reloaded` record lists it in its `jobs`, and the new job starts at its next fire

#### Scenario: A job removed while its run is going
- **WHEN** a job whose run is going is removed from the config, and the scheduler gets SIGHUP
- **THEN** the run goes on, still bounded by the timeout it started with, and the job starts no new run

#### Scenario: A broken config
- **WHEN** the config gains a key it doesn't know, and the scheduler gets SIGHUP
- **THEN** a `config refused` record's `reason` names the key, and the jobs of the old config keep firing

#### Scenario: A day interval added
- **WHEN** the zone is UTC, a job with `start = 2026-11-01T07:00` and `every = "7d"`, and no run log, is added to the config, and the scheduler gets SIGHUP at 2026-11-10T09:00Z
- **THEN** a `config reloaded` record lists it, and the job runs once at once, catching up, for the slot 2026-11-08T07:00:00Z
