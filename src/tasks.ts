import { d1Tasks } from "./d1.js";
import { discoverConfigs } from "./rust.js";
import type { TaskOptions } from "./types.js";

function suffix(options: TaskOptions): string {
  const parts: string[] = [];
  if (options.config) parts.push(`--config ${options.config}`);
  if (options.env) parts.push(`--env ${options.env}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Build the standard `vp run` task set for one Worker.
 *
 * Deploy is uncached and gated on the account guard; dev and preview are
 * uncached because they are long-running. Only `types` and the migration
 * check are safe to cache.
 */
export function wranglerTasks(options: TaskOptions = {}): Record<string, unknown> {
  const base = suffix(options);
  const guard = options.guardAccount ?? true;
  const configPath = options.config ?? "wrangler.toml";

  const accountCheck = `vite-plus-wrangler account-check ${configPath}${
    options.env ? ` --env ${options.env}` : ""
  }`;

  const devFlags = [
    base.trim(),
    options.port ? `--port ${options.port}` : "",
    ...(options.devArgs ?? []),
  ]
    .filter(Boolean)
    .join(" ");

  const deployFlags = [base.trim(), ...(options.deployArgs ?? [])].filter(Boolean).join(" ");

  const tasks: Record<string, unknown> = {
    "cf:account": { command: accountCheck, cache: false },
    "cf:dev": {
      command: `wrangler dev ${devFlags}`.trim(),
      cache: false,
      persistent: true,
    },
    "cf:preview": {
      command: `wrangler dev ${devFlags} --remote`.trim(),
      cache: false,
      persistent: true,
    },
    "cf:deploy": {
      command: guard
        ? [accountCheck, `wrangler deploy ${deployFlags}`.trim()]
        : `wrangler deploy ${deployFlags}`.trim(),
      cache: false,
      env: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
      dependsOn: [{ task: "build", from: "self" }],
    },
    "cf:types": {
      command: `wrangler types${base}`,
      cache: true,
      inputs: [configPath],
      outputs: ["worker-configuration.d.ts"],
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

  return tasks;
}

/**
 * Discover every Worker under `root` and emit a namespaced task per config.
 *
 * Intended for repos like `tapp-hosting-workers` or `bbdental-workers` where
 * the current setup is a `bun run --filter '*'` fan-out with no caching.
 */
export function discoverWranglerTasks(
  root: string = process.cwd(),
  options: Omit<TaskOptions, "config"> & { depth?: number } = {},
): Record<string, unknown> {
  const tasks: Record<string, unknown> = {};

  for (const found of discoverConfigs(root, options.depth ?? 6)) {
    if (found.error) continue;
    const name = found.worker_name ?? found.relative_path.replace(/[/\\]/g, "-");
    const generated = wranglerTasks({ ...options, config: found.path });

    for (const [task, definition] of Object.entries(generated)) {
      tasks[`${name}#${task}`] = definition;
    }
  }

  return tasks;
}
