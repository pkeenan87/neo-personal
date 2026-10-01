//! Fan-out of pushes (`warning`, `status_changed`) to subscribed pipe connections.

use std::sync::Mutex;
use std::sync::mpsc::{Receiver, Sender, channel};

use serde_json::Value;

#[derive(Default)]
pub struct Hub {
    subs: Mutex<Vec<Sender<String>>>,
}

impl Hub {
    pub fn subscribe(&self) -> Receiver<String> {
        let (tx, rx) = channel();
        self.subs.lock().unwrap_or_else(|e| e.into_inner()).push(tx);
        rx
    }

    /// Sends one JSON line to every live subscriber and returns how many got it. Subscribers whose
    /// connection is gone are dropped.
    pub fn broadcast(&self, push: &Value) -> usize {
        let line = push.to_string();
        let mut subs = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        subs.retain(|s| s.send(line.clone()).is_ok());
        subs.len()
    }

    pub fn subscriber_count(&self) -> usize {
        self.subs.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn broadcast_reaches_live_subscribers_and_drops_dead_ones() {
        let hub = Hub::default();
        assert_eq!(hub.broadcast(&json!({"push":"status_changed"})), 0);
        let a = hub.subscribe();
        let b = hub.subscribe();
        assert_eq!(hub.broadcast(&json!({"push":"status_changed"})), 2);
        assert_eq!(a.recv().unwrap(), r#"{"push":"status_changed"}"#);
        drop(b);
        assert_eq!(hub.broadcast(&json!({"push":"x"})), 1);
        assert_eq!(hub.subscriber_count(), 1);
    }
}
