import { defineConfig } from "vite-plus";

/**
 * Single source of truth for build, lint, and test configuration.
 *
 * `package.json` scripts delegate here (`vp pack`, `vp check`) rather than
 * re-specifying entries and flags — two competing definitions of the same
 * build only stay in sync until the first time someone edits one of them.
 */
const IGNORED = ["dist/**", "target/**", "node_modules/**", "npm/**", "test/fixtures/**"];

export default defineConfig({
  fmt: {
    ignorePatterns: IGNORED,
  },
  lint: {
    ignorePatterns: IGNORED,
  },
  pack: {
    entry: ["src/index.ts", "src/cli.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
  staged: {
    "*": "vp check --fix",
  },
});
