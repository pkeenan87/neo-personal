mod common;

use common::t0;
use neo_agent_core::state::{Cursors, History, LogCursor, MAX_LINE_BYTES, MAX_READ_BYTES, SeenState, ToolSighting};
use time::Duration;

#[test]
fn seen_roundtrips_as_json() {
    let mut s = SeenState::default();
    s.touch_tool("anydesk", t0());
    s.touch_program(&SeenState::program_key("Foo", Some("Bar")), t0(), true);
    s.take_session_slot("anydesk", Some("1"), t0());
    let back = SeenState::from_json(&s.to_json());
    assert_eq!(back, s);
    assert_eq!(SeenState::from_json("not json"), SeenState::default());
}

#[test]
fn seen_prunes_after_30_days_absent() {
    let mut s = SeenState::default();
    s.touch_tool("old", t0());
    s.touch_tool("recent", t0() + Duration::days(20));
    let k_old = SeenState::program_key("Old", None);
    let k_new = SeenState::program_key("New", None);
    s.touch_program(&k_old, t0(), false);
    s.touch_program(&k_new, t0() + Duration::days(20), false);
    s.prune(t0() + Duration::days(31));
    assert!(s.tool_span("old").is_none());
    assert!(s.tool_span("recent").is_some());
    assert!(s.program(&k_old).is_none());
    assert!(s.program(&k_new).is_some());
    // Within 30 days nothing is pruned.
    s.prune(t0() + Duration::days(40));
    assert_eq!(s.tool_count(), 1);
}

#[test]
fn pruned_tool_is_reported_as_first_again() {
    let mut s = SeenState::default();
    assert_eq!(s.touch_tool("t", t0()), ToolSighting::First);
    assert_eq!(s.touch_tool("t", t0() + Duration::days(6)), ToolSighting::Known);
    assert_eq!(s.touch_tool("t", t0() + Duration::days(14)), ToolSighting::Returned);
    s.prune(t0() + Duration::days(60));
    assert_eq!(s.touch_tool("t", t0() + Duration::days(60)), ToolSighting::First);
}

#[test]
fn seen_holds_names_not_paths() {
    let mut s = SeenState::default();
    s.touch_program(&SeenState::program_key("Foo", Some("Bar")), t0(), false);
    let json = s.to_json();
    assert!(json.contains("foo") && !json.contains(":\\\\"), "{json}");
}

// ---- cursors ----

fn read(cur: &mut LogCursor, file: &[u8], token: Option<&str>) -> Vec<String> {
    match cur.plan_read(file.len() as u64, token) {
        None => Vec::new(),
        Some(r) => {
            let bytes = &file[r.start as usize..(r.start + r.len) as usize];
            cur.consume(&r, bytes)
        }
    }
}

#[test]
fn reads_only_new_complete_lines_and_keeps_partial_tail() {
    let mut cur = LogCursor::default();
    assert_eq!(read(&mut cur, b"one\ntwo\r\nthr", None), ["one", "two"]);
    assert_eq!(cur.offset, 9);
    assert_eq!(read(&mut cur, b"one\ntwo\r\nthree\nfour\n", None), ["three", "four"]);
    assert!(read(&mut cur, b"one\ntwo\r\nthree\nfour\n", None).is_empty());
}

#[test]
fn truncation_resets_to_start() {
    let mut cur = LogCursor::default();
    read(&mut cur, b"aaaa\nbbbb\ncccc\n", None);
    assert_eq!(cur.offset, 15);
    assert_eq!(read(&mut cur, b"x\n", None), ["x"]);
    assert_eq!(cur.offset, 2);
}

#[test]
fn rotation_to_a_larger_file_is_noticed_by_file_token() {
    let mut cur = LogCursor::default();
    assert_eq!(read(&mut cur, b"old1\n", Some("id-1")), ["old1"]);
    assert_eq!(
        read(&mut cur, b"new-file-line-1\nnew-file-line-2\n", Some("id-2")),
        ["new-file-line-1", "new-file-line-2"]
    );
}

#[test]
fn oversize_lines_are_ignored() {
    let mut cur = LogCursor::default();
    let mut file = vec![b'x'; MAX_LINE_BYTES + 1];
    file.extend_from_slice(b"\nok\n");
    assert_eq!(read(&mut cur, &file, None), ["ok"]);
    // Exactly at the limit is kept.
    let mut cur = LogCursor::default();
    let mut file = vec![b'y'; MAX_LINE_BYTES];
    file.extend_from_slice(b"\n");
    assert_eq!(read(&mut cur, &file, None).len(), 1);
}

#[test]
fn unterminated_oversize_line_is_dropped_with_its_continuation() {
    let mut cur = LogCursor::default();
    let mut file = vec![b'x'; MAX_LINE_BYTES + 10];
    assert!(read(&mut cur, &file, None).is_empty());
    assert!(cur.skipping);
    file.extend_from_slice(b"yyyy\nnext\n");
    assert_eq!(read(&mut cur, &file, None), ["next"]);
}

#[test]
fn huge_backlog_is_read_in_64kb_steps_from_the_offset() {
    let mut cur = LogCursor::default();
    let mut file = Vec::new();
    for i in 0..30_000 {
        file.extend_from_slice(format!("line {i}\n").as_bytes());
    }
    assert!(file.len() as u64 > MAX_READ_BYTES * 2);
    let mut all = Vec::new();
    let mut polls = 0;
    while let Some(r) = cur.plan_read(file.len() as u64, None) {
        assert!(r.len <= MAX_READ_BYTES);
        let lines = cur.consume(&r, &file[r.start as usize..(r.start + r.len) as usize]);
        assert!(polls > 0 || cur.offset < file.len() as u64, "first poll leaves offset mid-file");
        all.extend(lines);
        polls += 1;
    }
    assert!(polls >= 3);
    assert_eq!(all.len(), 30_000, "no line lost across chunk boundaries");
    assert_eq!(all.first().unwrap(), "line 0");
    assert_eq!(all.last().unwrap(), "line 29999");
}

#[test]
fn cursors_skip_history_for_files_that_already_existed() {
    let mut c = Cursors::default();
    let cur = c.log_cursor("C:\\Logs\\A.txt", 500, History::Skip);
    assert_eq!(cur.offset, 500);
    assert!(cur.plan_read(500, None).is_none());
    let cur = c.log_cursor("c:\\logs\\a.txt", 900, History::Skip);
    assert_eq!(cur.offset, 500, "same file, case-insensitive key");
    let new = c.log_cursor("C:\\Logs\\B.txt", 40, History::Read);
    assert_eq!(new.offset, 0);
    let back = Cursors::from_json(&c.to_json());
    assert_eq!(back, c);
    c.set_event_bookmark("Chan", 42);
    assert_eq!(c.event_bookmark("chan"), Some(42));
}
