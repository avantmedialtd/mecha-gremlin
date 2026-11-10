## 1. The day interval in `schedule.rs`

- [ ] 1.1 Turn `Schedule` into an enum of `Cron`, holding croner's `Cron` as today, and `Days`, holding the start as a jiff `civil::DateTime` and N, with `next_after`, `latest_until` and `fires` matching on it (design decision 1). Cron schedules behave exactly as before, and their tests pass unchanged.
- [ ] 1.2 Compute a `Days` schedule's fires from the start's civil date (design decision 2). Fire k is `start.date() + k × N days` at `start.time()`, for k from 0. `next_after` returns the first fire strictly after its argument, and `latest_until` the last at or before it. Both start from k₀ = ⌊(the argument's date − the start's date) / N⌋ and try k₀ − 1 to k₀ + 1, never below 0. `fires` walks k up. All arithmetic is checked, and a date past 9999-12-31 ends the series.
- [ ] 1.3 Place each fire in the zone through `TimeZone::to_ambiguous_zoned`: a single instant as it is, the earlier instant in a fold, and in a gap the instant the clocks jump forward, found with `TimeZone::following`. Never use jiff's `compatible()`.
- [ ] 1.4 Test the fires (design decision 7):
  - the start as the first fire, and the 30-day series in Europe/London from 2026-11-15;
  - 2027-04-14 at 07:00 BST, after the change of 2027-03-28;
  - America/New_York's gap on 2027-03-14 and fold on 2027-11-07, at the same instants `30 2 * * *` and `30 1 * * *` give;
  - `next_after` strict and `latest_until` inclusive at a fire's exact instant, and nothing before the start;
  - `every = "1d"` against `@daily`'s times;
  - an N that runs past 9999;
  - a zone change between two calls.

## 2. `start` and `every` in the config

- [ ] 2.1 Make `JobTable`'s `schedule` optional, and add `start` as `Spanned<toml::value::Datetime>` and `every` as `Spanned<String>`, keeping `deny_unknown_fields` (design decision 3).
- [ ] 2.2 Check them in decision 3's order. Each failure names the file, the job or key, and its line:
  - exactly one kind of schedule;
  - `start` a local date-time, refusing a date alone, a time alone and an offset;
  - `every` ASCII digits then `d`, above 0, refusing `30`, `0d`, `+30d`, `30 d` and `4w`;
  - a fire after now.

  Leave the duration grammar of `timeout` and `stop_grace` without a `d`.
- [ ] 2.3 Test each refusal and its message, both kinds of schedule in one config, a `start` with seconds, and a `start` given as a string, which fails as a value of the wrong type.

## 3. The first look of a day interval that has never run (D59)

- [ ] 3.1 Give a job its first look through one helper (design decision 5): the start of its newest run log, or without a log, `Timestamp::MIN` for a day interval and now for a cron job.
  - Use it in `Scheduler::new`, and in `reload` for a new job with no log.
  - A new job with a log keeps the reload's time, and a kept job keeps its look.
- [ ] 3.2 Test with the injected clock:
  - at the start, a never-run day interval catches up its latest passed slot once with `GREMLIN_CATCH_UP=1`, records `skipped` with `missed` under `catch_up = false`, or waits for a start still to come;
  - the same job added by a reload acts at once;
  - a day interval with a log starts from that log;
  - a new cron job still waits for its next fire.

## 4. The binary and mutation testing

- [ ] 4.1 Test the built binary in `tests/`:
  - a day interval with a past start and no log runs at once, with its `started` record's `slot`, and its run's `GREMLIN_SLOT` and `GREMLIN_CATCH_UP=1`, as the spec says;
  - `check` prints a day interval's next 5 fires;
  - a config with `schedule` beside `every` fails `check`, naming the key and its line.
- [ ] 4.2 Run `bun run mutation:scheduler` until no mutant survives or times out. Turn off only equivalent or unreachable mutants, each with its reason above it.

## 5. Documentation and the Brief

- [ ] 5.1 Document day intervals in the README's scheduler section (design decision 8): `start` and `every` in the keys table and in the strict check's list, and a "Day intervals" part with an example and the rules for:
  - the local time and the zone;
  - a skipped or repeated hour;
  - a start that has passed;
  - the gap between runs across a DST change and after downtime.
- [ ] 5.2 Update the Brief: a line in its log saying that `add-day-intervals` carries out D56–D59, and "The change `add-day-intervals` carries it out" in their statuses.

## 6. Verify

- [ ] 6.1 With the CPU cool (`uptime`), run `bun run check` and `bun run mutation:scheduler`, and see both pass, running neither `install` nor `uninstall` on this machine.
- [ ] 6.2 Run `openspec validate add-day-intervals --strict`.
