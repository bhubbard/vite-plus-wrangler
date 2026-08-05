import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type {
  AccountCheck,
  BundleSizeReport,
  CodeBindingsReport,
  DiscoveredConfig,
  LintReport,
  MigrationReport,
  SecretsReport,
  WranglerConfig,
} from "./types.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BUILD_HINT =
  "Run `pnpm build` (or `cargo build --release`) to build it, or set WRANGLER_RS_BIN " +
  "to an existing binary.";

/** Thrown when the engine is missing or exits non-zero. */
export class WranglerEngineError extends Error {
  readonly code: number | null;
  readonly stderr: string;

  constructor(message: string, code: number | null = null, stderr = "") {
    super(`[vite-plus-wrangler] ${message}`);
    this.name = "WranglerEngineError";
    this.code = code;
    this.stderr = stderr;
  }
}

let cached: string | null = null;

/**
 * The `@vite-plus-wrangler/*` package holding the prebuilt binary for the
 * current platform. These ship as `optionalDependencies` so npm installs only
 * the one that matches — a single binary copied into the main tarball would
 * work on exactly the platform it was published from.
 */
export function platformPackage(): string | null {
  const key = `${process.platform}-${process.arch}`;
  const known: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
    "win32-x64": "win32-x64",
  };
  const slug = known[key];
  return slug ? `@vite-plus-wrangler/${slug}` : null;
}

function candidatePaths(): string[] {
  const exeName = process.platform === "win32" ? "wrangler-rs.exe" : "wrangler-rs";
  const candidates: string[] = [];

  // Prefer the prebuilt platform package when one is installed.
  const pkg = platformPackage();
  if (pkg) {
    try {
      const require = createRequire(import.meta.url);
      candidates.push(require.resolve(`${pkg}/bin/${exeName}`));
    } catch {
      // Not installed — fall through to the local/dev locations below.
    }
  }

  candidates.push(
    path.resolve(__dirname, "./bin", exeName),
    path.resolve(__dirname, "../dist/bin", exeName),
    path.resolve(__dirname, "../target/release", exeName),
    path.resolve(__dirname, "../target/debug", exeName),
  );

  return candidates;
}

/**
 * Locate the compiled engine. Mirrors the resolution order used by
 * vite-plus-commitlint so both plugins behave the same in a monorepo.
 *
 * Throws rather than falling back to a bare name on `PATH`: an unresolved
 * binary should be a loud, specific error, not an attempt to execute whatever
 * `wrangler-rs` happens to be installed elsewhere on the machine.
 */
export function getBinaryPath(): string {
  if (cached && fs.existsSync(cached)) return cached;

  const override = process.env.WRANGLER_RS_BIN;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new WranglerEngineError(
        `WRANGLER_RS_BIN points at ${override}, which does not exist.`,
      );
    }
    cached = override;
    return override;
  }

  const candidates = candidatePaths();
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    ensureExecutable(candidate);
    // Existence is not enough: a binary built for another architecture exists
    // just fine and fails only at exec time, with an error that reads like the
    // package is broken rather than "wrong platform".
    if (!isRunnable(candidate)) continue;
    cached = candidate;
    return candidate;
  }

  const pkg = platformPackage();
  const platformNote = pkg
    ? `Expected the prebuilt package ${pkg} to be installed.`
    : `No prebuilt binary is published for ${process.platform}-${process.arch}; ` +
      `it must be built from source.`;

  throw new WranglerEngineError(
    `Could not find the wrangler-rs engine. ${platformNote}\nLooked in:\n` +
      candidates.map((c) => `  - ${c}`).join("\n") +
      `\n${BUILD_HINT}`,
  );
}

/**
 * Confirm a candidate binary actually executes on this machine.
 *
 * Cheap: `--version` does no filesystem work. Guards against a binary for the
 * wrong architecture, a corrupt download, and a non-executable stub.
 */
export function isRunnable(file: string): boolean {
  const res = spawnSync(file, ["--version"], { encoding: "utf-8", timeout: 10_000 });
  return !res.error && res.status === 0;
}

function ensureExecutable(file: string): void {
  if (process.platform === "win32") return;
  try {
    const { mode } = fs.statSync(file);
    if ((mode & 0o111) === 0) fs.chmodSync(file, 0o755);
  } catch {
    // Read-only filesystem — the binary is probably already executable.
  }
}

/** Reset the memoized binary path. Exposed for tests. */
export function resetBinaryPathCache(): void {
  cached = null;
}

interface RunResult<T> {
  value: T | null;
  error: WranglerEngineError | null;
}

/**
 * Run the engine and parse its JSON output.
 *
 * Unlike a plain `spawnSync` wrapper this inspects `error`, `signal`, and
 * `status` so that a missing binary, a crash, or a config parse failure
 * cannot masquerade as an empty-but-successful result.
 *
 * Note that a non-zero exit is not automatically a failure: `account-check`
 * and `migrations` both exit 1 to report a *finding* while still writing a
 * valid JSON body. Parseable stdout therefore wins over the exit code.
 */
function run<T>(args: string[]): RunResult<T> {
  let binary: string;
  try {
    binary = getBinaryPath();
  } catch (err) {
    return { value: null, error: err as WranglerEngineError };
  }

  const res = spawnSync(binary, [...args, "--json"], {
    encoding: "utf-8",
    // The default 1MB buffer truncates `discover --json` at roughly 3,300
    // Workers, surfacing as a confusing ENOBUFS rather than "output too large".
    maxBuffer: 64 * 1024 * 1024,
    // Without this a hung engine hangs the build indefinitely.
    timeout: 60_000,
  });

  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    const detail =
      code === "ENOBUFS"
        ? "the engine produced more output than the read buffer allows"
        : code === "ETIMEDOUT"
          ? "the engine did not finish within 60s"
          : res.error.message;
    return {
      value: null,
      error: new WranglerEngineError(`Failed to run ${binary}: ${detail}. ${BUILD_HINT}`),
    };
  }

  if (res.signal) {
    return {
      value: null,
      error: new WranglerEngineError(
        `${binary} was terminated by signal ${res.signal}.`,
        null,
        res.stderr ?? "",
      ),
    };
  }

  const stdout = (res.stdout ?? "").trim();
  if (stdout) {
    try {
      return { value: JSON.parse(stdout) as T, error: null };
    } catch {
      // Fall through: unparseable stdout is a real failure, reported below.
    }
  }

  const stderr = (res.stderr ?? "").trim();
  return {
    value: null,
    error: new WranglerEngineError(
      stderr || `${binary} produced no output (exit ${String(res.status)}).`,
      res.status,
      stderr,
    ),
  };
}

/** Run and throw on failure. */
function runOrThrow<T>(args: string[]): T {
  const { value, error } = run<T>(args);
  if (error) throw error;
  return value as T;
}

/**
 * Run, and on failure warn and return a fallback.
 *
 * Used on plugin paths where aborting the whole build would be worse than
 * degrading — but the warning means the failure is never silent.
 */
function runOrWarn<T>(args: string[], fallback: T): T {
  const { value, error } = run<T>(args);
  if (error) {
    console.warn(error.message);
    return fallback;
  }
  return value as T;
}

/** Every wrangler config under `root`, parsed. Throws if the engine fails. */
export function discoverConfigs(root: string = process.cwd(), depth = 6): DiscoveredConfig[] {
  return runOrThrow<DiscoveredConfig[]>(["discover", root, "--depth", String(depth)]);
}

/** Non-throwing variant for plugin hooks: warns and returns `[]`. */
export function discoverConfigsSafe(root: string = process.cwd(), depth = 6): DiscoveredConfig[] {
  return runOrWarn<DiscoveredConfig[]>(["discover", root, "--depth", String(depth)], []);
}

/**
 * Parse one wrangler config, optionally resolving a named environment.
 *
 * Throws on a malformed config or an unknown environment name, both of which
 * used to come back as an indistinguishable `null`.
 */
export function loadConfig(configPath: string, env?: string): WranglerConfig {
  const args = ["config", configPath];
  if (env) args.push("--env", env);
  return runOrThrow<WranglerConfig>(args);
}

/** Non-throwing variant: warns and returns `null`. */
export function loadConfigSafe(configPath: string, env?: string): WranglerConfig | null {
  const args = ["config", configPath];
  if (env) args.push("--env", env);
  return runOrWarn<WranglerConfig | null>(args, null);
}

/**
 * Compare the config's account against CLOUDFLARE_ACCOUNT_ID.
 *
 * An engine failure is reported as a failing check rather than a thrown
 * error, so callers keep a single "did the guard pass" code path — but the
 * message says the guard could not run, which must never read as approval.
 */
export function checkAccount(
  configPath: string,
  options: { env?: string; expect?: string } = {},
): AccountCheck {
  const args = ["account-check", configPath];
  if (options.env) args.push("--env", options.env);
  if (options.expect) args.push("--expect", options.expect);

  const { value, error } = run<AccountCheck>(args);
  if (error) {
    return {
      status: "unpinned",
      ok: false,
      expected: options.expect ?? null,
      actual: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
      message: `Account check could not run: ${error.message}`,
    };
  }
  return value as AccountCheck;
}

/** Inspect a D1 migrations directory for ordering hazards. */
export function checkMigrations(dir = "migrations"): MigrationReport {
  const { value, error } = run<MigrationReport>(["migrations", dir]);
  if (error) {
    return {
      dir,
      count: 0,
      ok: false,
      migrations: [],
      issues: [{ severity: "error", message: `Migration check could not run: ${error.message}` }],
    };
  }
  return value as MigrationReport;
}

/** Check local .dev.vars file for a Worker configuration directory. */
export function checkSecrets(configPath = "wrangler.toml"): SecretsReport {
  const { value, error } = run<SecretsReport>(["secrets-check", configPath]);
  if (error) {
    return {
      path: configPath,
      exists: false,
      count: 0,
      ok: false,
      keys: [],
      issues: [{ severity: "error", message: `Secret check could not run: ${error.message}` }],
    };
  }
  return value as SecretsReport;
}

/** Lint a Wrangler configuration file for common schema & deprecation issues. */
export function checkConfigLint(configPath = "wrangler.toml"): LintReport {
  const { value, error } = run<LintReport>(["lint", configPath]);
  if (error) {
    return {
      path: configPath,
      ok: false,
      issues: [{ severity: "error", message: `Lint check could not run: ${error.message}` }],
    };
  }
  return value as LintReport;
}

/** Check output bundle size against Cloudflare limits. */
export function checkBundleSize(
  path = "dist",
  options: { limitMb?: number } = {},
): BundleSizeReport {
  const args = ["bundle-check", path];
  if (options.limitMb !== undefined) {
    args.push("--limit-mb", String(options.limitMb));
  }
  const { value, error } = run<BundleSizeReport>(args);
  if (error) {
    const limitMb = options.limitMb ?? 3;
    return {
      path,
      exists: false,
      total_bytes: 0,
      total_mb: 0,
      limit_mb: limitMb,
      limit_bytes: limitMb * 1024 * 1024,
      ok: false,
      files: [],
      issues: [{ severity: "error", message: `Bundle size check could not run: ${error.message}` }],
    };
  }
  return value as BundleSizeReport;
}

/** Check codebase AST bindings against Wrangler configuration. */
export function checkCodeBindings(
  configPath = "wrangler.toml",
  srcDir = "src",
  options: { env?: string } = {},
): CodeBindingsReport {
  const args = ["bindings-check", configPath, "--src", srcDir];
  if (options.env) {
    args.push("--env", options.env);
  }
  const { value, error } = run<CodeBindingsReport>(args);
  if (error) {
    return {
      config_path: configPath,
      src_dir: srcDir,
      ok: false,
      referenced_bindings: [],
      configured_bindings: [],
      missing_bindings: [],
      unused_bindings: [],
      issues: [{ severity: "error", binding: "", message: `Bindings check could not run: ${error.message}` }],
    };
  }
  return value as CodeBindingsReport;
}

/**

 * Passthrough for the CLI entrypoint.
 *
 * Returns 1 rather than 0 when the process could not start or was killed by a
 * signal. `status` is `null` in both cases, and treating that as success made
 * `cf:deploy`'s account guard silently pass in exactly the CI failure modes it
 * exists to catch.
 */
export function runWranglerRsCli(args: string[] = process.argv.slice(2)): number {
  let binary: string;
  try {
    binary = getBinaryPath();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const res = spawnSync(binary, args, { stdio: "inherit" });

  if (res.error) {
    console.error(`[vite-plus-wrangler] Failed to run ${binary}: ${res.error.message}`);
    return 1;
  }
  if (res.signal) {
    console.error(`[vite-plus-wrangler] ${binary} terminated by signal ${res.signal}`);
    return 1;
  }
  return res.status ?? 1;
}
