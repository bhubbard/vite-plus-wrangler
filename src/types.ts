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
  /**
   * Sibling config files in the same directory that this one takes precedence
   * over. Present only when the directory holds more than one wrangler config.
   */
  shadowed?: string[];
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
  /**
   * Numeric value of the filename prefix. Timestamp-style prefixes such as
   * `20240101120000` are supported and stay well inside `Number.MAX_SAFE_INTEGER`.
   */
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

export interface SecretIssue {
  severity: "error" | "warning";
  message: string;
}

export interface SecretsReport {
  path: string;
  exists: boolean;
  count: number;
  ok: boolean;
  keys: string[];
  issues: SecretIssue[];
}

export interface LintIssue {
  severity: "error" | "warning";
  message: string;
}

export interface LintReport {
  path: string;
  ok: boolean;
  issues: LintIssue[];
}

export interface BundleSizeIssue {
  severity: "error" | "warning";
  message: string;
}

export interface BundleFileDetails {
  path: string;
  size_bytes: number;
  size_mb: number;
}

export interface BundleSizeReport {
  path: string;
  exists: boolean;
  total_bytes: number;
  total_mb: number;
  limit_mb: number;
  limit_bytes: number;
  ok: boolean;
  files: BundleFileDetails[];
  issues: BundleSizeIssue[];
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
  /**
   * Serve `GET /__wrangler/config` from the dev server. Default false.
   *
   * The response describes every discovered Worker. Account ids are redacted
   * and non-localhost requests are refused, but absolute paths and worker
   * names are still disclosed, so this stays opt-in.
   */
  devEndpoint?: boolean;
}

export type { DevProxyConfig, DevProxyOptions, WorkerProxyRoute } from "./proxy.js";

export interface TaskOptions {
  /** Wrangler config path, relative to the package. */
  config?: string;
  /** Wrangler environment applied to every generated task. */
  env?: string;
  /** Port for `dev`. */
  port?: number;
  /** Starting port for sequential dev port allocation across Workers. Default 8787. */
  basePort?: number;
  /** Generate a unified `cf:dev:all` task in multi-Worker setups. Default true for multi-Worker setups. */
  devProxy?: boolean;
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
  /** Limit in MB for bundle size guard. Default 3. */
  bundleLimitMb?: number;
  /** Output dist directory or bundle path to check. Default "dist". */
  bundlePath?: string;
  /** Log format for `cf:tail` ("json" | "pretty"). */
  tailFormat?: "json" | "pretty";
  /** Extra flags appended to `wrangler tail`. */
  tailArgs?: string[];
  /** KV namespace binding name or flag enabling `cf:kv:seed`. */
  kv?: string | boolean;
  /** Seed file/json or command/args for `cf:kv:seed`. */
  kvSeed?: string;
  /** R2 bucket binding name or flag enabling `cf:r2:sync`. */
  r2?: string | boolean;
  /** Source directory or args for `cf:r2:sync`. */
  r2Sync?: string;
}

export type { KVTaskOptions, R2TaskOptions } from "./storage.js";


