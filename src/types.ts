export interface D1Binding {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir?: string | null;
}

export interface NamedBinding {
  binding: string;
  id?: string | null;
  bucket_name?: string | null;
  queue?: string | null;
  class_name?: string | null;
}

export interface WranglerConfig {
  name?: string | null;
  main?: string | null;
  account_id?: string | null;
  compatibility_date?: string | null;
  compatibility_flags: string[];
  workers_dev?: boolean | null;
  vars: Record<string, unknown>;
  d1_databases: D1Binding[];
  kv_namespaces: NamedBinding[];
  r2_buckets: NamedBinding[];
  durable_objects?: { bindings: NamedBinding[] } | null;
  env: Record<string, WranglerConfig>;
}

export interface DiscoveredConfig {
  path: string;
  relative_path: string;
  worker_name: string | null;
  account_id: string | null;
  environments: string[];
  d1_bindings: string[];
  error?: string;
}

export type AccountStatus = "ok" | "unpinned" | "mismatch";

export interface AccountCheck {
  status: AccountStatus;
  ok: boolean;
  expected: string | null;
  actual: string | null;
  message: string;
}

export interface MigrationIssue {
  severity: "error" | "warning";
  message: string;
}

export interface Migration {
  file: string;
  path: string;
  prefix: string;
  index: number;
  name: string;
}

export interface MigrationReport {
  dir: string;
  count: number;
  ok: boolean;
  migrations: Migration[];
  issues: MigrationIssue[];
}

export interface WranglerPluginOptions {
  /** Root to scan for wrangler configs. Defaults to the Vite config root. */
  root?: string;
  /** Max directory depth when discovering configs. Default 6. */
  depth?: number;
  /** Wrangler environment to resolve (`--env`). */
  env?: string;
  /**
   * Verify CLOUDFLARE_ACCOUNT_ID against the config before `vite build`.
   * Default true.
   */
  guardAccount?: boolean;
  /** Explicit account id override; defaults to the value in the config. */
  expectAccount?: string;
  /** Fail the build when the account guard trips. Default true. */
  failOnError?: boolean;
  /** Check D1 migration prefix hygiene during build. Default true. */
  checkMigrations?: boolean;
  /**
   * Expose `vars` and binding names to client code as
   * `import.meta.env.WRANGLER_*`. Default false — bindings are server-side.
   */
  exposeVars?: boolean;
}

export interface TaskOptions {
  /** Wrangler config path, relative to the package. */
  config?: string;
  /** Wrangler environment applied to every generated task. */
  env?: string;
  /** Port for `dev`. */
  port?: number;
  /** Extra flags appended to `wrangler dev`. */
  devArgs?: string[];
  /** Extra flags appended to `wrangler deploy`. */
  deployArgs?: string[];
  /** Run the account guard before deploy. Default true. */
  guardAccount?: boolean;
  /** D1 database name, enabling the migration tasks. */
  d1?: string;
  /** Migrations directory. Default "migrations". */
  migrationsDir?: string;
}
