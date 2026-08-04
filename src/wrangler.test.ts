import { describe, expect, it } from "vitest";
import { d1Tasks } from "./d1.js";
import { wranglerTasks } from "./tasks.js";

describe("wranglerTasks", () => {
  it("emits the core Cloudflare task set", () => {
    const tasks = wranglerTasks({ config: "wrangler.jsonc" });
    expect(Object.keys(tasks)).toEqual(
      expect.arrayContaining(["cf:dev", "cf:deploy", "cf:preview", "cf:types", "cf:account"]),
    );
  });

  it("gates deploy behind the account check by default", () => {
    const tasks = wranglerTasks({ config: "wrangler.toml" }) as Record<
      string,
      { command: string | string[] }
    >;
    const deploy = tasks["cf:deploy"]!;
    expect(Array.isArray(deploy.command)).toBe(true);
    expect((deploy.command as string[])[0]).toContain("account-check");
  });

  it("skips the guard when explicitly disabled", () => {
    const tasks = wranglerTasks({ guardAccount: false }) as Record<string, { command: string }>;
    expect(tasks["cf:deploy"]!.command).toBe("wrangler deploy");
  });

  it("threads --env through every task", () => {
    const tasks = wranglerTasks({ env: "dev", config: "wrangler.toml" }) as Record<
      string,
      { command: string }
    >;
    expect(tasks["cf:dev"]!.command).toContain("--env dev");
    expect(tasks["cf:types"]!.command).toContain("--env dev");
  });

  it("adds D1 tasks only when a database is named", () => {
    expect(wranglerTasks({})).not.toHaveProperty("d1:migrate:local");
    expect(wranglerTasks({ d1: "leads" })).toHaveProperty("d1:migrate:local");
  });
});

describe("d1Tasks", () => {
  it("separates local, remote, and status", () => {
    const tasks = d1Tasks({ database: "leads", env: "dev" }) as Record<
      string,
      { command: string; cache: boolean }
    >;
    expect(tasks["d1:migrate:local"]!.command).toContain("--local");
    expect(tasks["d1:migrate:remote"]!.command).toContain("--remote");
    expect(tasks["d1:migrate:local"]!.cache).toBe(false);
  });
});
