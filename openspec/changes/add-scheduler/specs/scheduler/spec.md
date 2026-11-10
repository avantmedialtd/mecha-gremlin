## ADDED Requirements

### Requirement: Start with a config and a data directory
The scheduler SHALL be a binary, `gremlin-scheduler`, started as `gremlin-scheduler --config <file> --data-dir <dir>`, each option given exactly once, or as `gremlin-scheduler --config <file> --check` (Requirement: --check prints each job's next fires). `--help` SHALL print the usage to stdout and `--version` the version, each exiting 0. A missing option, a missing value, a repeated option, `--check` with `--data-dir`, or any other argument SHALL exit 1 with the usage on stderr. The data directory SHALL exist and be a directory, or the start SHALL exit 1 naming it. The scheduler SHALL check the config (Requirement: The config is checked before anything runs), take the lock (Requirement: One scheduler per data directory), open its log, record `ready`, and then decide at once what fell due (Requirement: A missed fire runs once), before its first wait.

#### Scenario: A clean start
- **WHEN** the scheduler starts with a valid config and an existing data directory
- **THEN** `scheduler.log` gains a `ready` record whose `zone` names the zone and whose `jobs` give each job's `name` and `next` fire, and the scheduler keeps running

#### Scenario: A missing option
- **WHEN** the scheduler starts with `--config` and no `--data-dir`
- **THEN** it exits 1, and stderr holds the usage, naming both options

#### Scenario: An unknown or repeated option
- **WHEN** the scheduler starts with `--verbose`, or with `--config` given twice
- **THEN** it exits 1 with the usage on stderr, and starts no run

#### Scenario: Help and version
- **WHEN** the scheduler starts with `--help`, or with `--version`
- **THEN** it prints the usage, or its version, to stdout and exits 0

#### Scenario: A data directory that doesn't exist
- **WHEN** `--data-dir` names a path that doesn't exist, or a file
- **THEN** the scheduler exits 1, and stderr names the path

### Requirement: --check prints each job's next fires
`gremlin-scheduler --config <file> --check` SHALL check the config as a start does (Requirement: The config is checked before anything runs), print to stdout the zone, as the `ready` record names it, and then, for each job in the config's order, its name and its next 5 fires after now, each in ISO 8601 with the zone's UTC offset, and exit 0. A config that fails its check SHALL exit 1, with the check's message on stderr. `--check` SHALL need no data directory, take no lock, write no file and start no run.

#### Scenario: Checking a config
- **WHEN** a config whose `timezone` is America/New_York has one job, named `daily`, with the schedule `0 7 * * *`, and `--check` runs at 2026-11-10T13:00Z
- **THEN** stdout names `America/New_York` and `daily`, and gives the fires from `2026-11-11T07:00:00-05:00` to `2026-11-15T07:00:00-05:00`, one per day; the scheduler exits 0 and writes no file

#### Scenario: Checking a broken config
- **WHEN** `--check` runs on a config whose job holds `schedul = "0 7 * * *"`
- **THEN** it exits 1, and stderr names `schedul` and its line

#### Scenario: --check with a data directory
- **WHEN** the scheduler starts with `--config`, `--check` and `--data-dir`
- **THEN** it exits 1 with the usage on stderr

### Requirement: The config is checked before anything runs
The config SHALL be TOML. Its top level SHALL take `timezone`, `working_dir`, `command`, `env`, `timeout`, `stop_grace`, `keep_runs` and `on_failure`, and one `[[job]]` table per job; a config with no jobs SHALL be valid, and the scheduler SHALL idle. A job SHALL take `name`, `schedule`, `args`, `command`, `working_dir`, `env`, `timeout`, `catch_up` and `on_failure`. A job SHALL have a `name` and a `schedule`, and a `command` of its own or the top level's. The defaults SHALL be: the system's zone, the config file's folder as `working_dir`, `timeout` `1h`, `stop_grace` `30s`, `keep_runs` 50, `catch_up` true and no `on_failure`. An empty `on_failure` SHALL mean none, so that a job can turn off the top level's. A relative `working_dir` SHALL resolve against the config file's folder; `command`, `args` and `on_failure` SHALL reach the program as written.

The check SHALL fail, before any run, on:
- a config file that is missing, can't be read or isn't valid TOML;
- a key the config doesn't know, or a key in the wrong table;
- a value of the wrong type;
- a job without a name, a schedule or a command;
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

### Requirement: Schedules and the zone
A schedule SHALL be five cron fields made of digits, `*`, `,`, `-`, `/` and three-letter month and day names in either case, or one of `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight` and `@hourly`. A schedule of six or seven fields, any other `@` word, `@reboot` included, `?`, `L`, `W`, `#`, a `+` before the day of week, a full name such as `Monday`, or a schedule that can never fire SHALL fail the check. When both the day-of-month and the day-of-week fields are restricted, meaning anything but a literal `*`, a day SHALL match when either matches.

Schedules SHALL be read in the config's `timezone`, or, when it names none, in the system's zone, read again at every wake: the `TZ` variable when set, else the zone `/etc/localtime` links to.

A schedule with a single value in both its minute and its hour field is fixed-time: at a DST change it SHALL fire once in a repeated hour, at the first pass, and at the end of a skipped hour. Any other schedule SHALL fire in both passes of a repeated hour, and SHALL NOT fire for the times a skipped hour removes.

#### Scenario: A nickname
- **WHEN** a job's schedule is `@midnight`, or `@daily`, and the zone is UTC
- **THEN** it fires at 00:00 UTC each day

#### Scenario: Either day field
- **WHEN** the zone is UTC, the time is 2026-11-24T12:00Z, and one job's schedule is `0 0 1 * 5` and another's is `0 0 */2 * 1`
- **THEN** the first's next fires are 2026-11-27, a Friday, 2026-12-01, the 1st, and 2026-12-04, and the second's are 2026-11-25, an odd day, 2026-11-27 and 2026-11-29, then 2026-11-30, a Monday

#### Scenario: Syntax cron doesn't have, or a schedule that never fires
- **WHEN** a job's schedule is `0 0 7 * * *`, `@reboot`, `0 0 L * *`, `0 0 1 * +MON`, `0 0 * * Monday` or `0 0 30 2 *`
- **THEN** the check fails, naming the job

#### Scenario: The config's zone
- **WHEN** `timezone` is `America/New_York` and a job's schedule is `0 7 * * *`
- **THEN** on 2026-11-10 the job fires at 12:00 UTC

#### Scenario: The system's zone, and a change to it
- **WHEN** the config names no `timezone`, and the system's zone changes from Europe/London to America/New_York while the scheduler runs
- **THEN** a `0 7 * * *` job fires at 07:00 London time before the change, and at 07:00 New York time from the first wake after it

#### Scenario: A fixed time in a DST gap and a repeated hour
- **WHEN** `timezone` is `America/New_York`, and one job's schedule is `30 2 * * *` and another's is `30 1 * * *`
- **THEN** on 2027-03-14 the first fires at 03:00 EDT, and on 2027-11-07 the second fires once, at 01:30 EDT

#### Scenario: Intervals in a DST gap and a repeated hour
- **WHEN** `timezone` is `America/New_York`, and the jobs' schedules are `*/15 2 * * *`, `*/30 1 * * *` and `30 1,2 * * *`
- **THEN** on 2027-03-14 the first doesn't fire, and on 2027-11-07 the second fires at 01:00 and 01:30 EDT and again at 01:00 and 01:30 EST, and the third at 01:30 EDT, 01:30 EST and 02:30 EST

### Requirement: The wait is capped at 60 seconds
The scheduler SHALL wait until the earliest of the next fire of any job, the nearest signal due to a run (its deadline, or the SIGKILL after it), and 60 s from now, and SHALL then read the wall clock and decide what fell due. Fires SHALL count on the wall clock; a run's deadlines SHALL count on a clock that wall-clock steps don't move. When the wall clock reads earlier than at the previous wake, the scheduler SHALL record `clock stepped back`, and no job's last look SHALL move back, so that a job starts nothing until the wall clock passes its last look again.

#### Scenario: Idle
- **WHEN** no job fires within the next hour
- **THEN** the scheduler wakes at least once a minute, and starts nothing

#### Scenario: A fire within the minute
- **WHEN** a job's next fire is 20 s away
- **THEN** the scheduler wakes at that fire, and starts the job within a second of it

#### Scenario: The clock steps back
- **WHEN** a job ran at its 07:00 fire, and the wall clock then steps back from 07:00:30 to 06:59:00
- **THEN** the scheduler records `clock stepped back` with `from` and `to`, and the job doesn't run again at 07:00 that day

#### Scenario: The clock steps forward
- **WHEN** a `0 7 * * *` job's last look is 06:59, and the wall clock steps forward to 09:00
- **THEN** the job runs once, for the 07:00 slot, as a missed fire

### Requirement: A missed fire runs once
At each decision, for each job, the scheduler SHALL take the job's latest fire after its last look and at or before now, and SHALL drop any earlier fire in that interval. That fire SHALL be on time when seen less than 90 s after it, and missed when seen 90 s or more after it. An on-time fire SHALL start the job. A missed fire SHALL start the job once, unless the job sets `catch_up = false`, in which case the scheduler SHALL record `skipped` with the reason `missed`. A fire, on time or missed, that comes while the job's previous run is still going SHALL be recorded as `skipped` with the reason `running` instead. After each decision a job's last look SHALL become now, unless now is earlier. At the start, a job's last look SHALL be the start time of its newest run log, or the scheduler's start time for a job with no log.

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

### Requirement: A run is the job's command, in its own process group, with its output in a log
A run SHALL be the job's `command`, or the top level's, followed by the job's `args`. It SHALL start in the job's `working_dir`, or the top level's, with the scheduler's own environment, then the top level's `env`, then the job's, a later value replacing an earlier one. Over all of those, it SHALL get `GREMLIN_JOB`, the job's name; `GREMLIN_SLOT`, the fire it runs for, in ISO 8601 with the zone's UTC offset; and `GREMLIN_CATCH_UP`, set to `1` when the run catches up a missed fire and removed otherwise. It SHALL run in a process group of its own, with stdin empty, and its stdout and stderr appended to `jobs/<name>/<start>.log` in the data directory, where `<start>` is its UTC start time, written as `2026-11-09T07-00-00Z`. The job's folder SHALL have mode 0700 and the log mode 0600. The scheduler SHALL record `started` when the run starts and `exited` when it ends (Requirement: The scheduler's own log). A run that can't start SHALL be recorded as `error`, naming the job and the reason, and the job SHALL keep its schedule.

#### Scenario: The command, folder and environment
- **WHEN** a job sets `args = ["tasks/a.md"]` under a top-level `command = ["/bin/sh", "-c", "pwd; echo $A $B", "run"]`, `working_dir = "/tmp/w"` and `env = { A = "1", B = "top" }`, and its own `env = { B = "job" }`
- **THEN** its run starts in `/tmp/w` with `tasks/a.md` as its last argument, and its log holds `/tmp/w` and `1 job`

#### Scenario: A run on time knows its slot
- **WHEN** a job named `digest`, with the schedule `0 7 * * *` in the zone Europe/London, starts on time at 2026-11-10T07:00:05Z
- **THEN** its run's environment holds `GREMLIN_JOB=digest` and `GREMLIN_SLOT=2026-11-10T07:00:00+00:00`, and no `GREMLIN_CATCH_UP`

#### Scenario: A run that catches up knows it
- **WHEN** a job with the schedule `0 7 * * *` in the zone America/New_York catches up its 07:00 fire at 2026-11-10T16:12Z
- **THEN** its run's environment holds `GREMLIN_SLOT=2026-11-10T07:00:00-05:00` and `GREMLIN_CATCH_UP=1`

#### Scenario: The config can't set the run's variables
- **WHEN** the top level's `env` sets `GREMLIN_SLOT = "x"` and `GREMLIN_CATCH_UP = "1"`, and a job's run starts on time
- **THEN** the run's `GREMLIN_SLOT` is its fire's time, and the run has no `GREMLIN_CATCH_UP`

#### Scenario: The output and its log
- **WHEN** a run writes to stdout and to stderr
- **THEN** both reach `jobs/<name>/<start>.log`, which has mode 0600, in a folder with mode 0700

#### Scenario: The records of a run
- **WHEN** a run exits with code 3 after 2 s
- **THEN** `scheduler.log` holds a `started` record with the run's `job`, `slot`, `pid` and `log`, and an `exited` record with its `job`, `code` 3 and `seconds` from 2.0 to 3.0

#### Scenario: A program that doesn't exist
- **WHEN** a job's command names a program that doesn't exist
- **THEN** an `error` record gives the `job` and a `reason`, the scheduler keeps running, and the job tries again at its next fire

### Requirement: One run of a job at a time
When a job's fire comes while its previous run is still going, the scheduler SHALL record it as `skipped`, with the reason `running`, and start nothing for that fire.

#### Scenario: Still running at the next fire
- **WHEN** a `* * * * *` job's run takes 90 s
- **THEN** the fire during the run is recorded as `skipped` with the reason `running`, and the fire after the run ends starts a new run

### Requirement: A run past its timeout is stopped
Each run SHALL have a deadline, its start plus the job's `timeout`, or the top level's, and SHALL keep the `timeout` and `stop_grace` it started with, whatever a later reload changes. At the deadline the scheduler SHALL send SIGTERM to the run's process group, and SIGKILL `stop_grace` later if the group is still there, and SHALL record `timed out`. The scheduler SHALL send no signal to a process group below 2.

#### Scenario: A run that takes too long
- **WHEN** a job with `timeout = "2s"` runs `sh -c 'sleep 60 & wait'`
- **THEN** after 2 s the run and the `sleep` it started both get SIGTERM, and a `timed out` record gives the `job` and `pid`

#### Scenario: A run that ignores SIGTERM
- **WHEN** a run past its timeout ignores SIGTERM, and `stop_grace` is `1s`
- **THEN** its process group gets SIGKILL a second later, and the `exited` record's `signal` is `SIGKILL`

#### Scenario: A group below 2
- **WHEN** the group the scheduler is asked to signal is 0 or 1
- **THEN** it sends no signal

### Requirement: A failed run starts the job's on_failure command
When a run exits with a code other than 0, ends by a signal, passes its timeout or can't start, the scheduler SHALL start its job's `on_failure` command, or the top level's, unless there is none. The command SHALL start in the run's working directory, in a process group of its own, with stdin empty and its stdout and stderr appended to the run's log, with the run's environment and three more variables:
- `GREMLIN_RESULT`: `timeout` for a run that passed its timeout, whatever it then exited with, and otherwise `exit-code`, `signal`, or `error` for a run that couldn't start;
- `GREMLIN_STATUS`: the run's exit code, the name of the signal that ended it, or the reason it couldn't start;
- `GREMLIN_LOG`: the run log's absolute path.

The command SHALL get 60 s, then SIGTERM to its process group, and SIGKILL `stop_grace` later if the group is still there. It SHALL NOT count as the job's run. A run SHALL use the `on_failure` of the config it started under. A run that exits 0 without passing its timeout, a skipped fire, and a run that ends while the scheduler is stopping SHALL start no command. When the command exits with a code other than 0, ends by a signal, passes its 60 s or can't start, the scheduler SHALL record `error` with the job and a reason that names `on_failure`, and SHALL start nothing more for that run.

#### Scenario: A run that exits with code 1
- **WHEN** a job named `digest` has `on_failure = ["/bin/sh", "-c", "echo failed: $GREMLIN_JOB $GREMLIN_RESULT $GREMLIN_STATUS"]`, and its run exits with code 1
- **THEN** the command runs once, and the run's log ends with `failed: digest exit-code 1`

#### Scenario: A run that passes its timeout
- **WHEN** a job with `timeout = "2s"` and an `on_failure` command runs `sleep 60`
- **THEN** once the run has ended, the command runs with `GREMLIN_RESULT=timeout` and `GREMLIN_STATUS=SIGTERM`

#### Scenario: A program that doesn't exist
- **WHEN** a job's command names a program that doesn't exist, and the top level sets `on_failure`
- **THEN** the command runs with `GREMLIN_RESULT=error`, the reason in `GREMLIN_STATUS`, and the run log's absolute path in `GREMLIN_LOG`

#### Scenario: A run that succeeds, and a skipped fire
- **WHEN** a job with an `on_failure` command has a run that exits 0, and then a fire skipped with the reason `missed`
- **THEN** the command doesn't run

#### Scenario: A job that turns it off
- **WHEN** the top level sets `on_failure`, a job sets `on_failure = []`, and the job's run exits with code 1
- **THEN** no command runs

#### Scenario: The command fails
- **WHEN** a run fails, and its `on_failure` command exits with code 2
- **THEN** an `error` record gives the `job` and a `reason` that names `on_failure` and the code 2, and no other command starts

#### Scenario: A command that takes too long
- **WHEN** a run's `on_failure` command is still going 60 s after it started
- **THEN** its process group gets SIGTERM, and an `error` record gives the `job` and a `reason` that names `on_failure`

#### Scenario: Stopped with a run going
- **WHEN** the scheduler gets SIGTERM while a run of a job with an `on_failure` command is going
- **THEN** the run's process group gets SIGTERM, and no command starts when the run ends

### Requirement: Each job keeps its newest logs
After each run starts, the scheduler SHALL delete the job's oldest run logs beyond its `keep_runs`, and SHALL NOT delete the log of a run that is still going.

#### Scenario: Three runs, keeping two
- **WHEN** `keep_runs` is 2 and a job's third run starts
- **THEN** the job's folder holds the logs of its second and third runs only

### Requirement: The scheduler's own log
The scheduler SHALL append its records to `scheduler.log` in the data directory, created with mode 0600, one JSON object per line. Each object SHALL hold `time`, in ISO 8601 UTC, `level` and `message`, then the record's fields, and a time in a field SHALL be written as `time` is. The characters U+007F to U+009F SHALL be written as `\u` escapes, as the agent's JSON records write them. Before the log is open, the scheduler SHALL write its errors to stderr. Its records SHALL be:
- `info` `ready`: `zone`, and `jobs`, each with its `name` and `next` fire;
- `info` `started`: `job`, `slot`, `pid`, and `log`, the run log's path in the data directory;
- `info` `exited`: `job`, `code` or `signal` (a name, such as `SIGKILL`), and `seconds`, to a tenth;
- `info` `skipped`: `job`, `slot`, and `reason`, `running` or `missed`;
- `warn` `timed out`: `job` and `pid`;
- `error` `error`: `job` and `reason`, for a run that couldn't start or an `on_failure` command that failed;
- `warn` `clock stepped back`: `from` and `to`;
- `info` `config reloaded`: `jobs`, as in `ready`;
- `warn` `config refused`: `reason`;
- `info` `stopping`: `signal`;
- `info` `stopped`.

#### Scenario: A record
- **WHEN** a run starts
- **THEN** `scheduler.log` gains one line, a JSON object with `time`, `level` `info`, `message` `started`, and `job`, `slot`, `pid` and `log`

#### Scenario: Control characters in a reason
- **WHEN** an `error` record's `reason` holds ESC and U+009B
- **THEN** the line holds `\u001b` and `\u009b` and neither character itself

#### Scenario: The log's mode
- **WHEN** the scheduler creates `scheduler.log`
- **THEN** the file has mode 0600

### Requirement: One scheduler per data directory
The scheduler SHALL hold an exclusive lock on `lock` in the data directory, created with mode 0600, for as long as it runs. A scheduler that finds the lock held SHALL exit 1, saying that another scheduler is using the data directory. The lock SHALL be released when the scheduler's process ends, however it ends.

#### Scenario: A second scheduler
- **WHEN** a scheduler is running, and a second starts with the same data directory
- **THEN** the second exits 1, and its message names the data directory

#### Scenario: After a crash
- **WHEN** a scheduler is killed with SIGKILL
- **THEN** a scheduler started next with the same data directory starts

### Requirement: SIGTERM and SIGINT stop the scheduler and its runs
On SIGTERM or SIGINT the scheduler SHALL record `stopping`, start no more runs and no `on_failure` command, send SIGTERM to the process group of every run and `on_failure` command still going, wait up to `stop_grace` for them to end, send SIGKILL to any group still there, record `stopped`, and exit 0. Further signals during the stop SHALL be ignored.

#### Scenario: Stopped while idle
- **WHEN** the scheduler gets SIGTERM with no run going
- **THEN** it records `stopping` with `signal` `SIGTERM`, and `stopped`, and exits 0 within a second

#### Scenario: Stopped with a run going
- **WHEN** the scheduler gets SIGINT while a run is going
- **THEN** the run's process group gets SIGTERM, and the scheduler exits 0 once the run has ended

#### Scenario: A run that outlasts the grace
- **WHEN** the scheduler gets SIGTERM, `stop_grace` is `1s`, and a run ignores SIGTERM
- **THEN** the run's process group gets SIGKILL a second later, and the scheduler exits 0

### Requirement: SIGHUP rereads the config
On SIGHUP the scheduler SHALL read and check the config again. A config that passes SHALL replace the old one and be recorded as `config reloaded`: runs already going SHALL go on to their end, each with its own deadline; a job no longer in the config SHALL start nothing more; a job still in it SHALL keep its last look; and a new job's last look SHALL be the time of the reload. A config that fails SHALL be recorded as `config refused`, with its reason, and the old config SHALL stay in force.

#### Scenario: A job added
- **WHEN** a `* * * * *` job is added to the config, and the scheduler gets SIGHUP
- **THEN** a `config reloaded` record lists it in its `jobs`, and the new job starts at its next fire

#### Scenario: A job removed while its run is going
- **WHEN** a job whose run is going is removed from the config, and the scheduler gets SIGHUP
- **THEN** the run goes on, still bounded by the timeout it started with, and the job starts no new run

#### Scenario: A broken config
- **WHEN** the config gains a key it doesn't know, and the scheduler gets SIGHUP
- **THEN** a `config refused` record's `reason` names the key, and the jobs of the old config keep firing
