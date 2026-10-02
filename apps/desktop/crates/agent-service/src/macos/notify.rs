//! The warning fallback with nobody listening: when no tray app is subscribed, the daemon shows an
//! alert in the console user's session itself, through `launchctl asuser <uid> osascript`. All text
//! goes in as arguments (`argv`), never spliced into the script.

use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

use crate::agent::Notifier;

pub const LAUNCHCTL: &str = "/bin/launchctl";
pub const OSASCRIPT: &str = "/usr/bin/osascript";

/// The console user's uid: the owner of `/dev/console`. `None` when nobody is logged in (the login
/// window owns it as root).
pub fn console_uid(owner_of_console: Option<u32>) -> Option<u32> {
    owner_of_console.filter(|uid| *uid != 0)
}

fn dev_console_owner() -> Option<u32> {
    std::fs::metadata("/dev/console").ok().map(|m| m.uid())
}

/// The arguments to `launchctl` that show `title` and `body` with a single OK button to `uid`.
pub fn launchctl_args(uid: u32, title: &str, body: &str) -> Vec<String> {
    [
        "asuser",
        &uid.to_string(),
        OSASCRIPT,
        "-e",
        "on run argv",
        "-e",
        "display alert (item 1 of argv) message (item 2 of argv)",
        "-e",
        "end run",
        title,
        body,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

pub struct ConsoleNotifier;

impl Notifier for ConsoleNotifier {
    fn fallback_warning(&self, title: &str, text: &str) {
        let Some(uid) = console_uid(dev_console_owner()) else {
            log::warn!("nobody is logged in at the console; the warning was not shown");
            return;
        };
        // osascript waits for the OK button; do not hold the scan loop. A thread reaps the child.
        let child = Command::new(LAUNCHCTL)
            .args(launchctl_args(uid, title, text))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn();
        match child {
            Ok(mut c) => {
                std::thread::spawn(move || {
                    let _ = c.wait();
                });
            }
            Err(e) => log::warn!("fallback warning failed: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nobody_logged_in_means_no_console_user() {
        assert_eq!(console_uid(Some(501)), Some(501));
        assert_eq!(console_uid(Some(0)), None);
        assert_eq!(console_uid(None), None);
    }

    #[test]
    fn text_is_only_ever_an_argument() {
        let nasty = r#"x" & do shell script "touch /tmp/pwned" & ""#;
        let args = launchctl_args(501, "Neo: title", nasty);
        assert_eq!(&args[..3], ["asuser", "501", "/usr/bin/osascript"]);
        // The script lines are fixed; the text is the last two separate arguments.
        assert_eq!(args[4], "on run argv");
        assert_eq!(args[6], "display alert (item 1 of argv) message (item 2 of argv)");
        assert_eq!(args[8], "end run");
        assert_eq!(args[9], "Neo: title");
        assert_eq!(args[10], nasty);
        assert_eq!(args.len(), 11);
        assert!(!args[..9].iter().any(|a| a.contains("pwned")));
    }
}
