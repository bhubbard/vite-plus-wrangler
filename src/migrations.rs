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
    pub index: u32,
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
    let mut entries: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("sql"))
                .collect()
        })
        .unwrap_or_default();
    entries.sort();

    for path in &entries {
        let file = path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or_default()
            .to_string();

        match pattern.captures(&file) {
            Some(caps) => {
                let prefix = caps[1].to_string();
                let index = prefix.parse::<u32>().unwrap_or(0);
                migrations.push(Migration {
                    file: file.clone(),
                    path: path.clone(),
                    prefix,
                    index,
                    name: caps[2].to_string(),
                });
            }
            None => issues.push(Issue {
                severity: Severity::Error,
                message: format!("{file} does not match the <prefix>_<name>.sql convention"),
            }),
        }
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
    let mut seen: Vec<(u32, String)> = Vec::new();
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
    let mut sorted: Vec<u32> = migrations.iter().map(|m| m.index).collect();
    sorted.sort_unstable();
    sorted.dedup();
    for pair in sorted.windows(2) {
        if pair[1] > pair[0] + 1 {
            issues.push(Issue {
                severity: Severity::Warning,
                message: format!("Gap in migration sequence between {} and {}", pair[0], pair[1]),
            });
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

    #[test]
    fn missing_dir_is_an_error() {
        let report = inspect(Path::new("/definitely/not/here"));
        assert!(!report.ok);
    }
}
