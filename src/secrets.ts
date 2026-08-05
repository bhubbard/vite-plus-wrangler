import { checkSecrets } from "./rust.js";
import type { SecretsReport } from "./types.js";

export { checkSecrets };

/**
 * Throw unless `.dev.vars` exists and is readable.
 */
export function assertSecrets(configPath = "wrangler.toml"): SecretsReport {
  const report = checkSecrets(configPath);
  if (!report.ok) {
    const detail = report.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new Error(`[vite-plus-wrangler] Secret check failed:\n${detail}`);
  }
  return report;
}
