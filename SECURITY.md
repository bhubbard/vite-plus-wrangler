# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/bhubbard/vite-plus-wrangler/security/advisories/new),
or by email to bkhubbard@gmail.com. Please do not open a public issue for a
vulnerability.

Expect an acknowledgement within a few days. If the report is accepted, you will
get an estimated timeline for a fix and credit in the release notes unless you
prefer otherwise.

## Supported versions

While the project is pre-1.0, only the latest published version receives fixes.

## Threat model

This package generates shell commands and reads configuration files. Two areas
deserve attention from anyone auditing or contributing:

**Command construction.** Task definitions are strings handed to a shell, and
the values interpolated into them come from `wrangler.toml` files and directory
listings — not from a trusted source. Everything interpolated must go through
`quote()` in `src/shell.ts`, and identifier-shaped fields (database names,
environment names) should go through `assertIdentifier()`, which rejects rather
than escapes. A pull request that interpolates a raw value into a command string
will not be merged.

**The dev-server endpoint.** `GET /__wrangler/config` describes every discovered
Worker. It is off by default, requires a localhost `Host` header, and redacts
account ids. Do not enable it on a dev server exposed beyond your machine.

## What this package does not protect against

The account guard compares two _declared_ values: the config's `account_id` and
`CLOUDFLARE_ACCOUNT_ID`. It does not contact Cloudflare, so it cannot detect a
`CLOUDFLARE_API_TOKEN` scoped to a different account than the one both of those
agree on. It catches a stale environment variable from another project; it does
not verify your credentials.
