//! Authenticode results cached by path, size and modified time, so a 5-second process poll checks
//! each binary once.

use std::collections::HashMap;

const MAX_ENTRIES: usize = 4096;

#[derive(Default)]
pub struct SignerCache {
    map: HashMap<(String, u64, i64), Option<String>>,
}

impl SignerCache {
    /// The cached signer subject (`None` = unsigned or untrusted) or the result of `check`.
    pub fn get_or_check(&mut self, path: &str, size: u64, mtime: i64, check: impl FnOnce() -> Option<String>) -> Option<String> {
        let key = (path.to_lowercase(), size, mtime);
        if let Some(hit) = self.map.get(&key) {
            return hit.clone();
        }
        if self.map.len() >= MAX_ENTRIES {
            self.map.clear();
        }
        let v = check();
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

    #[test]
    fn checks_once_per_path_size_mtime() {
        let mut c = SignerCache::default();
        let mut calls = 0;
        for _ in 0..3 {
            let s = c.get_or_check(r"C:\X\a.exe", 10, 5, || {
                calls += 1;
                Some("AnyDesk Software GmbH".into())
            });
            assert_eq!(s.as_deref(), Some("AnyDesk Software GmbH"));
        }
        assert_eq!(calls, 1);
        // Same path in another case is the same file; a changed size or time is a new check.
        c.get_or_check(r"c:\x\A.EXE", 10, 5, || {
            calls += 1;
            None
        });
        assert_eq!(calls, 1);
        c.get_or_check(r"C:\X\a.exe", 11, 5, || {
            calls += 1;
            None
        });
        assert_eq!(calls, 2);
        // An unsigned result is cached too.
        c.get_or_check(r"C:\X\a.exe", 11, 5, || {
            calls += 1;
            None
        });
        assert_eq!(calls, 2);
        assert_eq!(c.len(), 2);
    }
}
