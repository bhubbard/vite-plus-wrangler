#!/usr/bin/env node
/**
 * Copy the locally built engine into `dist/bin` for development use.
 *
 * This is a convenience for working in the repo, not the publish path —
 * published installs get their binary from a `@vite-plus-wrangler/*` platform
 * package (see scripts/build-platform-packages.mjs). Copying a single binary
 * into the main tarball would make it work on exactly one platform.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "wrangler-rs.exe" : "wrangler-rs";
const source = path.join(root, "target", "release", exe);
const destDir = path.join(root, "dist", "bin");

if (!fs.existsSync(source)) {
  console.error(`[vite-plus-wrangler] Missing ${source}. Run \`cargo build --release\` first.`);
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(source, path.join(destDir, exe));
if (process.platform !== "win32") fs.chmodSync(path.join(destDir, exe), 0o755);

console.log(`[vite-plus-wrangler] Copied ${exe} to dist/bin/`);
