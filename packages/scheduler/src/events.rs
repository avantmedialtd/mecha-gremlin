use std::process::Child;
use std::sync::mpsc::Sender;
use std::thread;
use std::time::Duration;

use jiff::Timestamp;
use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
use signal_hook::iterator::Signals;

use crate::runs::{self, Ended};

// The wait counts on a clock that stops while the machine sleeps, so the scheduler reads the wall
// clock at least this often (D54).
pub const CAP: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq)]
pub enum Event {
    Signal(i32),
    Exited { id: u64, ended: Ended },
}

pub fn watch_signals(events: Sender<Event>) -> Result<(), String> {
    let mut signals = Signals::new([SIGTERM, SIGINT, SIGHUP])
        .map_err(|error| format!("couldn't watch for signals: {error}"))?;

    thread::spawn(move || {
        for signal in signals.forever() {
            let _ = events.send(Event::Signal(signal));
        }
    });

    Ok(())
}

pub fn wait_for(mut child: Child, id: u64, events: Sender<Event>) {
    thread::spawn(move || {
        // wait() fails only for a child that has been reaped elsewhere, which nothing here does.
        let ended = child.wait().map_or(Ended::Signal(0), runs::ended);
        let _ = events.send(Event::Exited { id, ended });
    });
}

pub fn wait_time(
    now: Timestamp,
    fire: Option<Timestamp>,
    mono: Duration,
    signal: Option<Duration>,
) -> Duration {
    let mut wait = CAP;

    if let Some(fire) = fire {
        wait = wait.min(Duration::try_from(fire.duration_since(now)).unwrap_or(Duration::ZERO));
    }

    if let Some(signal) = signal {
        wait = wait.min(signal.saturating_sub(mono));
    }

    wait
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    fn secs(seconds: f64) -> Duration {
        Duration::from_secs_f64(seconds)
    }

    #[test]
    fn an_idle_wait_is_capped_at_60_seconds() {
        let now = at("2026-11-10T07:00:00Z");

        assert_eq!(wait_time(now, None, secs(5.0), None), secs(60.0));
        assert_eq!(
            wait_time(now, Some(at("2026-11-10T09:00:00Z")), secs(5.0), None),
            secs(60.0)
        );
        assert_eq!(
            wait_time(now, None, secs(5.0), Some(secs(3605.0))),
            secs(60.0)
        );
    }

    #[test]
    fn the_wait_ends_at_the_next_fire() {
        let now = at("2026-11-10T07:00:40Z");

        assert_eq!(
            wait_time(now, Some(at("2026-11-10T07:01:00Z")), secs(5.0), None),
            secs(20.0)
        );
        assert_eq!(
            wait_time(now, Some(at("2026-11-10T07:00:39Z")), secs(5.0), None),
            Duration::ZERO
        );
    }

    #[test]
    fn the_wait_ends_at_the_nearest_signal() {
        let now = at("2026-11-10T07:00:00Z");

        assert_eq!(wait_time(now, None, secs(5.0), Some(secs(7.5))), secs(2.5));
        assert_eq!(
            wait_time(now, None, secs(5.0), Some(secs(4.0))),
            Duration::ZERO
        );
        assert_eq!(
            wait_time(
                now,
                Some(at("2026-11-10T07:00:10Z")),
                secs(5.0),
                Some(secs(8.0))
            ),
            secs(3.0)
        );
        assert_eq!(
            wait_time(
                now,
                Some(at("2026-11-10T07:00:02Z")),
                secs(5.0),
                Some(secs(8.0))
            ),
            secs(2.0)
        );
    }
}
