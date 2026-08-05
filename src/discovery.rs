//! Finds every Wrangler config in a repository, monorepo or not.

use crate::config::{load_config, WranglerConfig};
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Config filenames in precedence order. When a directory holds more than one,
/// the earliest entry wins and the rest are reported as `shadowed` — silently
/// emitting two entries for one Worker leads to duplicate, conflicting tasks.
const CONFIG_NAMES: [&str; 3] = ["wrangler.toml", "wrangler.jsonc", "wrangler.json"];

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
    /// Sibling config files in the same directory that this one takes
    /// precedence over. Non-empty means the project is ambiguous.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shadowed: Vec<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip)]
    pub config: Option<WranglerConfig>,
}

fn precedence(name: &str) -> Option<usize> {
    CONFIG_NAMES.iter().position(|c| *c == name)
}

/// Walk `root` and parse every Wrangler config found.
///
/// Parse failures are recorded on the entry rather than aborting the scan:
/// one malformed config in a 14-project monorepo should not blind the rest.
pub fn discover(root: &Path, max_depth: usize) -> Vec<DiscoveredConfig> {
    if !root.exists() {
        return vec![DiscoveredConfig {
            path: root.to_path_buf(),
            relative_path: root.to_path_buf(),
            worker_name: None,
            account_id: None,
            environments: Vec::new(),
            d1_bindings: Vec::new(),
            shadowed: Vec::new(),
            error: Some(format!("{}: No such file or directory", root.display())),
            config: None,
        }];
    }

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

    // Group candidates by parent directory so precedence can be applied.
    let mut by_dir: Vec<(PathBuf, Vec<(usize, PathBuf)>)> = Vec::new();

    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rank) = precedence(&name) else {
            continue;
        };

        let path = entry.path().to_path_buf();
        let parent = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));

        match by_dir.iter_mut().find(|(d, _)| *d == parent) {
            Some((_, files)) => files.push((rank, path)),
            None => by_dir.push((parent, vec![(rank, path)])),
        }
    }

    let mut found = Vec::new();

    for (_, mut candidates) in by_dir {
        candidates.sort_by_key(|(rank, _)| *rank);
        let (_, winner) = candidates.remove(0);
        let shadowed: Vec<PathBuf> = candidates.into_iter().map(|(_, p)| p).collect();

        let relative_path = winner
            .strip_prefix(root)
            .map(Path::to_path_buf)
            .unwrap_or_else(|_| winner.clone());

        match load_config(&winner) {
            Ok(cfg) => found.push(DiscoveredConfig {
                path: winner.clone(),
                relative_path,
                worker_name: cfg.name.clone(),
                account_id: cfg.account_id.clone(),
                environments: cfg.env_names(),
                d1_bindings: cfg.d1().iter().map(|d| d.binding.clone()).collect(),
                shadowed,
                error: None,
                config: Some(cfg),
            }),
            Err(err) => found.push(DiscoveredConfig {
                path: winner,
                relative_path,
                worker_name: None,
                account_id: None,
                environments: Vec::new(),
                d1_bindings: Vec::new(),
                shadowed,
                error: Some(err),
                config: None,
            }),
        }
    }

    found.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::TempDir;

    fn fixture() -> TempDir {
        TempDir::new("disc")
    }

    #[test]
    fn finds_nested_configs_and_skips_ignored_dirs() {
        let d = fixture();
        d.write("wrangler.toml", "name = \"root\"\n");
        d.write("workers/api/wrangler.toml", "name = \"api\"\n");
        d.write("node_modules/pkg/wrangler.toml", "name = \"nope\"\n");
        d.write("target/wrangler.toml", "name = \"nope2\"\n");

        let found = discover(d.path(), 6);
        // Results are sorted by relative path, so assert on the set.
        let mut names: Vec<_> = found.iter().filter_map(|f| f.worker_name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["api", "root"]);
    }

    #[test]
    fn toml_wins_over_json_and_records_shadowed() {
        let d = fixture();
        d.write("wrangler.toml", "name = \"from-toml\"\n");
        d.write("wrangler.json", "{\"name\":\"from-json\"}");

        let found = discover(d.path(), 6);
        assert_eq!(found.len(), 1, "one directory must yield one config");
        assert_eq!(found[0].worker_name.as_deref(), Some("from-toml"));
        assert_eq!(found[0].shadowed.len(), 1);
    }

    #[test]
    fn parse_failure_is_recorded_not_fatal() {
        let d = fixture();
        d.write("wrangler.toml", "this is not = = toml");
        d.write("workers/ok/wrangler.toml", "name = \"ok\"\n");

        let found = discover(d.path(), 6);
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|f| f.error.is_some()));
        assert!(found.iter().any(|f| f.worker_name.as_deref() == Some("ok")));
    }

    #[test]
    fn depth_limits_the_walk() {
        let d = fixture();
        d.write("a/b/c/wrangler.toml", "name = \"deep\"\n");
        assert!(discover(d.path(), 2).is_empty());
        assert_eq!(discover(d.path(), 6).len(), 1);
    }

    #[test]
    fn d1_bindings_are_collected() {
        let d = fixture();
        d.write(
            "wrangler.toml",
            "name = \"api\"\n[[d1_databases]]\nbinding = \"DB\"\n",
        );
        let found = discover(d.path(), 6);
        assert_eq!(found[0].d1_bindings, vec!["DB"]);
    }

    #[test]
    fn nonexistent_root_returns_error_entry() {
        let found = discover(Path::new("/definitely/nonexistent/path"), 6);
        assert_eq!(found.len(), 1);
        assert!(found[0].error.is_some());
        assert!(found[0]
            .error
            .as_ref()
            .unwrap()
            .contains("No such file or directory"));
    }
}
