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

An environment name that is not declared in the config is an error, not a
fallback — `--env producton` fails loudly rather than quietly checking the
default environment.

**What the guard does not do:** it compares two declared values, the config's
`account_id` and `CLOUDFLARE_ACCOUNT_ID`. It does not contact Cloudflare, so it
cannot tell you that `CLOUDFLARE_API_TOKEN` is scoped to a different account
than the one those two agree on. It catches a stale env var from another
project, not a mis-scoped token.

---

## D1 migrations

Wrangler orders migrations lexicographically, so `10_x.sql` sorts before
`9_x.sql`. The checker catches inconsistent prefix widths, duplicate prefixes,
sequence gaps, and non-conforming filenames.

Both sequential (`0001_`) and timestamp (`20240101120000_`) prefixes are
supported. Gap warnings apply only to sequential numbering, since timestamps are
never contiguous.

`migrations_dir` is resolved relative to the wrangler config file, matching
Wrangler's own behavior.

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

All commands accept `--json` for machine consumption.

Exit codes: `0` success, `1` a finding (account mismatch, migration error, bad
config), `2` a usage error. A failure to start the engine also exits non-zero —
a guard that could not run never reports success.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Compared against the config by the account guard |
| `WRANGLER_RS_BIN` | Absolute path to a `wrangler-rs` binary, overriding resolution |

---

## Plugin options

| Option | Default | Description |
| --- | --- | --- |
| `root` | Vite root | Directory to scan for wrangler configs |
| `depth` | `6` | Max discovery depth (1–64) |
| `env` | – | Wrangler environment to resolve |
| `guardAccount` | `true` | Run the account check on `buildStart` |
| `expectAccount` | config value | Explicit expected account id |
| `failOnError` | `true` | Fail the build when the guard trips |
| `checkMigrations` | `true` | Check D1 migration ordering on build |
| `exposeVars` | `false` | Expose `vars` as `import.meta.env.WRANGLER_*` |
| `devEndpoint` | `false` | Serve `GET /__wrangler/config` from the dev server |

---

## Dev server endpoint

With `devEndpoint: true`, `GET /__wrangler/config` returns the discovered
configuration as JSON — useful for dashboards, IDE extensions, and agents that
need to reason about bindings without shelling out.

It is **off by default** because the response describes every Worker in the
repo. When enabled, account ids are redacted and requests are refused unless the
`Host` header is localhost, which blocks DNS-rebinding reads from a page in your
browser. Even so, do not enable it on a dev server started with `--host`.

---

## Installation internals

The engine is a native binary. It ships as a set of per-platform packages
(`@vite-plus-wrangler/darwin-arm64`, `linux-x64`, `win32-x64`, …) declared as
`optionalDependencies`, so your package manager downloads only the one matching
your machine.

On a platform with no prebuilt binary, `postinstall` builds from source with
`cargo`. If Rust is not installed, the install still succeeds and the engine
reports a specific error the first time it is needed. To use a binary you built
yourself, set `WRANGLER_RS_BIN`.

---

## Development

```bash
pnpm install
cargo build --release   # required: the integration tests need the engine
pnpm build              # engine + TS bundle
pnpm test               # vitest (unit + integration)
cargo test              # Rust unit tests
pnpm typecheck          # tsc --noEmit
pnpm check              # oxlint + oxfmt
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout and house rules,
[SECURITY.md](SECURITY.md) for the threat model, and [AUDIT.md](AUDIT.md) for
the review this codebase has been through.

## License

MIT
