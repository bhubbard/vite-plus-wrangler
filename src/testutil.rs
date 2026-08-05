//! Shared test helpers.
//!
//! Only compiled under `cfg(test)`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// Monotonic counter, unique within this test binary.
///
/// `cargo test` runs the tests of one binary as threads in a single process, so
/// `process::id()` is identical across them and cannot contribute uniqueness.
/// A clock cannot either: two threads that call `SystemTime::now()` inside the
/// same tick get the same value, and the coarser the platform's clock the more
/// often that happens. Measured with 16 threads generating 32,000 names:
/// 710 collisions at 1ns resolution and 25,027 at the ~1us resolution macOS
/// typically reports.
///
/// The counter removes the race outright. `process::id()` is still included
/// because `cargo test` runs the lib and bin test binaries as separate
/// processes that may overlap.
static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A temporary directory that removes itself on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    /// Create a uniquely named temporary directory.
    ///
    /// Uses `create_dir`, not `create_dir_all`: if the name ever did collide,
    /// this panics instead of silently handing two tests the same directory.
    /// A collision used to surface as a neighbouring test's fixtures appearing
    /// mid-run — for example a migrations test failing with "Inconsistent
    /// prefix widths" over files it never created.
    pub fn new(prefix: &str) -> Self {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("vpw-{prefix}-{}-{n}", std::process::id()));

        // Left over from a previous run that was killed before Drop ran.
        if dir.exists() {
            fs::remove_dir_all(&dir).expect("clear stale temp dir");
        }
        fs::create_dir(&dir).unwrap_or_else(|e| panic!("create {}: {e}", dir.display()));

        TempDir(dir)
    }

    /// Create a temporary directory containing the given files, each with
    /// placeholder SQL contents.
    pub fn with_files(prefix: &str, files: &[&str]) -> Self {
        let dir = Self::new(prefix);
        for f in files {
            dir.write(f, "SELECT 1;");
        }
        dir
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Write a file, creating parent directories as needed.
    pub fn write(&self, rel: &str, body: &str) {
        let p = self.0.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("create parent dir");
        }
        fs::write(p, body).expect("write fixture");
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};

    #[test]
    fn names_are_unique_under_parallel_creation() {
        let paths = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();

        for _ in 0..8 {
            let paths = Arc::clone(&paths);
            handles.push(std::thread::spawn(move || {
                // Held until the end so no name can be recycled via Drop.
                let dirs: Vec<TempDir> = (0..50).map(|_| TempDir::new("race")).collect();
                let mut guard = paths.lock().unwrap();
                for d in &dirs {
                    guard.push(d.path().to_path_buf());
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let all = paths.lock().unwrap().clone();
        let distinct: HashSet<_> = all.iter().collect();
        assert_eq!(distinct.len(), all.len(), "temp dir names collided");
    }

    #[test]
    fn cleans_up_on_drop() {
        let path = {
            let d = TempDir::with_files("cleanup", &["0001_a.sql"]);
            let p = d.path().to_path_buf();
            assert!(p.join("0001_a.sql").exists());
            p
        };
        assert!(!path.exists(), "temp dir outlived its guard");
    }
}
