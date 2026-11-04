//! Acting on a Mac: closing a program and locking the screen (`_specs/v2-m2-child.md` section 7).
//!
//! Compiled on every unix so the logic can be tested on Linux; the one macOS-only fact, how to read
//! a process's path, is `libproc` there and `/proc` elsewhere. **Verify on real hardware:** that
//! `SIGTERM` then `SIGKILL` closes an app the person started, and that the lock command works on the
//! macOS versions in use (see the spec's Open Questions).

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::actuator::{Actuator, Target};

use super::notify::{LAUNCHCTL, console_uid, dev_console_owner};

/// How long a program has to quit after `SIGTERM` before it is killed.
pub const TERM_GRACE: Duration = Duration::from_secs(3);

/// The login-window lock tool. It lives inside a system bundle and is not present on every macOS
/// version, so it is tried only if it exists; `pmset displaysleepnow` is the fallback.
pub const CGSESSION: &str = "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession";
pub const PMSET: &str = "/usr/bin/pmset";

/// The path of the executable `pid` is running, `None` when it has ended or cannot be read.
#[cfg(target_os = "macos")]
fn path_of(pid: u32) -> Option<String> {
    super::procs::pid_path(pid as i32)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn path_of(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

/// Whether `pid` still runs the program at `image_path`.
fn same_program(pid: u32, image_path: &str) -> bool {
    path_of(pid).is_some_and(|p| p == image_path)
}

fn signal(pid: u32, sig: libc::c_int) -> bool {
    // SAFETY: kill(2) with a positive pid and a plain signal number.
    unsafe { libc::kill(pid as libc::pid_t, sig) == 0 }
}

/// `launchctl asuser <uid> <program> <args...>`: runs `program` in the person's login session.
pub fn asuser_args(uid: u32, program: &str, args: &[&str]) -> Vec<String> {
    let mut v = vec!["asuser".to_string(), uid.to_string(), program.to_string()];
    v.extend(args.iter().map(|a| a.to_string()));
    v
}

/// The lock command for `uid`: `CGSession -suspend` where that tool exists (it takes the Mac to the
/// login window, keeping the session), else `pmset displaysleepnow` (the display sleeps, and with
/// "require password immediately" it locks). All fixed text; nothing from the network or the person.
pub fn lock_command(uid: u32, cgsession_exists: bool) -> Vec<String> {
    if cgsession_exists {
        asuser_args(uid, CGSESSION, &["-suspend"])
    } else {
        asuser_args(uid, PMSET, &["displaysleepnow"])
    }
}

pub struct MacActuator;

impl Actuator for MacActuator {
    fn terminate(&self, target: &Target) -> Result<(), String> {
        let pid = target.pid;
        if pid <= 1 || pid == std::process::id() {
            return Err("refused: not a program that may be closed".into());
        }
        // A pid is reused after a process ends: close it only if it is still the program that was listed.
        if !same_program(pid, &target.image_path) {
            return Err("the program has already ended or changed".into());
        }
        if !signal(pid, libc::SIGTERM) {
            return Err("could not signal the program".into());
        }
        // Give it the grace period, then insist, on a thread so the scan loop is not held.
        let image = target.image_path.clone();
        std::thread::spawn(move || {
            std::thread::sleep(TERM_GRACE);
            if same_program(pid, &image) {
                signal(pid, libc::SIGKILL);
            }
        });
        Ok(())
    }

    fn lock_session(&self) -> Result<(), String> {
        let Some(uid) = console_uid(dev_console_owner()) else {
            return Err("nobody is logged in at the console".into());
        };
        let args = lock_command(uid, Path::new(CGSESSION).exists());
        Command::new(LAUNCHCTL)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|mut c| {
                // Reaped on a thread; the lock command returns at once.
                std::thread::spawn(move || {
                    let _ = c.wait();
                });
            })
            .map_err(|e| format!("could not run the lock command: {e}"))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Child;
    use std::time::Instant;

    fn spawn(script: &str) -> (Child, Target) {
        let child = Command::new("/bin/sh").args(["-c", script]).spawn().unwrap();
        std::thread::sleep(Duration::from_millis(150)); // let the shell finish any `exec`
        // The shell's own path, as /proc (or libproc) reports it.
        let path = path_of(child.id()).expect("a running child has a path");
        let t = Target {
            pid: child.id(),
            image_path: path,
        };
        (child, t)
    }

    fn wait_for_exit(c: &mut Child, within: Duration) -> bool {
        let end = Instant::now() + within;
        while Instant::now() < end {
            if c.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_program_is_closed_with_sigterm() {
        let (mut c, t) = spawn("exec sleep 30");
        // `exec sleep` replaced the shell: use the path of what is actually running.
        let t = Target {
            image_path: path_of(t.pid).unwrap(),
            ..t
        };
        MacActuator.terminate(&t).unwrap();
        assert!(wait_for_exit(&mut c, Duration::from_secs(2)), "SIGTERM closed it");
    }

    #[test]
    fn a_program_that_ignores_sigterm_is_killed_after_the_grace_period() {
        let (mut c, t) = spawn("trap '' TERM; while :; do sleep 1; done");
        MacActuator.terminate(&t).unwrap();
        // Not gone straight away: it ignores SIGTERM.
        std::thread::sleep(Duration::from_millis(500));
        assert!(c.try_wait().unwrap().is_none(), "still running inside the grace period");
        assert!(
            wait_for_exit(&mut c, TERM_GRACE + Duration::from_secs(3)),
            "SIGKILL after the grace period"
        );
    }

    #[test]
    fn a_pid_that_is_not_the_listed_program_is_left_alone() {
        let (mut c, t) = spawn("exec sleep 30");
        let wrong = Target {
            image_path: "/usr/bin/not-the-same".into(),
            ..t.clone()
        };
        assert!(MacActuator.terminate(&wrong).is_err());
        assert!(c.try_wait().unwrap().is_none());
        let gone = Target {
            pid: 4_000_000,
            image_path: t.image_path.clone(),
        };
        assert!(MacActuator.terminate(&gone).is_err());
        let _ = c.kill();
        let _ = c.wait();
    }

    #[test]
    fn init_and_the_service_itself_are_never_signalled() {
        for pid in [0, 1, std::process::id()] {
            let t = Target {
                pid,
                image_path: path_of(pid).unwrap_or_default(),
            };
            assert!(MacActuator.terminate(&t).is_err(), "pid {pid}");
        }
    }

    #[test]
    fn the_lock_command_is_fixed_text() {
        assert_eq!(
            lock_command(501, true),
            [
                "asuser",
                "501",
                "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession",
                "-suspend"
            ]
        );
        assert_eq!(lock_command(501, false), ["asuser", "501", "/usr/bin/pmset", "displaysleepnow"]);
    }
}
