// The public-api domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays reviewable.
// This file reaches most of the backend through registry.js, so a module it
// reaches cannot import it without closing a runtime import cycle. Those
// modules import attention-cursor.js, dispatch.js, errors.js, exec-control.js,
// operation-ledger.js and revisions.js directly: the storage layer
// (storage-public-operations.ts), the environment commands
// (commands-environment.ts, commands-servers.ts, container-replacement.ts) and
// the control MCP and scheduled-job callers (control-mcp/caller.ts,
// scheduled-jobs/executor.ts).
export {
  commandArguments,
  listSessionCommands,
  resolveSessionCommand,
  type SessionCommandContext,
} from "./actions-session-commands.js";
export { sessionPromptMode } from "./actions-sessions.js";
export { attentionKey, compareAttention, type AttentionPosition } from "./attention-cursor.js";
export { withPublicAuthority } from "./dispatch.js";
export { PublicActionError } from "./errors.js";
export {
  control,
  execDirectory,
  stopEnvironmentExecWorkers,
  workspaceRoot,
  type ExecState,
} from "./exec-control.js";
export {
  boundRecord,
  controlMcpAuthority,
  currentNamespace,
  emptyIndex,
  isActiveRecord,
  isPublicOperationRecord,
  MAX_RETIRED_NAMESPACES,
  namespaceAdmissionEnds,
  namespaceFence,
  namespaceOfOperationId,
  namespaceStatus,
  newOperationId,
  PUBLIC_OPERATION_RECORD_VERSION,
  recordBytes,
  requestKey,
  type PublicAuthority,
  type PublicOperationIndex,
  type PublicOperationRecord,
} from "./operation-ledger.js";
export { nativePromptQueueKey } from "./prompt-delivery.js";
export { PublicApiReconciliations } from "./reconciliations.js";
export { publicActionHandlers, registerPublicApiCommands } from "./registry.js";
export { withRelayController } from "./relay-context.js";
export {
  environmentSettingsRevision,
  projectRevision,
  repositorySettingsRevision,
} from "./revisions.js";
export { stopSessionTurn } from "./session-turn-stop.js";
export { resolveSession, sessionActivity, type ResolvedSession } from "./sessions.js";
export { nativeTabsOfLayout, type NativeTabInfo } from "./summaries.js";
export type { PublicActionHandler } from "./types.js";
