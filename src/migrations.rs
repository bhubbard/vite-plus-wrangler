//! D1 migration inventory and prefix hygiene.
//!
//! Wrangler applies migrations in lexicographic order, so an inconsistent
//! prefix width silently reorders them once you cross a power of ten.

use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct Migration {
    pub file: String,
    pub path: PathBuf,
    pub prefix: String,
    /// Numeric value of the prefix. `u64` so that timestamp prefixes such as
    /// `20240101120000_add_users.sql` fit — those overflow `u32` and used to
    /// silently collapse to 0, making every migration look like a duplicate.
    pub index: u64,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub severity: Severity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MigrationReport {
    pub dir: PathBuf,
    pub count: usize,
    pub ok: bool,
    pub migrations: Vec<Migration>,
    pub issues: Vec<Issue>,
}

/// Inspect a D1 migrations directory and report ordering hazards.
pub fn inspect(dir: &Path) -> MigrationReport {
    let mut issues = Vec::new();
    let mut migrations = Vec::new();

    if !dir.is_dir() {
        return MigrationReport {
            dir: dir.to_path_buf(),
            count: 0,
            ok: false,
            migrations,
            issues: vec![Issue {
                severity: Severity::Error,
                message: format!("{} is not a directory", dir.display()),
            }],
        };
    }

    let pattern = Regex::new(r"^(\d+)[_-](.+)\.sql$").expect("static regex");
    let mut entries: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("sql"))
            .collect(),
        Err(err) => {
            return MigrationReport {
                dir: dir.to_path_buf(),
                count: 0,
                ok: false,
                migrations,
                issues: vec![Issue {
                    severity: Severity::Error,
                    message: format!("{}: {err}", dir.display()),
                }],
            };
        }
    };
    entries.sort();

    for path in &entries {
        let file = path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or_default()
            .to_string();

        let Some(caps) = pattern.captures(&file) else {
            issues.push(Issue {
                severity: Severity::Error,
                message: format!("{file} does not match the <prefix>_<name>.sql convention"),
            });
            continue;
        };

        let prefix = caps[1].to_string();
        // A prefix too large even for u64 is a real error, not something to
        // paper over with a default: reporting it beats silently mis-ordering.
        let Ok(index) = prefix.parse::<u64>() else {
            issues.push(Issue {
                severity: Severity::Error,
                message: format!(
                    "{file}: prefix '{prefix}' is not a number this tool can order \
                     (values above {} are unsupported)",
                    u64::MAX
                ),
            });
            continue;
        };

        migrations.push(Migration {
            file: file.clone(),
            path: path.clone(),
            prefix,
            index,
            name: caps[2].to_string(),
        });
    }

    // Prefix width must be uniform or lexicographic ordering breaks at 10, 100, ...
    let widths: Vec<usize> = migrations.iter().map(|m| m.prefix.len()).collect();
    if let Some(first) = widths.first() {
        if widths.iter().any(|w| w != first) {
            issues.push(Issue {
                severity: Severity::Error,
                message: format!(
                    "Inconsistent prefix widths ({:?}). Wrangler orders migrations \
                     lexicographically, so mixed widths reorder them.",
                    dedupe(&widths)
                ),
            });
        }
    }

    // Duplicate prefixes make apply order undefined.
    let mut seen: Vec<(u64, String)> = Vec::new();
    for m in &migrations {
        if let Some((_, other)) = seen.iter().find(|(idx, _)| *idx == m.index) {
            issues.push(Issue {
                severity: Severity::Error,
                message: format!("Duplicate prefix {}: {} and {}", m.prefix, other, m.file),
            });
        } else {
            seen.push((m.index, m.file.clone()));
        }
    }

    // Gaps are legal but usually mean a migration was dropped from a branch.
    // Timestamp-style prefixes (12+ digits like YYYYMMDDHHMMSS) are never contiguous,
    // so only sequential numbering (prefixes under 12 digits) is checked.
    let looks_sequential = migrations.iter().all(|m| m.prefix.len() < 12);
    if looks_sequential {
        let mut sorted: Vec<u64> = migrations.iter().map(|m| m.index).collect();
        sorted.sort_unstable();
        sorted.dedup();
        for pair in sorted.windows(2) {
            if pair[1].saturating_sub(pair[0]) > 1 {
                issues.push(Issue {
                    severity: Severity::Warning,
                    message: format!(
                        "Gap in migration sequence between {} and {}",
                        pair[0], pair[1]
                    ),
                });
            }
        }
    }

    let ok = !issues.iter().any(|i| i.severity == Severity::Error);
    MigrationReport {
        dir: dir.to_path_buf(),
        count: migrations.len(),
        ok,
        migrations,
        issues,
    }
}

fn dedupe(widths: &[usize]) -> Vec<usize> {
    let mut out: Vec<usize> = widths.to_vec();
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    /// Build a temp directory containing the given migration filenames.
    fn fixture(files: &[&str]) -> TempDir {
        TempDir::with_files("mig", files)
    }

    #[test]
    fn missing_dir_is_an_error() {
        let report = inspect(Path::new("/definitely/not/here"));
        assert!(!report.ok);
    }

    #[test]
    fn clean_sequence_passes() {
        let d = fixture(&["0000_init.sql", "0001_add_email.sql", "0002_index.sql"]);
        let report = inspect(d.path());
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.count, 3);
        assert!(report.issues.is_empty());
    }

    #[test]
    fn timestamp_prefixes_are_not_duplicates() {
        // Regression: these overflow u32 and used to all parse to index 0,
        // making every file after the first report as a duplicate prefix.
        let d = fixture(&[
            "20240101120000_add_users.sql",
            "20240202120000_add_posts.sql",
            "20240303120000_add_index.sql",
        ]);
        let report = inspect(d.path());
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.count, 3);
        assert_eq!(report.migrations[0].index, 20240101120000);
        assert!(!report
            .issues
            .iter()
            .any(|i| i.message.contains("Duplicate")));
        // Timestamps are never contiguous; they must not produce gap warnings.
        assert!(!report.issues.iter().any(|i| i.message.contains("Gap")));
    }

    #[test]
    fn mixed_widths_are_an_error() {
        let d = fixture(&["9_nine.sql", "0010_ten.sql"]);
        let report = inspect(d.path());
        assert!(!report.ok);
        assert!(report
            .issues
            .iter()
            .any(|i| i.message.contains("Inconsistent prefix widths")));
    }

    #[test]
    fn duplicate_prefixes_are_an_error() {
        let d = fixture(&["0001_a.sql", "0001_b.sql"]);
        let report = inspect(d.path());
        assert!(!report.ok);
        assert!(report
            .issues
            .iter()
            .any(|i| i.message.contains("Duplicate prefix 0001")));
    }

    #[test]
    fn gap_is_a_warning_not_an_error() {
        let d = fixture(&["0001_a.sql", "0005_b.sql"]);
        let report = inspect(d.path());
        assert!(report.ok, "gaps must not fail the check");
        let gap = report
            .issues
            .iter()
            .find(|i| i.message.contains("Gap"))
            .expect("expected a gap warning");
        assert_eq!(gap.severity, Severity::Warning);
    }

    #[test]
    fn nonconforming_filename_is_an_error() {
        let d = fixture(&["0001_ok.sql", "notamigration.sql"]);
        let report = inspect(d.path());
        assert!(!report.ok);
        assert_eq!(report.count, 1);
        assert!(report
            .issues
            .iter()
            .any(|i| i.message.contains("does not match")));
    }

    #[test]
    fn non_sql_files_are_ignored() {
        let d = fixture(&["0001_a.sql", "README.md", "0002_b.sql"]);
        let report = inspect(d.path());
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.count, 2);
    }

    #[test]
    fn dash_separator_is_accepted() {
        let d = fixture(&["0001-a.sql", "0002-b.sql"]);
        let report = inspect(d.path());
        assert!(report.ok, "{:?}", report.issues);
        assert_eq!(report.count, 2);
    }

    #[test]
    fn eight_digit_sequential_gap_is_detected() {
        let d = fixture(&["00000001_a.sql", "00000005_b.sql"]);
        let report = inspect(d.path());
        assert!(report.ok, "gaps must not fail the check");
        let gap = report
            .issues
            .iter()
            .find(|i| i.message.contains("Gap"))
            .expect("expected a gap warning for 8-digit sequential migration");
        assert_eq!(gap.severity, Severity::Warning);
    }
}

