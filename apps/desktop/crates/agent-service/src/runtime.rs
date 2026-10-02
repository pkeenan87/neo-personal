//! The service loop: a pipe-server thread plus a one-second tick, until asked to stop (or, on
//! macOS, until the agent asks to be relaunched).

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::agent::Agent;

/// Runs `agent` until `stop` is set. `serve` is the pipe server (it must return soon after `stop`
/// is set and `on_stop` has been called); `on_stop` unblocks it.
pub fn run_loop(
    agent: Arc<Agent>,
    stop: Arc<AtomicBool>,
    serve: impl FnOnce(Arc<Agent>, Arc<AtomicBool>) + Send + 'static,
    on_stop: impl FnOnce(),
) {
    let server = {
        let (agent, stop) = (agent.clone(), stop.clone());
        std::thread::spawn(move || serve(agent, stop))
    };
    while !stop.load(Ordering::SeqCst) {
        if agent.relaunch_due() {
            // launchd (KeepAlive) starts a fresh process, which can see a new Full Disk Access grant.
            log::info!("exiting for a relaunch");
            stop.store(true, Ordering::SeqCst);
            break;
        }
        // A bug in one pass must not take the protection down.
        if catch_unwind(AssertUnwindSafe(|| agent.tick())).is_err() {
            log::error!("a scan pass panicked; continuing");
        }
        for _ in 0..5 {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    on_stop();
    let _ = server.join();
}
