import path from "node:path";
import process from "node:process";
import { checkMigrations } from "./rust.js";
import { assertIdentifier, join, quote, wranglerFlags } from "./shell.js";
import type { MigrationReport } from "./types.js";

export { checkMigrations };

export interface D1TaskOptions {
  /** D1 database name as it appears in the wrangler config. */
  database: string;
  /** Wrangler config path. */
  config?: string;
  /** Wrangler environment. */
  env?: string;
  /**
   * Migrations directory, relative to the wrangler config (matching Wrangler's
   * own interpretation of `migrations_dir`).
   */
  migrationsDir?: string;
}

/**
 * Join `migrations_dir` onto the directory holding the wrangler config, the
 * way Wrangler interprets it — **without** resolving against the process cwd.
 *
 * Relative in, relative out. That matters for generated tasks in three ways:
 *
 * - The emitted command and the cache `inputs` glob are both derived from this
 *   one value, so they cannot drift apart and cache against a directory that
 *   is never inspected.
 * - A relative path keeps the task's cache key identical across machines and
 *   CI runners. An absolute path makes every checkout a cache miss.
 * - `discoverWranglerTasks` hands over a path relative to the *scan root*,
 *   which is not necessarily the process cwd. Resolving here would silently
 *   rebase it onto the wrong directory.
 */
export function migrationsDirFor(
  configPath: string | undefined,
  migrationsDir = "migrations",
): string {
  if (path.isAbsolute(migrationsDir)) return migrationsDir;
  if (!configPath) return migrationsDir;

  const base = path.dirname(configPath);
  if (base === "" || base === ".") return migrationsDir;

  // Keep POSIX separators: this value goes into a shell command and a glob,
  // both of which want forward slashes even on Windows.
  return `${base.split(path.sep).join("/")}/${migrationsDir}`;
}

/**
 * Absolute form of {@link migrationsDirFor}, for callers that need to touch
 * the filesystem right now rather than emit a task.
 */
export function resolveMigrationsDir(
  configPath: string | undefined,
  migrationsDir = "migrations",
): string {
  const joined = migrationsDirFor(configPath, migrationsDir);
  return path.isAbsolute(joined) ? joined : path.resolve(process.cwd(), joined);
}

/**
 * Generate the D1 migration tasks for one database.
 *
 * Local, dev-remote, and production variants are spelled out separately on
 * purpose: the failure mode worth designing against is running a production
 * migration when you meant to run a local one.
 */
export function d1Tasks(options: D1TaskOptions): Record<string, unknown> {
  const database = assertIdentifier(options.database, "d1 database name");
  const flags = wranglerFlags(options);
  // One value feeds both the command and the cache inputs, so they cannot
  // disagree about which directory this task actually covers.
  const dir = migrationsDirFor(options.config, options.migrationsDir ?? "migrations");

  const apply = (target: "--local" | "--remote") =>
    join("wrangler", "d1", "migrations", "apply", database, target, ...flags);

  return {
    "d1:migrate:local": {
      command: apply("--local"),
      cache: false,
    },
    "d1:migrate:remote": {
      command: apply("--remote"),
      cache: false,
    },
    "d1:migrate:status": {
      command: join("wrangler", "d1", "migrations", "list", database, "--remote", ...flags),
      cache: false,
    },
    "d1:migrate:check": {
      command: join("vite-plus-wrangler", "migrations", quote(dir)),
      cache: true,
      inputs: [`${dir}/**/*.sql`],
    },
  };
}

/** Throw when migration prefixes would apply out of order. */
export function assertMigrations(dir = "migrations"): MigrationReport {
  const report = checkMigrations(dir);
  if (!report.ok) {
    const detail = report.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new Error(`[vite-plus-wrangler] Migration check failed:\n${detail}`);
  }
  return report;
}
