/**
 * Shell-safe command construction.
 *
 * Task definitions are strings handed to a shell, and the values interpolated
 * into them (database names, environment names, config paths) come from
 * `wrangler.toml` files and directory listings rather than from a trusted
 * source. Two separate problems follow from naive interpolation:
 *
 * 1. Injection — a value containing `;`, `&&`, `$(...)` or a backtick runs
 *    arbitrary commands.
 * 2. Plain breakage — a path containing a space splits into two arguments,
 *    which happens to ordinary users constantly.
 *
 * Everything interpolated into a command string must go through `quote`, and
 * identifier-shaped fields should additionally go through `assertIdentifier`,
 * which rejects rather than escapes. A database called `leads; rm -rf /` is
 * not a database name worth supporting.
 */

/** Characters that are safe unquoted in every POSIX shell. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Wrangler names: what Cloudflare actually permits for workers, envs, and D1. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Quote a value for safe use inside a POSIX shell command string.
 *
 * Uses single quotes, which suppress all expansion; an embedded single quote
 * is closed, escaped, and reopened (`'\''`).
 *
 * Note: this targets `sh`/`bash`. On Windows `cmd.exe` quoting rules differ —
 * task runners generally invoke a POSIX shell, but avoid metacharacters in
 * config values if you support native Windows shells.
 */
export function quote(value: string): string {
  if (value === "") return "''";
  if (SHELL_SAFE.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Reject a value that is not a plain identifier.
 *
 * Used for names that have no legitimate reason to contain shell
 * metacharacters. Failing loudly beats quoting something that should never
 * have arrived in the first place.
 */
export function assertIdentifier(value: string, label: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(
      `[vite-plus-wrangler] Invalid ${label}: ${JSON.stringify(value)}. ` +
        `Expected letters, digits, underscores, and hyphens.`,
    );
  }
  return value;
}

/** Validate a port and return it as a string. */
export function assertPort(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[vite-plus-wrangler] Invalid port: ${String(port)}. Expected 1-65535.`);
  }
  return String(port);
}

/**
 * Join pre-quoted command fragments, dropping empties.
 *
 * Every caller is responsible for having quoted its own values; this only
 * handles spacing so that an absent flag does not leave a double space.
 */
export function join(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(" ");
}

export interface WranglerFlagOptions {
  config?: string;
  env?: string;
}

/**
 * The `--config` / `--env` pair shared by every generated wrangler command.
 *
 * A single implementation on purpose: this previously existed twice with the
 * flags emitted in opposite orders, which is the kind of duplication that
 * drifts into a real inconsistency.
 */
export function wranglerFlags(options: WranglerFlagOptions): string[] {
  const parts: string[] = [];
  if (options.config) parts.push("--config", quote(options.config));
  if (options.env) parts.push("--env", assertIdentifier(options.env, "env"));
  return parts;
}
