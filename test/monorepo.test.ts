/**
 * Regression tests for path resolution across a monorepo.
 *
 * Every other fixture is a single Worker at the root of its own scan, which is
 * exactly why AUDIT-2 findings N-3, N-4 and N-5 survived the first fix pass:
 * none of them are observable unless a Worker lives in a subdirectory.
 *
 * These tests deliberately run with a `cwd` that is not the scan root.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { d1Tasks, migrationsDirFor } from "../src/d1.js";
import { wranglerTasks } from "../src/tasks.js";
import type { DiscoveredConfig } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const monorepo = path.join(here, "fixtures", "monorepo");

type Cmd = Record<string, { command: string | string[]; inputs?: string[] }>;

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

describe("N-3: the checked directory and the cache glob agree", () => {
  it("d1:migrate:check inspects exactly what it caches on", () => {
    const t = d1Tasks({ database: "leads", config: "workers/api/wrangler.toml" }) as Cmd;
    const checked = (t["d1:migrate:check"]!.command as string).split(" ").pop()!;
    const glob = t["d1:migrate:check"]!.inputs![0]!;
    expect(glob).toBe(`${checked}/**/*.sql`);
  });

  it("honours a non-default migrations_dir", () => {
    const t = d1Tasks({
      database: "hooks",
      config: "workers/webhooks/wrangler.jsonc",
      migrationsDir: "db/migrations",
    }) as Cmd;
    const checked = (t["d1:migrate:check"]!.command as string).split(" ").pop()!;
    expect(checked).toBe("workers/webhooks/db/migrations");
    expect(t["d1:migrate:check"]!.inputs![0]).toBe("workers/webhooks/db/migrations/**/*.sql");
  });
});

describe("N-4: cache keys stay portable", () => {
  it("no generated command embeds an absolute path", () => {
    const tasks = wranglerTasks({
      config: "workers/api/wrangler.toml",
      d1: "leads",
      env: "staging",
    }) as Cmd;
    for (const [name, def] of Object.entries(tasks)) {
      const commands = Array.isArray(def.command) ? def.command : [def.command];
      for (const c of commands) {
        expect(c, `${name} embeds an absolute path`).not.toContain(process.cwd());
        expect(c, `${name} embeds a home directory`).not.toMatch(/\/(Users|home)\//);
      }
      for (const input of def.inputs ?? []) {
        expect(path.isAbsolute(input), `${name} input is absolute`).toBe(false);
      }
    }
  });
});

describe("N-5: paths are relative to the scan root, not process.cwd()", () => {
  it("migrationsDirFor never rebases onto the cwd", () => {
    // The caller's cwd is irrelevant; the result must stay relative so the
    // task runner resolves it against the scan root at execution time.
    expect(migrationsDirFor("workers/api/wrangler.toml", "migrations")).toBe(
      "workers/api/migrations",
    );
    expect(migrationsDirFor("wrangler.toml", "migrations")).toBe("migrations");
    expect(migrationsDirFor(undefined, "migrations")).toBe("migrations");
  });

  it("an absolute migrations_dir is left alone", () => {
    expect(migrationsDirFor("workers/api/wrangler.toml", "/opt/migrations")).toBe("/opt/migrations");
  });
});

describe("discoverWranglerTasks fallback naming", () => {
  it("strips trailing -wrangler from unnamed worker paths", async () => {
    const { discoverWranglerTasks } = await import("../src/tasks.js");
    // Generate tasks for monorepo fixture where workers have explicit or fallback names
    const tasks = discoverWranglerTasks(monorepo);
    const prefixes = Array.from(new Set(Object.keys(tasks).map((k) => k.split("#")[0])));
    expect(prefixes).not.toContain("workers-api-wrangler");
    expect(prefixes).toEqual(expect.arrayContaining(["api", "webhooks"]));
  });
});


describe.skipIf(!binary)("engine against the monorepo fixture", () => {
  const discover = (root: string, cwd: string): DiscoveredConfig[] =>
    JSON.parse(
      execFileSync(binary as string, ["discover", root, "--json"], { encoding: "utf-8", cwd }),
    ) as DiscoveredConfig[];

  it("finds both Workers and ignores the config-less package", () => {
    const found = discover(monorepo, repoRoot);
    const names = found.map((f) => f.worker_name).sort();
    expect(names).toEqual(["api", "webhooks"]);
  });

  it("reports paths relative to the scan root regardless of cwd", () => {
    // Same scan root, two different working directories: the relative paths
    // must be identical, because that is what task prefixes are built from.
    const fromRepoRoot = discover(monorepo, repoRoot).map((f) => f.relative_path);
    const fromTmp = discover(monorepo, path.join(repoRoot, "test")).map((f) => f.relative_path);
    expect(fromRepoRoot).toEqual(fromTmp);
    expect(fromRepoRoot.sort()).toEqual([
      path.join("workers", "api", "wrangler.toml"),
      path.join("workers", "webhooks", "wrangler.jsonc"),
    ]);
  });

  it("the directory each generated task checks actually exists under the root", () => {
    for (const found of discover(monorepo, repoRoot)) {
      const migrationsDir =
        found.worker_name === "webhooks" ? "db/migrations" : "migrations";
      const rel = migrationsDirFor(found.relative_path, migrationsDir);
      const absolute = path.resolve(monorepo, rel);
      expect(fs.existsSync(absolute), `${rel} should exist under the scan root`).toBe(true);
    }
  });

  it("parses the jsonc Worker and its non-default migrations_dir", () => {
    const found = discover(monorepo, repoRoot).find((f) => f.worker_name === "webhooks")!;
    expect(found.d1_bindings).toEqual(["HOOKS"]);
    expect(found.error).toBeUndefined();
  });
});
