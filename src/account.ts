import process from "node:process";
import { checkAccount } from "./rust.js";
import type { AccountCheck } from "./types.js";

export { checkAccount };

/**
 * Throw unless the Cloudflare account is unambiguous and correct.
 *
 * Call this at the top of any script that deploys. A mismatch between the
 * config and `CLOUDFLARE_ACCOUNT_ID` is always fatal; an unpinned account is
 * fatal only when nothing at all identifies the target.
 */
export function assertAccount(
  configPath: string,
  options: { env?: string; expect?: string } = {},
): AccountCheck {
  const result = checkAccount(configPath, options);
  if (!result.ok) {
    throw new Error(`[vite-plus-wrangler] ${result.message}`);
  }
  if (result.status === "unpinned") {
    console.warn(`[vite-plus-wrangler] ${result.message}`);
  }
  return result;
}

/** Non-throwing variant for use inside a plugin hook. */
export function accountGuardMessage(
  configPath: string,
  options: { env?: string; expect?: string } = {},
): string | null {
  const result = checkAccount(configPath, options);
  return result.ok ? null : result.message;
}

/** The account id wrangler would actually use, for logging. */
export function ambientAccountId(): string | undefined {
  return process.env.CLOUDFLARE_ACCOUNT_ID;
}
