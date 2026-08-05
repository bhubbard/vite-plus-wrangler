#!/usr/bin/env node
/**
 * Generate the per-platform `@vite-plus-wrangler/*` packages that carry the
 * prebuilt engine.
 *
 * Run once per target in CI, after `cargo build --release --target <triple>`:
 *
 *   node scripts/build-platform-packages.mjs --target aarch64-apple-darwin
 *
 * Produces `npm/<slug>/` containing a package.json and `bin/wrangler-rs`,
 * ready to `npm publish`. `os`/`cpu` fields mean npm installs only the one
 * matching the consumer's machine.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));

/** Rust target triple → npm package metadata. */
const TARGETS = {
  "aarch64-apple-darwin": { slug: "darwin-arm64", os: "darwin", cpu: "arm64" },
  "x86_64-apple-darwin": { slug: "darwin-x64", os: "darwin", cpu: "x64" },
  "x86_64-unknown-linux-gnu": { slug: "linux-x64", os: "linux", cpu: "x64" },
  "aarch64-unknown-linux-gnu": { slug: "linux-arm64", os: "linux", cpu: "arm64" },
  "x86_64-pc-windows-msvc": { slug: "win32-x64", os: "win32", cpu: "x64" },
};

const targetIndex = process.argv.indexOf("--target");
const target = targetIndex === -1 ? null : process.argv[targetIndex + 1];

if (!target || !TARGETS[target]) {
  console.error(
    `Usage: build-platform-packages.mjs --target <triple>\nKnown targets:\n` +
      Object.keys(TARGETS)
        .map((t) => `  - ${t}`)
        .join("\n"),
  );
  process.exit(2);
}

const { slug, os, cpu } = TARGETS[target];
const exe = os === "win32" ? "wrangler-rs.exe" : "wrangler-rs";
const built = path.join(root, "target", target, "release", exe);

if (!fs.existsSync(built)) {
  console.error(`Missing ${built}. Run: cargo build --release --target ${target}`);
  process.exit(1);
}

const outDir = path.join(root, "npm", slug);
const binDir = path.join(outDir, "bin");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(binDir, { recursive: true });

fs.copyFileSync(built, path.join(binDir, exe));
if (os !== "win32") fs.chmodSync(path.join(binDir, exe), 0o755);

fs.writeFileSync(
  path.join(outDir, "package.json"),
  `${JSON.stringify(
    {
      name: `@vite-plus-wrangler/${slug}`,
      version: pkg.version,
      description: `Prebuilt wrangler-rs engine for ${slug}.`,
      license: pkg.license,
      repository: pkg.repository,
      os: [os],
      cpu: [cpu],
      files: ["bin"],
    },
    null,
    2,
  )}\n`,
);

fs.writeFileSync(
  path.join(outDir, "README.md"),
  `# @vite-plus-wrangler/${slug}\n\n` +
    `Prebuilt \`wrangler-rs\` binary for ${slug}. Installed automatically as an\n` +
    `optional dependency of [\`vite-plus-wrangler\`](https://www.npmjs.com/package/vite-plus-wrangler).\n` +
    `You should not need to depend on this package directly.\n`,
);

console.log(`Built npm/${slug} (v${pkg.version})`);
