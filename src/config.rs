//! Parsing for `wrangler.toml`, `wrangler.json`, and `wrangler.jsonc`.

use serde::{Deserialize, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// Serialize `Option<Vec<T>>` as `[]` rather than `null`.
///
/// The `Option` exists so we can tell "the environment omitted this key" from
/// "the environment explicitly set it to empty" (see [`WranglerConfig::for_env`]),
/// but consumers of the JSON should always see an array.
fn ser_vec<S, T>(value: &Option<Vec<T>>, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
    T: Serialize,
{
    value.as_deref().unwrap_or(&[]).serialize(serializer)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct D1Binding {
    #[serde(default)]
    pub binding: String,
    #[serde(default)]
    pub database_name: String,
    #[serde(default)]
    pub database_id: String,
    #[serde(default)]
    pub migrations_dir: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NamedBinding {
    #[serde(default)]
    pub binding: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub bucket_name: Option<String>,
    #[serde(default)]
    pub queue: Option<String>,
    #[serde(default)]
    pub class_name: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DurableObjects {
    #[serde(default)]
    pub bindings: Vec<NamedBinding>,
}

/// A single Wrangler configuration, which may itself contain named
/// environments under `[env.*]`.
///
/// List-valued fields are `Option<Vec<_>>` on purpose: an environment that
/// writes `d1_databases = []` is saying "this environment has no databases",
/// which is different from omitting the key and inheriting the parent's.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WranglerConfig {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub main: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub compatibility_date: Option<String>,
    #[serde(default, serialize_with = "ser_vec")]
    pub compatibility_flags: Option<Vec<String>>,
    #[serde(default)]
    pub workers_dev: Option<bool>,
    #[serde(default)]
    pub vars: BTreeMap<String, serde_json::Value>,
    #[serde(default, serialize_with = "ser_vec")]
    pub d1_databases: Option<Vec<D1Binding>>,
    #[serde(default, serialize_with = "ser_vec")]
    pub kv_namespaces: Option<Vec<NamedBinding>>,
    #[serde(default, serialize_with = "ser_vec")]
    pub r2_buckets: Option<Vec<NamedBinding>>,
    #[serde(default)]
    pub durable_objects: Option<DurableObjects>,
    #[serde(default)]
    pub env: BTreeMap<String, Box<WranglerConfig>>,
}

impl WranglerConfig {
    /// D1 bindings, treating an omitted key as empty.
    pub fn d1(&self) -> &[D1Binding] {
        self.d1_databases.as_deref().unwrap_or_default()
    }

    /// KV bindings, treating an omitted key as empty.
    pub fn kv(&self) -> &[NamedBinding] {
        self.kv_namespaces.as_deref().unwrap_or_default()
    }

    /// R2 bindings, treating an omitted key as empty.
    pub fn r2(&self) -> &[NamedBinding] {
        self.r2_buckets.as_deref().unwrap_or_default()
    }

    /// Compatibility flags, treating an omitted key as empty.
    pub fn flags(&self) -> &[String] {
        self.compatibility_flags.as_deref().unwrap_or_default()
    }

    /// Resolve a named environment, layering it over the top-level config.
    ///
    /// Wrangler does not deep-merge every key, but the fields we care about
    /// (account, bindings, name) do inherit when the environment omits them.
    ///
    /// An unknown environment name is an error rather than a silent fallback to
    /// the top-level config. Falling back would let `--env producton` report a
    /// successful account check against the *default* environment, which is the
    /// exact class of mistake this crate exists to prevent.
    pub fn for_env(&self, env: Option<&str>) -> Result<WranglerConfig, String> {
        let Some(env_name) = env else {
            return Ok(self.clone());
        };

        let Some(child) = self.env.get(env_name) else {
            let known = self.env_names().join(", ");
            return Err(format!(
                "unknown environment '{env_name}'. Declared environments: {known}"
            ));
        };

        let mut merged = (**child).clone();
        if merged.name.is_none() {
            merged.name = self.name.clone();
        }
        if merged.main.is_none() {
            merged.main = self.main.clone();
        }
        if merged.account_id.is_none() {
            merged.account_id = self.account_id.clone();
        }
        if merged.compatibility_date.is_none() {
            merged.compatibility_date = self.compatibility_date.clone();
        }
        if merged.workers_dev.is_none() {
            merged.workers_dev = self.workers_dev;
        }
        if merged.compatibility_flags.is_none() {
            merged.compatibility_flags = self.compatibility_flags.clone();
        }
        if merged.d1_databases.is_none() {
            merged.d1_databases = self.d1_databases.clone();
        }
        if merged.kv_namespaces.is_none() {
            merged.kv_namespaces = self.kv_namespaces.clone();
        }
        if merged.r2_buckets.is_none() {
            merged.r2_buckets = self.r2_buckets.clone();
        }
        if merged.durable_objects.is_none() {
            merged.durable_objects = self.durable_objects.clone();
        }
        merged.env = BTreeMap::new();
        Ok(merged)
    }

    /// Every environment name declared in the file, including the implicit
    /// top-level ("default") environment.
    pub fn env_names(&self) -> Vec<String> {
        let mut names = vec!["default".to_string()];
        names.extend(self.env.keys().cloned());
        names
    }
}

/// Strip `//` and `/* */` comments plus trailing commas from JSONC source.
///
/// String literals and escapes are respected, so a `//` inside a URL survives.
pub fn strip_jsonc(input: &str) -> String {
    let bytes: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    while i < bytes.len() {
        let c = bytes[i];

        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }

        if c == '/' && i + 1 < bytes.len() && bytes[i + 1] == '/' {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }

        if c == '/' && i + 1 < bytes.len() && bytes[i + 1] == '*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            continue;
        }

        out.push(c);
        i += 1;
    }

    strip_trailing_commas(&out)
}

fn strip_trailing_commas(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escaped = false;

    for (i, &c) in chars.iter().enumerate() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            continue;
        }
        if c == ',' {
            let next = chars[i + 1..].iter().find(|ch| !ch.is_whitespace());
            if matches!(next, Some('}') | Some(']')) {
                continue;
            }
        }
        out.push(c);
    }

    out
}

/// Load and parse a Wrangler config from disk, choosing the parser by extension.
pub fn load_config(path: &Path) -> Result<WranglerConfig, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_config(&raw, path)
}

pub fn parse_config(raw: &str, path: &Path) -> Result<WranglerConfig, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match ext.as_str() {
        "toml" => toml::from_str::<WranglerConfig>(raw)
            .map_err(|e| format!("{}: invalid TOML: {e}", path.display())),
        "json" | "jsonc" => serde_json::from_str::<WranglerConfig>(&strip_jsonc(raw))
            .map_err(|e| format!("{}: invalid JSON: {e}", path.display())),
        other => Err(format!(
            "{}: unsupported wrangler config extension '{other}'",
            path.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn toml_cfg(src: &str) -> WranglerConfig {
        parse_config(src, &PathBuf::from("wrangler.toml")).unwrap()
    }

    #[test]
    fn strips_comments_but_not_urls() {
        let src = r#"{
            // a line comment
            "name": "api", /* block */
            "url": "https://example.com/x",
        }"#;
        let cleaned = strip_jsonc(src);
        assert!(cleaned.contains("https://example.com/x"));
        assert!(!cleaned.contains("line comment"));
        let parsed: serde_json::Value = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(parsed["name"], "api");
    }

    #[test]
    fn strips_double_slash_inside_string_is_preserved() {
        let cleaned = strip_jsonc(r#"{"a":"x//y","b":"p/*q*/r"}"#);
        let parsed: serde_json::Value = serde_json::from_str(&cleaned).unwrap();
        assert_eq!(parsed["a"], "x//y");
        assert_eq!(parsed["b"], "p/*q*/r");
    }

    #[test]
    fn unterminated_block_comment_does_not_panic() {
        let cleaned = strip_jsonc("{\"a\":1} /* dangling");
        assert!(cleaned.contains("\"a\""));
    }

    #[test]
    fn env_inherits_account_id() {
        let cfg = toml_cfg(
            r#"
            name = "api"
            account_id = "abc123"
            [env.dev]
            name = "api-dev"
        "#,
        );
        let dev = cfg.for_env(Some("dev")).unwrap();
        assert_eq!(dev.name.as_deref(), Some("api-dev"));
        assert_eq!(dev.account_id.as_deref(), Some("abc123"));
    }

    #[test]
    fn unknown_env_is_an_error() {
        let cfg = toml_cfg(
            r#"
            name = "api"
            account_id = "abc123"
            [env.dev]
            name = "api-dev"
        "#,
        );
        let err = cfg.for_env(Some("producton")).unwrap_err();
        assert!(err.contains("unknown environment 'producton'"));
        assert!(err.contains("dev"));
    }

    #[test]
    fn omitted_bindings_inherit_but_explicit_empty_does_not() {
        let cfg = toml_cfg(
            r#"
            name = "api"
            [[d1_databases]]
            binding = "DB"
            database_name = "prod"
            database_id = "x"

            [env.inherits]
            name = "a"

            [env.opts_out]
            name = "b"
            d1_databases = []
        "#,
        );

        assert_eq!(cfg.for_env(Some("inherits")).unwrap().d1().len(), 1);
        assert_eq!(cfg.for_env(Some("opts_out")).unwrap().d1().len(), 0);
    }

    #[test]
    fn empty_lists_serialize_as_arrays_not_null() {
        let cfg = toml_cfg(r#"name = "api""#);
        let json = serde_json::to_value(cfg.for_env(None).unwrap()).unwrap();
        assert_eq!(json["d1_databases"], serde_json::json!([]));
        assert_eq!(json["compatibility_flags"], serde_json::json!([]));
    }

    #[test]
    fn env_names_include_default() {
        let cfg = toml_cfg(
            r#"
            name = "api"
            [env.dev]
            [env.staging]
        "#,
        );
        assert_eq!(cfg.env_names(), vec!["default", "dev", "staging"]);
    }
}
