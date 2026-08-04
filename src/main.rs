use std::env;
use std::path::{Path, PathBuf};
use std::process;

use vite_plus_wrangler::account::check_account;
use vite_plus_wrangler::config::load_config;
use vite_plus_wrangler::discovery::discover;
use vite_plus_wrangler::migrations::{inspect, Severity};

const HELP: &str = "\
wrangler-rs - Cloudflare config engine for vite-plus-wrangler

Usage:
  wrangler-rs discover [root] [--depth <n>] [--json]
  wrangler-rs config <path> [--env <name>] [--json]
  wrangler-rs account-check <path> [--env <name>] [--expect <id>] [--json]
  wrangler-rs migrations <dir> [--json]

Options:
  --env <name>     Wrangler environment to resolve before reporting
  --expect <id>    Override the expected account id (defaults to config)
  --depth <n>      Max directory depth for discover (default 6)
  --json           Emit machine-readable JSON
  -h, --help       Show this message
  -V, --version    Show version
";

struct Args {
    command: String,
    positional: Vec<String>,
    env: Option<String>,
    expect: Option<String>,
    depth: usize,
    json: bool,
}

fn parse_args() -> Args {
    let raw: Vec<String> = env::args().skip(1).collect();
    let mut args = Args {
        command: String::new(),
        positional: Vec::new(),
        env: None,
        expect: None,
        depth: 6,
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
            "--env" => {
                i += 1;
                args.env = raw.get(i).cloned();
            }
            "--expect" => {
                i += 1;
                args.expect = raw.get(i).cloned();
            }
            "--depth" => {
                i += 1;
                args.depth = raw.get(i).and_then(|v| v.parse().ok()).unwrap_or(6);
            }
            other if args.command.is_empty() => args.command = other.to_string(),
            other => args.positional.push(other.to_string()),
        }
        i += 1;
    }

    args
}

fn main() {
    let args = parse_args();

    let code = match args.command.as_str() {
        "discover" => cmd_discover(&args),
        "config" => cmd_config(&args),
        "account-check" => cmd_account_check(&args),
        "migrations" => cmd_migrations(&args),
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
    }
    println!("\n{} config(s)", found.len());
    0
}

fn cmd_config(args: &Args) -> i32 {
    let Some(path) = args.positional.first() else {
        eprintln!("config: missing <path>");
        return 2;
    };

    match load_config(Path::new(path)) {
        Ok(cfg) => {
            let resolved = cfg.for_env(args.env.as_deref());
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
                println!("d1:      {}", resolved.d1_databases.len());
                println!("kv:      {}", resolved.kv_namespaces.len());
                println!("r2:      {}", resolved.r2_buckets.len());
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

    let cfg = match load_config(Path::new(path)) {
        Ok(cfg) => cfg.for_env(args.env.as_deref()),
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
