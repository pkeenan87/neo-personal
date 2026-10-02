//! Serving the pipe protocol over any byte stream, plus the Linux/dev unix-socket server (the
//! Windows named-pipe server is in `windows::pipe`).

use std::io::{BufReader, Read, Write};
use std::sync::Arc;
#[cfg(unix)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::Value;

use crate::agent::Agent;
use crate::protocol::{Line, ProtocolError, Request, ok_response, parse_request, read_line};

/// At most this many connections are served at once.
pub const MAX_CONNECTIONS: usize = 32;
/// A subscribed connection gets a blank line this often so a vanished client is noticed.
const KEEPALIVE: Duration = Duration::from_secs(30);

fn write_line<W: Write>(w: &mut W, v: &Value) -> std::io::Result<()> {
    let mut s = v.to_string();
    s.push('\n');
    w.write_all(s.as_bytes())?;
    w.flush()
}

/// Serves one connection until the client leaves. After `subscribe` the connection only carries
/// pushes (a blocking read and a write on one synchronous pipe handle would deadlock), so a client
/// that wants to ask questions opens a second connection.
pub fn serve_connection<R: Read, W: Write>(agent: &Agent, reader: R, mut writer: W) {
    serve_connection_with(agent, reader, &mut writer, KEEPALIVE)
}

pub fn serve_connection_with<R: Read, W: Write>(agent: &Agent, reader: R, writer: &mut W, keepalive: Duration) {
    let mut reader = BufReader::new(reader);
    loop {
        let line = match read_line(&mut reader) {
            Ok(Line::Data(d)) => d,
            Ok(Line::TooLarge) => {
                let _ = write_line(writer, &ProtocolError::TooLarge.response());
                return;
            }
            Ok(Line::Eof) | Err(_) => return,
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match parse_request(&line) {
            Ok(Request::Subscribe) => {
                let rx = agent.hub().subscribe();
                if write_line(writer, &ok_response(serde_json::json!({}))).is_err() {
                    return;
                }
                loop {
                    let out = match rx.recv_timeout(keepalive) {
                        Ok(push) => push + "\n",
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => "\n".to_string(),
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                    };
                    if writer.write_all(out.as_bytes()).and_then(|_| writer.flush()).is_err() {
                        return;
                    }
                }
            }
            Ok(req) => {
                if write_line(writer, &agent.handle(req)).is_err() {
                    return;
                }
            }
            Err(e) => {
                if write_line(writer, &e.response()).is_err() {
                    return;
                }
            }
        }
    }
}

/// Counts open connections so a local process cannot exhaust threads.
#[derive(Default)]
pub struct ConnectionGate {
    open: AtomicUsize,
}

pub struct ConnectionPermit(Arc<ConnectionGate>);

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ConnectionGate {
    pub fn try_acquire(self: &Arc<Self>) -> Option<ConnectionPermit> {
        if self.open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.open.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(ConnectionPermit(self.clone()))
    }
}

/// Decides, per connection, whether a unix-socket peer may talk to the service (macOS: `getpeereid`;
/// every local user is allowed, a peer whose credentials cannot be read is not).
#[cfg(unix)]
pub trait PeerCheck: Send + Sync {
    fn admit(&self, stream: &std::os::unix::net::UnixStream) -> bool;
}

/// Serves the protocol on a unix socket until `stop` is set (Linux development; `--dev-pipe`).
#[cfg(unix)]
pub fn serve_unix(agent: Arc<Agent>, path: &std::path::Path, stop: Arc<AtomicBool>) -> std::io::Result<()> {
    serve_unix_checked(agent, path, stop, None)
}

/// [`serve_unix`] with a per-connection peer check (the macOS daemon's socket).
#[cfg(unix)]
pub fn serve_unix_checked(
    agent: Arc<Agent>,
    path: &std::path::Path,
    stop: Arc<AtomicBool>,
    peer: Option<Arc<dyn PeerCheck>>,
) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let _ = std::fs::remove_file(path);
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o666))?;
    listener.set_nonblocking(true)?;
    let gate = Arc::new(ConnectionGate::default());
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                if peer.as_ref().is_some_and(|p| !p.admit(&stream)) {
                    log::warn!("refused a connection whose peer could not be verified");
                    continue;
                }
                let Some(permit) = gate.try_acquire() else { continue };
                let _ = stream.set_nonblocking(false);
                let agent = agent.clone();
                std::thread::spawn(move || {
                    let _permit = permit;
                    if let Ok(read) = stream.try_clone() {
                        serve_connection(&agent, read, stream);
                    }
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(e),
        }
    }
    let _ = std::fs::remove_file(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_limits_connections() {
        let gate = Arc::new(ConnectionGate::default());
        let permits: Vec<_> = (0..MAX_CONNECTIONS).map(|_| gate.try_acquire().expect("under the limit")).collect();
        assert!(gate.try_acquire().is_none());
        drop(permits);
        assert!(gate.try_acquire().is_some());
    }
}
