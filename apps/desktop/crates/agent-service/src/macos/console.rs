//! What the Mac's console session is doing, for screen time (`_specs/v2-m2-child.md` section 7):
//! is someone signed in at the console, is the screen locked, how long since the last input.
//!
//! The facts come from the I/O Registry through `ioreg -a` (XML plists, no private API):
//! `IOConsoleUsers` (the console session's `kCGSSession...` keys) and `IOHIDSystem`'s `HIDIdleTime`
//! (nanoseconds). The parsers are plain functions over bytes, tested on Linux with captured shapes;
//! the output of the real tools on a real Mac is still to be checked ("verify on real hardware").

use std::io::Cursor;
use std::time::Duration;

use neo_agent_core::ledger::Console;
use plist::Value;

use super::exec;
use super::notify::console_uid;

const IOREG: &str = "/usr/sbin/ioreg";
const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT: usize = 512 * 1024;

/// Whether the console session has a person and whether its screen is locked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Session {
    pub present: bool,
    pub locked: bool,
}

fn parse(xml: &[u8]) -> Option<Value> {
    Value::from_reader(Cursor::new(xml)).ok()
}

/// The registry entries of an `ioreg -a` document: a top-level array of dictionaries (or one).
fn entries(v: &Value) -> Vec<&plist::Dictionary> {
    match v {
        Value::Array(a) => a.iter().filter_map(Value::as_dictionary).collect(),
        Value::Dictionary(d) => vec![d],
        _ => Vec::new(),
    }
}

/// The console user from `ioreg -n Root -d1 -a`. `None` when the document is not the expected shape;
/// `Some` with `present: false` at the login window (no user on the console).
pub fn parse_session(xml: &[u8]) -> Option<Session> {
    let doc = parse(xml)?;
    let root = entries(&doc).into_iter().find(|d| d.contains_key("IOConsoleUsers"))?;
    let users = root.get("IOConsoleUsers")?.as_array()?;
    let on_console = users
        .iter()
        .filter_map(Value::as_dictionary)
        .find(|u| u.get("kCGSSessionOnConsoleKey").and_then(Value::as_boolean) == Some(true));
    let Some(u) = on_console else {
        return Some(Session {
            present: false,
            locked: false,
        });
    };
    let named = u
        .get("kCGSSessionUserNameKey")
        .and_then(Value::as_string)
        .is_some_and(|n| !n.is_empty());
    let login_done = u.get("kCGSSessionLoginDoneKey").and_then(Value::as_boolean).unwrap_or(true);
    let locked = u.get("CGSSessionScreenIsLocked").and_then(Value::as_boolean).unwrap_or(false);
    Some(Session {
        present: named && login_done,
        locked,
    })
}

/// Seconds since the last keyboard or mouse input, from `ioreg -c IOHIDSystem -r -d1 -a`
/// (`HIDIdleTime` is nanoseconds). `None` when absent.
pub fn parse_idle_secs(xml: &[u8]) -> Option<u64> {
    let doc = parse(xml)?;
    entries(&doc)
        .into_iter()
        .find_map(|d| d.get("HIDIdleTime"))
        .and_then(|v| {
            v.as_unsigned_integer()
                .or_else(|| v.as_signed_integer().and_then(|i| u64::try_from(i).ok()))
        })
        .map(|ns| ns / 1_000_000_000)
}

fn run(args: &[&str]) -> Option<Vec<u8>> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let out = exec::run_capped(IOREG, &args, TIMEOUT, MAX_OUTPUT).ok()?;
    (out.status == Some(0) && !out.truncated).then_some(out.stdout)
}

/// The console now. When `ioreg` cannot be read or understood, a user is assumed present if
/// `/dev/console` is owned by someone other than root, and the screen is not locked.
pub fn read(console_owner_uid: Option<u32>) -> Console {
    let session = run(&["-n", "Root", "-d1", "-a"])
        .and_then(|x| parse_session(&x))
        .unwrap_or(Session {
            present: console_uid(console_owner_uid).is_some(),
            locked: false,
        });
    let idle_secs = if session.present {
        run(&["-c", "IOHIDSystem", "-r", "-d1", "-a"]).and_then(|x| parse_idle_secs(&x))
    } else {
        None
    };
    Console {
        present: session.present,
        locked: session.locked,
        idle_secs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(body: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">{body}</plist>"#
        )
        .into_bytes()
    }

    fn root(users: &str) -> Vec<u8> {
        doc(&format!(
            r#"<array><dict><key>IORegistryEntryName</key><string>Root</string><key>IOConsoleUsers</key><array>{users}</array></dict></array>"#
        ))
    }

    const ME: &str = r#"<dict><key>kCGSSessionOnConsoleKey</key><true/><key>kCGSSessionUserNameKey</key><string>kid</string><key>kCGSSessionLoginDoneKey</key><true/><key>kCGSSessionUserIDKey</key><integer>501</integer></dict>"#;
    const LOCKED: &str = r#"<dict><key>kCGSSessionOnConsoleKey</key><true/><key>kCGSSessionUserNameKey</key><string>kid</string><key>kCGSSessionLoginDoneKey</key><true/><key>CGSSessionScreenIsLocked</key><true/></dict>"#;
    const OTHER: &str = r#"<dict><key>kCGSSessionOnConsoleKey</key><false/><key>kCGSSessionUserNameKey</key><string>other</string><key>kCGSSessionLoginDoneKey</key><true/></dict>"#;

    #[test]
    fn a_signed_in_unlocked_console() {
        assert_eq!(
            parse_session(&root(ME)),
            Some(Session {
                present: true,
                locked: false
            })
        );
    }

    #[test]
    fn a_locked_screen() {
        assert_eq!(
            parse_session(&root(LOCKED)),
            Some(Session {
                present: true,
                locked: true
            })
        );
    }

    #[test]
    fn the_login_window_and_a_background_session_are_nobody_at_the_console() {
        assert_eq!(
            parse_session(&root("")),
            Some(Session {
                present: false,
                locked: false
            })
        );
        // Fast user switching: the other user is signed in but not on the console.
        assert_eq!(
            parse_session(&root(OTHER)),
            Some(Session {
                present: false,
                locked: false
            })
        );
        // The person who is on the console is the one counted, wherever it is in the list.
        let both = format!("{OTHER}{LOCKED}");
        assert_eq!(
            parse_session(&root(&both)),
            Some(Session {
                present: true,
                locked: true
            })
        );
    }

    #[test]
    fn a_session_that_has_not_finished_logging_in_is_not_present() {
        let u = r#"<dict><key>kCGSSessionOnConsoleKey</key><true/><key>kCGSSessionUserNameKey</key><string>kid</string><key>kCGSSessionLoginDoneKey</key><false/></dict>"#;
        assert_eq!(
            parse_session(&root(u)),
            Some(Session {
                present: false,
                locked: false
            })
        );
    }

    #[test]
    fn unexpected_output_is_not_guessed_at() {
        assert_eq!(parse_session(b"not a plist"), None);
        assert_eq!(parse_session(&doc("<array/>")), None);
        assert_eq!(parse_session(&doc("<dict><key>x</key><string>y</string></dict>")), None);
        assert_eq!(parse_session(b""), None);
    }

    #[test]
    fn idle_time_is_nanoseconds() {
        let one = doc(
            r#"<array><dict><key>IOClass</key><string>IOHIDSystem</string><key>HIDIdleTime</key><integer>7500000000</integer></dict></array>"#,
        );
        assert_eq!(parse_idle_secs(&one), Some(7));
        let zero = doc(r#"<array><dict><key>HIDIdleTime</key><integer>0</integer></dict></array>"#);
        assert_eq!(parse_idle_secs(&zero), Some(0));
        let big = doc(r#"<array><dict><key>HIDIdleTime</key><integer>86400000000000</integer></dict></array>"#);
        assert_eq!(parse_idle_secs(&big), Some(86_400));
        assert_eq!(parse_idle_secs(&doc("<array/>")), None);
        assert_eq!(parse_idle_secs(b"nope"), None);
        let neg = doc(r#"<array><dict><key>HIDIdleTime</key><integer>-5</integer></dict></array>"#);
        assert_eq!(parse_idle_secs(&neg), None);
    }
}
