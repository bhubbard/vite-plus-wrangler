---
name: deploying-with-vite-plus-wrangler
description: Use when deploying a Cloudflare Worker, running D1 migrations, or adding a new Worker in a repository that uses vite-plus-wrangler — verify the target account before deploying and use the generated vp tasks instead of raw wrangler commands
---

# Deploying in a repository using `vite-plus-wrangler`

`vite-plus-wrangler` wraps the Wrangler CLI in Vite+ tasks so deploys are
account-checked, migrations are ordering-checked, and every Worker in a
monorepo is discoverable from one place.

## 1. Detect whether the repository uses it

Any of these means the plugin is active:

- `wrangler()` in `vite.config.ts`, or `wranglerTasks(...)` inside `run.tasks`
- `vite-plus-wrangler` in `package.json` dependencies
- Tasks named `cf:dev`, `cf:deploy`, `cf:types` in `vp run --list`

## 2. Never call `wrangler deploy` directly

Use the generated task, which runs the account guard first:

```bash
vp run cf:deploy
```

In a monorepo, target one Worker:

```bash
vp run <worker-name>#cf:deploy
```

The guard fails closed. If it reports a mismatch between the config's
`account_id` and `CLOUDFLARE_ACCOUNT_ID`, **stop and ask** — do not export a
different account id to make the error go away.

## 3. Inspect configuration before changing it

```bash
# Every Worker in the repo, with its environments and D1 bindings
vite-plus-wrangler discover . --json

# One resolved config, including [env.*] inheritance
vite-plus-wrangler config workers/api/wrangler.toml --env dev --json
```

## 4. D1 migrations

Order matters and is lexicographic. Before adding a migration, check the
existing sequence:

```bash
vite-plus-wrangler migrations migrations
```

Then name the new file with the **same prefix width** as its neighbours —
`0007_add_index.sql`, not `7_add_index.sql`. Mixing widths reorders every
migration once the count passes ten.

Apply with the explicit target:

```bash
vp run d1:migrate:local     # local .wrangler state
vp run d1:migrate:remote    # the real database
vp run d1:migrate:status    # what has been applied
```

## 5. Adding a new Worker

1. Create `wrangler.toml` (or `.jsonc`) with `name`, `main`,
   `compatibility_date`, and an explicit `account_id`.
2. Register its tasks in the root `vite.config.ts` via `wranglerTasks({ config })`,
   or rely on `discoverWranglerTasks()` if the repo uses discovery.
3. Run `vp run cf:types` to generate binding types.

Always pin `account_id` in the config. An unpinned account makes deploys
depend on whichever credentials happen to be loaded.
