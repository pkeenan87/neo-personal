//! Event-log channels through `EvtQuery` / `EvtNext` / `EvtRender` (XML), newest records since a
//! time. Used for session evidence (`sessionEvidence` of kind `eventlog`).

use std::sync::OnceLock;

use regex::Regex;
use time::OffsetDateTime;
use windows::Win32::System::EventLog::{
    EVT_HANDLE, EvtClose, EvtNext, EvtQuery, EvtQueryChannelPath, EvtQueryForwardDirection, EvtRender, EvtRenderEventXml,
};
use windows::core::PCWSTR;

use neo_agent_core::snapshot::EventLogRecord;

/// At most this many records are returned per call.
const MAX_RECORDS: usize = 200;

fn xml_re() -> &'static (Regex, Regex) {
    static RE: OnceLock<(Regex, Regex)> = OnceLock::new();
    RE.get_or_init(|| {
        (
            Regex::new(r"<EventID[^>]*>(\d+)</EventID>").expect("static regex"),
            Regex::new(r#"SystemTime=['"]([^'"]+)['"]"#).expect("static regex"),
        )
    })
}

/// (event id, time) of one rendered event.
pub fn parse_event_xml(xml: &str) -> Option<(u32, OffsetDateTime)> {
    let (id_re, time_re) = xml_re();
    let id = id_re.captures(xml)?.get(1)?.as_str().parse().ok()?;
    let t = time_re.captures(xml)?.get(1)?.as_str();
    let t = OffsetDateTime::parse(t, &time::format_description::well_known::Rfc3339).ok()?;
    Some((id, t))
}

fn query_for(ids: &[u32], since_unix: i64) -> String {
    let id_clause = ids.iter().map(|i| format!("EventID={i}")).collect::<Vec<_>>().join(" or ");
    let since = OffsetDateTime::from_unix_timestamp(since_unix)
        .ok()
        .and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string());
    format!("*[System[({id_clause}) and TimeCreated[@SystemTime>='{since}']]]")
}

/// Records of `channel` with one of `ids`, newer than `since_unix`. An absent channel or a failed
/// query is just "no records".
pub fn records(channel: &str, ids: &[u32], since_unix: i64) -> Vec<EventLogRecord> {
    if ids.is_empty() {
        return Vec::new();
    }
    let wchannel = super::wide(channel);
    let wquery = super::wide(query_for(ids, since_unix));
    let mut out = Vec::new();
    // SAFETY: the wide strings outlive the query; every handle opened here is closed.
    unsafe {
        let Ok(query) = EvtQuery(
            None,
            PCWSTR(wchannel.as_ptr()),
            PCWSTR(wquery.as_ptr()),
            EvtQueryChannelPath.0 | EvtQueryForwardDirection.0,
        ) else {
            return out;
        };
        let mut handles = [0isize; 32];
        'outer: loop {
            let mut returned = 0u32;
            if EvtNext(query, &mut handles, 1000, 0, &mut returned).is_err() || returned == 0 {
                break;
            }
            for h in handles.iter().take(returned as usize) {
                let event = EVT_HANDLE(*h);
                if out.len() < MAX_RECORDS {
                    if let Some(xml) = render_xml(event) {
                        if let Some((event_id, time)) = parse_event_xml(&xml) {
                            out.push(EventLogRecord {
                                channel: channel.to_string(),
                                event_id,
                                time,
                            });
                        }
                    }
                }
                let _ = EvtClose(event);
            }
            if out.len() >= MAX_RECORDS {
                break 'outer;
            }
        }
        let _ = EvtClose(query);
    }
    out
}

/// # Safety
/// `event` must be a live event handle from `EvtNext`.
unsafe fn render_xml(event: EVT_HANDLE) -> Option<String> {
    unsafe {
        let mut used = 0u32;
        let mut props = 0u32;
        // First call: learn the size (it fails with ERROR_INSUFFICIENT_BUFFER).
        let _ = EvtRender(None, event, EvtRenderEventXml.0, 0, None, &mut used, &mut props);
        if used == 0 || used > 1 << 20 {
            return None;
        }
        let mut buf = vec![0u16; (used as usize).div_ceil(2)];
        EvtRender(
            None,
            event,
            EvtRenderEventXml.0,
            used,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            &mut used,
            &mut props,
        )
        .ok()?;
        Some(super::from_wide(&buf))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rendered_xml() {
        let xml = r#"<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='X'/><EventID Qualifiers='0'>1149</EventID><TimeCreated SystemTime='2026-10-01T09:00:00.1234567Z'/></System></Event>"#;
        let (id, t) = parse_event_xml(xml).unwrap();
        assert_eq!(id, 1149);
        assert_eq!(t.unix_timestamp(), 1_790_845_200);
        assert!(parse_event_xml("<Event/>").is_none());
    }

    #[test]
    fn builds_the_xpath() {
        let q = query_for(&[1, 2], 0);
        assert!(q.starts_with("*[System[(EventID=1 or EventID=2) and TimeCreated[@SystemTime>='1970-01-01T00:00:00Z']]]"));
    }
}
