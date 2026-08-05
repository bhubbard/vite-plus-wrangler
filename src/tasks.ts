import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { d1Tasks } from "./d1.js";
import { discoverConfigs, loadConfigSafe } from "./rust.js";
import { assertIdentifier, assertPort, join, quote, wranglerFlags } from "./shell.js";
import { kvTasks, r2Tasks } from "./storage.js";
import type { TaskOptions } from "./types.js";

/** Config filenames in the same precedence order the Rust engine uses. */
const CONFIG_NAMES = ["wrangler.toml", "wrangler.jsonc", "wrangler.json"] as const;

/**
 * Find the wrangler config for a package.
 *
 * Defaulting blindly to `wrangler.toml` meant a project using `wrangler.jsonc`
 * got an account check pointed at a file that does not exist — so `cf:deploy`
 * failed with "no such file" instead of anything actionable.
 */
export function resolveConfigPath(cwd: string = process.cwd()): string {
  for (const name of CONFIG_NAMES) {
    if (fs.existsSync(path.join(cwd, name))) return name;
  }
  return CONFIG_NAMES[0];
}

/**
 * Build the standard `vp run` task set for one Worker.
 *
 * Deploy is uncached and gated on the account guard; dev and preview are
 * uncached because they are long-running. Only `types` and the migration
 * check are safe to cache.
 */
export function wranglerTasks(options: TaskOptions = {}): Record<string, unknown> {
  const configPath = options.config ?? resolveConfigPath();
  const flags = wranglerFlags({ config: configPath, env: options.env });

  const accountCheck = join(
    "vite-plus-wrangler",
    "account-check",
    quote(configPath),
    options.env ? `--env ${assertIdentifier(options.env, "env")}` : "",
  );

  // Caller-supplied extra flags are quoted individually: they are arguments,
  // not a fragment of shell to be re-interpreted.
  const extra = (list: string[] | undefined) => (list ?? []).map(quote);

  const devFlags = join(
    ...flags,
    // `!== undefined`, not a truthiness check: port 0 is invalid and must be
    // rejected, not silently dropped.
    options.port !== undefined ? `--port ${assertPort(options.port)}` : "",
    ...extra(options.devArgs),
  );
  const deployFlags = join(...flags, ...extra(options.deployArgs));

  const deploy = join("wrangler", "deploy", deployFlags);

  const tasks: Record<string, unknown> = {
    "cf:account": { command: accountCheck, cache: false },
    "cf:dev": {
      command: join("wrangler", "dev", devFlags),
      cache: false,
      persistent: true,
    },
    "cf:preview": {
      command: join("wrangler", "dev", devFlags, "--remote"),
      cache: false,
      persistent: true,
    },
    "cf:deploy": {
      command: (options.guardAccount ?? true) ? [accountCheck, deploy] : deploy,
      cache: false,
      env: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
      dependsOn: [{ task: "build", from: "self" }],
    },
    "cf:secrets": {
      command: join("vite-plus-wrangler", "secrets-check", quote(configPath)),
      cache: false,
    },
    "cf:lint": {
      command: join("vite-plus-wrangler", "lint", quote(configPath)),
      cache: true,
      inputs: [configPath],
    },
    "cf:bundle": {
      command: join(
        "vite-plus-wrangler",
        "bundle-check",
        quote(options.bundlePath ?? "dist"),
        options.bundleLimitMb !== undefined ? `--limit-mb ${options.bundleLimitMb}` : "",
      ),
      cache: false,
    },
    "cf:types": {
      command: join("wrangler", "types", ...flags),
      cache: true,
      // Relative so the cache key survives a different checkout directory or
      // CI runner. An absolute path here defeats caching across machines.
      inputs: [configPath],
      outputs: ["worker-configuration.d.ts"],
    },
    "cf:tail": {
      command: join(
        "wrangler",
        "tail",
        ...flags,
        options.tailFormat
          ? `--format ${assertIdentifier(options.tailFormat, "tail format")}`
          : "",
        ...extra(options.tailArgs),
      ),
      cache: false,
      persistent: true,
    },
  };

  if (options.d1) {
    Object.assign(
      tasks,
      d1Tasks({
        database: options.d1,
        config: options.config,
        env: options.env,
        migrationsDir: options.migrationsDir,
      }),
    );
  }

  const loadedConfig = loadConfigSafe(configPath, options.env);

  const kvBinding =
    typeof options.kv === "string"
      ? options.kv
      : (loadedConfig?.kv_namespaces?.[0]?.binding ?? undefined);

  const hasKv =
    options.kv !== undefined ||
    options.kvSeed !== undefined ||
    (loadedConfig?.kv_namespaces && loadedConfig.kv_namespaces.length > 0);

  if (hasKv) {
    Object.assign(
      tasks,
      kvTasks({
        binding: kvBinding,
        seed: options.kvSeed,
        config: options.config,
        env: options.env,
      }),
    );
  }

  const r2Bucket =
    typeof options.r2 === "string"
      ? options.r2
      : (loadedConfig?.r2_buckets?.[0]?.binding ?? loadedConfig?.r2_buckets?.[0]?.bucket_name ?? undefined);

  const hasR2 =
    options.r2 !== undefined ||
    options.r2Sync !== undefined ||
    (loadedConfig?.r2_buckets && loadedConfig.r2_buckets.length > 0);

  if (hasR2) {
    Object.assign(
      tasks,
      r2Tasks({
        bucket: r2Bucket,
        syncDir: options.r2Sync,
        config: options.config,
        env: options.env,
      }),
    );
  }

  return tasks;
}

/**
 * Discover every Worker under `root` and emit a namespaced task per config.
 *
 * Intended for repos like `tapp-hosting-workers` or `bbdental-workers` where
 * the current setup is a `bun run --filter '*'` fan-out with no caching.
 *
 * Task prefixes must be unique. `worker_name` is not guaranteed unique across
 * a monorepo, and silently letting the second Worker overwrite the first would
 * mean `vp run api#cf:deploy` deploys whichever one happened to sort last —
 * precisely the class of mistake this package exists to prevent.
 */
export function discoverWranglerTasks(
  root: string = process.cwd(),
  options: Omit<TaskOptions, "config"> & { depth?: number } = {},
): Record<string, unknown> {
  const tasks: Record<string, unknown> = {};
  const claimed = new Map<string, string>();
  const devTaskNames: string[] = [];
  const basePort = options.basePort ?? 8787;

  const configs = discoverConfigs(root, options.depth ?? 6).filter((c) => !c.error);

  configs.forEach((found, index) => {
    const rawFallback = found.relative_path.replace(/[/\\]/g, "-").replace(/\.(toml|jsonc?)$/, "");
    const fallback = rawFallback === "wrangler" ? rawFallback : rawFallback.replace(/[-/]wrangler$/, "");
    const name = found.worker_name ?? fallback;

    const existing = claimed.get(name);
    if (existing) {
      throw new Error(
        `[vite-plus-wrangler] Duplicate task prefix "${name}": ` +
          `${existing} and ${found.relative_path} would generate the same tasks. ` +
          `Give the Workers distinct \`name\` values in their wrangler configs.`,
      );
    }
    claimed.set(name, found.relative_path);

    const workerPort = options.port !== undefined ? options.port : basePort + index;

    // Relative so generated cache keys stay portable across machines.
    const generated = wranglerTasks({
      ...options,
      config: found.relative_path,
      port: workerPort,
    });

    for (const [task, definition] of Object.entries(generated)) {
      tasks[`${name}#${task}`] = definition;
    }

    devTaskNames.push(`${name}#cf:dev`);
  });

  const shouldEnableDevProxy = options.devProxy ?? devTaskNames.length > 1;
  if (shouldEnableDevProxy && devTaskNames.length > 0) {
    tasks["cf:dev:all"] = {
      command: `vp run ${devTaskNames.join(" ")}`,
      cache: false,
      persistent: true,
      dependsOn: devTaskNames.map((task) => ({ task, from: "self" })),
    };
  }

  return tasks;
}

