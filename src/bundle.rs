//! Worker output bundle size guard.
//!
//! Cloudflare Workers have hard size limits: 3 MB on free accounts, 10 MB or
//! 25 MB on paid plans. This module checks bundle file sizes against a limit.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const DEFAULT_LIMIT_MB: f64 = 3.0;
const BYTES_PER_MB: f64 = 1_048_576.0; // 1024 * 1024

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize)]
pub struct BundleSizeIssue {
    pub severity: Severity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BundleFileDetails {
    pub path: PathBuf,
    pub size_bytes: u64,
    pub size_mb: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BundleSizeReport {
    pub path: PathBuf,
    pub exists: bool,
    pub total_bytes: u64,
    pub total_mb: f64,
    pub limit_mb: f64,
    pub limit_bytes: u64,
    pub ok: bool,
    pub files: Vec<BundleFileDetails>,
    pub issues: Vec<BundleSizeIssue>,
}

fn is_bundle_file(path: &Path) -> bool {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.ends_with(".map") || name.ends_with(".d.ts") {
        return false;
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(ext.as_str(), "js" | "mjs" | "cjs" | "wasm")
}

pub fn check_bundle_size(path: &Path, limit_mb: Option<f64>) -> BundleSizeReport {
    let limit_mb = limit_mb.unwrap_or(DEFAULT_LIMIT_MB);
    let limit_bytes = (limit_mb * BYTES_PER_MB) as u64;

    let mut issues = Vec::new();
    let mut files = Vec::new();

    if !path.exists() {
        issues.push(BundleSizeIssue {
            severity: Severity::Error,
            message: format!("Target path does not exist: {}", path.display()),
        });
        return BundleSizeReport {
            path: path.to_path_buf(),
            exists: false,
            total_bytes: 0,
            total_mb: 0.0,
            limit_mb,
            limit_bytes,
            ok: false,
            files,
            issues,
        };
    }

    if path.is_file() {
        if let Ok(meta) = fs::metadata(path) {
            let size_bytes = meta.len();
            let raw_mb = (size_bytes as f64) / BYTES_PER_MB;
            let size_mb = (raw_mb * 100.0).round() / 100.0;
            files.push(BundleFileDetails {
                path: path.to_path_buf(),
                size_bytes,
                size_mb,
            });
        }
    } else if path.is_dir() {
        let walker = WalkDir::new(path).into_iter().flatten();
        for entry in walker {
            if entry.file_type().is_file() && is_bundle_file(entry.path()) {
                if let Ok(meta) = entry.metadata() {
                    let size_bytes = meta.len();
                    let raw_mb = (size_bytes as f64) / BYTES_PER_MB;
                    let size_mb = (raw_mb * 100.0).round() / 100.0;
                    files.push(BundleFileDetails {
                        path: entry.path().to_path_buf(),
                        size_bytes,
                        size_mb,
                    });
                }
            }
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));

    if files.is_empty() {
        issues.push(BundleSizeIssue {
            severity: Severity::Error,
            message: format!("No JS/WASM bundle files found under {}", path.display()),
        });
        return BundleSizeReport {
            path: path.to_path_buf(),
            exists: true,
            total_bytes: 0,
            total_mb: 0.0,
            limit_mb,
            limit_bytes,
            ok: false,
            files,
            issues,
        };
    }

    let total_bytes: u64 = files.iter().map(|f| f.size_bytes).sum();
    let raw_total_mb = (total_bytes as f64) / BYTES_PER_MB;
    let total_mb = (raw_total_mb * 100.0).round() / 100.0;

    let is_over = total_bytes > limit_bytes;

    if is_over {
        let diff_mb = ((total_bytes - limit_bytes) as f64 / BYTES_PER_MB * 100.0).round() / 100.0;
        issues.push(BundleSizeIssue {
            severity: Severity::Error,
            message: format!(
                "Bundle size ({:.2} MB) exceeds limit of {:.2} MB by {:.2} MB",
                total_mb, limit_mb, diff_mb
            ),
        });
    } else if total_bytes as f64 >= limit_bytes as f64 * 0.8 {
        let pct = ((total_bytes as f64 / limit_bytes as f64) * 100.0).round() as u64;
        issues.push(BundleSizeIssue {
            severity: Severity::Warning,
            message: format!(
                "Bundle size ({:.2} MB) is at {}% of the {:.2} MB limit",
                total_mb, pct, limit_mb
            ),
        });
    }

    BundleSizeReport {
        path: path.to_path_buf(),
        exists: true,
        total_bytes,
        total_mb,
        limit_mb,
        limit_bytes,
        ok: !is_over,
        files,
        issues,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn non_existent_path_returns_error() {
        let report = check_bundle_size(Path::new("non_existent_dist"), None);
        assert!(!report.exists);
        assert!(!report.ok);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].severity, Severity::Error);
        assert!(report.issues[0].message.contains("does not exist"));
    }

    #[test]
    fn single_file_under_limit() {
        let d = TempDir::new("bundle_file");
        let file_path = d.path().join("index.js");
        fs::write(&file_path, vec![0u8; 100_000]).unwrap(); // ~0.1 MB

        let report = check_bundle_size(&file_path, None);
        assert!(report.exists);
        assert!(report.ok);
        assert_eq!(report.total_bytes, 100_000);
        assert_eq!(report.files.len(), 1);
        assert_eq!(report.issues.len(), 0);
    }

    #[test]
    fn single_file_exceeds_limit() {
        let d = TempDir::new("bundle_large");
        let file_path = d.path().join("index.js");
        // 4 MB = 4 * 1024 * 1024 = 4,194,304 bytes
        fs::write(&file_path, vec![0u8; 4_194_304]).unwrap();

        let report = check_bundle_size(&file_path, Some(3.0));
        assert!(report.exists);
        assert!(!report.ok);
        assert_eq!(report.total_bytes, 4_194_304);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].severity, Severity::Error);
        assert!(report.issues[0].message.contains("exceeds limit"));
    }

    #[test]
    fn directory_scans_and_ignores_maps() {
        let d = TempDir::new("bundle_dir");
        d.write("dist/worker.mjs", "console.log('hi');");
        d.write("dist/worker.mjs.map", "source map content");
        d.write("dist/types.d.ts", "export type X = string;");

        let report = check_bundle_size(&d.path().join("dist"), None);
        assert!(report.exists);
        assert!(report.ok);
        assert_eq!(report.files.len(), 1);
        assert!(report.files[0]
            .path
            .to_string_lossy()
            .contains("worker.mjs"));
    }

    #[test]
    fn warning_when_close_to_limit() {
        let d = TempDir::new("bundle_warn");
        let file_path = d.path().join("index.js");
        // 2.5 MB = 2.5 * 1024 * 1024 = 2,621,440 bytes (83.3% of 3MB limit)
        fs::write(&file_path, vec![0u8; 2_621_440]).unwrap();

        let report = check_bundle_size(&file_path, Some(3.0));
        assert!(report.exists);
        assert!(report.ok);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].severity, Severity::Warning);
        assert!(report.issues[0].message.contains("83%"));
    }
}
