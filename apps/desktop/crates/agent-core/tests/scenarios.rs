mod common;

use common::scenario::{describe, load, run};
use neo_agent_core::warn::{WarningKind, decide};

fn scenario_files() -> Vec<std::path::PathBuf> {
    let mut v: Vec<_> = std::fs::read_dir(common::fixtures().join("scenarios"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    v.sort();
    v
}

#[test]
fn every_scenario_produces_its_expected_events() {
    let files = scenario_files();
    assert!(files.len() >= 6);
    for path in files {
        let loaded = load(&path).unwrap();
        let out = run(&loaded, common::t0());
        for (step, (at, events)) in loaded.scenario.steps.iter().zip(out) {
            let got: Vec<String> = events.iter().map(describe).collect();
            assert_eq!(Some(&got), step.expect.as_ref(), "{} at +{at}s", loaded.scenario.name);
        }
    }
}

#[test]
fn headline_scenario_warns_for_tool_then_session() {
    let loaded = load(&common::fixtures().join("scenarios/portable-anydesk-session.json")).unwrap();
    let kinds: Vec<_> = run(&loaded, common::t0())
        .into_iter()
        .flat_map(|(_, evs)| evs)
        .filter_map(|e| decide(&e, &loaded.scenario.expected_tools))
        .collect();
    assert_eq!(kinds, [WarningKind::Tool, WarningKind::Session]);
}

#[test]
fn expected_tool_with_known_peer_shows_no_local_warning() {
    let loaded = load(&common::fixtures().join("scenarios/expected-tool-known-peer.json")).unwrap();
    let kinds: Vec<_> = run(&loaded, common::t0())
        .into_iter()
        .flat_map(|(_, evs)| evs)
        .filter_map(|e| decide(&e, &loaded.scenario.expected_tools))
        .collect();
    assert!(kinds.is_empty());
}
