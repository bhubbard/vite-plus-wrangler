import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import type { Plugin } from "vite";
import { checkAccount, checkMigrations, discoverConfigs, loadConfig } from "./rust.js";
import type { DiscoveredConfig, WranglerPluginOptions } from "./types.js";

const PLUGIN_NAME = "vite-plus-wrangler";

/**
 * Vite+ plugin that makes Cloudflare configuration a first-class input:
 * discovers every wrangler config, guards the target account before a build,
 * and checks D1 migration ordering.
 */
export function wrangler(options: WranglerPluginOptions = {}): Plugin {
  let root = options.root ?? process.cwd();
  let configs: DiscoveredConfig[] = [];

  const primary = (): DiscoveredConfig | undefined =>
    configs.find((c) => !c.error && c.relative_path.split(path.sep).length === 1) ??
    configs.find((c) => !c.error);

  return {
    name: PLUGIN_NAME,

    configResolved(resolved) {
      root = options.root ?? resolved.root;
      configs = discoverConfigs(root, options.depth ?? 6);

      for (const entry of configs) {
        if (entry.error) {
          resolved.logger.warn(`[${PLUGIN_NAME}] ${entry.error}`);
        }
      }
    },

    config() {
      if (!options.exposeVars) return undefined;

      const target = primary();
      if (!target) return undefined;

      const cfg = loadConfig(target.path, options.env);
      if (!cfg) return undefined;

      const define: Record<string, string> = {};
      for (const [key, value] of Object.entries(cfg.vars ?? {})) {
        define[`import.meta.env.WRANGLER_${key}`] = JSON.stringify(value);
      }
      return { define };
    },

    configureServer(server) {
      // Lets the dashboard, an IDE extension, or an agent read resolved
      // Cloudflare config without shelling out to wrangler.
      server.middlewares.use("/__wrangler/config", (_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ root, configs }, null, 2));
      });
    },

    buildStart() {
      const target = primary();
      if (!target) return;

      if (options.guardAccount ?? true) {
        const result = checkAccount(target.path, {
          env: options.env,
          expect: options.expectAccount,
        });
        if (!result.ok) {
          if (options.failOnError ?? true) {
            this.error(`[${PLUGIN_NAME}] ${result.message}`);
          } else {
            this.warn(`[${PLUGIN_NAME}] ${result.message}`);
          }
        } else if (result.status === "unpinned") {
          this.warn(`[${PLUGIN_NAME}] ${result.message}`);
        }
      }

      if (options.checkMigrations ?? true) {
        const cfg = loadConfig(target.path, options.env);
        const dirs = new Set<string>();
        for (const binding of cfg?.d1_databases ?? []) {
          dirs.add(binding.migrations_dir ?? "migrations");
        }

        for (const dir of dirs) {
          const report = checkMigrations(path.resolve(root, dir));
          for (const issue of report.issues) {
            const message = `[${PLUGIN_NAME}] ${dir}: ${issue.message}`;
            if (issue.severity === "error") {
              this.error(message);
            } else {
              this.warn(message);
            }
          }
        }
      }
    },
  };
}

export const vitePlusWrangler = wrangler;
export default wrangler;
