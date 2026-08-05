import { wrangler, vitePlusWrangler } from "./plugin.js";
import { assertAccount, accountGuardMessage, ambientAccountId, checkAccount } from "./account.js";
import {
  assertMigrations,
  checkMigrations,
  d1Tasks,
  migrationsDirFor,
  resolveMigrationsDir,
} from "./d1.js";
import { discoverWranglerTasks, resolveConfigPath, wranglerTasks } from "./tasks.js";
import {
  WranglerEngineError,
  discoverConfigs,
  discoverConfigsSafe,
  getBinaryPath,
  loadConfig,
  loadConfigSafe,
} from "./rust.js";
import { assertIdentifier, quote } from "./shell.js";

import { assertSecrets, checkSecrets } from "./secrets.js";
import { assertConfigLint, checkConfigLint } from "./lint.js";
import { assertBundleSize, checkBundleSize } from "./bundle.js";
import { assertCodeBindings, checkCodeBindings } from "./bindings.js";
import { generateDevProxyConfig } from "./proxy.js";
import { kvTasks, r2Tasks } from "./storage.js";

export * from "./types.js";

export {
  wrangler,
  vitePlusWrangler,
  wranglerTasks,
  discoverWranglerTasks,
  resolveConfigPath,
  d1Tasks,
  kvTasks,
  r2Tasks,
  migrationsDirFor,
  resolveMigrationsDir,
  assertAccount,
  accountGuardMessage,
  ambientAccountId,
  checkAccount,
  assertMigrations,
  checkMigrations,
  assertSecrets,
  checkSecrets,
  assertConfigLint,
  checkConfigLint,
  assertBundleSize,
  checkBundleSize,
  assertCodeBindings,
  checkCodeBindings,
  generateDevProxyConfig,
  discoverConfigs,
  discoverConfigsSafe,
  loadConfig,
  loadConfigSafe,
  getBinaryPath,
  WranglerEngineError,
  quote,
  assertIdentifier,
};

export default wrangler;
