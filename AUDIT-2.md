# Second audit — `vite-plus-wrangler`

**Date:** 2026-08-04
**Subject:** the codebase *after* the [AUDIT.md](AUDIT.md) fix pass
**Bias disclosure:** the same author wrote both the code under review and the previous audit. To compensate, findings here are weighted toward things that could be **reproduced by execution** rather than by re-reading the code. Every 🔴/🟠/🟡 finding below has a runnable repro.

**Environment:** Rust 1.97.1 and Node 22.22.3 installed; the engine was compiled and executed against real fixtures, real `/bin/sh`, and synthetic monorepos of up to 4,000 Workers.

> **Status:** the blockers (N-1, N-2, N-3, N-4, N-5, N-6, N-11) are fixed and verified, along with **H-3**, a test-harness race condition reported by an independent review that this audit missed. Remaining open: N-7, N-8, N-9, N-10, N-12 — all Low. See "Resolution log" at the end.

---

## Summary

| Severity | Count |
| --- | --- |
| 🟠 High | 2 |
| 🟡 Medium | 4 |
| 🔵 Low | 6 |

**Six of the twelve findings are regressions introduced by the first fix pass.** That is the headline. The first audit's diagnoses were sound, but three of its fixes traded one bug for another — most importantly, the packaging fix (H-2) is defeated by the release workflow it shipped alongside, and the `migrations_dir` fix (M-4) broke the cache-portability fix (M-8) in the same commit.

### What held up

Worth stating plainly, because these were the highest-risk changes:

| Area | Verification | Result |
| --- | --- | --- |
| `quote()` shell escaping | 41 hostile values round-tripped through real `/bin/sh` | **exact match on all 41** |
| Injection rejection | `$(id)`, backticks, `;`, `\|`, `&`, newlines, `'`, unicode | never executed |
| JSONC parser | 17 adversarial inputs (comment markers in strings, escaped quotes, `*/` in a string, unterminated constructs) | correct on all |
| Dev-endpoint `Host` allowlist | 10 rebinding/spoofing attempts | all denied; fails closed |
| Rust→TS JSON contract | every field of all three payloads compared to `types.ts` | no drift |
| Config precedence | directory with all three config filenames | one entry, correct winner, both siblings reported |

---

## 🟠 High

### N-1 — The release workflow re-ships the single-platform binary that H-2 removed

**Files:** `.github/workflows/release.yml:103`, `package.json` (`build` → `build:bin`, `files: ["dist", …]`)

`release.yml` runs `pnpm build` before `npm publish`. `build` is `pnpm build:cargo && vp pack && pnpm build:bin`, and `build:bin` copies `target/release/wrangler-rs` into `dist/bin/`. Because `files` includes `dist`, that binary lands in the published tarball — built on `ubuntu-latest`, so it is a Linux x64 binary shipped to every consumer.

Verified with `npm pack --dry-run` on a simulated post-build tree:

```
npm notice 3.6MB dist/bin/wrangler-rs
npm notice unpacked size: 3.7 MB
```

This is the exact condition H-2 was raised to eliminate, and it makes the rest of the H-2 machinery worse rather than merely redundant:

1. **Every install downloads 3.6 MB it does not need** — the platform packages already provide the right binary.
2. **The source-build fallback never runs on unsupported platforms.** `scripts/postinstall.mjs:50` decides via `fs.existsSync(dist/bin/wrangler-rs)`, which cannot tell one architecture from another. On, say, `linux-arm` or FreeBSD, the stray Linux x64 binary makes `alreadyPresent()` return `true`, so `cargo build` is skipped.
3. **The helpful error never fires.** `getBinaryPath()` also uses `existsSync`, finds `dist/bin/wrangler-rs`, and hands it to `spawnSync`. The user gets a generic exec failure instead of "no prebuilt binary is published for your platform; install Rust".

So on an unsupported platform the package is permanently broken, silently, in a way the previous design would have handled.

**Fix:** drop `build:bin` from the publish path — `release.yml` should run `vp pack` only. Additionally, make `alreadyPresent()` and `getBinaryPath()` verify the binary actually runs (`spawnSync(candidate, ["--version"])`) rather than merely existing, so an arch mismatch is detected rather than assumed away.

---

### N-2 — CI cannot pass as written: `--frozen-lockfile` with no lockfile

**Files:** `.github/workflows/ci.yml:61`, `.github/workflows/release.yml:78`

Both workflows run `pnpm install --frozen-lockfile`, and no `pnpm-lock.yaml` is committed. `--frozen-lockfile` fails when the lockfile is absent, so **every run of both workflows fails at the install step** — before any test, lint, or publish executes.

This was listed as follow-up #4 in the first audit, which understated it: a release pipeline that cannot reach its publish step is not a follow-up, and the CI green-check that the first audit's verification section implicitly promises would never appear.

**Fix:** run `pnpm install` locally and commit `pnpm-lock.yaml`. Until then the workflows are decorative.

---

## 🟡 Medium

### N-3 — `d1:migrate:check` checks one directory and caches on another

**File:** `src/d1.ts:69-73`

```ts
"d1:migrate:check": {
  command: join("vite-plus-wrangler", "migrations", quote(checkDir)),  // absolute
  cache: true,
  inputs: [`${dir}/**/*.sql`],                                          // relative
}
```

`checkDir` is absolutized by `resolveMigrationsDir` (the M-4 fix); `inputs` stays relative (the M-8 fix). For any Worker not at the repo root the two point at different places. Reproduced with `config: "workers/api/wrangler.toml"`:

```
checked : /<cwd>/workers/api/migrations
globDir : /<cwd>/migrations
```

The task therefore caches against a directory it never inspects. Editing a real migration does not invalidate the cache, so **`d1:migrate:check` reports a stale pass** — a caching bug in the one task whose entire job is catching migration mistakes.

### N-4 — The same absolute path defeats cache portability

**File:** `src/d1.ts:70`

The `d1:migrate:check` command string now embeds an absolute path (`vite-plus-wrangler migrations /Users/you/repo/workers/api/migrations`). Task runners hash the command into the cache key, so the key differs on every machine and CI runner — precisely the failure M-8 was raised to fix, reintroduced two files away by the M-4 fix.

M-8's own regression test only checks `cf:types` inputs, so it does not catch this.

**Fix for N-3 and N-4 together:** keep the command relative and let the task's working directory do the work, or emit both the command path and the input glob from one resolved-relative value so they cannot diverge.

### N-5 — `discoverWranglerTasks(root)` resolves migrations against `process.cwd()`, not `root`

**Files:** `src/tasks.ts:137`, `src/d1.ts:36`

`discoverWranglerTasks` passes `found.relative_path` — relative to the **scan root** — into `wranglerTasks`, which forwards it to `resolveMigrationsDir`, which resolves it against `process.cwd()`. When the scan root is not the cwd, the result is wrong. Reproduced:

```
scan root      : /srv/monorepo
process.cwd()  : /tmp/vpwcheck
should check   : /srv/monorepo/workers/api/migrations
actually checks: /tmp/vpwcheck/workers/api/migrations
```

The plugin path is unaffected (it passes the absolute `target.path`), so this only bites callers who pass an explicit `root` to `discoverWranglerTasks` — which is the documented monorepo entry point.

**Fix:** thread the scan root through, or have the engine emit a root-relative path plus the root so callers can rejoin them.

### N-6 — `spawnSync` has no `maxBuffer`, and the failure is misreported

**File:** `src/rust.ts:161`

The default `maxBuffer` is 1 MB. Measured against synthetic monorepos, `discover --json` crosses it at roughly **3,300 Workers**:

| Workers | Output | Result |
| --- | --- | --- |
| 2,500 | 742 KB | parses, 2500 entries |
| 4,000 | 1.19 MB | `ENOBUFS`, `SIGTERM`, stdout truncated to 1,114,112 bytes |

`run()` checks `res.error` first, so this surfaces as `Failed to run <binary>: spawnSync ENOBUFS` — which reads like a broken binary, not "output too large". Downstream, `discoverConfigsSafe` warns and returns `[]`, so **the plugin silently sees zero Workers** in the largest repos, the ones this package is aimed at.

4,000 Workers is unrealistic, but the same limit applies to `config --json` on a config with large `vars`, and the diagnostic is wrong in every case.

**Fix:** pass `maxBuffer: 64 * 1024 * 1024`, and special-case `ENOBUFS` with a message naming the real cause. Consider a `timeout` at the same time — there is currently none, so a hung engine hangs the build indefinitely.

---

## 🔵 Low

| ID | File | Finding | Repro |
| --- | --- | --- | --- |
| N-7 | `src/discovery.rs:69` | `walker.flatten()` discards every `WalkDir` error, so a nonexistent root, a path that is a file, and an unreadable directory all return `[]` with exit 0. A typo in `root` is indistinguishable from a repo with no Workers — the same fail-open pattern H-3 fixed one layer up. | `wrangler-rs discover /nope/not/here --json` → `[]`, exit 0 |
| N-8 | `src/plugin.ts:15-23` | The `Host` allowlist is case-sensitive and rejects a trailing dot, so `LOCALHOST:5173` and `localhost.:5173` are refused. Both are valid per RFC 9110. Fails closed, so this is usability, not security. | `isLocalRequest("LOCALHOST:5173")` → `false` |
| N-9 | `src/tasks.ts:123` | The unnamed-Worker fallback strips the extension *after* replacing separators, so `workers/api/wrangler.toml` becomes the task prefix `workers-api-wrangler`. The trailing `-wrangler` is noise; the directory name is what identifies the Worker. | `"workers/api/wrangler.toml".replace(/[/\\]/g,"-").replace(/\.(toml\|jsonc?)$/,"")` → `workers-api-wrangler` |
| N-10 | `package.json` | `build:bin` and `build:platform` reference `scripts/copy-binary.mjs` and `scripts/build-platform-packages.mjs`, neither of which is in `files`. `npm run build` in an installed copy fails on a missing script. | `files` lists only `scripts/postinstall.mjs` |
| N-11 | `.github/workflows/ci.yml:75,82` | `pnpm test` runs twice — once for results, once piped to `grep` for the skip check — doubling the Node job's runtime on all three OSes. The second run also omits `WRANGLER_RS_BIN` and only finds the engine because `../target/release` happens to resolve from `src/`. | two `pnpm test` invocations in one job |
| N-12 | `src/migrations.rs` | Gap detection is gated on `prefix.len() <= 6`, so a project using 7-digit sequential prefixes silently loses gap warnings. The heuristic conflates "wide" with "timestamp". | prefixes `0000001`…`0000009` produce no gap warning |

---

## Notes on the first audit's verification claims

Worth recording, since the first audit asserted a clean bill of health:

- **"All green" was accurate but narrow.** The suite genuinely passed. It did not cover the release workflow's output (N-1), the interaction between two fixes in different files (N-3, N-4, N-5), or any input larger than a two-Worker fixture (N-6).
- **The M-8 regression test was too specific.** It asserts `cf:types` inputs are relative. It does not look at `d1:migrate:check`, which is where the absolute path reappeared.
- **Integration tests only ever ran against `test/fixtures/basic-worker`,** a single Worker at the fixture root. Every path-resolution bug found here needs a Worker in a *subdirectory* to appear.

---

## Suggested order of work

1. **N-2** — commit the lockfile. Nothing else in CI is real until this is done.
2. **N-1** — remove `build:bin` from the publish path, and verify with `npm pack --dry-run` that `dist/bin/` is absent. Blocks any release.
3. **N-3 / N-4 / N-5** — one fix: make the migrations path relative and single-sourced, then add a fixture with a Worker in a subdirectory so the regression tests can actually see it.
4. **N-6** — `maxBuffer` and `timeout`; two lines.
5. **N-7** — surface `WalkDir` errors, and make a nonexistent root a non-zero exit.
6. Low findings as convenient.

### Test-suite gap to close alongside

The bugs above share a root cause: **every fixture is a single Worker at the root of its scan.** Before fixing N-3/N-4/N-5, add a `test/fixtures/monorepo/` with at least two Workers in subdirectories, one with a non-default `migrations_dir`, and run `discoverWranglerTasks` against it from a different cwd. That one fixture would have caught four of the six regressions.


---

## Resolution log

### H-3 — TempDir race in the Rust test helpers (reported independently; missed by this audit)

**Files:** `src/testutil.rs` (new), `src/migrations.rs`, `src/discovery.rs`, `src/lib.rs`

The helper generated directory names from `process::id()` plus
`SystemTime::now().as_nanos()`. `cargo test` runs a binary's tests as threads in
one process, so the pid contributes nothing and uniqueness rested entirely on
clock resolution. Measured with 16 threads generating 32,000 names:

| Clock resolution | Collisions |
| --- | --- |
| 1 ns (typical Linux) | 63 – 710 depending on contention |
| ~1 µs (typical macOS) | 25,751 |
| **Atomic counter (the fix)** | **0** |

The failure was silent rather than loud: `create_dir_all` succeeds on an
existing directory, so two tests shared one directory and each saw the other's
fixtures. Reproduced — a migrations test reported `Inconsistent prefix widths`
over files it never created.

**Fix:** one shared `TempDir` in `src/testutil.rs` keyed on a process-wide
`AtomicU64`, using `create_dir` (not `create_dir_all`) so any future collision
panics instead of silently sharing. Verified with a 400-way concurrent
uniqueness test and **25 consecutive `cargo test` runs at `RUST_TEST_THREADS=32`,
all green**.

The gap worth naming: this audit checked what the tests *assert*, never
whether the harness itself was sound.

### N-1 — Native binary in the published tarball

**Fixed.** `files` now carries `"!dist/bin"`, `release.yml` runs `build:dist`
(`vp pack` only) instead of `pnpm build`, and a pack-time guard fails the
release if `dist/bin` ever appears. Both `getBinaryPath()` and
`postinstall.mjs` now confirm a candidate binary *runs* (`--version`) rather
than merely existing, so a wrong-architecture binary no longer suppresses the
source-build fallback.

Verified with `npm pack --dry-run` against a tree that *does* contain a 3.6 MB
binary at `dist/bin/wrangler-rs`:

| | Before | After |
| --- | --- | --- |
| Tarball unpacked size | 3.7 MB | **72.2 kB** |
| `dist/bin` present | yes | **no** |

### N-2 — CI could not install: `--frozen-lockfile` with no lockfile

**Fixed, and the root cause was deeper than reported.** Committing a lockfile
alone does not work. The `@vite-plus-wrangler/*` packages in
`optionalDependencies` have never been published, so:

1. `pnpm install` silently drops them (E404 on an optional dep is not fatal).
2. They therefore never reach `pnpm-lock.yaml`.
3. `pnpm install --frozen-lockfile` then fails with
   `ERR_PNPM_OUTDATED_LOCKFILE — 5 dependencies were added`.
4. CI cannot install, so the release that would publish them never runs.

A bootstrap deadlock: the lockfile cannot be made valid until the packages
exist, and the packages cannot be published until CI works. Reproduced end to
end with pnpm 11.20.0.

**Fix:** `optionalDependencies` moved out of the committed manifest (with a
comment explaining why) and injected at publish time by
`scripts/set-optional-deps.mjs`, which `release.yml` runs *after* the platform
packages are published. `pnpm-lock.yaml` is now committed and
`pnpm install --frozen-lockfile` passes.

### N-3, N-4, N-5 — Migrations path resolution

**Fixed as one change.** New `migrationsDirFor()` joins `migrations_dir` onto
the config's directory *without* resolving against `process.cwd()`, so relative
in means relative out. `d1Tasks` derives both the command and the cache
`inputs` glob from that single value, so they cannot disagree (N-3), the path
stays relative and the cache key stays portable (N-4), and a path relative to
the scan root is never rebased onto the cwd (N-5). `resolveMigrationsDir()`
remains for the plugin, which needs an absolute path at runtime.

### N-6 — `spawnSync` buffer and timeout

**Fixed.** `maxBuffer: 64 MB` and `timeout: 60s`, with `ENOBUFS` and `ETIMEDOUT`
translated into messages that name the real cause instead of reading as a
broken binary.

### N-11 — CI ran the test suite twice

**Fixed.** One run, `tee`'d to a log that the skip-check greps.

### Test coverage added

`test/fixtures/monorepo/` — two Workers in subdirectories, one on
`wrangler.jsonc` with a non-default `migrations_dir`, plus a package with no
config that must not be discovered. `test/monorepo.test.ts` exercises it from a
cwd that is not the scan root.

This is the fixture whose absence let N-3, N-4 and N-5 through: every previous
fixture was a single Worker at the root of its own scan, and none of those bugs
are observable in that shape.

### Verification

| Check | Result |
| --- | --- |
| `cargo test` | 38 passing (31 lib + 7 bin) |
| `cargo test` × 25 at `RUST_TEST_THREADS=32` | 25/25 green — no flakes |
| `cargo clippy --all-targets -- -D warnings` | 0 errors |
| `cargo fmt --all -- --check` | clean |
| `tsc --noEmit` (strict + `noUncheckedIndexedAccess`) | clean |
| `vitest run` | 47 passing, 1 skipped |
| `pnpm install --frozen-lockfile` | passes |
| `npm pack --dry-run` with a binary in `dist/bin` | 72.2 kB, no `dist/bin` |

### Still open (all Low)

N-7 (`WalkDir` errors swallowed — a nonexistent root returns `[]` with exit 0),
N-8 (`Host` allowlist is case-sensitive), N-9 (fallback task prefix keeps a
`-wrangler` suffix), N-10 (`build:bin` / `build:platform` reference scripts not
shipped in `files`), N-12 (gap detection gated on prefix width ≤ 6).
