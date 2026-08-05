# Contributing

Thanks for taking a look. This package is half Rust and half TypeScript, so the
setup takes one extra step compared to a normal Node project.

## Setup

You will need Node 22.12+, pnpm, and a Rust toolchain ([rustup](https://rustup.rs)).

```bash
pnpm install
cargo build --release   # required: the integration tests need the engine
```

## Layout

| Path             | What it is                                                                     |
| ---------------- | ------------------------------------------------------------------------------ |
| `src/*.rs`       | The engine. Everything that touches the filesystem or parses config.           |
| `src/*.ts`       | A thin Node wrapper: task generation, the Vite plugin, and the CLI shim.       |
| `src/shell.ts`   | Shell-safe command construction. Read this before generating any command.      |
| `test/fixtures/` | Real wrangler configs and migration directories used by the integration tests. |
| `scripts/`       | Build and packaging helpers.                                                   |

The two halves must agree: `src/types.ts` describes the JSON the Rust binary
emits. Changing a `Serialize` struct means changing the matching interface, and
the integration tests in `test/engine.test.ts` are what catch it when you don't.

## Running things

```bash
pnpm test         # vitest (unit + integration)
cargo test        # Rust unit tests
pnpm typecheck    # tsc --noEmit
pnpm check        # oxlint + oxfmt
cargo clippy --all-targets -- -D warnings
cargo fmt --all
```

`pnpm test` will skip the integration tests with a warning if the engine has not
been built. CI treats that skip as a failure, so build first.

## House rules

**Never interpolate an unquoted value into a command string.** Use `quote()` and
`assertIdentifier()` from `src/shell.ts`. See [SECURITY.md](SECURITY.md).

**Fail closed on anything account-related.** If a check cannot run, it reports
failure. An ambiguous result must never read as approval — the whole point of
this package is that deploying to the wrong Cloudflare account is expensive to
undo.

**Prefer an error over a silent default.** A large share of the bugs in
[`AUDIT.md`](AUDIT.md) were fallbacks that hid a mistake: an unknown environment
name resolving to the default config, a bad `--depth` quietly becoming `6`, a
failed spawn reported as an empty result. When input is wrong, say so.

**Tests come with fixes.** Every bug fixed in the audit pass has a regression
test. Please keep that up.

## Commits and pull requests

Conventional Commits (`fix:`, `feat:`, `docs:`, `chore:`) are appreciated but not
enforced. In the PR description, say what changed and why; if it fixes something
from `AUDIT.md`, reference the finding id.
