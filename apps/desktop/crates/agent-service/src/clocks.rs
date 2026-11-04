//! The two monotonic clocks Child mode needs, read from the OS:
//!
//! - `boot_secs` keeps counting while the computer sleeps. The trusted clock advances by it, so a
//!   night's sleep is a night, and a wall clock moved by hand shows up as a difference.
//! - `awake_secs` stops while the computer sleeps. Screen time and the service-gap rule use it, so
//!   a closed lid is neither use nor an outage.
//!
//! Both start at zero at boot.

/// One reading of both clocks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Clocks {
    pub boot_secs: u64,
    pub awake_secs: u64,
}

/// Reads the clocks of the machine the service runs on.
pub fn read() -> Clocks {
    imp::read()
}

#[cfg(windows)]
mod imp {
    use super::Clocks;

    pub fn read() -> Clocks {
        crate::windows::clocks::read()
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Clocks;

    // `CLOCK_MONOTONIC_RAW` runs through sleep; `CLOCK_UPTIME_RAW` does not (clock_gettime(3)).
    pub fn read() -> Clocks {
        Clocks {
            boot_secs: super::unix_clock(libc::CLOCK_MONOTONIC_RAW),
            awake_secs: super::unix_clock(libc::CLOCK_UPTIME_RAW),
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use super::Clocks;

    // Linux (development and tests): `CLOCK_BOOTTIME` runs through suspend, `CLOCK_MONOTONIC` does not.
    pub fn read() -> Clocks {
        Clocks {
            boot_secs: super::unix_clock(libc::CLOCK_BOOTTIME),
            awake_secs: super::unix_clock(libc::CLOCK_MONOTONIC),
        }
    }
}

#[cfg(unix)]
fn unix_clock(id: libc::clockid_t) -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: `ts` is a valid out-pointer for the duration of the call.
    let rc = unsafe { libc::clock_gettime(id, &mut ts) };
    if rc == 0 { ts.tv_sec.max(0) as u64 } else { 0 }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn the_clocks_run_and_awake_never_exceeds_boot() {
        let a = read();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let b = read();
        assert!(b.boot_secs >= a.boot_secs && b.awake_secs >= a.awake_secs);
        assert!(b.boot_secs >= b.awake_secs, "sleep can only make the boot clock bigger");
        assert!(b.boot_secs > 0);
    }
}
