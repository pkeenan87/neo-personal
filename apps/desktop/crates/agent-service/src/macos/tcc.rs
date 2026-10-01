//! Reading the TCC databases (`/Library/Application Support/com.apple.TCC/TCC.db` and each user's
//! `~/Library/Application Support/com.apple.TCC/TCC.db`) for the `tcc_grant` detector.
//!
//! - Reading needs Full Disk Access even as root: opening fails with `EPERM` and the agent reports
//!   `fullDiskAccess: false`. The permission check is a plain `File::open` *before* SQLite is
//!   involved (SQLite's own open is lazy and hides the errno).
//! - `tccd` keeps the database open, so it is opened read-only with SQLite's `immutable=1` URI.
//!   `immutable` ignores the write-ahead log, though, and a fresh grant can sit in `-wal` for a
//!   while; when a non-empty `-wal` exists the database and its `-wal` are copied into a private
//!   scratch directory, read there, and the copy deleted.
//! - The schema is private and changes between macOS versions, so only `service`, `client`,
//!   `client_type` and `auth_value` are selected from `access`. A missing table or column is
//!   [`DbRead::Unsupported`]: the caller disables TCC detection and fails open.
//! - SQLite is bundled (`rusqlite` with `bundled`), so the system's libsqlite does not matter.

use std::io;
use std::path::{Path, PathBuf};

use neo_agent_core::snapshot::{TccRow, TccSnapshot};
use rusqlite::{Connection, OpenFlags};

pub const SYSTEM_DB: &str = "/Library/Application Support/com.apple.TCC/TCC.db";
/// The query. Only these four columns of `access` are ever read.
const QUERY: &str = "SELECT service, client, client_type, auth_value FROM access";
/// A database with more rows than this is not read (a corrupt or hostile file).
const MAX_ROWS: usize = 20_000;

/// `~/Library/Application Support/com.apple.TCC/TCC.db`.
pub fn user_db_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("com.apple.TCC")
        .join("TCC.db")
}

/// How reading one database came out.
#[derive(Debug)]
pub enum DbRead {
    Rows(Vec<TccRow>),
    /// `EPERM`/`EACCES` opening the file: no Full Disk Access.
    Denied,
    /// The file is not there (a user who never logged in).
    Missing,
    /// The file opened but is not the shape this agent understands (message for the log).
    Unsupported(String),
    /// Anything else (I/O trouble, a locked file); try again next pass.
    Failed(String),
}

/// The `file:` URI for a path: SQLite parses `?` and `#`, and a space or `%` must be escaped.
pub fn sqlite_uri(path: &Path, query: &str) -> String {
    let mut out = String::from("file:");
    for b in path.to_string_lossy().bytes() {
        match b {
            b'%' => out.push_str("%25"),
            b'?' => out.push_str("%3F"),
            b'#' => out.push_str("%23"),
            b' ' => out.push_str("%20"),
            b if b.is_ascii_graphic() => out.push(b as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out.push('?');
    out.push_str(query);
    out
}

/// Whether the service may read the system database: `Some(false)` is the `EPERM` of a missing
/// Full Disk Access, `None` when the file is simply absent or something else went wrong.
pub fn can_read(path: &Path) -> Option<bool> {
    match std::fs::File::open(path) {
        Ok(_) => Some(true),
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => Some(false),
        Err(_) => None,
    }
}

fn query(conn: &Connection, db: &str) -> Result<Vec<TccRow>, DbRead> {
    // A schema problem shows up here, at prepare time.
    let mut stmt = conn.prepare(QUERY).map_err(|e| DbRead::Unsupported(e.to_string()))?;
    let mapped = stmt
        .query_map([], |r| {
            Ok(TccRow {
                db: db.to_string(),
                service: r.get::<_, String>(0)?,
                client: r.get::<_, String>(1)?,
                client_type: r.get::<_, i64>(2)?,
                auth_value: r.get::<_, i64>(3)?,
            })
        })
        .map_err(|e| DbRead::Failed(e.to_string()))?;
    let mut rows = Vec::new();
    for row in mapped {
        match row {
            Ok(r) => rows.push(r),
            // A NULL or wrongly typed value in one of the four columns: not the shape we know.
            Err(rusqlite::Error::InvalidColumnType(..)) => return Err(DbRead::Unsupported("unexpected column type".into())),
            Err(e) => return Err(DbRead::Failed(e.to_string())),
        }
        if rows.len() > MAX_ROWS {
            return Err(DbRead::Failed("too many rows".into()));
        }
    }
    Ok(rows)
}

fn read_immutable(path: &Path, db: &str) -> DbRead {
    let uri = sqlite_uri(path, "mode=ro&immutable=1");
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    match Connection::open_with_flags(uri, flags) {
        Ok(conn) => query(&conn, db).map_or_else(|e| e, DbRead::Rows),
        Err(e) => DbRead::Failed(e.to_string()),
    }
}

/// Copies the database and its `-wal` into `scratch`, reads the copy (WAL recovery happens in the
/// copy) and deletes it.
fn read_copy(path: &Path, db: &str, scratch: &Path) -> DbRead {
    use std::os::unix::fs::DirBuilderExt;
    if let Err(e) = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(scratch) {
        return DbRead::Failed(format!("scratch directory: {e}"));
    }
    let name = format!("tcc-{}", db.replace(':', "-"));
    let copy = scratch.join(format!("{name}.db"));
    let wal = {
        let mut p = path.as_os_str().to_owned();
        p.push("-wal");
        PathBuf::from(p)
    };
    let copy_wal = scratch.join(format!("{name}.db-wal"));
    let cleanup = || {
        for suffix in ["", "-wal", "-shm"] {
            let mut p = copy.as_os_str().to_owned();
            p.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(p));
        }
    };
    cleanup();
    let result = (|| {
        std::fs::copy(path, &copy).map_err(|e| format!("copy: {e}"))?;
        // The -wal may be checkpointed away between the check and the copy; then the main file has it.
        if wal.exists() {
            let _ = std::fs::copy(&wal, &copy_wal);
        }
        let conn = Connection::open_with_flags(&copy, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(|e| format!("open copy: {e}"))?;
        Ok::<_, String>(query(&conn, db))
    })();
    cleanup();
    match result {
        Ok(Ok(rows)) => DbRead::Rows(rows),
        Ok(Err(e)) => e,
        Err(msg) => DbRead::Failed(msg),
    }
}

fn has_wal(path: &Path) -> bool {
    let mut p = path.as_os_str().to_owned();
    p.push("-wal");
    std::fs::metadata(PathBuf::from(p)).is_ok_and(|m| m.len() > 0)
}

/// Reads one database. `db` names it in the rows (`"system"` or `"user:<uid>"`); `scratch` is a
/// private directory for the WAL-aware copy.
pub fn read_db(path: &Path, db: &str, scratch: &Path) -> DbRead {
    match std::fs::File::open(path) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return DbRead::Denied,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return DbRead::Missing,
        Err(e) => return DbRead::Failed(e.to_string()),
    }
    if has_wal(path) {
        read_copy(path, db, scratch)
    } else {
        read_immutable(path, db)
    }
}

/// What one pass over every database found.
#[derive(Debug, Default)]
pub struct Pass {
    pub snapshot: TccSnapshot,
    /// The system database was refused: no Full Disk Access.
    pub denied: bool,
    /// The first schema problem seen (the caller logs it once and disables detection).
    pub unsupported: Option<String>,
}

/// Reads the system database and each `(uid, home)` user database. A database that cannot be read
/// this pass is left out of `dbs_read` (its state is then kept, not treated as revoked).
pub fn read_all(system_db: &Path, users: &[(u32, PathBuf)], scratch: &Path) -> Pass {
    let mut pass = Pass::default();
    let mut one = |path: &Path, name: String| match read_db(path, &name, scratch) {
        DbRead::Rows(rows) => {
            pass.snapshot.dbs_read.push(name);
            pass.snapshot.rows.extend(rows);
        }
        DbRead::Denied => pass.denied = true,
        DbRead::Missing => {}
        DbRead::Unsupported(msg) => {
            pass.unsupported.get_or_insert(msg);
        }
        DbRead::Failed(msg) => log::debug!("TCC database {name}: {msg}"),
    };
    one(system_db, "system".to_string());
    for (uid, home) in users {
        one(&user_db_path(home), format!("user:{uid}"));
    }
    pass
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// The `access` table of macOS 15.7.9, recorded on a GitHub macos-15 runner (spec "Verified
    /// before implementation"). Only the four columns the agent reads matter, but the table is
    /// the real shape, including the primary key.
    const SCHEMA_15_7_9: &str = "CREATE TABLE access (
        service TEXT NOT NULL, client TEXT NOT NULL, client_type INTEGER NOT NULL,
        auth_value INTEGER NOT NULL, auth_reason INTEGER NOT NULL, auth_version INTEGER NOT NULL,
        csreq BLOB, policy_id INTEGER, indirect_object_identifier_type INTEGER,
        indirect_object_identifier TEXT NOT NULL DEFAULT 'UNUSED', indirect_object_code_identity BLOB,
        flags INTEGER, last_modified INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        pid INTEGER, pid_version INTEGER, boot_uuid TEXT NOT NULL DEFAULT 'UNUSED', last_reminded INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service, client, client_type, indirect_object_identifier))";
    /// A hypothetical future shape where `auth_value` was renamed.
    const SCHEMA_CHANGED: &str = "CREATE TABLE access (service TEXT, client TEXT, client_type INTEGER, authorization INTEGER)";

    fn create(path: &Path, schema: &str, rows: &[(&str, &str, i64, i64)]) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(schema).unwrap();
        for (svc, client, ct, auth) in rows {
            // auth_reason and auth_version are NOT NULL in the real schema.
            if schema == SCHEMA_15_7_9 {
                conn.execute(
                    "INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES (?1, ?2, ?3, ?4, 4, 1)",
                    rusqlite::params![svc, client, ct, auth],
                )
                .unwrap();
            } else {
                conn.execute(
                    "INSERT INTO access (service, client, client_type, authorization) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![svc, client, ct, auth],
                )
                .unwrap();
            }
        }
        conn
    }

    fn rows_of(r: DbRead) -> Vec<TccRow> {
        match r {
            DbRead::Rows(v) => v,
            other => panic!("expected rows, got {other:?}"),
        }
    }

    #[test]
    fn reads_the_recorded_15_7_9_schema() {
        let tmp = tempfile::tempdir().unwrap();
        // A directory with a space in the name, like the real one.
        let dir = tmp.path().join("Application Support").join("com.apple.TCC");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("TCC.db");
        let conn = create(
            &db,
            SCHEMA_15_7_9,
            &[
                ("kTCCServiceScreenCapture", "us.zoom.xos", 0, 2),
                ("kTCCServiceAccessibility", "/usr/local/bin/helper", 1, 0),
                ("kTCCServiceCamera", "com.apple.FaceTime", 0, 2),
            ],
        );
        drop(conn);
        let rows = rows_of(read_db(&db, "system", &tmp.path().join("scratch")));
        assert_eq!(rows.len(), 3);
        assert_eq!(
            rows[0],
            TccRow {
                db: "system".into(),
                service: "kTCCServiceScreenCapture".into(),
                client: "us.zoom.xos".into(),
                client_type: 0,
                auth_value: 2
            }
        );
        assert_eq!(rows[1].client_type, 1);
        assert_eq!(rows[1].auth_value, 0);
    }

    #[test]
    fn a_changed_schema_fails_open() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("TCC.db");
        drop(create(&db, SCHEMA_CHANGED, &[("kTCCServiceScreenCapture", "a.b", 0, 2)]));
        assert!(matches!(read_db(&db, "system", tmp.path()), DbRead::Unsupported(_)));
        // No `access` table at all.
        let db2 = tmp.path().join("other.db");
        Connection::open(&db2).unwrap().execute_batch("CREATE TABLE something (x)").unwrap();
        assert!(matches!(read_db(&db2, "system", tmp.path()), DbRead::Unsupported(_)));
        // Not a database.
        let junk = tmp.path().join("junk.db");
        std::fs::write(&junk, b"this is not sqlite at all, just text, long enough to look like a file").unwrap();
        assert!(matches!(
            read_db(&junk, "system", tmp.path()),
            DbRead::Unsupported(_) | DbRead::Failed(_)
        ));
    }

    #[test]
    fn eperm_means_no_full_disk_access_and_a_missing_file_means_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("TCC.db");
        drop(create(&db, SCHEMA_15_7_9, &[]));
        // Root ignores file modes; the rest of this test is about what the reader does on EPERM.
        if unsafe { libc::geteuid() } != 0 {
            std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o000)).unwrap();
            assert!(matches!(read_db(&db, "system", tmp.path()), DbRead::Denied));
            assert_eq!(can_read(&db), Some(false));
            std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert_eq!(can_read(&db), Some(true));
        assert!(matches!(
            read_db(&tmp.path().join("nope.db"), "system", tmp.path()),
            DbRead::Missing
        ));
        assert_eq!(can_read(&tmp.path().join("nope.db")), None);
    }

    #[test]
    fn a_grant_still_in_the_wal_is_seen_and_the_copy_is_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let db = tmp.path().join("TCC.db");
        let conn = create(&db, SCHEMA_15_7_9, &[("kTCCServiceAccessibility", "old.app", 0, 2)]);
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        // Written but not checkpointed: lives only in the -wal while `conn` is open.
        conn.execute(
            "INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceScreenCapture', 'new.app', 0, 2, 4, 1)",
            [],
        )
        .unwrap();
        assert!(has_wal(&db), "the test setup should leave a -wal");
        let scratch = tmp.path().join("scratch");
        let rows = rows_of(read_db(&db, "system", &scratch));
        assert!(
            rows.iter().any(|r| r.client == "new.app"),
            "the immutable read alone would miss this"
        );
        assert!(rows.iter().any(|r| r.client == "old.app"));
        assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0, "the copy is removed");
        assert_eq!(std::fs::metadata(&scratch).unwrap().permissions().mode() & 0o777, 0o700);
        // The original is untouched.
        assert!(has_wal(&db));
        drop(conn);
    }

    #[test]
    fn the_uri_escapes_spaces_and_sqlite_metacharacters() {
        assert_eq!(
            sqlite_uri(
                Path::new("/Library/Application Support/com.apple.TCC/TCC.db"),
                "mode=ro&immutable=1"
            ),
            "file:/Library/Application%20Support/com.apple.TCC/TCC.db?mode=ro&immutable=1"
        );
        assert_eq!(sqlite_uri(Path::new("/a%b?c#d"), "mode=ro"), "file:/a%25b%3Fc%23d?mode=ro");
        assert_eq!(
            sqlite_uri(Path::new("/Users/jos\u{e9}/x"), "mode=ro"),
            "file:/Users/jos%C3%A9/x?mode=ro"
        );
    }

    #[test]
    fn a_pass_reads_system_and_user_databases_and_lists_what_it_read() {
        let tmp = tempfile::tempdir().unwrap();
        let sys = tmp.path().join("sys.db");
        drop(create(&sys, SCHEMA_15_7_9, &[("kTCCServiceAccessibility", "a.b", 0, 2)]));
        let home = tmp.path().join("gran");
        let udb = user_db_path(&home);
        std::fs::create_dir_all(udb.parent().unwrap()).unwrap();
        drop(create(&udb, SCHEMA_15_7_9, &[("kTCCServiceScreenCapture", "c.d", 0, 2)]));
        let nodb = tmp.path().join("never-logged-in");
        let users = vec![(501, home), (502, nodb)];
        let pass = read_all(&sys, &users, &tmp.path().join("scratch"));
        assert_eq!(pass.snapshot.dbs_read, ["system", "user:501"]);
        assert_eq!(pass.snapshot.rows.len(), 2);
        assert_eq!(pass.snapshot.rows[1].db, "user:501");
        assert!(!pass.denied && pass.unsupported.is_none());
    }

    #[test]
    fn a_schema_change_in_any_database_is_reported_and_that_database_is_not_read() {
        let tmp = tempfile::tempdir().unwrap();
        let sys = tmp.path().join("sys.db");
        drop(create(&sys, SCHEMA_CHANGED, &[]));
        let pass = read_all(&sys, &[], tmp.path());
        assert!(pass.unsupported.is_some());
        assert!(pass.snapshot.dbs_read.is_empty());
    }
}
