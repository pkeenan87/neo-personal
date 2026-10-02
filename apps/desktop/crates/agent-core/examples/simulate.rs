//! Replays a fixture scenario through detection and prints the events.
//!
//! ```text
//! cargo run --example simulate -- tests/fixtures/scenarios/portable-anydesk-session.json
//! cargo run --example simulate -- tests/fixtures/scenarios/macos-anydesk-accessibility.json
//! cargo run --example simulate -- <scenario.json> --post http://localhost:3000 --code <enrollment code>
//! ```
//!
//! With `--post` it enrolls against a local MOCK_MODE web server (`pnpm --filter @neo/web dev`)
//! using the enrollment code, sends a heartbeat first, then posts each step's events. Event times
//! are shifted so the last step is "now" (the server rejects events older than 24 hours). The
//! device token is kept in memory only.

#[path = "../tests/common/scenario.rs"]
mod scenario;

use std::path::PathBuf;
use std::process::ExitCode;

use neo_agent_core::api::{ApiClient, UreqTransport};
use neo_agent_core::queue::EventQueue;
use neo_agent_core::warn::{ExpectedTool, decide_with_lists};
use time::{Duration, OffsetDateTime};

const VERSION: &str = env!("CARGO_PKG_VERSION");

struct Args {
    scenario: PathBuf,
    post: Option<String>,
    code: Option<String>,
    name: String,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let mut scenario = None;
    let (mut post, mut code, mut name) = (None, None, "Simulated Windows PC".to_string());
    while let Some(a) = it.next() {
        match a.as_str() {
            "--post" => post = Some(it.next().ok_or("--post needs a base URL")?),
            "--code" => code = Some(it.next().ok_or("--code needs an enrollment code")?),
            "--name" => name = it.next().ok_or("--name needs a value")?,
            s if s.starts_with("--") => return Err(format!("unknown option {s}")),
            s => scenario = Some(PathBuf::from(s)),
        }
    }
    if post.is_some() != code.is_some() {
        return Err("--post and --code go together".into());
    }
    Ok(Args {
        scenario: scenario.ok_or("usage: simulate <scenario.json> [--post <baseUrl> --code <code>] [--name <device name>]")?,
        post,
        code,
        name,
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    let loaded = scenario::load(&args.scenario)?;
    let sc = &loaded.scenario;
    println!("scenario: {}", sc.name);
    if !sc.description.is_empty() {
        println!("  {}", sc.description);
    }
    let last = sc.steps.iter().map(|s| s.at_seconds).max().unwrap_or(0);
    let start = if args.post.is_some() {
        OffsetDateTime::now_utc() - Duration::seconds(last)
    } else {
        OffsetDateTime::UNIX_EPOCH + Duration::days(20_000)
    };
    let mut expected: Vec<ExpectedTool> = sc.expected_tools.clone();

    let mut client = None;
    if let (Some(base), Some(code)) = (&args.post, &args.code) {
        let c = ApiClient::new(base, UreqTransport::new(&format!("neo-agent-core-simulate/{VERSION}"))).map_err(|e| e.to_string())?;
        let preview = c.enroll_preview(code).map_err(|e| e.to_string())?;
        println!("enrolling for {:?} in household {:?}", preview.member_name, preview.household_name);
        let enrolled = c.enroll(code, &args.name, VERSION).map_err(|e| e.to_string())?;
        let c = c.with_token(&enrolled.token);
        let hb = c.heartbeat(VERSION).map_err(|e| e.to_string())?;
        println!("heartbeat ok, lists version {}", hb.lists_version);
        expected = hb.device.expected();
        client = Some(c);
    }

    let out = scenario::run(&loaded, start);
    let mut queue = EventQueue::default();
    for (step, (at, events)) in sc.steps.iter().zip(out) {
        println!(
            "t+{at}s{}: {} event(s)",
            if step.discovery_phase { " (baseline scan)" } else { "" },
            events.len()
        );
        for e in &events {
            println!("  {}", scenario::describe(e));
            println!("    {}", serde_json::to_string(e).map_err(|e| e.to_string())?);
            match decide_with_lists(e, &expected, &loaded.lists) {
                Some(k) => println!("    local warning: {k:?}"),
                None => println!("    local warning: none"),
            }
        }
        queue.push(events, start + Duration::seconds(at));
        if let Some(c) = &client {
            let now = OffsetDateTime::now_utc();
            while let Some(batch) = queue.next_batch(now) {
                match c.post_signals(&batch) {
                    Ok(results) => {
                        for r in &results {
                            println!("  server: {:?} severity={:?} reason={:?}", r.status, r.severity, r.reason);
                        }
                        queue.on_results(&batch, &results, now);
                    }
                    Err(e) => {
                        queue.on_failure(now, e.retry_after_secs().map(|s| Duration::seconds(s as i64)));
                        return Err(format!("post failed: {e}"));
                    }
                }
            }
        }
    }
    Ok(())
}
