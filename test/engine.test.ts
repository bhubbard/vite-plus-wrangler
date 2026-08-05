/**
 * Integration tests: the real Rust binary against the real fixtures.
 *
 * These are the tests that catch parity drift between the two halves of the
 * package — a change to the Rust JSON shape that the TypeScript types no
 * longer describe shows up here and nowhere else.
 *
 * They are skipped, loudly, when the engine has not been built.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type {
  AccountCheck,
  BundleSizeReport,
  CodeBindingsReport,
  DiscoveredConfig,
  LintReport,
  MigrationReport,
  SecretsReport,
  WranglerConfig,
} from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixture = path.join(here, "fixtures", "basic-worker");

function findBinary(): string | null {
  if (process.env.WRANGLER_RS_BIN && fs.existsSync(process.env.WRANGLER_RS_BIN)) {
    return process.env.WRANGLER_RS_BIN;
  }
  const exe = process.platform === "win32" ? "wrangler-rs.exe" : "wrangler-rs";
  for (const dir of ["dist/bin", "target/release", "target/debug"]) {
    const candidate = path.join(repoRoot, dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const binary = findBinary();

/** Run the engine, tolerating the non-zero exits that signal a finding. */
function engine(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(binary as string, args, { encoding: "utf-8" });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

function json<T>(args: string[]): { data: T; status: number } {
  const { stdout, status } = engine([...args, "--json"]);
  return { data: JSON.parse(stdout) as T, status };
}

describe.skipIf(!binary)("engine integration", () => {
  beforeAll(() => {
    if (!binary) return;
    // Fail fast with a useful message rather than a confusing parse error.
    expect(fs.existsSync(fixture)).toBe(true);
  });

  describe("config", () => {
    it("parses the fixture and resolves bindings", () => {
      const { data } = json<WranglerConfig>(["config", path.join(fixture, "wrangler.toml")]);
      expect(data.name).toBe("basic-worker");
      expect(data.account_id).toBe("0123456789abcdef0123456789abcdef");
      expect(data.d1_databases).toHaveLength(1);
      expect(data.d1_databases[0]!.binding).toBe("DB");
    });

    it("serializes absent lists as arrays, never null", () => {
      const { data } = json<WranglerConfig>(["config", path.join(fixture, "wrangler.toml")]);
      expect(Array.isArray(data.kv_namespaces)).toBe(true);
      expect(Array.isArray(data.compatibility_flags)).toBe(true);
    });

    it("inherits account_id into an environment that omits it", () => {
      const { data } = json<WranglerConfig>([
        "config",
        path.join(fixture, "wrangler.toml"),
        "--env",
        "dev",
      ]);
      expect(data.name).toBe("basic-worker-dev");
      expect(data.account_id).toBe("0123456789abcdef0123456789abcdef");
    });

    it("lets an environment override account_id", () => {
      const { data } = json<WranglerConfig>([
        "config",
        path.join(fixture, "wrangler.toml"),
        "--env",
        "staging",
      ]);
      expect(data.account_id).toBe("fedcba9876543210fedcba9876543210");
    });

    it("fails on an unknown environment instead of silently using the default", () => {
      const { status } = engine(["config", path.join(fixture, "wrangler.toml"), "--env", "nope"]);
      expect(status).not.toBe(0);
    });
  });

  describe("discover", () => {
    it("finds the fixture worker", () => {
      const { data } = json<DiscoveredConfig[]>(["discover", fixture]);
      expect(data).toHaveLength(1);
      expect(data[0]!.worker_name).toBe("basic-worker");
      expect(data[0]!.d1_bindings).toEqual(["DB"]);
      expect(data[0]!.environments).toEqual(["default", "dev", "staging"]);
    });

    it("rejects a depth of zero rather than silently finding nothing", () => {
      const { status } = engine(["discover", fixture, "--depth", "0"]);
      expect(status).toBe(2);
    });
  });

  describe("account-check", () => {
    it("passes when the env var matches the config", () => {
      const stdout = execFileSync(
        binary as string,
        ["account-check", path.join(fixture, "wrangler.toml"), "--json"],
        {
          encoding: "utf-8",
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" },
        },
      );
      const data = JSON.parse(stdout) as AccountCheck;
      expect(data.ok).toBe(true);
      expect(data.status).toBe("ok");
    });

    it("refuses, with a non-zero exit, when they disagree", () => {
      let status = 0;
      let stdout = "";
      try {
        stdout = execFileSync(
          binary as string,
          ["account-check", path.join(fixture, "wrangler.toml"), "--json"],
          {
            encoding: "utf-8",
            env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "ffffffffffffffffffffffffffffffff" },
          },
        );
      } catch (err) {
        const e = err as { stdout?: string; status?: number };
        stdout = e.stdout ?? "";
        status = e.status ?? 1;
      }
      expect(status).toBe(1);
      const data = JSON.parse(stdout) as AccountCheck;
      expect(data.ok).toBe(false);
      expect(data.status).toBe("mismatch");
    });

    it("checks the environment's own account when --env overrides it", () => {
      const stdout = execFileSync(
        binary as string,
        ["account-check", path.join(fixture, "wrangler.toml"), "--env", "staging", "--json"],
        {
          encoding: "utf-8",
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "fedcba9876543210fedcba9876543210" },
        },
      );
      expect((JSON.parse(stdout) as AccountCheck).ok).toBe(true);
    });
  });

  describe("migrations", () => {
    it("passes on the clean fixture sequence", () => {
      const { data, status } = json<MigrationReport>([
        "migrations",
        path.join(fixture, "migrations"),
      ]);
      expect(status).toBe(0);
      expect(data.ok).toBe(true);
      expect(data.count).toBe(2);
    });

    it("accepts timestamp prefixes without calling them duplicates", () => {
      const { data, status } = json<MigrationReport>([
        "migrations",
        path.join(here, "fixtures", "timestamp-migrations"),
      ]);
      expect(status).toBe(0);
      expect(data.ok).toBe(true);
      expect(data.migrations[0]!.index).toBe(20240101120000);
    });

    it("reports mixed prefix widths as an error with a non-zero exit", () => {
      const { data, status } = json<MigrationReport>([
        "migrations",
        path.join(here, "fixtures", "broken-migrations"),
      ]);
      expect(status).toBe(1);
      expect(data.ok).toBe(false);
      expect(data.issues.some((i) => i.message.includes("Inconsistent prefix widths"))).toBe(true);
    });
  });

  describe("secrets-check", () => {
    it("reports missing .dev.vars as warning", () => {
      const { data, status } = json<SecretsReport>([
        "secrets-check",
        path.join(fixture, "wrangler.toml"),
      ]);
      expect(status).toBe(0);
      expect(data.ok).toBe(true);
      expect(data.issues.some((i) => i.message.includes(".dev.vars"))).toBe(true);
    });
  });

  describe("bundle-check", () => {
    it("reports non-existent path as error", () => {
      const { data, status } = json<BundleSizeReport>(["bundle-check", "non_existent_dist"]);
      expect(status).toBe(1);
      expect(data.ok).toBe(false);
      expect(data.exists).toBe(false);
      expect(data.issues.some((i) => i.message.includes("does not exist"))).toBe(true);
    });

    it("respects custom limit-mb flag", () => {
      const { data, status } = json<BundleSizeReport>([
        "bundle-check",
        "non_existent_dist",
        "--limit-mb",
        "10",
      ]);
      expect(status).toBe(1);
      expect(data.limit_mb).toBe(10);
      expect(data.limit_bytes).toBe(10485760);
    });
  });

  describe("lint", () => {
    it("lints a valid config file", () => {
      const { data, status } = json<LintReport>(["lint", path.join(fixture, "wrangler.toml")]);
      expect(status).toBe(0);
      expect(data.ok).toBe(true);
    });

    it("reports errors on non-existent config path", () => {
      const { data, status } = json<LintReport>(["lint", "non_existent.toml"]);
      expect(status).toBe(1);
      expect(data.ok).toBe(false);
      expect(data.issues.some((i) => i.message.includes("not found"))).toBe(true);
    });
  });

  describe("bindings-check", () => {
    it("detects codebase AST bindings against config", () => {
      const { data } = json<CodeBindingsReport>([
        "bindings-check",
        path.join(fixture, "wrangler.toml"),
        "--src",
        path.join(fixture, "src"),
      ]);

      expect(data.config_path).toContain("wrangler.toml");
      expect(Array.isArray(data.referenced_bindings)).toBe(true);
    });
  });

  describe("argument handling", () => {
    it("rejects a flag with no value", () => {
      expect(engine(["config", path.join(fixture, "wrangler.toml"), "--env"]).status).toBe(2);
    });

    it("rejects an unknown option", () => {
      expect(engine(["discover", fixture, "--recursive"]).status).toBe(2);
    });
  });
});

describe.skipIf(binary)("engine integration (skipped)", () => {
  it("reports why it was skipped", () => {
    console.warn(
      "Integration tests skipped: wrangler-rs not built. Run `cargo build --release` first.",
    );
    expect(binary).toBeNull();
  });
});
