//! The Tauri shell: tray, windows, toasts and the background link to the service.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::ipc;
use crate::logic::{self, IconState};

const SHIELD: &[u8] = include_bytes!("../icons/tray-shield.png");
const GREY: &[u8] = include_bytes!("../icons/tray-grey.png");
const ALERT: &[u8] = include_bytes!("../icons/tray-alert.png");
const STATUS_REFRESH: Duration = Duration::from_secs(30);

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// What the tray knows about the service.
#[derive(Default)]
struct Shared(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    service_up: bool,
    status: Option<Value>,
    /// Warnings by event id (the warning window loads its content from here).
    warnings: HashMap<String, Value>,
    /// Unix seconds of the newest warning this tray app received.
    last_alert: Option<i64>,
    setup_prompted: bool,
}

struct TrayUi {
    tray: TrayIcon,
    menu: Menu<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
    checkin: MenuItem<tauri::Wry>,
    setup: MenuItem<tauri::Wry>,
    check: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
    /// macOS: "App permission checks are off: turn on...", in the menu only while it applies.
    perms: MenuItem<tauri::Wry>,
    perms_shown: Mutex<bool>,
    /// macOS: "Uninstall Neo...", at the end of the menu.
    uninstall: MenuItem<tauri::Wry>,
    uninstall_shown: Mutex<bool>,
}

/// Where the permissions item goes: after the two status lines and their separator.
const PERMS_MENU_POSITION: usize = 3;

// ---- commands the web view may call --------------------------------------------------------

#[tauri::command]
async fn agent_request(request: Value) -> Result<Value, String> {
    if !logic::op_allowed(&request) {
        return Err("that request is not allowed".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || ipc::request(&request))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !logic::url_openable(&url) {
        return Err("only web addresses can be opened".to_string());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// The macOS-only actions. Everything is fixed here: the web view only names the action and never
/// supplies an address, a path or a command.
#[cfg(target_os = "macos")]
mod mac {
    use crate::logic;

    fn open_with(args: &[&str]) -> bool {
        std::process::Command::new("/usr/bin/open")
            .args(args)
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// The macOS 13+ Full Disk Access address first, the older one as a fallback.
    pub fn open_full_disk_access() -> Result<(), String> {
        if logic::FULL_DISK_ACCESS_LINKS.iter().any(|link| open_with(&[link])) {
            Ok(())
        } else {
            Err("could not open System Settings".to_string())
        }
    }

    /// Shows `Neo Protection` in Finder so it can be added to the list with the + button.
    pub fn reveal_daemon() -> Result<(), String> {
        if open_with(&["-R", logic::DAEMON_BUNDLE]) {
            Ok(())
        } else {
            Err("could not open Finder".to_string())
        }
    }

    /// Runs `uninstall.sh` with the standard administrator password prompt. Cancelling the prompt
    /// makes `osascript` fail and nothing is changed.
    pub fn uninstall() -> Result<(), String> {
        let script = logic::uninstall_applescript(logic::UNINSTALL_SCRIPT).ok_or("bad uninstall path")?;
        let ok = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok { Ok(()) } else { Err("the uninstall did not run".to_string()) }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    const NOT_A_MAC: &str = "this only works on a Mac";

    pub fn open_full_disk_access() -> Result<(), String> {
        Err(NOT_A_MAC.to_string())
    }

    pub fn reveal_daemon() -> Result<(), String> {
        Err(NOT_A_MAC.to_string())
    }

    pub fn uninstall() -> Result<(), String> {
        Err(NOT_A_MAC.to_string())
    }
}

#[tauri::command]
async fn open_full_disk_access() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(mac::open_full_disk_access)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn reveal_daemon() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(mac::reveal_daemon)
        .await
        .map_err(|e| e.to_string())?
}

/// "Uninstall Neo...": the confirmation (who will be told) is the web view's `uninstall` window.
#[tauri::command]
async fn uninstall_mac() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(mac::uninstall)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn close_self(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_warning(app: AppHandle, event_id: String) -> Option<Value> {
    let shared = app.state::<Shared>();
    let inner = shared.0.lock().unwrap_or_else(|e| e.into_inner());
    inner.warnings.get(&event_id).cloned()
}

// ---- windows ---------------------------------------------------------------------------------

fn open_view(app: &AppHandle, label: &str, query: &str, title: &str, width: f64, height: f64) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let url = WebviewUrl::App(format!("index.html?{query}").into());
    if let Err(e) = WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(width, height)
        .resizable(false)
        .center()
        .build()
    {
        eprintln!("could not open the {label} window: {e}");
    }
}

/// The critical window: topmost, and it does not take keyboard focus from what the person is doing.
fn open_warning_window(app: &AppHandle, event_id: &str) {
    let label = logic::warning_label(event_id);
    if app.get_webview_window(&label).is_some() {
        return;
    }
    let url = WebviewUrl::App(format!("index.html?view=warning&event={event_id}").into());
    let built = WebviewWindowBuilder::new(app, &label, url)
        .title("Neo: warning")
        .inner_size(620.0, 420.0)
        .resizable(false)
        .minimizable(false)
        .always_on_top(true)
        .focused(false)
        .center()
        .build();
    if let Err(e) = built {
        eprintln!("could not open the warning window: {e}");
    }
}

fn open_setup(app: &AppHandle) {
    open_view(app, "setup", "view=setup", "Set up Neo", 520.0, 520.0);
}

// ---- tray ------------------------------------------------------------------------------------

fn build_tray(app: &AppHandle) -> tauri::Result<TrayUi> {
    let status = MenuItem::with_id(app, "status", "Checking…", false, None::<&str>)?;
    let checkin = MenuItem::with_id(app, "checkin", "Last check-in: never", false, None::<&str>)?;
    let setup = MenuItem::with_id(app, "setup", "Set up Neo…", false, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Check a link…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Neo", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "About and privacy", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop protecting this computer…", false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let perms = MenuItem::with_id(app, "perms", "App permission checks are off: turn on\u{2026}", true, None::<&str>)?;
    let uninstall = MenuItem::with_id(app, "uninstall", "Uninstall Neo\u{2026}", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &checkin, &sep1, &setup, &check, &open, &about, &sep2, &stop])?;
    let tray = TrayIconBuilder::with_id("neo")
        .icon(Image::from_bytes(GREY)?)
        .tooltip("Neo")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "setup" => open_setup(app),
            "check" => open_view(app, "check", "view=check", "Check a link", 520.0, 360.0),
            "about" => open_view(app, "about", "view=about", "About Neo", 520.0, 420.0),
            "stop" => open_view(app, "stop", "view=stop", "Stop protecting", 480.0, 280.0),
            "perms" => open_view(
                app,
                "permissions",
                "view=permissions",
                "Let Neo check app permissions",
                540.0,
                600.0,
            ),
            "uninstall" => open_view(app, "uninstall", "view=uninstall", "Uninstall Neo", 480.0, 320.0),
            "open" => {
                let base = {
                    let shared = app.state::<Shared>();
                    let inner = shared.0.lock().unwrap_or_else(|e| e.into_inner());
                    inner.status.as_ref().and_then(|s| s["serverUrl"].as_str()).map(str::to_string)
                };
                let url = base
                    .filter(|u| logic::url_openable(u))
                    .unwrap_or_else(|| "https://www.neoshield.dev".to_string());
                let _ = app.opener().open_url(url, None::<&str>);
            }
            _ => {}
        })
        .build(app)?;
    Ok(TrayUi {
        tray,
        menu,
        status,
        checkin,
        setup,
        check,
        stop,
        perms,
        perms_shown: Mutex::new(false),
        uninstall,
        uninstall_shown: Mutex::new(false),
    })
}

/// Redraws the menu and icon from what the tray knows.
fn refresh_tray(app: &AppHandle) {
    let (up, status, last_alert) = {
        let shared = app.state::<Shared>();
        let inner = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        (inner.service_up, inner.status.clone(), inner.last_alert)
    };
    let ui = app.state::<TrayUi>();
    let now = now_unix();
    let state = status.as_ref().and_then(|s| s["state"].as_str());
    let enrolled = up && state == Some("enrolled");
    let last_warning = [
        last_alert,
        status
            .as_ref()
            .and_then(|s| s["lastWarningAt"].as_str())
            .and_then(logic::parse_rfc3339_unix),
    ]
    .into_iter()
    .flatten()
    .max();

    let line = logic::status_line(up, status.as_ref());
    let _ = ui.status.set_text(&line);
    let _ = ui
        .checkin
        .set_text(logic::checkin_line(status.as_ref().and_then(|s| s["lastCheckIn"].as_str()), now));
    let _ = ui.setup.set_enabled(up && !enrolled);
    let _ = ui.check.set_enabled(enrolled);
    let _ = ui.stop.set_enabled(enrolled);
    // macOS: the Full Disk Access offer and the Uninstall item come and go with the status. The icon
    // and the notifications are untouched: the person is still protected by the other detectors.
    sync_menu_item(
        &ui.menu,
        &ui.perms,
        &ui.perms_shown,
        logic::permissions_menu_text(status.as_ref()).is_some(),
        Some(PERMS_MENU_POSITION),
    );
    sync_menu_item(&ui.menu, &ui.uninstall, &ui.uninstall_shown, logic::is_macos(status.as_ref()), None);
    let (bytes, tip) = match logic::icon_state(up, state, last_warning, now) {
        IconState::Shield => (SHIELD, format!("Neo: {line}")),
        IconState::Grey => (GREY, format!("Neo: {line}")),
        IconState::Alert => (ALERT, "Neo: a warning was shown in the last hour".to_string()),
    };
    if let Ok(img) = Image::from_bytes(bytes) {
        let _ = ui.tray.set_icon(Some(img));
    }
    let _ = ui.tray.set_tooltip(Some(tip));
}

/// Adds or removes a menu item so that it is in the menu exactly when `want` (`at`: where to
/// insert it, `None` = at the end).
fn sync_menu_item(menu: &Menu<tauri::Wry>, item: &MenuItem<tauri::Wry>, shown: &Mutex<bool>, want: bool, at: Option<usize>) {
    let mut shown = shown.lock().unwrap_or_else(|e| e.into_inner());
    if *shown == want {
        return;
    }
    let done = match (want, at) {
        (true, Some(pos)) => menu.insert(item, pos),
        (true, None) => menu.append(item),
        (false, _) => menu.remove(item),
    };
    if done.is_ok() {
        *shown = want;
    }
}

/// Asks the service for its status and updates the tray. The first time the computer turns out
/// not to be set up, the first-run window opens.
fn refresh_status(app: &AppHandle) {
    let reply = ipc::request(&serde_json::json!({ "op": "status" }));
    let open_first_run = {
        let shared = app.state::<Shared>();
        let mut inner = shared.0.lock().unwrap_or_else(|e| e.into_inner());
        if reply["ok"] == true {
            inner.service_up = true;
            let not_enrolled = reply["state"] == "not_enrolled";
            inner.status = Some(reply);
            let prompt = not_enrolled && !inner.setup_prompted;
            if prompt {
                inner.setup_prompted = true;
            }
            prompt
        } else {
            inner.service_up = false;
            false
        }
    };
    refresh_tray(app);
    if open_first_run {
        open_setup(app);
    }
}

// ---- pushes ----------------------------------------------------------------------------------

fn handle_push(app: &AppHandle, push: Value) {
    match push["push"].as_str() {
        Some("status_changed") => refresh_status(app),
        Some("warning") => {
            let Some(warning) = logic::parse_warning(&push) else { return };
            let event_id = warning["eventId"].as_str().unwrap_or_default().to_string();
            let first_time = {
                let shared = app.state::<Shared>();
                let mut inner = shared.0.lock().unwrap_or_else(|e| e.into_inner());
                inner.last_alert = Some(now_unix());
                inner.warnings.insert(event_id.clone(), warning.clone()).is_none()
            };
            // A repeat of the same warning (the owner was told) updates an open window.
            let _ = app.emit("agent-warning", &warning);
            if first_time {
                let kind = warning["kind"].as_str().unwrap_or_default();
                let tool = warning["toolName"].as_str().unwrap_or_default();
                match logic::toast_text(kind, tool) {
                    Some((title, body)) => {
                        let _ = app.notification().builder().title(title).body(body).show();
                    }
                    None => open_warning_window(app, &event_id),
                }
            }
            refresh_tray(app);
        }
        _ => {}
    }
}

/// Keeps a subscription to the service, with a calm retry when it is not there.
fn spawn_background(app: AppHandle) {
    let poll_app = app.clone();
    std::thread::spawn(move || {
        loop {
            refresh_status(&poll_app);
            std::thread::sleep(STATUS_REFRESH);
        }
    });
    std::thread::spawn(move || {
        let mut wait = Duration::from_secs(2);
        loop {
            let handle = app.clone();
            match ipc::subscribe(|push| handle_push(&handle, push)) {
                Ok(()) => wait = Duration::from_secs(2),
                Err(_) => wait = (wait * 2).min(Duration::from_secs(30)),
            }
            // The service went away or is not running yet: show that, then try again.
            {
                let shared = app.state::<Shared>();
                shared.0.lock().unwrap_or_else(|e| e.into_inner()).service_up = false;
            }
            refresh_tray(&app);
            std::thread::sleep(wait);
        }
    });
}

pub fn run() {
    let app = tauri::Builder::default()
        // Registered first: a second launch (shortcut, login) just opens the setup/status window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| open_setup(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Shared::default())
        .invoke_handler(tauri::generate_handler![
            agent_request,
            open_url,
            close_self,
            get_warning,
            open_full_disk_access,
            reveal_daemon,
            uninstall_mac
        ])
        .setup(|app| {
            // A menu-bar-only app: no Dock icon, no app menu.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();
            let ui = build_tray(&handle)?;
            app.manage(ui);
            spawn_background(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Neo tray app");

    app.run(|_app, event| {
        // A tray app: closing the last window does not quit. The icon stays while enrolled.
        if let RunEvent::ExitRequested { api, code, .. } = event
            && code.is_none()
        {
            api.prevent_exit();
        }
    });
}
