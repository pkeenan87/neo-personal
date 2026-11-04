//! The two monotonic clocks on Windows: `GetTickCount64` (milliseconds since boot, running through
//! sleep) and `QueryUnbiasedInterruptTime` (100 ns units, not running while the computer sleeps).

use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::WindowsProgramming::QueryUnbiasedInterruptTime;

use crate::clocks::Clocks;

pub fn read() -> Clocks {
    // SAFETY: no arguments.
    let boot_ms = unsafe { GetTickCount64() };
    let mut unbiased = 0u64;
    // SAFETY: valid out-pointer.
    let ok = unsafe { QueryUnbiasedInterruptTime(&mut unbiased) }.as_bool();
    let boot_secs = boot_ms / 1000;
    Clocks {
        boot_secs,
        // If the call fails, the sleep-free clock is not known: use the boot clock (never less
        // strict about elapsed time, only about sleep).
        awake_secs: if ok { unbiased / 10_000_000 } else { boot_secs },
    }
}
