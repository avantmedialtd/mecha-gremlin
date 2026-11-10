## Context

`gremlin-scheduler` takes a job's `schedule` as five cron fields or a nickname, parsed by croner-rust 4.0.3. Cron counts calendar dates, so no schedule runs a job every 30 days: `0 7 */30 * *` fires on the 1st and the 31st (Brief, R27.1). The decisions of 2026-11-10 settle the answer (C25, R27):

- **D56:** a day interval counts from a start date the config gives, as asked, so every fire follows from the start alone, and a late run doesn't move the cycle.
- **D57:** a day is a calendar day. Fire k is the start's date plus k × N days, at the start's time, in the schedule's zone, with the fixed-time rule at a DST change.
- **D58:** a job writes `start`, a TOML local date-time, and `every`, whole days, in place of `schedule`.
- **D59:** a day-interval job with no run log catches up its latest passed slot once, when the scheduler starts or a reload adds it, as asked. Waiting for its next fire had been recommended.

The scheduler's parts this touches:
- **`schedule.rs`:** the rest of the scheduler sees a schedule through `Schedule`'s `next_after`, `latest_until` and `fires`, today a wrapper of croner's `Cron`. `due()` takes the latest fire after a job's last look and at or before now.
- **`config.rs`:** it deserializes each `[[job]]` into a `JobTable` with `deny_unknown_fields` and `Spanned` values, so that an error names its key and line.
- **`main.rs`:** a job's first look is the start of its newest run log, or now. A reload keeps a kept job's look and gives a new job now. A decision follows every wake and every event, so it also follows a reload.

## Goals / Non-Goals

**Goals:**
- `start` and `every` as a second kind of schedule, checked as strictly as `schedule`.
- Fires that keep the start's local time, follow the zone, and match a fixed-time cron schedule's instants at a DST change.
- Catch-up, overlap, `catch_up = false`, the run's variables, `check`, `install`'s printout and the `ready` record, all unchanged in code and behaviour.
- D59's first look for a day interval that has never run, at the start and at a reload.
- cargo-mutants still catches every mutant.

**Non-Goals:**
- Intervals in hours, minutes, weeks or months; several fires a day on every Nth day; a start with an offset or a zone of its own; counting from the last run.
- Any change to cron schedules, their parsing or their first look.
- `check` showing that a never-run job will catch up. It reads no data directory, so it can't know whether the job has run.

## Decisions

### 1. A second kind of schedule behind `Schedule`

`Schedule` becomes an enum with two variants: `Cron`, holding croner's `Cron` as today, and `Days`, holding the start as a jiff `civil::DateTime` and N. The three methods match on it. Nothing outside `schedule.rs` changes for the fires, because `due()`, the loop, `check`, `ready` and `install` only call those methods, with a `Zoned` whose zone is the schedule's.

Alternatives:
- **A trait object.** It adds dynamic dispatch and boxing, but nothing an enum of two can't do.
- **Extending croner-rust.** It has no start date, interval or misfire setting (R27.2), and the scheduler pins a published release.

### 2. Fires computed from the start's civil date

Fire k is the civil date-time `start.date() + k × N days` at `start.time()`, placed in the zone. Each is computed from the start, never by adding N days to the fire before. A fire moved by a DST gap then moves no other, and a long run of fires accumulates no error (R27.3).
- **`next_after(t)`:** take t's civil date in the zone, find k₀ = ⌊(that date − start's date) / N days⌋ with jiff's day count, and try k₀ − 1, k₀ and k₀ + 1, from 0 up. It returns the first fire strictly after t, since a fire's instant can sit an hour either side of its civil time at a change.
- **`latest_until(t)`:** the last fire at or before t, or none before the first fire.
- **`fires(after, count)`:** walks k up from `next_after`.
- **Overflow:** every addition is checked. A date past jiff's range, 9999-12-31, ends the series, so the arithmetic never panics, and a day interval with no fire after now fails the check, as a cron schedule that never fires does.

Placing a civil date-time in the zone goes through jiff's `TimeZone::to_ambiguous_zoned`:
- **One instant:** that instant.
- **A fold:** the earlier instant, the first pass, as `earlier()` gives.
- **A gap:** the instant the clocks jump forward, the end of the skipped hour, as croner-rust puts a fixed time ("at the first valid second/minute immediately following the gap", R27.2). The transition is found through `TimeZone::following` from the gap's start. jiff's own `compatible()` would give 03:30 for 02:30 where the spec's rule gives 03:00 (R27.3), so the gap is handled here.

Alternatives:
- **24-hour steps.** D57 rejected them: the run's clock time would move an hour twice a year.
- **Adding N days to the previous fire with `Zoned::checked_add`.** jiff's `compatible()` rule would leave a gap-moved fire, and the fires after it, at 03:30 rather than 03:00.

### 3. `start` and `every` in the config

`JobTable`'s `schedule` becomes optional. It gains `start: Option<Spanned<toml::value::Datetime>>` and `every: Option<Spanned<String>>`, and keeps `deny_unknown_fields`. The check, in order, failing at the first problem, with the file, the key and its line, as every check does:
1. **Exactly one kind of schedule.** A job has either `schedule`, or `start` and `every`. A `schedule` beside either of the others, one of `start` and `every` without the other, or none of the three, fails, naming the job and the key.
2. **`start` is a local date-time.** toml's `Datetime` holds an optional date, time and offset. A date alone, a time alone or any offset fails. A string, such as `"2026-11-15T07:00"`, already fails as a value of the wrong type. Seconds default to 0, as TOML 1.1 says (R27.4).
3. **`every` is whole days.** ASCII digits, then `d`, above 0, parsed as durations are, with the digits checked first, since `parse()` would take a leading `+`. `30`, `0d`, `+30d`, `30 d` and `4w` fail. The duration grammar of `timeout` and `stop_grace` gains no `d`, so a day keeps one meaning in the config: a calendar day, in `every` alone.
4. **A fire after now.** As for cron, the check fails a day interval whose `next_after(now)` finds no fire.

Messages follow the existing ones, such as "`every` must be a whole number of days above 0 followed by d, such as 30d, not `…`".

Alternatives (D58): one `schedule` string with a grammar of its own, and a cron `schedule` filtered by `every` and a start date.

### 4. The zone, as for cron

A `Days` schedule holds no zone. Its fires are placed in the zone of the `Zoned` passed in, which is the zone the loop reads again at every wake (D53). A start of `…T07:00` therefore fires at 07:00 New York time after a move from London, as `0 7 * * *` does.

### 5. The first look of a day interval that has never run (D59)

- **At the start:** a job's first look stays the start of its newest run log. Without a log, a day interval's first look is the earliest timestamp, `Timestamp::MIN`, and a cron job's stays now. A day interval has no fire before its start, so an earliest look counts every slot since the start as unseen, which is the spec's "just before its first fire". The start's decision then takes the latest passed fire, through `due()`:
  - one seen 90 s or more after its time is missed, and runs once with `GREMLIN_CATCH_UP=1`, or is recorded as `skipped` with `missed` under `catch_up = false`;
  - one seen sooner is on time;
  - a start still to come gives nothing until it.
- **At a reload,** the same helper gives the look of a new job with no log. A new job with a log keeps the reload's time, as the spec has it today, and a kept job keeps its look. The decision after the reload's event acts at once.

The backward-step check compares now with the previous wake, not with looks, so an earliest look doesn't trip it.

Alternative: the instant just before the start, placed in the zone at the time of the look. It needs the zone where `Scheduler::new` doesn't have it yet, and gives the same decisions.

### 6. `check`, `ready` and `install`

There is no new code here. Each prints a job's next fires through `fires` or `next_after`, and a day interval answers both. `check` shows future fires only. The README says that a job which has never run, and whose start has passed, also runs once when the scheduler starts.

### 7. Tests

- **`schedule.rs` unit tests:**
  - the start as the first fire, and the 30-day series in Europe/London from 2026-11-15;
  - the kept clock time across 2027-03-28, so 2027-04-14 at 07:00 BST;
  - a gap and a fold in America/New_York on 2027-03-14 and 2027-11-07, at the same instants `30 2 * * *` and `30 1 * * *` give;
  - `next_after` strict and `latest_until` inclusive at a fire's exact instant, nothing before the start, `every = "1d"` against `@daily`, and an N that runs past 9999;
  - a zone change between two calls.
- **`config.rs` unit tests:** every refusal in decision 3, each naming its key and line; both kinds side by side; a `start` with seconds.
- **The loop's tests,** with the injected clock: a never-run day interval at the start, which catches up, or skips under `catch_up = false`, or waits for a start still to come; the same added by a reload; a day interval with a log, which starts from it; and a new cron job, unchanged.
- **The binary's tests:** a day interval with a past start and no log runs at once, with `GREMLIN_SLOT` and `GREMLIN_CATCH_UP=1`, so there's no wait for a minute; `check` prints a day interval's fires.
- **cargo-mutants** must still catch every mutant. The arithmetic's literals and boundaries, k₀ ± 1, the strict and inclusive comparisons, and the gap and fold branches each get a test that fails when they change.

### 8. The README

The config section's table gains `start` and `every`, and the strict-check list gains their refusals. A short "Day intervals" part gives an example and four rules:
- runs keep the start's local time, in the schedule's zone;
- a skipped hour runs at its end, and a repeated hour runs once;
- a start that has passed makes a never-run job run once when the scheduler starts or a reload adds it;
- two runs come N × 24 hours ± 1 apart across a DST change, and after a long downtime the run after a catch-up can come sooner than N days.

## Risks / Trade-offs

- **[The gap rule is written by hand, beside croner-rust's]** → Tests pin the day interval's instants at both 2027 New York transitions to the ones croner gives for the same fixed times, so the two kinds can't drift apart unnoticed.
- **[A start months back runs at once (D59)]** → This is the chosen behaviour. The README says so, `check` shows the next fires, and `catch_up = false` turns it off.
- **[Across a DST change, two runs are N × 24 hours ± 1 apart (D57)]** → A service that counts exactly 720 hours could refuse a run an hour early. The README says so.
- **[After a long downtime, the run after a catch-up can come fewer than N days later]** → Fires stay on the start's slots by design (D56). The README says so.
- **[Changing a kept job's `start` or `every` at a reload]** → The kept look can make a slot of the new schedule, between the look and now, a missed fire that runs once. This is the same as editing a cron schedule today.
- **[`Timestamp::MIN` as a look]** → Only `due()` reads looks, comparing a fire with them, and every fire is later. A test covers a never-run job's first decision.

## Migration Plan

None. The change is additive: configs with `schedule` keep working unchanged, and `start` and `every` are new keys. Rolling back means removing jobs that use them, whose keys an older binary refuses as unknown.

## Open Questions

None. D56–D59 are decided.
