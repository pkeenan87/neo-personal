//! Real HTTP (`ureq`), behind the `http` feature so the OS-only code can be compile-checked
//! without a C toolchain.

use std::io::Read;

use crate::update::{Downloader, UpdateError};

/// `ureq`-based downloader (follows redirects: GitHub release assets redirect to a CDN).
pub struct UreqDownloader {
    agent: ureq::Agent,
}

impl Default for UreqDownloader {
    fn default() -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(600)))
            .user_agent(concat!("neo-agent/", env!("CARGO_PKG_VERSION")))
            .build();
        UreqDownloader {
            agent: ureq::Agent::new_with_config(config),
        }
    }
}

impl Downloader for UreqDownloader {
    fn fetch(&self, url: &str, max_bytes: u64) -> Result<Vec<u8>, UpdateError> {
        let mut resp = self.agent.get(url).call().map_err(|e| UpdateError::Download(e.to_string()))?;
        let mut out = Vec::new();
        resp.body_mut()
            .as_reader()
            .take(max_bytes + 1)
            .read_to_end(&mut out)
            .map_err(|e| UpdateError::Download(e.to_string()))?;
        if out.len() as u64 > max_bytes {
            return Err(UpdateError::Download("file is too large".into()));
        }
        Ok(out)
    }
}
