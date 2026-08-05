#!/usr/bin/env node
/**
 * Fallback engine build.
 *
 * The happy path is a prebuilt `@vite-plus-wrangler/<platform>` package pulled
 * in as an optionalDependency. This script covers the two cases that misses:
 * an unsupported platform, and installing straight from a git checkout.
 *
 * It never fails the install. A missing engine surfaces later as a clear,
 * actionable error from `getBinaryPath()`; taking down `npm install` for a
 * transitive dependency of a dependency would be worse.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "wrangler-rs.exe" : "wrangler-rs";

const PLATFORM_PACKAGES = {
  "darwin-arm64": "@vite-plus-wrangler/darwin-arm64",
  "darwin-x64": "@vite-plus-wrangler/darwin-x64",
  "linux-x64": "@vite-plus-wrangler/linux-x64",
  "linux-arm64": "@vite-plus-wrangler/linux-arm64",
  "win32-x64": "@vite-plus-wrangler/win32-x64",
};

function log(message) {
  console.log(`[vite-plus-wrangler] ${message}`);
}

/**
 * Does a *working* engine already exist?
 *
 * Checks that the candidate runs, not merely that it exists. A binary built
 * for another architecture passes `existsSync` and fails only at exec time —
 * which would make this script skip the source build and leave the user with
 * a permanently broken install and a misleading error.
 */
function runnable(file) {
  if (!fs.existsSync(file)) return false;
  const res = spawnSync(file, ["--version"], { stdio: "ignore", timeout: 10_000 });
  return !res.error && res.status === 0;
}

function alreadyPresent() {
  const pkg = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];

  if (pkg) {
    try {
      // Resolved relative to this package, matching what rust.ts does.
      if (runnable(require.resolve(`${pkg}/bin/${exe}`))) return true;
    } catch {
      // Not installed; keep looking.
    }
  }

  return ["dist/bin", "target/release"].some((dir) => runnable(path.join(root, dir, exe)));
}

function hasCargo() {
  const res = spawnSync("cargo", ["--version"], { stdio: "ignore" });
  return res.status === 0;
}

function main() {
  if (alreadyPresent()) return;

  if (!hasCargo()) {
    log(
      `No prebuilt binary for ${process.platform}-${process.arch} and cargo is not installed.\n` +
        `  Install Rust (https://rustup.rs) and run \`cargo build --release\` in this package,\n` +
        `  or set WRANGLER_RS_BIN to an existing wrangler-rs binary.`,
    );
    return;
  }

  log("No prebuilt binary for this platform — building from source with cargo...");
  const res = spawnSync("cargo", ["build", "--release"], { cwd: root, stdio: "inherit" });

  if (res.status !== 0) {
    log("cargo build failed. Run `cargo build --release` manually to see the error.");
    return;
  }

  const built = path.join(root, "target", "release", exe);
  const destDir = path.join(root, "dist", "bin");
  if (fs.existsSync(built)) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(built, path.join(destDir, exe));
    if (process.platform !== "win32") fs.chmodSync(path.join(destDir, exe), 0o755);
    log("Engine built.");
  }
}

try {
  main();
} catch (err) {
  log(`Postinstall skipped: ${err.message}`);
}
