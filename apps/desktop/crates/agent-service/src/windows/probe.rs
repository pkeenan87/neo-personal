//! The Windows implementation of [`SystemProbe`]: ToolHelp32 processes, the uninstall keys, the
//! services key, profile enumeration, files and the event log. Registry access goes through the
//! `windows-registry` crate.

use std::collections::HashMap;
use std::io::{self, Read, Seek, SeekFrom};
use std::mem::size_of;
use std::path::Path;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
use windows::core::PWSTR;
use windows_registry::{Key, LOCAL_MACHINE, USERS};

use neo_agent_core::detect::ExeHint;
use neo_agent_core::lists::PathEnv;
use neo_agent_core::snapshot::{EventLogRecord, ExeFacts, ProcessInfo, ServiceInfo, UninstallEntry};

use crate::inspect::{self, SigCheck};
use crate::probe::{FileStat, SystemProbe};
use crate::signer_cache::SignerCache;

const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
const SERVICES: &str = r"SYSTEM\CurrentControlSet\Services";
const PROFILE_LIST: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList";
/// At most this many programs are hashed and signature-checked per scan.
const MAX_FACTS: usize = 50;

const KEY_READ: u32 = 0x0002_0019;
const KEY_WOW64_64KEY: u32 = 0x0100;
const KEY_WOW64_32KEY: u32 = 0x0200;
const SERVICE_TYPE_WIN32: u32 = 0x30;

pub struct WindowsProbe {
    cache: Mutex<SignerCache>,
}

impl WindowsProbe {
    pub fn new() -> Self {
        WindowsProbe {
            cache: Mutex::new(SignerCache::default()),
        }
    }
}

impl Default for WindowsProbe {
    fn default() -> Self {
        Self::new()
    }
}

fn open(root: &Key, path: &str, view: u32) -> Option<Key> {
    root.options().access(KEY_READ | view).open(path).ok()
}

fn user_sids() -> Vec<String> {
    // Loaded user hives only; `_Classes` hives and the service accounts are not profiles.
    USERS
        .keys()
        .map(|k| k.collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|n| (n.starts_with("S-1-5-21-") || n.starts_with("S-1-12-1-")) && !n.ends_with("_Classes"))
        .collect()
}

fn read_uninstall(root: &Key, path: &str, view: u32, hive: &str, out: &mut Vec<UninstallEntry>) {
    let Some(parent) = open(root, path, view) else { return };
    let Ok(names) = parent.keys() else { return };
    for name in names {
        let Some(k) = open(&parent, &name, 0) else { continue };
        let Some(display_name) = k.get_string("DisplayName").ok().filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let get = |v: &str| k.get_string(v).ok().filter(|s| !s.trim().is_empty());
        out.push(UninstallEntry {
            display_name,
            publisher: get("Publisher"),
            version: get("DisplayVersion"),
            install_location: get("InstallLocation"),
            display_icon: get("DisplayIcon"),
            hive: hive.to_string(),
        });
    }
}

fn expand_system_drive(p: &str) -> String {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    p.replace("%SystemDrive%", &drive).replace("%systemdrive%", &drive)
}

impl SystemProbe for WindowsProbe {
    fn computer_name(&self) -> String {
        std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows computer".to_string())
    }

    fn path_env(&self) -> PathEnv {
        let mut vars = HashMap::new();
        for k in ["ProgramData", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(v) = std::env::var(k) {
                vars.insert(k.to_string(), v);
            }
        }
        let mut app_data = Vec::new();
        if let Some(list) = open(LOCAL_MACHINE, PROFILE_LIST, KEY_WOW64_64KEY) {
            for sid in list.keys().map(|k| k.collect::<Vec<_>>()).unwrap_or_default() {
                if !(sid.starts_with("S-1-5-21-") || sid.starts_with("S-1-12-1-")) {
                    continue;
                }
                if let Some(path) = open(&list, &sid, 0).and_then(|k| k.get_string("ProfileImagePath").ok()) {
                    app_data.push(format!(r"{}\AppData\Roaming", expand_system_drive(&path)));
                }
            }
        }
        PathEnv {
            vars,
            app_data,
            ..Default::default()
        }
    }

    fn processes(&self) -> Vec<ProcessInfo> {
        let system_root = std::env::var("SystemRoot").unwrap_or_default();
        let mut out = Vec::new();
        // SAFETY: standard ToolHelp32 enumeration; the snapshot handle is closed below.
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut more = Process32FirstW(snap, &mut entry).is_ok();
            while more {
                let pid = entry.th32ProcessID;
                let image_name = super::from_wide(&entry.szExeFile);
                let image_path = image_path(pid).unwrap_or_default();
                let signer = if image_path.is_empty() || inspect::is_under(&image_path, &system_root) {
                    None
                } else {
                    self.signer_of(&image_path)
                };
                out.push(ProcessInfo {
                    pid,
                    image_name,
                    image_path,
                    signer,
                    ..Default::default()
                });
                more = Process32NextW(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    fn uninstall_entries(&self) -> Vec<UninstallEntry> {
        let mut out = Vec::new();
        read_uninstall(LOCAL_MACHINE, UNINSTALL, KEY_WOW64_64KEY, "HKLM64", &mut out);
        read_uninstall(LOCAL_MACHINE, UNINSTALL, KEY_WOW64_32KEY, "HKLM32", &mut out);
        for sid in user_sids() {
            let path = format!(r"{sid}\{UNINSTALL}");
            read_uninstall(USERS, &path, 0, &format!("HKU:{sid}"), &mut out);
        }
        out
    }

    fn services(&self) -> Vec<ServiceInfo> {
        // The services key is the SCM's own database: the same names, display names and image
        // paths as an SCM enumeration, without the buffer juggling.
        let mut out = Vec::new();
        let Some(root) = open(LOCAL_MACHINE, SERVICES, KEY_WOW64_64KEY) else {
            return out;
        };
        for name in root.keys().map(|k| k.collect::<Vec<_>>()).unwrap_or_default() {
            let Some(k) = open(&root, &name, 0) else { continue };
            if k.get_u32("Type").map(|t| t & SERVICE_TYPE_WIN32 == 0).unwrap_or(true) {
                continue; // drivers and unknown types
            }
            out.push(ServiceInfo {
                name,
                display_name: k.get_string("DisplayName").unwrap_or_default(),
                binary_path: k.get_string("ImagePath").unwrap_or_default(),
            });
        }
        out
    }

    fn file_stat(&self, path: &str) -> Option<FileStat> {
        let m = std::fs::metadata(path).ok()?;
        if !m.is_file() {
            return None;
        }
        let token = m
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().to_string());
        Some(FileStat { len: m.len(), token })
    }

    fn read_range(&self, path: &str, start: u64, len: u64) -> io::Result<Vec<u8>> {
        let mut f = std::fs::File::open(path)?;
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        f.take(len).read_to_end(&mut buf)?;
        Ok(buf)
    }

    fn event_records(&self, channel: &str, event_ids: &[u32], since_unix: i64) -> Vec<EventLogRecord> {
        super::eventlog::records(channel, event_ids, since_unix)
    }

    fn exe_facts(&self, hints: &[ExeHint]) -> Vec<ExeFacts> {
        inspect::exe_facts(hints, MAX_FACTS, &|p| {
            let v = super::authenticode::verify(p);
            SigCheck {
                trusted: v.trusted,
                signer: v.signer,
            }
        })
    }
}

impl WindowsProbe {
    /// The trusted signer of an image, cached by path, size and modified time.
    fn signer_of(&self, image_path: &str) -> Option<String> {
        let (size, mtime) = inspect::file_identity(Path::new(image_path))?;
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.get_or_check(image_path, size, mtime, || super::authenticode::signer(Path::new(image_path)))
    }
}

/// The full image path of a process, `None` when it cannot be opened (protected processes).
fn image_path(pid: u32) -> Option<String> {
    // SAFETY: the process handle is closed before returning; the buffer outlives the call.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        r.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}
