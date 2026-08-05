//! Config schema validation and linting for Wrangler configs.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::config::{parse_config, strip_jsonc, WranglerConfig};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LintIssue {
    pub severity: Severity,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LintReport {
    pub path: PathBuf,
    pub ok: bool,
    pub issues: Vec<LintIssue>,
}

/// Lint a Wrangler configuration file for common issues.
pub fn lint_config(path: &Path) -> LintReport {
    let mut issues = Vec::new();

    if !path.is_file() {
        issues.push(LintIssue {
            severity: Severity::Error,
            message: format!("Config file not found: {}", path.display()),
        });
        return LintReport {
            path: path.to_path_buf(),
            ok: false,
            issues,
        };
    }

    let raw = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(err) => {
            issues.push(LintIssue {
                severity: Severity::Error,
                message: format!("Failed to read {}: {err}", path.display()),
            });
            return LintReport {
                path: path.to_path_buf(),
                ok: false,
                issues,
            };
        }
    };

    let config = match parse_config(&raw, path) {
        Ok(cfg) => cfg,
        Err(err) => {
            issues.push(LintIssue {
                severity: Severity::Error,
                message: err,
            });
            return LintReport {
                path: path.to_path_buf(),
                ok: false,
                issues,
            };
        }
    };

    lint_parsed(&config, &raw, path, &mut issues);

    let ok = !issues.iter().any(|i| i.severity == Severity::Error);

    LintReport {
        path: path.to_path_buf(),
        ok,
        issues,
    }
}

fn is_valid_worker_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn lint_parsed(config: &WranglerConfig, raw: &str, path: &Path, issues: &mut Vec<LintIssue>) {
    // 1. Missing compatibility_date
    if config
        .compatibility_date
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        issues.push(LintIssue {
            severity: Severity::Warning,
            message: "Missing \"compatibility_date\" in config".to_string(),
        });
    }

    // 2. Empty or invalid name
    match config.name.as_deref() {
        None => {
            issues.push(LintIssue {
                severity: Severity::Error,
                message: "Worker name is missing or empty".to_string(),
            });
        }
        Some(name) if name.trim().is_empty() => {
            issues.push(LintIssue {
                severity: Severity::Error,
                message: "Worker name is missing or empty".to_string(),
            });
        }
        Some(name) => {
            if !is_valid_worker_name(name) {
                issues.push(LintIssue {
                    severity: Severity::Error,
                    message: format!(
                        "Invalid worker name '{name}': names must contain only alphanumeric characters, hyphens, and underscores"
                    ),
                });
            }
        }
    }

    // 3. Missing main entry point
    if config.main.as_deref().unwrap_or("").trim().is_empty() {
        issues.push(LintIssue {
            severity: Severity::Warning,
            message: "Missing \"main\" entry point".to_string(),
        });
    }

    // 4. Empty binding names in d1_databases, kv_namespaces, r2_buckets
    check_bindings(config, None, issues);
    for (env_name, env_cfg) in &config.env {
        check_bindings(env_cfg, Some(env_name), issues);
    }

    // 5. Use of deprecated fields (e.g. type = "javascript")
    check_deprecated_fields(raw, path, issues);
}

fn check_bindings(config: &WranglerConfig, env_name: Option<&str>, issues: &mut Vec<LintIssue>) {
    let prefix = match env_name {
        Some(e) => format!("env.{e}: "),
        None => String::new(),
    };

    for b in config.d1() {
        if b.binding.trim().is_empty() {
            issues.push(LintIssue {
                severity: Severity::Error,
                message: format!("{prefix}d1_databases entry has an empty binding name"),
            });
        }
    }

    for b in config.kv() {
        if b.binding.trim().is_empty() {
            issues.push(LintIssue {
                severity: Severity::Error,
                message: format!("{prefix}kv_namespaces entry has an empty binding name"),
            });
        }
    }

    for b in config.r2() {
        if b.binding.trim().is_empty() {
            issues.push(LintIssue {
                severity: Severity::Error,
                message: format!("{prefix}r2_buckets entry has an empty binding name"),
            });
        }
    }
}

fn check_deprecated_fields(raw: &str, path: &Path, issues: &mut Vec<LintIssue>) {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match ext.as_str() {
        "toml" => {
            if let Ok(value) = toml::from_str::<toml::Value>(raw) {
                inspect_value_for_deprecated(&value, issues);
            }
        }
        "json" | "jsonc" => {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&strip_jsonc(raw)) {
                inspect_json_for_deprecated(&value, issues);
            }
        }
        _ => {}
    }
}

fn inspect_value_for_deprecated(val: &toml::Value, issues: &mut Vec<LintIssue>) {
    let Some(table) = val.as_table() else { return };

    if table.contains_key("type") {
        issues.push(LintIssue {
            severity: Severity::Warning,
            message: "Deprecated field 'type' is used (Wrangler v2+ no longer uses the type field)".to_string(),
        });
    }
    if table.contains_key("zone_id") {
        issues.push(LintIssue {
            severity: Severity::Warning,
            message: "Deprecated field 'zone_id' is used".to_string(),
        });
    }
    if table.contains_key("site") {
        issues.push(LintIssue {
            severity: Severity::Warning,
            message: "Deprecated field 'site' is used".to_string(),
        });
    }
    if let Some(build) = table.get("build").and_then(|b| b.as_table()) {
        if build.contains_key("upload") {
            issues.push(LintIssue {
                severity: Severity::Warning,
                message: "Deprecated field 'build.upload' is used".to_string(),
            });
        }
    }

    if let Some(env_table) = table.get("env").and_then(|e| e.as_table()) {
        for (_env_name, env_val) in env_table {
            if let Some(env_obj) = env_val.as_table() {
                if env_obj.contains_key("type") {
                    issues.push(LintIssue {
                        severity: Severity::Warning,
                        message: "Deprecated field 'type' is used".to_string(),
                    });
                }
                if env_obj.contains_key("zone_id") {
                    issues.push(LintIssue {
                        severity: Severity::Warning,
                        message: "Deprecated field 'zone_id' is used".to_string(),
                    });
                }
            }
        }
    }
}

fn inspect_json_for_deprecated(val: &serde_json::Value, issues: &mut Vec<LintIssue>) {
    let Some(obj) = val.as_object() else { return };

    if obj.contains_key("type") {
        issues.push(LintIssue {
            severity: Severity::Warning,
            message: "Deprecated field 'type' is used (Wrangler v2+ no longer uses the type field)".to_string(),
        });
    }
    if obj.contains_key("zone_id") {
        issues.push(LintIssue {
            severity: Severity::Warning,
            message: "Deprecated field 'zone_id' is used".to_string(),
        });
    }
    if obj.contains_key("site") {
        issues.push(LintIssue {
            severity: Severity::Warning,
            message: "Deprecated field 'site' is used".to_string(),
        });
    }
    if let Some(build) = obj.get("build").and_then(|b| b.as_object()) {
        if build.contains_key("upload") {
            issues.push(LintIssue {
                severity: Severity::Warning,
                message: "Deprecated field 'build.upload' is used".to_string(),
            });
        }
    }

    if let Some(env_obj) = obj.get("env").and_then(|e| e.as_object()) {
        for (_env_name, env_val) in env_obj {
            if let Some(env_child) = env_val.as_object() {
                if env_child.contains_key("type") {
                    issues.push(LintIssue {
                        severity: Severity::Warning,
                        message: "Deprecated field 'type' is used".to_string(),
                    });
                }
                if env_child.contains_key("zone_id") {
                    issues.push(LintIssue {
                        severity: Severity::Warning,
                        message: "Deprecated field 'zone_id' is used".to_string(),
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    #[test]
    fn missing_file_returns_error() {
        let report = lint_config(Path::new("nonexistent.toml"));
        assert!(!report.ok);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].severity, Severity::Error);
        assert!(report.issues[0].message.contains("not found"));
    }

    #[test]
    fn valid_config_passes() {
        let d = TempDir::new("lint_valid");
        d.write(
            "wrangler.toml",
            r#"
            name = "my-worker"
            compatibility_date = "2024-01-01"
            main = "src/index.ts"

            [[d1_databases]]
            binding = "DB"
            database_name = "prod"
            database_id = "xxxx"
            "#,
        );

        let report = lint_config(&d.path().join("wrangler.toml"));
        assert!(report.ok);
        assert!(report.issues.is_empty());
    }

    #[test]
    fn detects_missing_compatibility_date_and_main() {
        let d = TempDir::new("lint_missing");
        d.write(
            "wrangler.toml",
            r#"
            name = "my-worker"
            "#,
        );

        let report = lint_config(&d.path().join("wrangler.toml"));
        assert!(report.ok); // warnings do not make ok=false
        assert_eq!(report.issues.len(), 2);
        assert!(report.issues.iter().any(|i| i.message.contains("compatibility_date")));
        assert!(report.issues.iter().any(|i| i.message.contains("main")));
    }

    #[test]
    fn detects_empty_and_invalid_worker_name() {
        let d = TempDir::new("lint_name");
        d.write(
            "wrangler.toml",
            r#"
            name = ""
            compatibility_date = "2024-01-01"
            main = "src/index.ts"
            "#,
        );

        let report = lint_config(&d.path().join("wrangler.toml"));
        assert!(!report.ok);
        assert!(report.issues.iter().any(|i| i.message.contains("missing or empty")));

        let d2 = TempDir::new("lint_name_invalid");
        d2.write(
            "wrangler.toml",
            r#"
            name = "invalid worker@name!"
            compatibility_date = "2024-01-01"
            main = "src/index.ts"
            "#,
        );

        let report2 = lint_config(&d2.path().join("wrangler.toml"));
        assert!(!report2.ok);
        assert!(report2.issues.iter().any(|i| i.message.contains("Invalid worker name")));
    }

    #[test]
    fn detects_empty_binding_names() {
        let d = TempDir::new("lint_bindings");
        d.write(
            "wrangler.toml",
            r#"
            name = "my-worker"
            compatibility_date = "2024-01-01"
            main = "src/index.ts"

            [[d1_databases]]
            binding = ""
            database_name = "db"
            database_id = "123"

            [[kv_namespaces]]
            binding = "  "
            id = "456"

            [[r2_buckets]]
            binding = ""
            bucket_name = "b"
            "#,
        );

        let report = lint_config(&d.path().join("wrangler.toml"));
        assert!(!report.ok);
        assert_eq!(report.issues.len(), 3);
        assert!(report.issues.iter().any(|i| i.message.contains("d1_databases")));
        assert!(report.issues.iter().any(|i| i.message.contains("kv_namespaces")));
        assert!(report.issues.iter().any(|i| i.message.contains("r2_buckets")));
    }

    #[test]
    fn detects_deprecated_fields_in_toml_and_json() {
        let d = TempDir::new("lint_deprecated");
        d.write(
            "wrangler.toml",
            r#"
            name = "my-worker"
            compatibility_date = "2024-01-01"
            main = "src/index.ts"
            type = "javascript"
            zone_id = "12345"
            "#,
        );

        let report = lint_config(&d.path().join("wrangler.toml"));
        assert!(report.ok); // warnings
        assert_eq!(report.issues.len(), 2);
        assert!(report.issues.iter().any(|i| i.message.contains("type")));
        assert!(report.issues.iter().any(|i| i.message.contains("zone_id")));

        let d_json = TempDir::new("lint_deprecated_json");
        d_json.write(
            "wrangler.jsonc",
            r#"{
                // JSONC format
                "name": "json-worker",
                "compatibility_date": "2024-01-01",
                "main": "src/index.ts",
                "type": "javascript"
            }"#,
        );

        let report_json = lint_config(&d_json.path().join("wrangler.jsonc"));
        assert!(report_json.ok);
        assert_eq!(report_json.issues.len(), 1);
        assert!(report_json.issues[0].message.contains("type"));
    }
}
