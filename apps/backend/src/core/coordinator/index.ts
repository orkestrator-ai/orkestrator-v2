// The coordinator domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays reviewable.
//
// The domain is the coordinator service and everything it owns: the runtime
// and provider qualification (`runtime.ts`, `providers.ts`), status wakes and
// pull-request watches, delegation, worker turns, mail and changes, account
// routing, node and remote coordination, and workflow retention. The
// coordinator's MCP tools stay in `control-mcp/`, and its command registry
// (`commands/registry-coordinator*.ts`) and storage (`storage/coordinator*.ts`)
// stay with their own prefix groups.
//
// Eleven modules are named exceptions in `.oxlintrc.json`, not part of this
// surface, because each reaches back into code that imports this file, so
// re-exporting it here would close a runtime import cycle. Each is imported
// directly by the files listed:
// - command handlers the command registry installs, which reach the command
//   layer (`commands/servers.ts`, the `control-mcp/` tools): `fork-worker.ts`
//   and `worker-changes.ts` for `commands/registry.ts`; `goal-actions.ts`,
//   `pipeline-step-actions.ts`, `surface-actions.ts`, `worker-mail.ts` and
//   `worker-turn-actions.ts` for `commands/registry-coordinator.ts`;
// - `mail-attachments.ts` and `node-coordinator-mail.ts` (reach
//   `storage/config.ts` and `storage/coordinators.ts`), for
//   `commands/registry.ts` and `commands/registry-coordinator-nodes.ts`, and
//   a type of the first for `nodes/node-coordination.ts`;
// - `pr.ts` (reaches `worker-action-receipts.ts`), for
//   `commands/registry-controller-workflows.ts`;
// - `usage-limit-account-routing.ts` (reaches `commands/servers.ts`), for the
//   composition root `core/index.ts`.
// `node-tickets.ts`, `review-actions.ts` and `subork-actions.ts` were
// exceptions too until the commands domain moved into `commands/`: their
// importers there now reach only the light `commands/index.ts`, so
// re-exporting them closes no cycle and they are re-exported below.
export {
  actionHash,
  coordinatorCaller,
  coordinatorLaunchIdentity,
  coordinatorMultiReviewLaunchHash,
  requireCoordinatorConversation,
  withCoordinatorReceipt,
} from "./action-scope.js";
export { findCoordinatorCheckoutTurn } from "./checkout-turn.js";
export { pendingCheckoutUpdate, renderCheckoutUpdate } from "./checkout-update.js";
export {
  agentMessagingEnabled,
  coordinatorDelegationAvailable,
  readCoordinatorWaitingOn,
} from "./context-reads.js";
export {
  carryCoordinatorDelegationPresentation,
  coordinatorDelegationPresentationFrom,
  restoreCoordinatorDelegationPresentation,
  withCoordinatorDelegationPresentation,
} from "./delegation-authority.js";
export { launchDelegationRequest } from "./delegation-request.js";
export { coordinatorDeliverNowResult, settleCoordinatorDeliverNow } from "./deliver-now.js";
export { coordinatorEnvironmentRefusals } from "./environment-refusals.js";
export {
  assertCoordinatorMayActOnEnvironment,
  assertCoordinatorMayControlWorkflow,
} from "./environment-scope.js";
export { featurePlanFollowSummary } from "./feature-plan-status.js";
export { registerCoordinatorGraphActions } from "./graph-actions.js";
export {
  buildPipelineInputWithDefaults,
  multiReviewInputWithDefaults,
  readLaunchModelCatalog,
  savedLaunchSettings,
} from "./launch-defaults.js";
export { fastForwardBeforeCoordinatorMail } from "./mail-upstream.js";
export { runCoordinatorMaintenance } from "./maintenance.js";
export { checkUpstreamBeforeMessage } from "./message-upstream.js";
export {
  connectCoordinatorNodeWakes,
  type CoordinatorNodeAttempt,
} from "./node-reconnect-wakes.js";
export { prepareRemoteBuildTicket, registerCoordinatorNodeTicketCommands } from "./node-tickets.js";
export {
  coordinatorPrFields,
  nodePrHealth,
  prReadingFrom,
  pullRequestFollowSummary,
  summaryPrHealth,
  thisNodePrHealth,
} from "./pr-status.js";
export {
  COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION,
  coordinatorProviderAllowed,
  coordinatorProviderTierSetting,
  defaultCoordinatorHostCapabilities,
  normalizeCoordinatorProviderTierDefaultVersion,
} from "./providers.js";
export type {
  CoordinatorRemoteAccess,
  RemotePullRequestReading,
  RemoteWorkerState,
  RemoteWorkflowRecord,
} from "./remote.js";
export { coordinatorRepairJob } from "./repair-job.js";
export { CoordinatorRequestFlights } from "./request-flights.js";
export { coordinatorResearchLine, loadCoordinatorResearch } from "./research-context.js";
export {
  multiReviewButtonStart,
  registerCoordinatorReviewActions,
  runMultiReviewSurface,
  startMultiReviewAt,
} from "./review-actions.js";
export {
  coordinatorPlatformAllowed,
  coordinatorRuntimeEnvironment,
  coordinatorRuntimeUnavailableMessage,
  heldCoordinatorConversation,
  openCoordinatorConversation,
  resolveCoordinatorRuntime,
} from "./runtime.js";
export { CoordinatorService, sanitizeCoordinatorError } from "./service.js";
export {
  COORDINATOR_STATUS_COALESCE_MS,
  type CoordinatorStatus,
  type CoordinatorWaitingBlocker,
  lastAssistantText,
  waitingBlocker,
} from "./status-wakes.js";
export { registerCoordinatorSuborkActions } from "./subork-actions.js";
export { coordinatorCallerTurnOrigin } from "./turn-origin.js";
export { CoordinatorUsageLimitNotices } from "./usage-limit-notices.js";
export { CoordinatorViewRevisions } from "./view-revisions.js";
export { WORKER_CHANGES_LIMITS, WORKER_DIFF_SCOPES } from "./worker-changes-limits.js";
export {
  COORDINATOR_WORKFLOW_CLEANUP_BATCH,
  COORDINATOR_WORKFLOW_NEAR_LIMIT,
  COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS,
  COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR,
  coordinatorDelegationNotOpenedNote,
  coordinatorRequestAlias,
  coordinatorRequestMatch,
  coordinatorWorkflowStoreState,
  MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
  selectCoordinatorWorkflowsToClear,
} from "./workflow-retention.js";
