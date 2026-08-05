import { assertIdentifier, join, quote, wranglerFlags } from "./shell.js";

export interface KVTaskOptions {
  /** KV namespace binding name. */
  binding?: string;
  /** Seed file path (e.g. "kv-seed.json") or key/value payload. */
  seed?: string;
  /** Wrangler config path. */
  config?: string;
  /** Wrangler environment. */
  env?: string;
}

export interface R2TaskOptions {
  /** R2 bucket binding name or bucket name. */
  bucket?: string;
  /** Directory or file path to sync (e.g. "public"). */
  syncDir?: string;
  /** Wrangler config path. */
  config?: string;
  /** Wrangler environment. */
  env?: string;
}

/**
 * Generate task definition for KV key-value seeding (`cf:kv:seed`).
 */
export function kvTasks(options: KVTaskOptions = {}): Record<string, unknown> {
  const binding = options.binding
    ? assertIdentifier(options.binding, "kv binding")
    : "KV";
  const flags = wranglerFlags(options);

  const seed = options.seed ?? "kv-seed.json";

  const command =
    seed.includes(" ") && !seed.endsWith(".json")
      ? join("wrangler", "kv", "key", "put", seed, "--binding", binding, "--local", ...flags)
      : join("wrangler", "kv", "bulk", "put", quote(seed), "--binding", binding, "--local", ...flags);

  return {
    "cf:kv:seed": {
      command,
      cache: false,
    },
  };
}

/**
 * Generate task definition for R2 object directory syncing (`cf:r2:sync`).
 */
export function r2Tasks(options: R2TaskOptions = {}): Record<string, unknown> {
  const bucket = options.bucket
    ? assertIdentifier(options.bucket, "r2 bucket")
    : "BUCKET";
  const flags = wranglerFlags(options);

  const syncDir = options.syncDir ?? "public";

  const command = join(
    "wrangler",
    "r2",
    "object",
    "put",
    bucket,
    "--file",
    quote(syncDir),
    "--local",
    ...flags,
  );

  return {
    "cf:r2:sync": {
      command,
      cache: false,
    },
  };
}
