//! Finds every Wrangler config in a repository, monorepo or not.

use crate::config::{load_config, WranglerConfig};
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const CONFIG_NAMES: [&str; 3] = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];
const SKIP_DIRS: [&str; 7] = [
    "node_modules",
    "dist",
    "build",
    "target",
    ".wrangler",
    ".git",
    "coverage",
];

#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredConfig {
    pub path: PathBuf,
    /// Path relative to the scan root — what you want in task names.
    pub relative_path: PathBuf,
    pub worker_name: Option<String>,
    pub account_id: Option<String>,
    pub environments: Vec<String>,
    pub d1_bindings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip)]
    pub config: Option<WranglerConfig>,
}

/// Walk `root` and parse every Wrangler config found.
///
/// Parse failures are recorded on the entry rather than aborting the scan:
/// one malformed config in a 14-project monorepo should not blind the rest.
pub fn discover(root: &Path, max_depth: usize) -> Vec<DiscoveredConfig> {
    let mut found = Vec::new();

    let walker = WalkDir::new(root)
        .max_depth(max_depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                return !SKIP_DIRS.contains(&name.as_ref());
            }
            true
        });

    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !CONFIG_NAMES.contains(&name.as_str()) {
            continue;
        }

        let path = entry.path().to_path_buf();
        let relative_path = path
            .strip_prefix(root)
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| path.clone());

        match load_config(&path) {
            Ok(cfg) => found.push(DiscoveredConfig {
                path: path.clone(),
                relative_path,
                worker_name: cfg.name.clone(),
                account_id: cfg.account_id.clone(),
                environments: cfg.env_names(),
                d1_bindings: cfg.d1_databases.iter().map(|d| d.binding.clone()).collect(),
                error: None,
                config: Some(cfg),
            }),
            Err(err) => found.push(DiscoveredConfig {
                path,
                relative_path,
                worker_name: None,
                account_id: None,
                environments: Vec::new(),
                d1_bindings: Vec::new(),
                error: Some(err),
                config: None,
            }),
        }
    }

    found.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    found
}
