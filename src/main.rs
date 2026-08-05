use std::env;
use std::path::{Path, PathBuf};
use std::process;

use vite_plus_wrangler::account::check_account;
use vite_plus_wrangler::bundle::{check_bundle_size, Severity as BundleSeverity};
use vite_plus_wrangler::config::{load_config, WranglerConfig};
use vite_plus_wrangler::discovery::discover;
use vite_plus_wrangler::lint::{lint_config, Severity as LintSeverity};
use vite_plus_wrangler::migrations::{inspect, Severity};
use vite_plus_wrangler::secrets::{inspect_secrets, Severity as SecretSeverity};

const HELP: &str = "\
wrangler-rs - Cloudflare config engine for vite-plus-wrangler

Usage:
  wrangler-rs discover [root] [--depth <n>] [--json]
  wrangler-rs config <path> [--env <name>] [--json]
  wrangler-rs account-check <path> [--env <name>] [--expect <id>] [--json]
  wrangler-rs migrations <dir> [--json]
  wrangler-rs secrets-check [path] [--json]
  wrangler-rs lint <path> [--json]
  wrangler-rs bundle-check <path> [--limit-mb <n>] [--json]

Options:
  --env <name>     Wrangler environment to resolve before reporting
  --expect <id>    Override the expected account id (defaults to config)
  --depth <n>      Max directory depth for discover (1-64, default 6)
  --limit-mb <n>   Bundle size limit in MB (default 3)
  --json           Emit machine-readable JSON
  -h, --help       Show this message
  -V, --version    Show version
";

const DEFAULT_DEPTH: usize = 6;
const MAX_DEPTH: usize = 64;

#[derive(Debug)]
struct Args {
    command: String,
    positional: Vec<String>,
    env: Option<String>,
    expect: Option<String>,
    depth: usize,
    limit_mb: Option<f64>,
    json: bool,
}

/// Read the value that follows a flag, erroring when it is missing or is
/// itself a flag. Silently defaulting here is how `--env` at the end of a
/// command line ends up checking the wrong environment.
fn take_value(raw: &[String], i: &mut usize, flag: &str) -> Result<String, String> {
    *i += 1;
    match raw.get(*i) {
        Some(v) if !v.starts_with("--") => Ok(v.clone()),
        Some(v) => Err(format!("{flag} expects a value, found '{v}'")),
        None => Err(format!("{flag} expects a value")),
    }
}

fn parse_args(raw: &[String]) -> Result<Args, String> {
    let mut args = Args {
        command: String::new(),
        positional: Vec::new(),
        env: None,
        expect: None,
        depth: DEFAULT_DEPTH,
        limit_mb: None,
        json: false,
    };

    let mut i = 0;
    while i < raw.len() {
        match raw[i].as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                process::exit(0);
            }
            "-V" | "--version" => {
                println!(env!("CARGO_PKG_VERSION"));
                process::exit(0);
            }
            "--json" => args.json = true,
            "--env" => args.env = Some(take_value(raw, &mut i, "--env")?),
            "--expect" => args.expect = Some(take_value(raw, &mut i, "--expect")?),
            "--limit-mb" => {
                let value = take_value(raw, &mut i, "--limit-mb")?;
                let limit: f64 = value
                    .parse()
                    .map_err(|_| format!("--limit-mb expects a number, found '{value}'"))?;
                if limit <= 0.0 {
                    return Err("--limit-mb must be greater than 0".to_string());
                }
                args.limit_mb = Some(limit);
            }
            "--depth" => {
                let value = take_value(raw, &mut i, "--depth")?;
                let depth: usize = value
                    .parse()
                    .map_err(|_| format!("--depth expects a number, found '{value}'"))?;
                if depth == 0 || depth > MAX_DEPTH {
                    // max_depth(0) makes WalkDir visit only the root directory,
                    // so discovery would always come back empty.
                    return Err(format!("--depth must be between 1 and {MAX_DEPTH}"));
                }
                args.depth = depth;
            }
            other if other.starts_with('-') && other != "-" => {
                return Err(format!("unknown option '{other}'"));
            }
            other if args.command.is_empty() => args.command = other.to_string(),
            other => args.positional.push(other.to_string()),
        }
        i += 1;
    }

    Ok(args)
}

fn main() {
    let raw: Vec<String> = env::args().skip(1).collect();

    let args = match parse_args(&raw) {
        Ok(args) => args,
        Err(err) => {
            eprintln!("{err}\n\n{HELP}");
            process::exit(2);
        }
    };

    let code = match args.command.as_str() {
        "discover" => cmd_discover(&args),
        "config" => cmd_config(&args),
        "account-check" => cmd_account_check(&args),
        "migrations" => cmd_migrations(&args),
        "secrets-check" => cmd_secrets_check(&args),
        "lint" => cmd_lint(&args),
        "bundle-check" => cmd_bundle_check(&args),
        "" => {
            println!("{HELP}");
            0
        }
        other => {
            eprintln!("Unknown command '{other}'\n\n{HELP}");
            2
        }
    };

    process::exit(code);
}

/// Load a config and resolve `--env`, reporting either failure the same way.
fn resolve(path: &str, env: Option<&str>) -> Result<WranglerConfig, String> {
    load_config(Path::new(path))?.for_env(env)
}

fn cmd_discover(args: &Args) -> i32 {
    let root = args
        .positional
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let found = discover(&root, args.depth);

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&found).unwrap_or_else(|_| "[]".into())
        );
        return 0;
    }

    if found.is_empty() {
        println!("No wrangler configs found under {}", root.display());
        return 0;
    }

    for entry in &found {
        match &entry.error {
            Some(err) => println!("  ✗ {}  {err}", entry.relative_path.display()),
            None => println!(
                "  • {}  name={}  envs=[{}]",
                entry.relative_path.display(),
                entry.worker_name.as_deref().unwrap_or("<unnamed>"),
                entry.environments.join(", ")
            ),
        }
        for shadowed in &entry.shadowed {
            println!(
                "      ! also present, ignored: {}",
                shadowed.file_name().unwrap_or_default().to_string_lossy()
            );
        }
    }
    println!("\n{} config(s)", found.len());
    0
}

fn cmd_config(args: &Args) -> i32 {
    let Some(path) = args.positional.first() else {
        eprintln!("config: missing <path>");
        return 2;
    };

    match resolve(path, args.env.as_deref()) {
        Ok(resolved) => {
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&resolved).unwrap_or_else(|_| "{}".into())
                );
            } else {
                println!("name:    {}", resolved.name.as_deref().unwrap_or("-"));
                println!("account: {}", resolved.account_id.as_deref().unwrap_or("-"));
                println!(
                    "compat:  {}",
                    resolved.compatibility_date.as_deref().unwrap_or("-")
                );
                println!("d1:      {}", resolved.d1().len());
                println!("kv:      {}", resolved.kv().len());
                println!("r2:      {}", resolved.r2().len());
            }
            0
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

fn cmd_account_check(args: &Args) -> i32 {
    let Some(path) = args.positional.first() else {
        eprintln!("account-check: missing <path>");
        return 2;
    };

    let cfg = match resolve(path, args.env.as_deref()) {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("{err}");
            return 1;
        }
    };

    let expected = args.expect.clone().or(cfg.account_id.clone());
    let actual = env::var("CLOUDFLARE_ACCOUNT_ID").ok();
    let result = check_account(expected.as_deref(), actual.as_deref());

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".into())
        );
    } else if result.ok {
        println!("✓ {}", result.message);
    } else {
        eprintln!("✗ {}", result.message);
    }

    i32::from(!result.ok)
}

fn cmd_migrations(args: &Args) -> i32 {
    let dir = args
        .positional
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("migrations"));

    let report = inspect(&dir);

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into())
        );
        return i32::from(!report.ok);
    }

    println!("{} migration(s) in {}", report.count, report.dir.display());
    for issue in &report.issues {
        let marker = match issue.severity {
            Severity::Error => "✗",
            Severity::Warning => "!",
        };
        println!("  {marker} {}", issue.message);
    }
    if report.ok && report.issues.is_empty() {
        println!("  ✓ prefixes are consistent and sequential");
    }

    i32::from(!report.ok)
}

fn cmd_secrets_check(args: &Args) -> i32 {
    let path = args
        .positional
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("wrangler.toml"));

    let report = inspect_secrets(&path, None);

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into())
        );
        return i32::from(!report.ok);
    }

    if report.exists {
        println!("✓ Found {} secret(s) in {}", report.count, report.path.display());
    } else {
        println!("! No .dev.vars file found at {}", report.path.display());
    }

    for issue in &report.issues {
        let marker = match issue.severity {
            SecretSeverity::Error => "✗",
            SecretSeverity::Warning => "!",
        };
        println!("  {marker} {}", issue.message);
    }

    i32::from(!report.ok)
}

fn cmd_lint(args: &Args) -> i32 {
    let path = args
        .positional
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("wrangler.toml"));

    let report = lint_config(&path);

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into())
        );
        return i32::from(!report.ok);
    }

    println!("Linting {}", report.path.display());
    for issue in &report.issues {
        let marker = match issue.severity {
            LintSeverity::Error => "✗",
            LintSeverity::Warning => "!",
        };
        println!("  {marker} {}", issue.message);
    }
    if report.ok && report.issues.is_empty() {
        println!("  ✓ No issues found");
    }

    i32::from(!report.ok)
}

fn cmd_bundle_check(args: &Args) -> i32 {
    let path = args
        .positional
        .first()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("dist"));

    let report = check_bundle_size(&path, args.limit_mb);

    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".into())
        );
        return i32::from(!report.ok);
    }

    if report.exists {
        println!(
            "Bundle size: {:.2} MB / {:.2} MB ({})",
            report.total_mb,
            report.limit_mb,
            report.path.display()
        );
        for file in &report.files {
            println!("  • {} ({:.2} MB)", file.path.display(), file.size_mb);
        }
    } else {
        println!("✗ Bundle path not found: {}", report.path.display());
    }

    for issue in &report.issues {
        let marker = match issue.severity {
            BundleSeverity::Error => "✗",
            BundleSeverity::Warning => "!",
        };
        println!("  {marker} {}", issue.message);
    }

    if report.ok && report.issues.is_empty() {
        println!("  ✓ Bundle size is within limit");
    }

    i32::from(!report.ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_a_normal_invocation() {
        let a = parse_args(&args(&[
            "config",
            "wrangler.toml",
            "--env",
            "dev",
            "--json",
        ]))
        .unwrap();
        assert_eq!(a.command, "config");
        assert_eq!(a.positional, vec!["wrangler.toml"]);
        assert_eq!(a.env.as_deref(), Some("dev"));
        assert!(a.json);
    }

    #[test]
    fn trailing_flag_without_value_is_an_error() {
        let err = parse_args(&args(&["config", "wrangler.toml", "--env"])).unwrap_err();
        assert!(err.contains("--env expects a value"));
    }

    #[test]
    fn flag_value_that_is_a_flag_is_an_error() {
        let err = parse_args(&args(&["config", "x", "--env", "--json"])).unwrap_err();
        assert!(err.contains("--env expects a value"));
    }

    #[test]
    fn non_numeric_depth_is_an_error() {
        let err = parse_args(&args(&["discover", ".", "--depth", "abc"])).unwrap_err();
        assert!(err.contains("--depth expects a number"));
    }

    #[test]
    fn zero_depth_is_rejected() {
        let err = parse_args(&args(&["discover", ".", "--depth", "0"])).unwrap_err();
        assert!(err.contains("between 1 and"));
    }

    #[test]
    fn unknown_option_is_an_error() {
        let err = parse_args(&args(&["discover", "--recursive"])).unwrap_err();
        assert!(err.contains("unknown option '--recursive'"));
    }

    #[test]
    fn depth_defaults_when_absent() {
        let a = parse_args(&args(&["discover"])).unwrap();
        assert_eq!(a.depth, DEFAULT_DEPTH);
    }

    #[test]
    fn parses_limit_mb_flag() {
        let a = parse_args(&args(&["bundle-check", "dist", "--limit-mb", "10"])).unwrap();
        assert_eq!(a.command, "bundle-check");
        assert_eq!(a.positional, vec!["dist"]);
        assert_eq!(a.limit_mb, Some(10.0));
    }
}
