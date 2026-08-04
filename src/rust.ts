import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type {
  AccountCheck,
  DiscoveredConfig,
  MigrationReport,
  WranglerConfig,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the compiled engine. Mirrors the resolution order used by
 * vite-plus-commitlint so both plugins behave the same in a monorepo.
 */
export function getBinaryPath(): string {
  if (process.env.WRANGLER_RS_BIN && fs.existsSync(process.env.WRANGLER_RS_BIN)) {
    return process.env.WRANGLER_RS_BIN;
  }

  const exeName = process.platform === "win32" ? "wrangler-rs.exe" : "wrangler-rs";
  const candidates = [
    path.resolve(__dirname, "./bin", exeName),
    path.resolve(__dirname, "../dist/bin", exeName),
    path.resolve(__dirname, "../target/release", exeName),
    path.resolve(__dirname, "../target/debug", exeName),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (process.platform !== "win32") {
      try {
        const { mode } = fs.statSync(candidate);
        if ((mode & 0o111) === 0) fs.chmodSync(candidate, 0o755);
      } catch {
        // Read-only filesystem — the binary is probably already executable.
      }
    }
    return candidate;
  }

  return exeName;
}

function runJson<T>(args: string[], fallback: T): T {
  const res = spawnSync(getBinaryPath(), [...args, "--json"], { encoding: "utf-8" });
  if (res.stdout) {
    try {
      return JSON.parse(res.stdout.trim()) as T;
    } catch {
      // Fall through to the caller's default.
    }
  }
  return fallback;
}

/** Every wrangler config under `root`, parsed. */
export function discoverConfigs(root: string = process.cwd(), depth = 6): DiscoveredConfig[] {
  return runJson<DiscoveredConfig[]>(["discover", root, "--depth", String(depth)], []);
}

/** Parse one wrangler config, optionally resolving a named environment. */
export function loadConfig(configPath: string, env?: string): WranglerConfig | null {
  const args = ["config", configPath];
  if (env) args.push("--env", env);
  return runJson<WranglerConfig | null>(args, null);
}

/** Compare the config's account against CLOUDFLARE_ACCOUNT_ID. */
export function checkAccount(
  configPath: string,
  options: { env?: string; expect?: string } = {},
): AccountCheck {
  const args = ["account-check", configPath];
  if (options.env) args.push("--env", options.env);
  if (options.expect) args.push("--expect", options.expect);

  return runJson<AccountCheck>(args, {
    status: "unpinned",
    ok: false,
    expected: options.expect ?? null,
    actual: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
    message: "Account check could not run — is the wrangler-rs binary built?",
  });
}

/** Inspect a D1 migrations directory for ordering hazards. */
export function checkMigrations(dir = "migrations"): MigrationReport {
  return runJson<MigrationReport>(["migrations", dir], {
    dir,
    count: 0,
    ok: false,
    migrations: [],
    issues: [
      {
        severity: "error",
        message: "Migration check could not run — is the wrangler-rs binary built?",
      },
    ],
  });
}

/** Passthrough for the CLI entrypoint. */
export function runWranglerRsCli(args: string[] = process.argv.slice(2)): number {
  const res = spawnSync(getBinaryPath(), args, { stdio: "inherit" });
  return res.status ?? 0;
}
