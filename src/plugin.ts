import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import process from "node:process";
import type { Plugin } from "vite";
import { resolveMigrationsDir } from "./d1.js";
import { checkAccount, checkMigrations, discoverConfigsSafe, loadConfigSafe } from "./rust.js";
import type { DiscoveredConfig, WranglerPluginOptions } from "./types.js";

const PLUGIN_NAME = "vite-plus-wrangler";

/** Identifiers safe to splice into an `import.meta.env.WRANGLER_*` define key. */
const DEFINE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Hosts the dev-server endpoint will answer for. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  // Strip the port; IPv6 literals keep their brackets.
  const bare = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTS.has(bare?.toLowerCase() ?? "");
}

/** Strip values that should not leave the machine. */
function redact(configs: DiscoveredConfig[]): DiscoveredConfig[] {
  return configs.map((c) => ({ ...c, account_id: c.account_id ? "[redacted]" : null }));
}

/**
 * Vite+ plugin that makes Cloudflare configuration a first-class input:
 * discovers every wrangler config, guards the target account before a build,
 * and checks D1 migration ordering.
 */
export function wrangler(options: WranglerPluginOptions = {}): Plugin {
  let root = options.root ?? process.cwd();
  let configs: DiscoveredConfig[] = [];
  let scannedRoot: string | null = null;

  const scan = (nextRoot: string): void => {
    if (scannedRoot === nextRoot) return;
    root = nextRoot;
    configs = discoverConfigsSafe(nextRoot, options.depth ?? 6);
    scannedRoot = nextRoot;
  };

  const primary = (): DiscoveredConfig | undefined =>
    configs.find((c) => !c.error && c.relative_path.split(path.sep).length === 1) ??
    configs.find((c) => !c.error);

  return {
    name: PLUGIN_NAME,

    // Discovery happens here, not in configResolved, because `config` is the
    // first hook Vite calls and `define` must be returned from it. Reading
    // `configs` here while populating it in configResolved meant `exposeVars`
    // always saw an empty list and silently produced no defines at all.
    config(userConfig) {
      scan(options.root ?? userConfig.root ?? process.cwd());

      if (!options.exposeVars) return undefined;

      const target = primary();
      if (!target) return undefined;

      const cfg = loadConfigSafe(target.path, options.env);
      if (!cfg) return undefined;

      const define: Record<string, string> = {};
      for (const [key, value] of Object.entries(cfg.vars ?? {})) {
        if (!DEFINE_KEY.test(key)) {
          console.warn(
            `[${PLUGIN_NAME}] Skipping var ${JSON.stringify(key)}: not a valid identifier.`,
          );
          continue;
        }
        define[`import.meta.env.WRANGLER_${key}`] = JSON.stringify(value);
      }
      return { define };
    },

    configResolved(resolved) {
      // The resolved root can differ from what `config` saw; rescan if so.
      scan(options.root ?? resolved.root);

      for (const entry of configs) {
        if (entry.error) {
          resolved.logger.warn(`[${PLUGIN_NAME}] ${entry.error}`);
        }
        for (const shadowed of entry.shadowed ?? []) {
          resolved.logger.warn(
            `[${PLUGIN_NAME}] ${entry.relative_path} takes precedence; ignoring ${shadowed}`,
          );
        }
      }
    },

    configureServer(server) {
      // Off by default: the payload contains account ids and absolute paths,
      // and a dev server started with --host is reachable from the whole LAN.
      if (!options.devEndpoint) return;

      server.middlewares.use("/__wrangler/config", (req: IncomingMessage, res: ServerResponse) => {
        // Without a Host check, a page in the user's browser can read this
        // cross-origin via DNS rebinding while the dev server is running.
        if (!isLocalRequest(req)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ root, configs: redact(configs) }, null, 2));
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
        const cfg = loadConfigSafe(target.path, options.env);
        const dirs = new Set<string>();
        for (const binding of cfg?.d1_databases ?? []) {
          dirs.add(binding.migrations_dir ?? "migrations");
        }

        for (const dir of dirs) {
          // Wrangler resolves migrations_dir relative to the config file, not
          // to the Vite root. Resolving against root pointed the checker at a
          // non-existent directory for any Worker in a subdirectory.
          const report = checkMigrations(resolveMigrationsDir(target.path, dir));
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
