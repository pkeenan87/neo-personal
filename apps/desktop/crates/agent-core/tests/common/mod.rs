#![allow(dead_code)]

pub mod scenario;

use std::path::PathBuf;

use neo_agent_core::lists::{CompiledLists, DetectionLists, PathEnv};
use neo_agent_core::snapshot::{ProcessInfo, Snapshot};
use time::OffsetDateTime;

pub fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

pub fn fixture_text(rel: &str) -> String {
    std::fs::read_to_string(fixtures().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

pub fn lists() -> CompiledLists {
    let l: DetectionLists = serde_json::from_str(&fixture_text("lists.json")).unwrap();
    CompiledLists::compile(&l)
}

pub fn t0() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(1_790_000_000).unwrap()
}

pub fn env() -> PathEnv {
    let mut e = PathEnv::default();
    e.vars.insert("ProgramData".into(), "C:\\ProgramData".into());
    e.vars.insert("ProgramFiles".into(), "C:\\Program Files".into());
    e.vars.insert("ProgramFiles(x86)".into(), "C:\\Program Files (x86)".into());
    e.app_data.push("C:\\Users\\Gran\\AppData\\Roaming".into());
    e
}

pub fn snap() -> Snapshot {
    Snapshot {
        env: env(),
        ..Default::default()
    }
}

pub fn proc(name: &str, signer: Option<&str>) -> ProcessInfo {
    ProcessInfo {
        pid: 1,
        image_name: name.into(),
        image_path: format!("C:\\Users\\Gran\\Downloads\\{name}"),
        signer: signer.map(str::to_string),
        ..Default::default()
    }
}

pub fn lists_macos() -> CompiledLists {
    let l: DetectionLists = serde_json::from_str(&fixture_text("lists-macos.json")).unwrap();
    CompiledLists::compile(&l)
}
