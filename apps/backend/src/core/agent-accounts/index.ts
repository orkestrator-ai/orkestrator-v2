// The agent-accounts domain's public surface: the only module other backend
// code imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// The domain is the added provider accounts of docs/architecture/agent-accounts.md:
// the account operations (`accounts.ts`), the persisted registry (`store.ts`),
// each account's home directory (`homes.ts`), the account launches use
// (`active.ts`), sign-in (`login.ts`), the container side (`containers.ts`),
// automatic switching and its notices (`auto-switch*.ts`), usage readings
// (`last-usage.ts`, `shared-usage.ts`, `usage-sharing.ts`), other machines'
// accounts (`machines.ts`), session accounts (`session.ts`), promotion and the
// runtime state (`runtime.ts`). The command registry
// (`commands/registry-accounts.ts`), storage (`storage/agent-accounts.ts`),
// usage-limit reads (`agent-usage-limits.ts`) and the host login refreshers
// (`claude-host-login-refresh.ts`, `codex-host-login-refresh.ts`) stay with
// their own prefix groups.
//
// Five modules are named exceptions in `.oxlintrc.json`, not part of this
// surface. Routing them through this file would close a runtime import cycle.
// Each is imported directly by the files listed:
// - `accounts.ts`, `machines.ts` and `session.ts` reach the command layer
//   (`commands/servers.ts`, `host-model-catalog-refresh.ts`,
//   `commands/environment.ts`, …), which imports this file. They are for
//   `commands/registry-accounts.ts` and `commands/registry-projects.ts`, the
//   composition root `core/index.ts`, `session-title-service.ts` (a dynamic
//   import) and `coordinator/usage-limit-account-routing.ts`;
// - `runtime.ts` reaches `plan-usage/reader.ts`, which imports this file. It
//   is for `backend-runtime.ts` and, for one type, `commands/servers.ts`;
// - `homes.ts` is imported from below the modules this file re-exports:
//   `permission-rules/`, `mcp-management/`, `capabilities/`,
//   `environments/move-sessions.ts` and `codex-host-login-refresh.ts`, which
//   the re-exported modules (`active.ts`, `containers.ts`, …) reach, so they
//   cannot import this file. Like every exception, it stays out of this file
//   for all its importers.
// `store.ts` and `auto-switch-notices.ts` were exceptions too until the
// storage and commands domains moved into their folders: their importers
// (the storage layer, `commands/servers.ts`, the host model catalogue and
// `coordinator/notice-router.ts`) now reach only the light `storage/index.ts`
// and `commands/index.ts`, so routing them through this file closes no cycle.
export {
  activeAgentAccountShellEnvironment,
  addedClaudeAccountHomes,
  applyActiveAgentAccountEnvironment,
  applyCoordinatorClaudeAccount,
  coordinatorHostCodexHome,
  localBridgeIsOnActiveAccount,
  readAddedClaudeCredentials,
  readAddedCodexAuth,
  readCoordinatorCodexLogin,
  resolveActiveAgentAccount,
  runtimeHostCodexHome,
  stripInheritedAgentCredentials,
  TOKEN_REPLACEMENT_LEAD_MS,
  type CoordinatorAgentAccount,
  type ResolvedAgentAccount,
} from "./active.js";
export {
  AgentAccountAutoSwitcher,
  type LimitedAccountMove,
  type UsageLimitStopReport,
} from "./auto-switch.js";
export { mailAutoSwitchNotice } from "./auto-switch-notices.js";
export {
  activeAgentAccountInputRoots,
  activeClaudeCredentials,
  applyActiveAgentAccountsForContainerTerminal,
  PUSHED_LOGIN_PROVIDERS,
  pushedLoginHostFile,
  reconcileContainerAgentAccount,
  startContainerWithAgentAccounts,
  syncContainerAgentAccountsOnStart,
  syncContainerClaudeLogin,
  syncContainerClaudeLoginUnlocked,
  syncContainerLogin,
  syncContainerLoginUnlocked,
  type ClaudeLoginHandover,
  type ClaudeLoginPassSnapshot,
  type ContainerBridgeControl,
  type PushedLoginProvider,
} from "./containers.js";
export {
  beginAgentAccountLogin,
  ensureBrowserShim,
  INHERITED_CREDENTIAL_ENV,
  type AgentAccountLoginHandle,
  type SpawnLike,
} from "./login.js";
export { agentAccountLoginKey, parseAgentAccountStore, type AgentAccountStore } from "./store.js";
export {
  applySharedUsageReadings,
  centralUsageReadings,
  collectSharedUsageReadings,
  recordCentralUsageReadings,
} from "./usage-sharing.js";
