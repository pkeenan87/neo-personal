//! The pipe protocol end to end over a unix socket (the Linux stand-in for the named pipe), with
//! the real `run_loop` and `serve_unix`.
#![cfg(unix)]

mod common;

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use common::*;
use neo_agent::protocol::MAX_REQUEST_BYTES;
use serde_json::{Value, json};

struct Running {
    _h: Harness,
    socket: std::path::PathBuf,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    _dir: tempfile::TempDir,
}

impl Running {
    fn start() -> Running {
        let h = Harness::new();
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("neo.sock");
        let stop = Arc::new(AtomicBool::new(false));
        let (agent, s2, sock2) = (h.agent.clone(), stop.clone(), socket.clone());
        let thread = std::thread::spawn(move || {
            neo_agent::runtime::run_loop(
                agent,
                s2,
                move |agent, stop| neo_agent::ipc::serve_unix(agent, &sock2, stop).unwrap(),
                || {},
            );
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !Path::new(&socket).exists() {
            assert!(Instant::now() < deadline, "socket never appeared");
            std::thread::sleep(Duration::from_millis(20));
        }
        Running {
            _h: h,
            socket,
            stop,
            thread: Some(thread),
            _dir: dir,
        }
    }

    fn connect(&self) -> (BufReader<UnixStream>, UnixStream) {
        let s = UnixStream::connect(&self.socket).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        (BufReader::new(s.try_clone().unwrap()), s)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn ask(r: &mut BufReader<UnixStream>, w: &mut UnixStream, line: &str) -> Value {
    w.write_all(line.as_bytes()).unwrap();
    w.write_all(b"\n").unwrap();
    let mut out = String::new();
    r.read_line(&mut out).unwrap();
    serde_json::from_str(&out).unwrap_or_else(|_| panic!("not JSON: {out:?}"))
}

#[test]
fn answers_status_and_keeps_the_connection_for_more_requests() {
    let run = Running::start();
    let (mut r, mut w) = run.connect();
    let s = ask(&mut r, &mut w, r#"{"op":"status"}"#);
    assert_eq!(s["ok"], true);
    assert_eq!(s["state"], "not_enrolled");
    let s2 = ask(&mut r, &mut w, r#"{"op":"status"}"#);
    assert_eq!(s2["ok"], true);
}

#[test]
fn bad_requests_get_error_codes_not_a_crash() {
    let run = Running::start();
    let (mut r, mut w) = run.connect();
    assert_eq!(ask(&mut r, &mut w, "not json")["code"], "invalid_json");
    assert_eq!(ask(&mut r, &mut w, r#"{"op":"rm_rf"}"#)["code"], "unknown_op");
    assert_eq!(ask(&mut r, &mut w, r#"{"op":"enroll"}"#)["code"], "invalid_request");
    assert_eq!(
        ask(&mut r, &mut w, r#"{"op":"check_url","url":"javascript:alert(1)"}"#)["code"],
        "invalid_request"
    );
    // Still alive.
    assert_eq!(ask(&mut r, &mut w, r#"{"op":"status"}"#)["ok"], true);
}

#[test]
fn an_oversize_request_is_refused_and_the_connection_closed() {
    let run = Running::start();
    let (mut r, mut w) = run.connect();
    let big = format!(r#"{{"op":"enroll","code":"{}"}}"#, "a".repeat(MAX_REQUEST_BYTES));
    let v = ask(&mut r, &mut w, &big);
    assert_eq!(v["code"], "request_too_large");
    let mut rest = String::new();
    assert_eq!(r.read_line(&mut rest).unwrap(), 0, "the server closes after an oversize request");
    // Other clients are unaffected.
    let (mut r2, mut w2) = run.connect();
    assert_eq!(ask(&mut r2, &mut w2, r#"{"op":"status"}"#)["ok"], true);
}

#[test]
fn subscribers_get_status_changed_and_warnings() {
    let run = Running::start();
    let (mut sub_r, mut sub_w) = run.connect();
    assert_eq!(ask(&mut sub_r, &mut sub_w, r#"{"op":"subscribe"}"#)["ok"], true);
    // Enroll on another connection: the subscriber hears about it.
    let (mut r, mut w) = run.connect();
    let e = ask(
        &mut r,
        &mut w,
        &json!({"op":"enroll","code":"ABCD","name":"PC","serverUrl":"http://127.0.0.1:3007"}).to_string(),
    );
    assert_eq!(e["ok"], true, "{e}");
    let mut line = String::new();
    sub_r.read_line(&mut line).unwrap();
    let push: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(push["push"], "status_changed");
}
