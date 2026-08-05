import type { DiscoveredConfig } from "./types.js";

export interface DevProxyOptions {
  /** Base port for sequential dev port allocation across Workers. Default 8787. */
  basePort?: number;
  /** Target host for Worker dev servers. Default "localhost". */
  host?: string;
}

export interface WorkerProxyRoute {
  workerName: string;
  relativePath: string;
  port: number;
  target: string;
  routePrefix: string;
}

export interface DevProxyConfig {
  routes: WorkerProxyRoute[];
  /** Proxy map suitable for Vite `server.proxy` or node-http-proxy. */
  proxyTable: Record<string, string>;
}

/**
 * Clean a relative path to generate a valid fallback name for a Worker.
 */
function getWorkerName(config: DiscoveredConfig): string {
  if (config.worker_name) return config.worker_name;
  const rawFallback = config.relative_path.replace(/[/\\]/g, "-").replace(/\.(toml|jsonc?)$/, "");
  return rawFallback === "wrangler" ? rawFallback : rawFallback.replace(/[-/]wrangler$/, "");
}

/**
 * Generate multi-Worker dev proxy routes and ports for discovered Workers.
 */
export function generateDevProxyConfig(
  configs: DiscoveredConfig[],
  options: DevProxyOptions = {},
): DevProxyConfig {
  const basePort = options.basePort ?? 8787;
  const host = options.host ?? "localhost";

  const validConfigs = configs.filter((c) => !c.error);
  const routes: WorkerProxyRoute[] = [];
  const proxyTable: Record<string, string> = {};

  validConfigs.forEach((config, index) => {
    const port = basePort + index;
    const workerName = getWorkerName(config);
    const routePrefix = `/${workerName}`;
    const target = `http://${host}:${port}`;

    routes.push({
      workerName,
      relativePath: config.relative_path,
      port,
      target,
      routePrefix,
    });

    proxyTable[routePrefix] = target;
  });

  return { routes, proxyTable };
}
