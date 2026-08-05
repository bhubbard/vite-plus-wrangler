import fs from "node:fs";
import path from "node:path";
import { checkCodeBindings as rustCheckCodeBindings } from "./rust.js";

export interface CodeBindingIssue {
  severity: "error" | "warning";
  binding: string;
  message: string;
}

export interface CodeBindingsReport {
  config_path: string;
  src_dir: string;
  ok: boolean;
  referenced_bindings: string[];
  configured_bindings: string[];
  missing_bindings: string[];
  unused_bindings: string[];
  issues: CodeBindingIssue[];
}

const RESERVED_KEYS = new Set([
  "NODE_ENV",
  "CF_PAGES",
  "FETCH",
  "ASSETS",
  "PROD",
  "DEV",
  "MODE",
  "SSR",
  "CF",
  "REQUEST",
]);

/**
 * Scan JS/TS source files under `srcDir` for `env.BINDING` and `c.env.BINDING` references.
 */
export function scanCodebaseBindingsJs(srcDir: string): string[] {
  const bindings = new Set<string>();
  if (!fs.existsSync(srcDir)) return [];

  const dotRegex = /(?:c\.)?env\.([A-Za-z_][A-Za-z0-9_]*)/g;
  const bracketRegex = /(?:c\.)?env\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/g;

  function walk(current: string) {
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      const ext = path.extname(current);
      if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
        const content = fs.readFileSync(current, "utf-8");
        let match: RegExpExecArray | null;
        while ((match = dotRegex.exec(content)) !== null) {
          const name = match[1];
          if (name && !RESERVED_KEYS.has(name)) bindings.add(name);
        }
        while ((match = bracketRegex.exec(content)) !== null) {
          const name = match[1];
          if (name && !RESERVED_KEYS.has(name)) bindings.add(name);
        }
      }
    } else if (stat.isDirectory()) {
      const base = path.basename(current);
      if (!base.startsWith(".") && base !== "node_modules" && base !== "dist") {
        for (const child of fs.readdirSync(current)) {
          walk(path.join(current, child));
        }
      }
    }
  }

  walk(srcDir);
  return Array.from(bindings).sort();
}

/**
 * Check codebase AST bindings against Wrangler configuration.
 */
export function checkCodeBindings(
  configPath = "wrangler.toml",
  srcDir = "src",
  options: { env?: string } = {},
): CodeBindingsReport {
  const report = rustCheckCodeBindings(configPath, srcDir, options);
  if (
    !report.ok &&
    report.issues.some((i: CodeBindingIssue) => i.message.includes("could not run"))
  ) {
    return checkCodeBindingsJs(configPath, srcDir);
  }
  return report;
}

/**
 * Fallback JS implementation for codebase binding validation.
 */
export function checkCodeBindingsJs(configPath: string, srcDir: string): CodeBindingsReport {
  const issues: CodeBindingIssue[] = [];

  if (!fs.existsSync(configPath)) {
    issues.push({
      severity: "error",
      binding: "",
      message: `Config file not found: ${configPath}`,
    });
    return {
      config_path: configPath,
      src_dir: srcDir,
      ok: false,
      referenced_bindings: [],
      configured_bindings: [],
      missing_bindings: [],
      unused_bindings: [],
      issues,
    };
  }

  const referenced = scanCodebaseBindingsJs(srcDir);
  const configured: string[] = [];

  const missing = referenced.filter((r) => !configured.includes(r));
  for (const name of missing) {
    issues.push({
      severity: "error",
      binding: name,
      message: `Binding '${name}' is referenced in codebase (${srcDir}) but not configured in ${configPath}`,
    });
  }

  return {
    config_path: configPath,
    src_dir: srcDir,
    ok: missing.length === 0,
    referenced_bindings: referenced,
    configured_bindings: configured,
    missing_bindings: missing,
    unused_bindings: [],
    issues,
  };
}

/**
 * Assert that all codebase AST bindings are declared in configuration, throwing an Error if missing.
 */
export function assertCodeBindings(
  configPath = "wrangler.toml",
  srcDir = "src",
  options: { env?: string } = {},
): void {
  const report = checkCodeBindings(configPath, srcDir, options);
  if (!report.ok) {
    const details = report.issues.map((i: CodeBindingIssue) => `  - ${i.message}`).join("\n");
    throw new Error(`[vite-plus-wrangler] Codebase binding verification failed:\n${details}`);
  }
}
