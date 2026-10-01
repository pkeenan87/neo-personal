//! Running system tools (`log`, `pkgutil`, `sw_vers`) with a deadline and a byte cap, so a hung or
//! chatty tool cannot stall the scan loop or fill memory.

use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What a finished command produced.
#[derive(Debug)]
pub struct Output {
    pub status: Option<i32>,
    /// Standard output, cut at the byte cap.
    pub stdout: Vec<u8>,
    pub truncated: bool,
}

/// Runs `program` with `args`, reading at most `max_bytes` of stdout, and kills it after `timeout`.
/// Standard error is discarded.
pub fn run_capped(program: impl AsRef<Path>, args: &[String], timeout: Duration, max_bytes: usize) -> io::Result<Output> {
    let mut child = Command::new(program.as_ref())
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdout = child.stdout.take().ok_or_else(|| io::Error::other("no stdout"))?;
    // Read on a thread; the parent polls for exit so the deadline holds even if the tool blocks.
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        let mut truncated = false;
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if buf.len() < max_bytes {
                        let take = n.min(max_bytes - buf.len());
                        buf.extend_from_slice(&chunk[..take]);
                        truncated |= take < n;
                    } else {
                        truncated = true;
                    }
                }
            }
        }
        (buf, truncated)
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s.code();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // Not joined: a grandchild may still hold the pipe; the reader ends when it does.
            drop(reader);
            return Err(io::Error::new(io::ErrorKind::TimedOut, "the command took too long"));
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let (stdout, truncated) = reader.join().map_err(|_| io::Error::other("reader panicked"))?;
    Ok(Output { status, stdout, truncated })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn captures_output_and_exit_status() {
        let o = run_capped("/bin/sh", &s(&["-c", "echo hi; exit 3"]), Duration::from_secs(5), 1024).unwrap();
        assert_eq!(o.status, Some(3));
        assert_eq!(o.stdout, b"hi\n");
        assert!(!o.truncated);
    }

    #[test]
    fn output_is_capped() {
        let o = run_capped("/bin/sh", &s(&["-c", "yes | head -c 100000"]), Duration::from_secs(5), 1000).unwrap();
        assert_eq!(o.stdout.len(), 1000);
        assert!(o.truncated);
    }

    #[test]
    fn a_hung_tool_is_killed_at_the_deadline() {
        let start = Instant::now();
        let e = run_capped("/bin/sh", &s(&["-c", "exec sleep 30"]), Duration::from_millis(300), 1000).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_missing_tool_is_an_error() {
        assert!(run_capped("/nonexistent/tool", &[], Duration::from_secs(1), 10).is_err());
    }
}
