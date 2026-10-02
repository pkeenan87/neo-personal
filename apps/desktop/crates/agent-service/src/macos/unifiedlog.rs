//! Unified-log evidence: `/usr/bin/log show --last 1m --style ndjson --predicate <p>`. The predicate
//! is only ever one that passes `valid_log_predicate` (`process == "<name>"` or
//! `subsystem == "<name>"`), so a list update cannot inject another `log` predicate.

use std::time::Duration;

use neo_agent_core::lists::valid_log_predicate;
use neo_agent_core::snapshot::UnifiedLogRecord;
use serde_json::Value;
use time::OffsetDateTime;

use super::exec;

pub const LOG_TOOL: &str = "/usr/bin/log";
/// One `log show` may print at most this much; more is cut off.
pub const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
/// At most this many records are returned per predicate per query.
pub const MAX_RECORDS: usize = 500;
const TIMEOUT: Duration = Duration::from_secs(20);

/// The arguments for one query, or `None` when the predicate is not an allowed form.
pub fn log_args(predicate: &str) -> Option<Vec<String>> {
    valid_log_predicate(predicate).then(|| {
        ["show", "--last", "1m", "--style", "ndjson", "--predicate", predicate]
            .iter()
            .map(|s| s.to_string())
            .collect()
    })
}

/// Parses `log show --style ndjson` output into records for `predicate`. Lines that are not
/// entries (the trailing `{"count":0,"finished":1}`, noise) are skipped; a missing or unparsable
/// timestamp becomes `now`.
pub fn parse_ndjson(predicate: &str, output: &str, now: OffsetDateTime) -> Vec<UnifiedLogRecord> {
    let mut out = Vec::new();
    for line in output.lines() {
        if out.len() >= MAX_RECORDS {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let Some(message) = v.get("eventMessage").and_then(Value::as_str) else {
            continue;
        };
        let time = v.get("timestamp").and_then(Value::as_str).and_then(parse_timestamp).unwrap_or(now);
        out.push(UnifiedLogRecord {
            predicate: predicate.to_string(),
            message: message.to_string(),
            time,
        });
    }
    out
}

/// `2026-10-01 10:00:00.123456-0700` (the unified log's own format).
fn parse_timestamp(s: &str) -> Option<OffsetDateTime> {
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond][offset_hour sign:mandatory][offset_minute]"
    );
    OffsetDateTime::parse(s.trim(), &fmt).ok()
}

/// Runs the query for every predicate. A failure (the tool is missing, it hangs) yields nothing for
/// that predicate: session evidence is best effort.
pub fn query(predicates: &[String], now: OffsetDateTime) -> Vec<UnifiedLogRecord> {
    let mut out = Vec::new();
    for p in predicates {
        let Some(args) = log_args(p) else {
            log::warn!("refusing a unified-log predicate that is not an allowed form");
            continue;
        };
        match exec::run_capped(LOG_TOOL, &args, TIMEOUT, MAX_OUTPUT_BYTES) {
            Ok(o) => out.extend(parse_ndjson(p, &String::from_utf8_lossy(&o.stdout), now)),
            Err(e) => log::debug!("log show failed: {}", e.kind()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> OffsetDateTime {
        OffsetDateTime::from_unix_timestamp(1_790_000_000).unwrap()
    }

    #[test]
    fn only_the_two_allowed_predicate_forms_are_queried() {
        let a = log_args(r#"process == "screensharingd""#).unwrap();
        assert_eq!(&a[..6], ["show", "--last", "1m", "--style", "ndjson", "--predicate"]);
        assert_eq!(a[6], r#"process == "screensharingd""#);
        assert!(log_args(r#"subsystem == "com.apple.screensharing""#).is_some());
        for bad in [
            r#"process == "a" OR process == "b""#,
            r#"eventMessage CONTAINS "x""#,
            r#"process == "a b""#,
            r#"process == """#,
            "process == \"a\"; rm -rf /",
            "",
        ] {
            assert!(log_args(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn parses_entries_and_skips_the_summary_line() {
        let out = concat!(
            r#"{"traceID":1,"eventMessage":"Authentication: SUCCEEDED","processImagePath":"/System/x/screensharingd","timestamp":"2026-10-01 10:00:00.123456-0700","messageType":"Default"}"#,
            "\n",
            "not json\n",
            r#"{"eventMessage":"second","timestamp":"garbage"}"#,
            "\n",
            r#"{"count":2,"finished":1}"#,
            "\n",
        );
        let recs = parse_ndjson(r#"process == "screensharingd""#, out, now());
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].message, "Authentication: SUCCEEDED");
        assert_eq!(recs[0].predicate, r#"process == "screensharingd""#);
        // 10:00 at UTC-7 is 17:00 UTC.
        assert_eq!(recs[0].time.to_offset(time::UtcOffset::UTC).hour(), 17);
        assert_eq!(recs[0].time.offset().whole_hours(), -7);
        assert_eq!(recs[1].time, now(), "an unparsable timestamp becomes now");
    }

    #[test]
    fn an_empty_result_is_just_the_count_line() {
        assert!(parse_ndjson("p", "{\"count\":0,\"finished\":1}\n", now()).is_empty());
        assert!(parse_ndjson("p", "", now()).is_empty());
    }

    #[test]
    fn records_are_bounded() {
        let line = r#"{"eventMessage":"x","timestamp":"2026-10-01 10:00:00.000000+0000"}"#;
        let out = vec![line; MAX_RECORDS + 50].join("\n");
        assert_eq!(parse_ndjson("p", &out, now()).len(), MAX_RECORDS);
    }
}
