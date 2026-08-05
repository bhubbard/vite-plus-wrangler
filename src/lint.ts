import { checkConfigLint } from "./rust.js";
import type { LintReport } from "./types.js";

export { checkConfigLint };

/**
 * Throw unless wrangler config lint passes without errors.
 */
export function assertConfigLint(configPath = "wrangler.toml"): LintReport {
  const report = checkConfigLint(configPath);
  if (!report.ok) {
    const detail = report.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new Error(`[vite-plus-wrangler] Config lint failed for ${configPath}:\n${detail}`);
  }
  return report;
}
