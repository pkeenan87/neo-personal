//! The socket's peer check. Any local user may connect (like INTERACTIVE on Windows; the socket is
//! not reachable from the network), but the daemon insists it can read the peer's credentials
//! with `getpeereid` before it serves anything.

use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;

use crate::ipc::PeerCheck;

pub struct GetPeerEid;

/// The peer's effective uid, `None` when the call fails.
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let (mut uid, mut gid): (libc::uid_t, libc::gid_t) = (0, 0);
    // SAFETY: the fd is a live socket owned by `stream`; uid and gid are valid out-pointers.
    let rc = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    (rc == 0).then_some(uid)
}

impl PeerCheck for GetPeerEid {
    fn admit(&self, stream: &UnixStream) -> bool {
        match peer_uid(stream) {
            Some(uid) => {
                log::debug!("connection from uid {uid}");
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_peer_is_admitted_with_its_own_uid() {
        let (a, b) = UnixStream::pair().unwrap();
        assert!(GetPeerEid.admit(&a));
        // SAFETY: geteuid has no preconditions.
        assert_eq!(peer_uid(&b), Some(unsafe { libc::geteuid() }));
    }
}
