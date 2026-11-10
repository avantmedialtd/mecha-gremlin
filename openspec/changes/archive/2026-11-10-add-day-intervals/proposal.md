## Why

`gremlin-scheduler` runs a job only on a cron schedule, and cron counts calendar dates: `0 7 */30 * *` fires on the 1st and the 31st, 30 days apart and then 1, and only gaps of 1 and 7 days have a cron form (Brief, R27.1). A job that should run every 30 days can't be written. D56–D59 settle the answer (C25, R27): an interval of N calendar days, counted from a start date the config gives, written as `start` and `every` in place of `schedule`.

## What Changes

- **Day intervals.** A `[[job]]` can hold `start` and `every` in place of `schedule`. `start = 2026-11-15T07:00` is a TOML local date-time, with or without seconds, and `every = "30d"` is a whole number of days from 1 followed by `d` (D58). The job fires at the start, then every N days after it.
- **Calendar days in the schedule's zone (D57).** Fire k is the start's date plus k × N days, at the start's time. It is read in the config's `timezone`, or in the system's zone when the config names none, as cron fields are, so a run keeps its local time across DST changes and follows the zone when it changes. Each fire comes from the start, never from the fire before it. A time in a skipped hour fires at that hour's end, and one in a repeated hour fires once, at the first pass, as fixed-time cron schedules do.
- **Everything else as for cron.** A missed fire runs once, for the latest slot, and `catch_up = false` skips it. A fire during a run is skipped. The run gets `GREMLIN_SLOT` and, when it catches up, `GREMLIN_CATCH_UP=1`. `check`, `install` and the `ready` record show the job's next fires, and after a restart its last look comes from its newest run log.
- **A start that has passed (D59).** A day-interval job with no run log counts every slot since its start as unseen. So when the scheduler starts, or a reload adds the job, its latest slot that has passed runs once, as a catch-up, or is recorded as `skipped` with `missed` under `catch_up = false`. A cron job with no log still waits for its next fire.
- **The check** refuses:
  - `start` without `every`, or the reverse;
  - either beside `schedule`;
  - a `start` that is a date or a time alone, or has an offset;
  - an `every` that isn't a whole number of days followed by `d`, or is `0d`;
  - a day interval with no fire after now.

  A job still needs a schedule of one kind or the other.
- **The README** documents day intervals in the scheduler's config section: an example, the zone and DST rules, and what a start that has passed does.

## Capabilities

### New Capabilities

None: a day interval is a second kind of schedule in the existing `scheduler` capability.

### Modified Capabilities

- `scheduler`: these requirements change:
  - **The config:** it takes `start` and `every` as a second kind of schedule, and its check refuses them when they're wrong.
  - **Schedules:** they gain day intervals, read in the same zone, with the fixed-time rule for a skipped or repeated hour.
  - **A missed fire:** a day-interval job that has never run gets a first look of its own, at the start and at a reload.
  - **`check`:** it prints a day interval's fires.

## Impact

- **`packages/scheduler`:**
  - `schedule.rs` gains the day interval behind `Schedule`'s `next_after`, `latest_until` and `fires`, with its own handling of a skipped hour.
  - `config.rs` reads and checks `start` and `every`.
  - Where a job's first look is set, a day-interval job with no run log starts its look before its start.
  - Tests, under cargo-mutants' bar, cover each of these.
- **No new dependency:** jiff already does the calendar arithmetic and zone lookups, and `toml` 1.2.1 reads TOML 1.1's local date-times (R27.3, R27.4).
- **Also touched:** the README's scheduler section and the Brief.
- **Not in scope:**
  - intervals in hours, minutes, weeks or months, since `every` takes days;
  - several fires a day on every Nth day, D58's cron schedule filtered by an interval;
  - a start with an offset or a zone of its own;
  - counting from the last run (D56);
  - changing a cron job's first look.
