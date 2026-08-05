use crate::config::{load_config, WranglerConfig};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BindingIssue {
    pub severity: Severity,
    pub binding: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeBindingsReport {
    pub config_path: PathBuf,
    pub src_dir: PathBuf,
    pub ok: bool,
    pub referenced_bindings: Vec<String>,
    pub configured_bindings: Vec<String>,
    pub missing_bindings: Vec<String>,
    pub unused_bindings: Vec<String>,
    pub issues: Vec<BindingIssue>,
}

const RESERVED_KEYS: &[&str] = &[
    "NODE_ENV", "CF_PAGES", "FETCH", "ASSETS", "PROD", "DEV", "MODE", "SSR", "CF", "REQUEST",
];

pub fn extract_configured_bindings(config: &WranglerConfig) -> BTreeSet<String> {
    let mut set = BTreeSet::new();

    for key in config.vars.keys() {
        set.insert(key.clone());
    }
    for db in config.d1() {
        if !db.binding.is_empty() {
            set.insert(db.binding.clone());
        }
    }
    for kv in config.kv() {
        if !kv.binding.is_empty() {
            set.insert(kv.binding.clone());
        }
    }
    for r2 in config.r2() {
        if !r2.binding.is_empty() {
            set.insert(r2.binding.clone());
        }
    }
    if let Some(ref do_obj) = config.durable_objects {
        for b in &do_obj.bindings {
            if !b.binding.is_empty() {
                set.insert(b.binding.clone());
            }
        }
    }

    set
}

pub fn scan_codebase_bindings(src_dir: &Path) -> BTreeSet<String> {
    let mut bindings = BTreeSet::new();
    if !src_dir.exists() {
        return bindings;
    }

    // Match env.BINDING, c.env.BINDING, env['BINDING'], c.env['BINDING']
    let dot_re = Regex::new(r"(?:c\.)?env\.([A-Za-z_][A-Za-z0-9_]*)").unwrap();
    let bracket_re = Regex::new(r#"(?:c\.)?env\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]"#).unwrap();

    let mut stack = vec![src_dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        if current.is_file() {
            if let Some(ext) = current.extension().and_then(|s| s.to_str()) {
                if matches!(ext, "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs") {
                    if let Ok(content) = fs::read_to_string(&current) {
                        for cap in dot_re.captures_iter(&content) {
                            if let Some(m) = cap.get(1) {
                                let name = m.as_str();
                                if !RESERVED_KEYS.contains(&name) {
                                    bindings.insert(name.to_string());
                                }
                            }
                        }
                        for cap in bracket_re.captures_iter(&content) {
                            if let Some(m) = cap.get(1) {
                                let name = m.as_str();
                                if !RESERVED_KEYS.contains(&name) {
                                    bindings.insert(name.to_string());
                                }
                            }
                        }
                    }
                }
            }
        } else if current.is_dir() {
            if let Ok(entries) = fs::read_dir(&current) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if !name_str.starts_with('.') && name_str != "node_modules" && name_str != "dist" {
                        stack.push(path);
                    }
                }
            }
        }
    }

    bindings
}

pub fn check_codebase_bindings(
    config_path: &Path,
    src_dir: &Path,
    env_name: Option<&str>,
) -> CodeBindingsReport {
    let mut issues = Vec::new();

    if !config_path.exists() {
        issues.push(BindingIssue {
            severity: Severity::Error,
            binding: String::new(),
            message: format!("Config file not found: {}", config_path.display()),
        });
        return CodeBindingsReport {
            config_path: config_path.to_path_buf(),
            src_dir: src_dir.to_path_buf(),
            ok: false,
            referenced_bindings: vec![],
            configured_bindings: vec![],
            missing_bindings: vec![],
            unused_bindings: vec![],
            issues,
        };
    }

    let raw_config = match load_config(config_path) {
        Ok(cfg) => cfg,
        Err(err) => {
            issues.push(BindingIssue {
                severity: Severity::Error,
                binding: String::new(),
                message: format!("Could not parse config: {err}"),
            });
            return CodeBindingsReport {
                config_path: config_path.to_path_buf(),
                src_dir: src_dir.to_path_buf(),
                ok: false,
                referenced_bindings: vec![],
                configured_bindings: vec![],
                missing_bindings: vec![],
                unused_bindings: vec![],
                issues,
            };
        }
    };

    let config = match raw_config.for_env(env_name) {
        Ok(cfg) => cfg,
        Err(err) => {
            issues.push(BindingIssue {
                severity: Severity::Error,
                binding: String::new(),
                message: err,
            });
            return CodeBindingsReport {
                config_path: config_path.to_path_buf(),
                src_dir: src_dir.to_path_buf(),
                ok: false,
                referenced_bindings: vec![],
                configured_bindings: vec![],
                missing_bindings: vec![],
                unused_bindings: vec![],
                issues,
            };
        }
    };

    let configured_set = extract_configured_bindings(&config);
    let referenced_set = scan_codebase_bindings(src_dir);

    let mut missing = Vec::new();
    let mut unused = Vec::new();

    for ref_name in &referenced_set {
        if !configured_set.contains(ref_name) {
            missing.push(ref_name.clone());
            issues.push(BindingIssue {
                severity: Severity::Error,
                binding: ref_name.clone(),
                message: format!(
                    "Binding '{ref_name}' is referenced in codebase ({}) but not configured in {}",
                    src_dir.display(),
                    config_path.display()
                ),
            });
        }
    }

    for cfg_name in &configured_set {
        if !referenced_set.contains(cfg_name) {
            unused.push(cfg_name.clone());
            issues.push(BindingIssue {
                severity: Severity::Warning,
                binding: cfg_name.clone(),
                message: format!(
                    "Binding '{cfg_name}' is configured in {} but not referenced in codebase ({})",
                    config_path.display(),
                    src_dir.display()
                ),
            });
        }
    }

    let ok = missing.is_empty();

    CodeBindingsReport {
        config_path: config_path.to_path_buf(),
        src_dir: src_dir.to_path_buf(),
        ok,
        referenced_bindings: referenced_set.into_iter().collect(),
        configured_bindings: configured_set.into_iter().collect(),
        missing_bindings: missing,
        unused_bindings: unused,
        issues,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;
    use std::fs;

    #[test]
    fn scans_ts_files_for_env_references() {
        let dir = TempDir::new("scans-ts-bindings");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();


        fs::write(
            src.join("index.ts"),
            r#"
            export default {
              async fetch(req, env) {
                const db = env.DB;
                const kv = c.env.MY_KV;
                const r2 = env['STORAGE_R2'];
                const reserved = env.NODE_ENV;
                return new Response("ok");
              }
            }
            "#,
        )
        .unwrap();

        let found = scan_codebase_bindings(&src);
        assert!(found.contains("DB"));
        assert!(found.contains("MY_KV"));
        assert!(found.contains("STORAGE_R2"));
        assert!(!found.contains("NODE_ENV"));
    }

    #[test]
    fn detects_missing_and_unused_bindings() {
        let dir = TempDir::new("detects-missing-bindings");
        let config_file = dir.path().join("wrangler.toml");

        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();

        fs::write(
            &config_file,
            r#"
            name = "my-worker"
            compatibility_date = "2024-01-01"

            [[d1_databases]]
            binding = "DB"
            database_name = "prod-db"
            database_id = "123"

            [[kv_namespaces]]
            binding = "OLD_CACHE"
            id = "456"
            "#,
        )
        .unwrap();

        fs::write(
            src.join("index.ts"),
            r#"
            export default {
              async fetch(req, env) {
                return env.DB.prepare("SELECT 1").all() && env.NEW_KV.get("key");
              }
            }
            "#,
        )
        .unwrap();

        let report = check_codebase_bindings(&config_file, &src, None);
        assert!(!report.ok);
        assert_eq!(report.missing_bindings, vec!["NEW_KV"]);
        assert_eq!(report.unused_bindings, vec!["OLD_CACHE"]);
        assert_eq!(report.referenced_bindings, vec!["DB", "NEW_KV"]);
    }

    #[test]
    fn scans_nested_directories_and_multiple_extensions() {
        let dir = TempDir::new("scans-nested-ts");
        let src = dir.path().join("src");
        let sub = src.join("routes").join("api");
        fs::create_dir_all(&sub).unwrap();

        fs::write(src.join("helper.jsx"), "const x = env.HELPER_KV;").unwrap();
        fs::write(sub.join("user.tsx"), "const db = c.env.USERS_DB;").unwrap();
        fs::write(sub.join("utils.mjs"), "const r2 = env['ASSETS_R2'];").unwrap();

        let found = scan_codebase_bindings(&src);
        assert_eq!(found.into_iter().collect::<Vec<_>>(), vec!["ASSETS_R2", "HELPER_KV", "USERS_DB"]);
    }

    #[test]
    fn handles_environment_specific_bindings() {
        let dir = TempDir::new("env-bindings");
        let config_file = dir.path().join("wrangler.toml");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).unwrap();

        fs::write(
            &config_file,
            r#"
            name = "my-worker"
            compatibility_date = "2024-01-01"

            [env.staging]
            [[d1_databases]]
            binding = "STAGING_DB"
            database_name = "stage"
            database_id = "789"
            "#,
        )
        .unwrap();

        fs::write(src.join("index.ts"), "const db = env.STAGING_DB;").unwrap();

        let report = check_codebase_bindings(&config_file, &src, Some("staging"));
        assert!(report.ok);
        assert_eq!(report.missing_bindings, Vec::<String>::new());
    }

    #[test]
    fn handles_nonexistent_src_dir_gracefully() {
        let dir = TempDir::new("no-src");
        let config_file = dir.path().join("wrangler.toml");
        let src = dir.path().join("does_not_exist");
        fs::write(&config_file, "name = 'test'\ncompatibility_date = '2024-01-01'").unwrap();

        let report = check_codebase_bindings(&config_file, &src, None);
        assert!(report.ok);
        assert!(report.referenced_bindings.is_empty());
    }
}

