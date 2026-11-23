// The nodes domain's public surface: the only module other backend code
// imports. Re-export by name (never `export *`) so the surface stays reviewable.
// The storage layer (storage/nodes.ts) imports the stored-format readers from
// here: only storage/service.ts reaches it, and nothing this file reaches
// imports service.ts at run time.
export { parseNodeActionApproval } from "./node-action-requests.js";
export {
  accountSwitchGrantState,
  runGrantedAccountSwitch,
  runTimerAccountSwitch,
} from "./node-account-switch-grant.js";
export { coordinatorNodeContext } from "./node-context.js";
export { NodeCoordination, type NodeCoordinatorNotices } from "./node-coordination.js";
export type { OutboxItem } from "./node-mail.js";
export { bridgeRemoteCoordinatorEvents, NodeCoordinatorRemote } from "./node-coordinator-remote.js";
export type { NodeFileTransfer } from "./node-file-transfer.js";
export { parseNodeFileScope, seedFilesDir } from "./node-files.js";
export {
  NodeOutcomeUnknownError,
  NodeUnavailableError,
  type ContractEnvelope,
  type NodeLink,
} from "./node-link.js";
export { linkDomainApi, routedDomainApi } from "./node-domain-clients.js";
export { NodeUsageSync } from "./node-usage-sync.js";
export { NodePortal } from "./node-portal.js";
export {
  NodeEventMultiplexer,
  type NodeEventMultiplexerOptions,
} from "./node-event-multiplexer.js";
export { NODE_HEARTBEAT_MS } from "./node-link.js";
export { listProjectCopyCandidates, listProjectCopyFiles } from "./node-project-copy-files.js";
export { NODE_RELAY_PREFIX, parseRelayPath, relayHttp, relayUpgrade } from "./node-relay.js";
export { approveSetupCommandsOnNodes } from "./node-setup-approvals.js";
export {
  admitsWorkspaceCommand,
  isGlobalConfigEcho,
  isGlobalConfigWriteCommand,
} from "./workspace-grant-scope.js";
export { readSeedManifest } from "./node-seed.js";
export { readStoredNodeAttachments, readStoredNodeRegistry } from "./node-store-format.js";
export { errorCode, NodeService, type NodeServiceOptions } from "./node-service.js";
export { createNodeSshFactory } from "./node-ssh.js";
export { environmentMailMarkers, isWorkingPipelineRecord } from "./node-summary-markers.js";
export { boundSummaryIcons } from "./project-summary-icons.js";
