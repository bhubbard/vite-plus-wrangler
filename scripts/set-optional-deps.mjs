#!/usr/bin/env node
/**
 * Add the prebuilt-binary `optionalDependencies` immediately before publishing.
 *
 * They are deliberately absent from the committed `package.json`. Declaring
 * them there is a bootstrap deadlock:
 *
 *   1. `@vite-plus-wrangler/*` does not exist on npm until a release publishes it.
 *   2. `pnpm install` silently drops optional dependencies it cannot resolve,
 *      so they never reach `pnpm-lock.yaml`.
 *   3. `pnpm install --frozen-lockfile` then fails with ERR_PNPM_OUTDATED_LOCKFILE
 *      ("5 dependencies were added"), because package.json and the lockfile disagree.
 *   4. CI cannot install, so the release that would publish the packages never runs.
 *
 * The release workflow publishes the platform packages first, then runs this
 * script, then publishes the main package — so the published manifest has the
 * optional dependencies and the repo stays installable.
 *
 * Versions are pinned exactly to the main package's version; a range would let
 * a consumer pair mismatched engine and wrapper versions.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SLUGS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

const optional = {};
for (const slug of SLUGS) {
  optional[`@vite-plus-wrangler/${slug}`] = manifest.version;
}

manifest.optionalDependencies = optional;
delete manifest["//optionalDependencies"];

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `[vite-plus-wrangler] Added ${SLUGS.length} optionalDependencies at version ${manifest.version}:`,
);
for (const slug of SLUGS) console.log(`  @vite-plus-wrangler/${slug}`);
console.log("\nThis edit is for the publish artifact only — do not commit it.");

if (process.env.CI !== "true") {
  console.log("Warning: not running in CI. `git checkout package.json` when finished.");
}
