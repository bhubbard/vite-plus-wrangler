import { checkMigrations } from "./rust.js";
import type { MigrationReport } from "./types.js";

export { checkMigrations };

export interface D1TaskOptions {
  /** D1 database name as it appears in the wrangler config. */
  database: string;
  /** Wrangler config path. */
  config?: string;
  /** Wrangler environment. */
  env?: string;
  /** Migrations directory. Default "migrations". */
  migrationsDir?: string;
}

function flags(options: D1TaskOptions): string {
  const parts: string[] = [];
  if (options.env) parts.push(`--env ${options.env}`);
  if (options.config) parts.push(`--config ${options.config}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Generate the D1 migration tasks for one database.
 *
 * Local, dev-remote, and production variants are spelled out separately on
 * purpose: the failure mode worth designing against is running a production
 * migration when you meant to run a local one.
 */
export function d1Tasks(options: D1TaskOptions): Record<string, unknown> {
  const { database } = options;
  const suffix = flags(options);
  const dir = options.migrationsDir ?? "migrations";

  return {
    "d1:migrate:local": {
      command: `wrangler d1 migrations apply ${database} --local${suffix}`,
      cache: false,
    },
    "d1:migrate:remote": {
      command: `wrangler d1 migrations apply ${database} --remote${suffix}`,
      cache: false,
    },
    "d1:migrate:status": {
      command: `wrangler d1 migrations list ${database} --remote${suffix}`,
      cache: false,
    },
    "d1:migrate:check": {
      command: `vite-plus-wrangler migrations ${dir}`,
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
