# vite-plus-wrangler ⚡☁️

> Cloudflare Wrangler plugin and CLI for the [Vite+](https://viteplus.dev) toolchain. Task wiring with caching, account guards, D1 migration checks, and monorepo-wide config discovery.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Vite+](https://img.shields.io/badge/Toolchain-Vite%2B-7474FB)](https://viteplus.dev)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.12.0-brightgreen)](https://nodejs.org)

---

## Why

Wrangler is a great CLI and a poor build system. Every project ends up with its
own hand-rolled `dev`/`deploy`/`d1:migrate` scripts, its own account-id
handling, and no caching. This plugin moves all of that into `vite.config.ts`
so it is declared once and shared.

- 🎯 **Task wiring** — `cf:dev`, `cf:deploy`, `cf:preview`, `cf:types` as real `vp run` tasks with caching, inputs/outputs, and dependency ordering.
- 🔒 **Account guard** — a deploy fails closed when the config's `account_id` and `CLOUDFLARE_ACCOUNT_ID` disagree, or when neither is set.
- 🗃 **D1 migrations** — local/remote/status tasks plus prefix-ordering checks, because Wrangler applies migrations lexicographically.
- 🔎 **Config discovery** — parses every `wrangler.toml` / `.json` / `.jsonc` in a monorepo, resolving `[env.*]` inheritance.
- 🦀 **Rust core** — config parsing, discovery, and checks run in a single native binary; the Node layer is a thin wrapper.

---

## Installation

```bash
vp add -D vite-plus-wrangler
```

---

## Quick start

### Single Worker

```ts
import { defineConfig } from "vite-plus";
import { wrangler, wranglerTasks } from "vite-plus-wrangler";

export default defineConfig({
  plugins: [wrangler()],
  run: {
    tasks: wranglerTasks({
      config: "wrangler.jsonc",
      d1: "my-app-db",
      port: 8787,
    }),
  },
});
```

```bash
vp run cf:dev
vp run cf:deploy
```

### Monorepo

```ts
import { defineConfig } from "vite-plus";
import { wrangler, discoverWranglerTasks } from "vite-plus-wrangler";

export default defineConfig({
  plugins: [wrangler({ depth: 4 })],
  run: {
    tasks: discoverWranglerTasks(),
  },
});
```

Every discovered Worker gets namespaced tasks:

```bash
vp run api#cf:deploy
vp run webhooks#cf:dev
```

---

## Account guard

The single most valuable thing here. Deploying to the wrong Cloudflare account
is easy and expensive to undo.

| Config `account_id` | `CLOUDFLARE_ACCOUNT_ID` | Result |
| --- | --- | --- |
| set | set, same | ✅ proceed |
| set | set, different | ❌ **refuse** |
| set | unset | ✅ proceed, config wins |
| unset | set | ⚠️ proceed with warning |
| unset | unset | ❌ **refuse** |

```ts
import { assertAccount } from "vite-plus-wrangler";

assertAccount("wrangler.toml", { env: "production" });
```

Or standalone:

```bash
vite-plus-wrangler account-check wrangler.toml --env production
```

---

## D1 migrations

Wrangler orders migrations lexicographically, so `10_x.sql` sorts before
`9_x.sql`. The checker catches inconsistent prefix widths, duplicate prefixes,
sequence gaps, and non-conforming filenames.

```bash
vite-plus-wrangler migrations migrations
```

```ts
import { assertMigrations } from "vite-plus-wrangler";

assertMigrations("migrations");
```

Generated tasks: `d1:migrate:local`, `d1:migrate:remote`, `d1:migrate:status`,
`d1:migrate:check`.

---

## CLI

```bash
vite-plus-wrangler discover . --depth 4 --json
vite-plus-wrangler config workers/api/wrangler.toml --env dev --json
vite-plus-wrangler account-check wrangler.toml --expect <account-id>
vite-plus-wrangler migrations ./migrations --json
```

All commands accept `--json` for machine consumption. Exit codes are non-zero
on failure, so they drop straight into CI.

---

## Plugin options

| Option | Default | Description |
| --- | --- | --- |
| `root` | Vite root | Directory to scan for wrangler configs |
| `depth` | `6` | Max discovery depth |
| `env` | – | Wrangler environment to resolve |
| `guardAccount` | `true` | Run the account check on `buildStart` |
| `expectAccount` | config value | Explicit expected account id |
| `failOnError` | `true` | Fail the build when the guard trips |
| `checkMigrations` | `true` | Check D1 migration ordering on build |
| `exposeVars` | `false` | Expose `vars` as `import.meta.env.WRANGLER_*` |

---

## Dev server endpoint

With the plugin active, `GET /__wrangler/config` returns the discovered and
parsed configuration as JSON — useful for dashboards, IDE extensions, and
agents that need to reason about bindings without shelling out.

---

## Development

```bash
cargo build --release   # build the engine
pnpm build              # engine + TS bundle
pnpm test               # vitest
cargo test              # Rust unit tests
```

## License

MIT
