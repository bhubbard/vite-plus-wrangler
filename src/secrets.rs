//! `.dev.vars` parsing and secret validation.
//!
//! Wrangler reads local environment secrets from a `.dev.vars` file located in
//! the same directory as `wrangler.toml` / `wrangler.jsonc`.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

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
pub struct SecretsReport {
    pub path: PathBuf,
    pub exists: bool,
    pub count: usize,
    pub ok: bool,
    pub keys: Vec<String>,
    pub issues: Vec<Issue>,
}

/// Parse a `.dev.vars` file into a map of key-value pairs.
///
/// Ignores comments (lines starting with `#`), empty lines, and trims leading/trailing whitespace.
pub fn parse_dev_vars(contents: &str) -> BTreeMap<String, String> {
    let mut vars = BTreeMap::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((key, val)) = line.split_once('=') else {
            continue;
        };

        let key = key.trim().to_string();
        if key.is_empty() {
            continue;
        }

        let mut val = val.trim();
        if ((val.starts_with('"') && val.ends_with('"'))
            || (val.starts_with('\'') && val.ends_with('\'')))
            && val.len() >= 2
        {
            val = &val[1..val.len() - 1];
        }

        vars.insert(key, val.to_string());
    }
    vars
}

/// Check the `.dev.vars` file for a given Wrangler configuration directory.
pub fn inspect_secrets(config_path: &Path, override_dev_vars: Option<&Path>) -> SecretsReport {
    let dev_vars_path = match override_dev_vars {
        Some(p) => p.to_path_buf(),
        None => {
            let base = config_path.parent().unwrap_or_else(|| Path::new(""));
            base.join(".dev.vars")
        }
    };

    let mut issues = Vec::new();
    if !dev_vars_path.is_file() {
        issues.push(Issue {
            severity: Severity::Warning,
            message: format!(
                "No .dev.vars file found at {}. Local wrangler dev may lack required secrets.",
                dev_vars_path.display()
            ),
        });

        return SecretsReport {
            path: dev_vars_path,
            exists: false,
            count: 0,
            ok: true,
            keys: Vec::new(),
            issues,
        };
    }

    match fs::read_to_string(&dev_vars_path) {
        Ok(contents) => {
            let parsed = parse_dev_vars(&contents);
            let keys: Vec<String> = parsed.keys().cloned().collect();

            SecretsReport {
                path: dev_vars_path,
                exists: true,
                count: keys.len(),
                ok: true,
                keys,
                issues,
            }
        }
        Err(err) => {
            issues.push(Issue {
                severity: Severity::Error,
                message: format!("Failed to read {}: {err}", dev_vars_path.display()),
            });

            SecretsReport {
                path: dev_vars_path,
                exists: true,
                count: 0,
                ok: false,
                keys: Vec::new(),
                issues,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn parses_comments_and_quotes() {
        let src = r#"
            # Environment variables for dev
            SECRET_KEY=supersecret
            QUOTED="hello world"
            SINGLE='quoted value'
            EMPTY=
        "#;

        let parsed = parse_dev_vars(src);
        assert_eq!(
            parsed.get("SECRET_KEY").map(String::as_str),
            Some("supersecret")
        );
        assert_eq!(
            parsed.get("QUOTED").map(String::as_str),
            Some("hello world")
        );
        assert_eq!(
            parsed.get("SINGLE").map(String::as_str),
            Some("quoted value")
        );
        assert_eq!(parsed.get("EMPTY").map(String::as_str), Some(""));
        assert!(!parsed.contains_key("# Environment variables for dev"));
    }

    #[test]
    fn missing_file_is_warning() {
        let report = inspect_secrets(
            Path::new("wrangler.toml"),
            Some(Path::new("nonexistent.dev.vars")),
        );
        assert!(report.ok);
        assert!(!report.exists);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].severity, Severity::Warning);
    }

    #[test]
    fn inspects_existing_dev_vars() {
        let d = TempDir::new("sec");
        d.write(".dev.vars", "API_KEY=abc\nDB_PASS=123\n");

        let report = inspect_secrets(&d.path().join("wrangler.toml"), None);
        assert!(report.ok);
        assert!(report.exists);
        assert_eq!(report.count, 2);
        assert_eq!(report.keys, vec!["API_KEY", "DB_PASS"]);
    }
}
