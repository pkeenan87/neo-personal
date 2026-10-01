//! Finding things on a Mac's disk: local users' home directories, `.app` bundles, their
//! `Info.plist` data, and launchd items. Plain file and plist reading; the code-signing facts come
//! from the Security framework in `codesign` (macOS only) and are joined in by the probe.

use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use neo_agent_core::snapshot::ServiceInfo;

/// An `Info.plist` or launchd plist larger than this is ignored.
const MAX_PLIST_BYTES: u64 = 1024 * 1024;
/// At most this many bundles per directory are looked at.
const MAX_APPS_PER_DIR: usize = 2000;

/// A local user: the owner of a directory directly under `/Users`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalUser {
    pub name: String,
    pub uid: u32,
    pub home: PathBuf,
}

/// The people with a home directory under `users_root` (`/Users`): directories only, not hidden,
/// not `Shared` or `Guest`, and not owned by root.
pub fn local_users(users_root: &Path) -> Vec<LocalUser> {
    let Ok(rd) = std::fs::read_dir(users_root) else { return Vec::new() };
    let mut out: Vec<LocalUser> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.eq_ignore_ascii_case("Shared") || name.eq_ignore_ascii_case("Guest") {
                return None;
            }
            let meta = std::fs::metadata(e.path()).ok()?;
            (meta.is_dir() && meta.uid() != 0).then(|| LocalUser {
                name,
                uid: meta.uid(),
                home: e.path(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The `.app` bundles directly inside `dir`.
pub fn list_apps(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("app")) && p.is_dir())
        .take(MAX_APPS_PER_DIR)
        .collect();
    out.sort();
    out
}

/// `/Applications` plus each user's `~/Applications`.
pub fn app_dirs(system_apps: &Path, users: &[LocalUser]) -> Vec<PathBuf> {
    let mut v = vec![system_apps.to_path_buf()];
    v.extend(users.iter().map(|u| u.home.join("Applications")));
    v
}

/// `/Library/LaunchAgents`, `/Library/LaunchDaemons` and each user's `~/Library/LaunchAgents`.
pub fn launchd_dirs(library: &Path, users: &[LocalUser]) -> Vec<PathBuf> {
    let mut v = vec![library.join("LaunchAgents"), library.join("LaunchDaemons")];
    v.extend(users.iter().map(|u| u.home.join("Library").join("LaunchAgents")));
    v
}

/// What a bundle's `Info.plist` says.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BundleInfo {
    pub bundle_id: Option<String>,
    /// `CFBundleName`, else `CFBundleDisplayName`, else the bundle's file name without `.app`.
    pub name: String,
    /// `CFBundleShortVersionString`, else `CFBundleVersion`.
    pub version: Option<String>,
    /// `CFBundleExecutable`.
    pub executable: Option<String>,
}

fn read_plist(path: &Path) -> Option<plist::Value> {
    if std::fs::metadata(path).ok()?.len() > MAX_PLIST_BYTES {
        return None;
    }
    plist::Value::from_file(path).ok()
}

fn dict_string(d: &plist::Dictionary, key: &str) -> Option<String> {
    d.get(key)
        .and_then(plist::Value::as_string)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Reads `<app>/Contents/Info.plist`. `None` when it is missing or not a plist.
pub fn read_bundle_info(app: &Path) -> Option<BundleInfo> {
    let value = read_plist(&app.join("Contents").join("Info.plist"))?;
    let d = value.as_dictionary()?;
    let name = dict_string(d, "CFBundleName")
        .or_else(|| dict_string(d, "CFBundleDisplayName"))
        .or_else(|| app.file_stem().map(|s| s.to_string_lossy().to_string()))?;
    Some(BundleInfo {
        bundle_id: dict_string(d, "CFBundleIdentifier"),
        name,
        version: dict_string(d, "CFBundleShortVersionString").or_else(|| dict_string(d, "CFBundleVersion")),
        executable: dict_string(d, "CFBundleExecutable"),
    })
}

/// The bundle's main executable: `Contents/MacOS/<CFBundleExecutable>`, else the only or first
/// file in `Contents/MacOS`. The executable name must be a plain file name.
pub fn main_executable(app: &Path, info: Option<&BundleInfo>) -> Option<PathBuf> {
    let macos = app.join("Contents").join("MacOS");
    if let Some(exe) = info.and_then(|i| i.executable.as_deref())
        && !exe.contains('/')
        && exe != ".."
    {
        let p = macos.join(exe);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&macos)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    files.into_iter().next()
}

/// The outermost `.app` directory containing `exe`, e.g. `/Applications/X.app` for
/// `/Applications/X.app/Contents/MacOS/x`. App Translocation paths
/// (`/private/var/folders/.../AppTranslocation/<uuid>/d/X.app/...`) are read-only mounts of the
/// original bundle, so the same rule reads the right `Info.plist` and signature there.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let mut so_far = PathBuf::new();
    for comp in exe.components() {
        so_far.push(comp);
        if comp.as_os_str().to_string_lossy().to_ascii_lowercase().ends_with(".app") && so_far != exe {
            return Some(so_far);
        }
    }
    None
}

/// Whether a running process at `path` is Apple's own or system software that is never a
/// remote-access tool, so the (slow) signature check is skipped, like `SystemRoot` on Windows.
pub fn is_system_path(path: &str) -> bool {
    ["/System/", "/usr/", "/bin/", "/sbin/", "/Library/Apple/", "/private/var/db/"]
        .iter()
        .any(|p| path.starts_with(p))
}

/// Label and program of every launchd plist in `dirs`, as [`ServiceInfo`] so the shared
/// `service_names` matching applies (`name` is the label).
pub fn launchd_items(dirs: &[PathBuf]) -> Vec<ServiceInfo> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        let mut paths: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("plist")))
            .collect();
        paths.sort();
        for p in paths {
            let Some(v) = read_plist(&p) else { continue };
            let Some(d) = v.as_dictionary() else { continue };
            let Some(label) = dict_string(d, "Label").or_else(|| p.file_stem().map(|s| s.to_string_lossy().to_string())) else {
                continue;
            };
            let program = dict_string(d, "Program")
                .or_else(|| {
                    d.get("ProgramArguments")
                        .and_then(plist::Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(plist::Value::as_string)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            out.push(ServiceInfo {
                display_name: label.clone(),
                name: label,
                binary_path: program,
            });
        }
    }
    out
}

/// A small bounded cache keyed by path, size and modified time (the identity of an executable on
/// disk), so a 5-second process poll checks each binary's signature once.
pub struct IdentCache<V: Clone> {
    map: HashMap<(String, u64, i64), V>,
}

const MAX_CACHE_ENTRIES: usize = 4096;

impl<V: Clone> Default for IdentCache<V> {
    fn default() -> Self {
        IdentCache { map: HashMap::new() }
    }
}

impl<V: Clone> IdentCache<V> {
    pub fn get_or_compute(&mut self, path: &str, size: u64, mtime: i64, compute: impl FnOnce() -> V) -> V {
        let key = (path.to_string(), size, mtime);
        if let Some(v) = self.map.get(&key) {
            return v.clone();
        }
        if self.map.len() >= MAX_CACHE_ENTRIES {
            self.map.clear();
        }
        let v = compute();
        self.map.insert(key, v.clone());
        v
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_plist(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            format!(r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>{body}</dict></plist>"#),
        )
        .unwrap();
    }

    fn make_app(root: &Path, name: &str, bundle_id: &str, exe: &str) -> PathBuf {
        let app = root.join(format!("{name}.app"));
        write_plist(
            &app.join("Contents/Info.plist"),
            &format!(
                "<key>CFBundleIdentifier</key><string>{bundle_id}</string><key>CFBundleName</key><string>{name}</string><key>CFBundleShortVersionString</key><string>1.2.3</string><key>CFBundleExecutable</key><string>{exe}</string>"
            ),
        );
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::write(app.join("Contents/MacOS").join(exe), b"#!/bin/sh\n").unwrap();
        app
    }

    #[test]
    fn reads_bundle_info_and_the_main_executable() {
        let tmp = tempfile::tempdir().unwrap();
        let app = make_app(tmp.path(), "AnyDesk", "com.philandro.anydesk", "AnyDesk");
        let info = read_bundle_info(&app).unwrap();
        assert_eq!(info.bundle_id.as_deref(), Some("com.philandro.anydesk"));
        assert_eq!(info.name, "AnyDesk");
        assert_eq!(info.version.as_deref(), Some("1.2.3"));
        assert_eq!(main_executable(&app, Some(&info)).unwrap(), app.join("Contents/MacOS/AnyDesk"));
        // A hostile CFBundleExecutable cannot point out of the bundle.
        let evil = BundleInfo {
            executable: Some("../../../../etc/passwd".into()),
            ..info.clone()
        };
        assert_eq!(main_executable(&app, Some(&evil)).unwrap(), app.join("Contents/MacOS/AnyDesk"));
    }

    #[test]
    fn a_bundle_without_a_plist_or_with_garbage_is_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let none = tmp.path().join("None.app");
        fs::create_dir_all(none.join("Contents")).unwrap();
        assert!(read_bundle_info(&none).is_none());
        let bad = tmp.path().join("Bad.app");
        fs::create_dir_all(bad.join("Contents")).unwrap();
        fs::write(bad.join("Contents/Info.plist"), "not a plist").unwrap();
        assert!(read_bundle_info(&bad).is_none());
    }

    #[test]
    fn the_name_falls_back_to_the_file_name() {
        let tmp = tempfile::tempdir().unwrap();
        let app = tmp.path().join("Plain Thing.app");
        write_plist(
            &app.join("Contents/Info.plist"),
            "<key>CFBundleIdentifier</key><string>com.x.y</string>",
        );
        assert_eq!(read_bundle_info(&app).unwrap().name, "Plain Thing");
    }

    #[test]
    fn lists_only_app_directories() {
        let tmp = tempfile::tempdir().unwrap();
        make_app(tmp.path(), "B", "com.b", "b");
        make_app(tmp.path(), "A", "com.a", "a");
        fs::write(tmp.path().join("readme.txt"), "x").unwrap();
        fs::write(tmp.path().join("File.app"), "a file, not a bundle").unwrap();
        let apps = list_apps(tmp.path());
        assert_eq!(apps, vec![tmp.path().join("A.app"), tmp.path().join("B.app")]);
        assert!(list_apps(&tmp.path().join("missing")).is_empty());
    }

    #[test]
    fn finds_the_enclosing_bundle_including_translocated_paths() {
        assert_eq!(
            bundle_of(Path::new("/Applications/AnyDesk.app/Contents/MacOS/AnyDesk")).unwrap(),
            PathBuf::from("/Applications/AnyDesk.app")
        );
        assert_eq!(
            bundle_of(Path::new(
                "/private/var/folders/ab/cd/T/AppTranslocation/1234-ABCD/d/AnyDesk.app/Contents/MacOS/AnyDesk"
            ))
            .unwrap(),
            PathBuf::from("/private/var/folders/ab/cd/T/AppTranslocation/1234-ABCD/d/AnyDesk.app")
        );
        assert_eq!(
            bundle_of(Path::new("/Volumes/AnyDesk/AnyDesk.app/Contents/MacOS/AnyDesk")).unwrap(),
            PathBuf::from("/Volumes/AnyDesk/AnyDesk.app")
        );
        // The outermost one: a helper app inside the main app.
        assert_eq!(
            bundle_of(Path::new("/Applications/X.app/Contents/Library/LoginItems/H.app/Contents/MacOS/h")).unwrap(),
            PathBuf::from("/Applications/X.app")
        );
        assert!(bundle_of(Path::new("/usr/local/bin/tool")).is_none());
        assert!(
            bundle_of(Path::new("/Applications/X.app")).is_none(),
            "the bundle itself is not inside one"
        );
    }

    #[test]
    fn system_software_is_skipped() {
        assert!(is_system_path("/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"));
        assert!(is_system_path("/usr/libexec/x"));
        assert!(is_system_path("/bin/sh"));
        assert!(!is_system_path("/Applications/AnyDesk.app/Contents/MacOS/AnyDesk"));
        assert!(!is_system_path("/Users/gran/Downloads/Tool"));
        assert!(!is_system_path("/Library/Application Support/X/x"));
    }

    #[test]
    fn local_users_exclude_shared_guest_hidden_and_root_owned() {
        let tmp = tempfile::tempdir().unwrap();
        for d in ["gran", "pat", "Shared", "Guest", ".hidden"] {
            fs::create_dir(tmp.path().join(d)).unwrap();
        }
        fs::write(tmp.path().join(".localized"), "").unwrap();
        let users = local_users(tmp.path());
        // The test runs as a normal user (uid != 0), so only the exclusion rules apply.
        if unsafe { libc::geteuid() } != 0 {
            let names: Vec<_> = users.iter().map(|u| u.name.as_str()).collect();
            assert_eq!(names, ["gran", "pat"]);
            assert_eq!(users[0].home, tmp.path().join("gran"));
        }
        assert!(local_users(&tmp.path().join("missing")).is_empty());
    }

    #[test]
    fn scan_directories_follow_the_users() {
        let users = vec![LocalUser {
            name: "gran".into(),
            uid: 501,
            home: PathBuf::from("/Users/gran"),
        }];
        assert_eq!(
            app_dirs(Path::new("/Applications"), &users),
            [PathBuf::from("/Applications"), PathBuf::from("/Users/gran/Applications")]
        );
        assert_eq!(
            launchd_dirs(Path::new("/Library"), &users),
            [
                PathBuf::from("/Library/LaunchAgents"),
                PathBuf::from("/Library/LaunchDaemons"),
                PathBuf::from("/Users/gran/Library/LaunchAgents")
            ]
        );
    }

    #[test]
    fn launchd_plists_give_label_and_program() {
        let tmp = tempfile::tempdir().unwrap();
        write_plist(
            &tmp.path().join("com.anydesk.service.plist"),
            "<key>Label</key><string>com.anydesk.service</string><key>ProgramArguments</key><array><string>/Applications/AnyDesk.app/Contents/MacOS/AnyDesk</string><string>--service</string></array>",
        );
        write_plist(
            &tmp.path().join("b.plist"),
            "<key>Label</key><string>com.example.b</string><key>Program</key><string>/usr/local/bin/b</string>",
        );
        write_plist(&tmp.path().join("nolabel.plist"), "<key>RunAtLoad</key><true/>");
        fs::write(tmp.path().join("broken.plist"), "garbage").unwrap();
        fs::write(tmp.path().join("notes.txt"), "x").unwrap();
        let items = launchd_items(&[tmp.path().to_path_buf(), tmp.path().join("missing")]);
        let by: Vec<(&str, &str)> = items.iter().map(|s| (s.name.as_str(), s.binary_path.as_str())).collect();
        assert_eq!(
            by,
            [
                ("com.example.b", "/usr/local/bin/b"),
                ("com.anydesk.service", "/Applications/AnyDesk.app/Contents/MacOS/AnyDesk"),
                ("nolabel", ""),
            ]
        );
    }

    #[test]
    fn the_cache_checks_once_per_path_size_and_mtime() {
        let mut c: IdentCache<Option<String>> = IdentCache::default();
        let mut calls = 0;
        for _ in 0..3 {
            let v = c.get_or_compute("/a", 10, 5, || {
                calls += 1;
                Some("TEAM".to_string())
            });
            assert_eq!(v.as_deref(), Some("TEAM"));
        }
        assert_eq!(calls, 1);
        c.get_or_compute("/a", 11, 5, || {
            calls += 1;
            None
        });
        c.get_or_compute("/a", 10, 6, || {
            calls += 1;
            None
        });
        assert_eq!(calls, 3);
        assert_eq!(c.len(), 3);
    }
}
