import fs from "node:fs";
import path from "node:path";
import { checkBundleSize as checkBundleSizeRust } from "./rust.js";
import type { BundleFileDetails, BundleSizeIssue, BundleSizeReport } from "./types.js";

/**
 * Check Worker bundle size against size limits.
 *
 * Uses the Rust engine if available, or falls back to JS filesystem checks.
 */
export function checkBundleSize(
  targetPath = "dist",
  options: { limitMb?: number } = {},
): BundleSizeReport {
  try {
    const report = checkBundleSizeRust(targetPath, options);
    // If the engine ran successfully (not a "could not run" error fallback), return the report.
    if (
      report &&
      !(
        report.issues.length === 1 &&
        report.issues[0]?.message.startsWith("Bundle size check could not run:")
      )
    ) {
      return report;
    }
  } catch {
    // Engine unavailable, fall back to JS filesystem check.
  }

  return checkBundleSizeJs(targetPath, options.limitMb ?? 3);
}

/**
 * Pure JavaScript fallback for bundle size checking.
 */
export function checkBundleSizeJs(
  targetPath = "dist",
  limitMb = 3,
): BundleSizeReport {
  const limitBytes = limitMb * 1024 * 1024;
  const issues: BundleSizeIssue[] = [];
  const files: BundleFileDetails[] = [];

  if (!fs.existsSync(targetPath)) {
    issues.push({
      severity: "error",
      message: `Target path does not exist: ${targetPath}`,
    });
    return {
      path: targetPath,
      exists: false,
      total_bytes: 0,
      total_mb: 0,
      limit_mb: limitMb,
      limit_bytes: limitBytes,
      ok: false,
      files: [],
      issues,
    };
  }

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    const sizeBytes = stat.size;
    const sizeMb = Math.round((sizeBytes / 1048576) * 100) / 100;
    files.push({
      path: targetPath,
      size_bytes: sizeBytes,
      size_mb: sizeMb,
    });
  } else if (stat.isDirectory()) {
    const collectFiles = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          collectFiles(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (
            (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".wasm") &&
            !entry.name.endsWith(".map") &&
            !entry.name.endsWith(".d.ts")
          ) {
            const fileStat = fs.statSync(fullPath);
            const sizeBytes = fileStat.size;
            const sizeMb = Math.round((sizeBytes / 1048576) * 100) / 100;
            files.push({
              path: fullPath,
              size_bytes: sizeBytes,
              size_mb: sizeMb,
            });
          }
        }
      }
    };
    collectFiles(targetPath);
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    issues.push({
      severity: "error",
      message: `No JS/WASM bundle files found under ${targetPath}`,
    });
    return {
      path: targetPath,
      exists: true,
      total_bytes: 0,
      total_mb: 0,
      limit_mb: limitMb,
      limit_bytes: limitBytes,
      ok: false,
      files: [],
      issues,
    };
  }

  const totalBytes = files.reduce((acc, f) => acc + f.size_bytes, 0);
  const totalMb = Math.round((totalBytes / 1048576) * 100) / 100;
  const isOverLimit = totalBytes > limitBytes;

  if (isOverLimit) {
    const diffMb = Math.round(((totalBytes - limitBytes) / 1048576) * 100) / 100;
    issues.push({
      severity: "error",
      message: `Bundle size (${totalMb} MB) exceeds limit of ${limitMb} MB by ${diffMb} MB`,
    });
  } else if (totalBytes >= limitBytes * 0.8) {
    const pct = Math.round((totalBytes / limitBytes) * 100);
    issues.push({
      severity: "warning",
      message: `Bundle size (${totalMb} MB) is at ${pct}% of the ${limitMb} MB limit`,
    });
  }

  return {
    path: targetPath,
    exists: true,
    total_bytes: totalBytes,
    total_mb: totalMb,
    limit_mb: limitMb,
    limit_bytes: limitBytes,
    ok: !isOverLimit,
    files,
    issues,
  };
}

/**
 * Throw unless the bundle size is within the limit.
 */
export function assertBundleSize(
  targetPath = "dist",
  options: { limitMb?: number } = {},
): BundleSizeReport {
  const report = checkBundleSize(targetPath, options);
  if (!report.ok) {
    const detail = report.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new Error(`[vite-plus-wrangler] Bundle size check failed:\n${detail}`);
  }
  return report;
}
