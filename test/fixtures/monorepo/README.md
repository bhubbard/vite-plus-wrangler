Fixture: a monorepo with Workers in subdirectories.

Exists because every other fixture is a single Worker at the root of its scan,
which is why a whole class of path-resolution bugs survived two audits. Any
change to how config paths, migrations_dir, or task prefixes are resolved
should be exercised against this tree, from a cwd that is NOT this directory.

  workers/api          wrangler.toml, default migrations_dir
  workers/webhooks     wrangler.jsonc, migrations_dir = "db/migrations"
  packages/shared      no wrangler config; must not be discovered
