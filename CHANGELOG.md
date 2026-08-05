# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First pass over the findings in [`AUDIT.md`](AUDIT.md).

### Security

- **Task commands are now shell-quoted.** Every value interpolated into a generated
  command (`database`, `env`, `config`, `port`, extra args) passes through
  `quote()`, and identifier-shaped fields are validated rather than escaped.
  Previously a config value containing `;` or `$(...)` ran arbitrary commands, and
  an ordinary path containing a space silently split into two arguments.
- **The dev-server endpoint is opt-in.** `GET /__wrangler/config` now requires
  `devEndpoint: true`, refuses non-localhost requests (blocking DNS rebinding),
  and redacts `account_id`. It previously served every account id in the repo to
  anyone who could reach a `vite --host` dev server.
- **Replaced the account id in `test/fixtures/basic-worker`** with an obvious
  placeholder.
- **Removed the `PATH` fallback for the engine binary.** An unresolved engine is
  now a specific error instead of an attempt to execute whatever `wrangler-rs`
  happens to be on the machine.

### Fixed

- **`exposeVars` produced no defines at all.** Discovery ran in `configResolved`,
  but the `define` values were read in `config`, which Vite calls first — so the
  list was always empty. Discovery moved into `config`.
- **Timestamp-prefixed migrations were reported as duplicates.** Prefixes such as
  `20240101120000` overflow `u32`; the parse failure fell back to index `0`, so
  every file after the first looked like a duplicate. Indices are now `u64`, and
  gap detection is skipped for timestamp-style prefixes.
- **An unknown `--env` silently resolved to the top-level config.** `--env producton`
  reported a passing account check against the *default* environment. Unknown
  environment names are now an error listing the ones that exist.
- **`migrations_dir` resolved against the wrong base.** Wrangler treats it as
  relative to the config file; the plugin resolved it against the Vite root, which
  failed the build for any Worker in a subdirectory.
- **The CLI exited 0 when the engine could not start.** `spawnSync` reports `null`
  status both for a failed spawn and for a signal kill; both now exit 1. The
  account guard could previously "pass" in CI without having run.
- **Engine failures were silent.** `spawnSync`'s `error`, `signal`, `status`, and
  `stderr` were all discarded, so a missing binary was indistinguishable from a
  repo containing no Workers. Failures now surface, and `loadConfig` /
  `discoverConfigs` throw (with `*Safe` variants that warn).
- **Duplicate task prefixes silently overwrote each other** in
  `discoverWranglerTasks`. Two Workers named `api` meant `api#cf:deploy` deployed
  whichever sorted last. Now an error.
- **`cf:account` assumed `wrangler.toml`** regardless of the config in use, so
  `wrangler.jsonc` projects got a check pointed at a non-existent file.
- **Cache inputs used absolute paths**, which do not survive a different checkout
  directory or CI runner.
- **A directory holding two wrangler configs produced two entries** with no
  precedence rule. Precedence is now `toml` → `jsonc` → `json`, with the ignored
  siblings reported as `shadowed`.
- **Environments could not opt out of inherited bindings.** `d1_databases = []`
  was indistinguishable from omitting the key, so the parent's bindings were
  inherited anyway.
- **Invalid CLI flags were silently defaulted.** A trailing `--env`, or
  `--depth abc`, quietly used a default; `--depth 0` made discovery always return
  empty. All are now errors.

### Added

- Per-platform prebuilt binaries published as `@vite-plus-wrangler/*`
  `optionalDependencies`, with a `postinstall` that builds from source as a
  fallback. Previously the published tarball carried a single binary that worked
  only on the platform it was published from.
- GitHub Actions CI (Rust + Node across Linux, macOS, Windows) and a release
  workflow that cross-compiles and publishes the platform packages.
- Integration tests that run the real engine against `test/fixtures/`, which
  existed but were referenced by nothing. CI fails if they skip.
- Rust unit tests for migration prefix hygiene, discovery, config merging, and
  argument parsing.
- `AUDIT.md` recording the review these changes came from.
