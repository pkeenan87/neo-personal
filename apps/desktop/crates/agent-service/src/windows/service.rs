//! The Windows service shell (`windows-service`): registers with the SCM as `NeoAgent`, reports
//! Running, and runs the entry function until Stop or Shutdown.

use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use windows_service::service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

use crate::config::SERVICE_NAME;

/// The agent's main: runs until the flag is set.
pub type Entry = fn(Arc<AtomicBool>);

static ENTRY: OnceLock<Entry> = OnceLock::new();

define_windows_service!(ffi_service_main, service_main);

/// Hands the process to the SCM. Blocks until the service stops. Fails with
/// `ERROR_FAILED_SERVICE_CONTROLLER_CONNECT` when not started by the SCM.
pub fn run(entry: Entry) -> windows_service::Result<()> {
    let _ = ENTRY.set(entry);
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
}

fn service_main(_arguments: Vec<OsString>) {
    if let Err(e) = run_service() {
        log::error!("service failed: {e}");
    }
}

fn status(state: ServiceState, accept: ServiceControlAccept, wait_hint: Duration) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accept,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint: 0,
        wait_hint,
        process_id: None,
    }
}

fn run_service() -> windows_service::Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let handler_stop = stop.clone();
    let handler = move |control| -> ServiceControlHandlerResult {
        match control {
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            ServiceControl::Stop | ServiceControl::Shutdown => {
                handler_stop.store(true, Ordering::SeqCst);
                super::pipe::wake();
                ServiceControlHandlerResult::NoError
            }
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let handle = service_control_handler::register(SERVICE_NAME, handler)?;
    handle.set_service_status(status(
        ServiceState::Running,
        ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
        Duration::default(),
    ))?;
    if let Some(entry) = ENTRY.get() {
        entry(stop);
    }
    handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty(), Duration::default()))?;
    Ok(())
}
