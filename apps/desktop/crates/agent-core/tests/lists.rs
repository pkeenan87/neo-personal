mod common;

use neo_agent_core::lists::{CompiledLists, DetectionLists, PathEnv, SessionEvidence, publisher_matches, same_path};

#[test]
fn parses_fixture_and_ignores_unknown_fields() {
    let l: DetectionLists = serde_json::from_str(&common::fixture_text("lists.json")).unwrap();
    assert_eq!(l.version, "fixture0000000001");
    assert_eq!(l.remote_access_tools.len(), 5);
    assert_eq!(l.pup_publishers.len(), 2);
    // Unknown evidence kinds parse (as `Unknown`) rather than failing the whole list.
    let splash = l.remote_access_tools.iter().find(|t| t.id == "splashtop").unwrap();
    assert!(matches!(splash.windows.session_evidence[1], SessionEvidence::Unknown));
}

#[test]
fn list_without_session_evidence_still_parses() {
    let l: DetectionLists = serde_json::from_str(
        r#"{"version":"v","remoteAccessTools":[{"id":"x","name":"X","windows":{"publishers":[],"displayNamePatterns":["^X$"],"serviceNames":[],"processNames":[]},"macos":{}}],"pupPublishers":[]}"#,
    )
    .unwrap();
    let c = CompiledLists::compile(&l);
    assert_eq!(c.tools.len(), 1);
    assert!(c.tools[0].log_evidence.is_empty());
}

#[test]
fn bad_regex_is_skipped_not_fatal() {
    let c = common::lists();
    // The lookbehind pattern entry is verified but uncompilable: skipped with a warning.
    assert_eq!(c.warnings.len(), 1, "{:?}", c.warnings);
    let any = c.tools.iter().find(|t| t.id == "anydesk").unwrap();
    assert_eq!(any.log_evidence.len(), 2);
}

#[test]
fn bad_display_name_pattern_is_skipped() {
    let l: DetectionLists =
        serde_json::from_str(r#"{"remoteAccessTools":[{"id":"x","name":"X","windows":{"displayNamePatterns":["(?<=a)b","^ok$"]}}]}"#)
            .unwrap();
    let c = CompiledLists::compile(&l);
    assert_eq!(c.tools[0].display_name_patterns.len(), 1);
    assert_eq!(c.warnings.len(), 1);
}

#[test]
fn only_verified_evidence_is_used() {
    let c = common::lists();
    let any = c.tools.iter().find(|t| t.id == "anydesk").unwrap();
    assert!(any.log_evidence.iter().all(|e| !e.path_template.contains("unverified")));
    let sc = c.tools.iter().find(|t| t.id == "screenconnect").unwrap();
    assert_eq!(sc.process_evidence, vec!["ScreenConnect.WindowsClient.exe"]);
    let sp = c.tools.iter().find(|t| t.id == "splashtop").unwrap();
    assert_eq!(sp.eventlog_evidence.len(), 1);
}

#[test]
fn named_peer_group_compiles_and_captures() {
    let c = common::lists();
    let any = c.tools.iter().find(|t| t.id == "anydesk").unwrap();
    let caps = any.log_evidence[0]
        .pattern
        .captures("Incoming    2026-10-01, 10:03    User    123456789")
        .unwrap();
    assert_eq!(&caps["peer"], "123456789");
}

#[test]
fn env_expansion() {
    let mut env = common::env();
    env.app_data.push("C:\\Users\\Pat\\AppData\\Roaming\\".into());
    assert_eq!(env.expand("%ProgramData%\\AnyDesk\\x.txt"), vec!["C:\\ProgramData\\AnyDesk\\x.txt"]);
    assert_eq!(
        env.expand("%AppData%\\AnyDesk\\x.txt"),
        vec![
            "C:\\Users\\Gran\\AppData\\Roaming\\AnyDesk\\x.txt",
            "C:\\Users\\Pat\\AppData\\Roaming\\AnyDesk\\x.txt"
        ]
    );
    assert_eq!(
        env.expand("%programfiles(x86)%\\T\\l.log"),
        vec!["C:\\Program Files (x86)\\T\\l.log"]
    );
    assert!(env.expand("%Nope%\\x").is_empty());
    assert!(PathEnv::default().expand("%AppData%\\x").is_empty());
    assert_eq!(env.expand("C:\\plain\\100%.log"), vec!["C:\\plain\\100%.log"]);
}

#[test]
fn log_targets_expand_per_profile() {
    let c = common::lists();
    let t = c.log_targets(&common::env());
    assert_eq!(t.len(), 2);
    assert!(t.iter().any(|t| t.path == "C:\\ProgramData\\AnyDesk\\connection_trace.txt"));
    assert!(
        t.iter()
            .any(|t| t.path == "C:\\Users\\Gran\\AppData\\Roaming\\AnyDesk\\connection_trace.txt")
    );
}

#[test]
fn publisher_and_path_matching() {
    assert!(publisher_matches("AnyDesk Software GmbH", "anydesk software gmbh"));
    assert!(publisher_matches(
        "CN=AnyDesk Software GmbH, O=AnyDesk Software GmbH, C=DE",
        "AnyDesk Software GmbH"
    ));
    assert!(!publisher_matches("AnyDesk Software GmbH Fake Ltd", "AnyDesk Software GmbH"));
    assert!(!publisher_matches("NotAnyDesk Software GmbH", "AnyDesk Software GmbH"));
    assert!(!publisher_matches("anything", ""));
    assert!(same_path("C:/A/b.TXT", "c:\\a\\B.txt"));
}
