//! The client side of the service pipe: newline-delimited JSON over `\\.\pipe\neo-agent` (Windows)
//! or a unix socket (Linux development, served by `neo-agent --dev-pipe`). The tray app talks to
//! the service only through here and never sees the device token.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{Value, json};

/// A request that takes longer than this is given up (enrollment calls the server).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
/// Longest line read from the service.
const MAX_LINE: u64 = 1 << 20;

pub trait Stream: Read + Write + Send {}
impl<T: Read + Write + Send> Stream for T {}

#[cfg(windows)]
pub fn connect() -> io::Result<Box<dyn Stream>> {
    use std::fs::OpenOptions;

    const ERROR_PIPE_BUSY: i32 = 231;
    let mut last = io::Error::from(io::ErrorKind::NotFound);
    // The server makes a new pipe instance right after each connect; wait briefly if we win the race.
    for _ in 0..40 {
        match OpenOptions::new().read(true).write(true).open(r"\\.\pipe\neo-agent") {
            Ok(f) => return Ok(Box::new(f)),
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                last = e;
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

/// Where the Linux development service listens (`NEO_AGENT_SOCKET`, else a fixed path in /tmp).
#[cfg(unix)]
pub fn socket_path() -> std::path::PathBuf {
    std::env::var_os("NEO_AGENT_SOCKET")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("neo-agent-dev.sock"))
}

#[cfg(unix)]
pub fn connect() -> io::Result<Box<dyn Stream>> {
    Ok(Box::new(std::os::unix::net::UnixStream::connect(socket_path())?))
}

fn read_line<R: BufRead>(r: &mut R) -> io::Result<Option<String>> {
    let mut line = String::new();
    let n = r.by_ref().take(MAX_LINE).read_line(&mut line)?;
    Ok((n > 0).then_some(line))
}

/// One request, one reply, on a fresh connection.
fn exchange(request: &Value) -> Result<Value, String> {
    let mut stream = connect().map_err(|e| format!("cannot reach the service: {e}"))?;
    let mut line = request.to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(stream);
    let reply = read_line(&mut reader)
        .map_err(|e| e.to_string())?
        .ok_or("the service closed the connection")?;
    serde_json::from_str(&reply).map_err(|e| format!("bad reply from the service: {e}"))
}

/// Sends `request` and waits for the reply. A service that is not running, or that does not
/// answer, comes back as `{ ok: false, code: "agent_unavailable" }`, never as an error.
pub fn request(request: &Value) -> Value {
    let (tx, rx) = mpsc::channel();
    let req = request.clone();
    std::thread::spawn(move || {
        let _ = tx.send(exchange(&req));
    });
    match rx.recv_timeout(REQUEST_TIMEOUT) {
        Ok(Ok(v)) => v,
        _ => unavailable(),
    }
}

pub fn unavailable() -> Value {
    json!({ "ok": false, "code": "agent_unavailable", "error": "Neo Protection isn't running on this computer." })
}

/// Opens a connection, subscribes, and calls `on_line` for every push until the connection ends.
/// Blank keep-alive lines are skipped. Returns when the service goes away.
pub fn subscribe(mut on_push: impl FnMut(Value)) -> io::Result<()> {
    let mut stream = connect()?;
    stream.write_all(b"{\"op\":\"subscribe\"}\n")?;
    stream.flush()?;
    let mut reader = BufReader::new(stream);
    let ack = read_line(&mut reader)?.ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))?;
    let ack: Value = serde_json::from_str(&ack).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    if ack["ok"] != true {
        return Err(io::Error::other("the service refused the subscription"));
    }
    while let Some(line) = read_line(&mut reader)? {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            on_push(v);
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    // One test only: it sets the process-wide socket path.
    #[test]
    fn requests_subscriptions_and_a_missing_service_over_a_unix_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent.sock");
        // SAFETY: no other test in this crate reads the environment concurrently.
        unsafe { std::env::set_var("NEO_AGENT_SOCKET", &path) };

        // Nothing listening: not an error, a plain "unavailable".
        assert_eq!(request(&json!({"op":"status"}))["code"], "agent_unavailable");

        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            // First connection: a normal request.
            let (s, _) = listener.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut w = s;
            let line = read_line(&mut r).unwrap().unwrap();
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["op"], "status");
            w.write_all(b"{\"ok\":true,\"state\":\"enrolled\"}\n").unwrap();
            // Second connection: a subscription with a keep-alive and two pushes.
            let (s, _) = listener.accept().unwrap();
            let mut r = BufReader::new(s.try_clone().unwrap());
            let mut w = s;
            let line = read_line(&mut r).unwrap().unwrap();
            assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["op"], "subscribe");
            w.write_all(b"{\"ok\":true}\n\n{\"push\":\"status_changed\"}\n{\"push\":\"warning\",\"eventId\":\"e\"}\n")
                .unwrap();
        });

        let reply = request(&json!({"op":"status"}));
        assert_eq!(reply["state"], "enrolled");
        let mut pushes = Vec::new();
        subscribe(|p| pushes.push(p["push"].as_str().unwrap().to_string())).unwrap();
        assert_eq!(pushes, vec!["status_changed", "warning"]);
        server.join().unwrap();
    }
}
