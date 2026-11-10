/**
 * The `environments` domain client (plan item 7003; §11.2 "Client
 * adapters"): one method per command, taking the definition's arguments and
 * answering its result. The web's `lib/backend` functions call it
 * (`apps/web/src/lib/node-scope/domains/domain-api.ts`).
 *
 * No environments command was capability-gated and the domain has no
 * capability command, so both adapters call the same commands:
 *
 * - version 1 sends the envelope (with the critical keys a call carries) and
 *   decodes each result with the command's schema;
 * - version 0, for a node without an `environments` range (pre-contract),
 *   sends today's `{ command, args }` and answers the result as sent
 *   ({@link answeredAsSent}), as 7001 and 7002's legacy adapters do: such a
 *   node's records are the shapes its callers already handle, and decoding
 *   them would refuse an older node's variation those callers accept.
 *
 * A command a node in the window lacks answers `unknown-command`, which the
 * caller reads with `incompatibility()` as before.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `environments` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "../../command.js";
import {
  getLogDirectoryCommand,
  getLogStorageStatsCommand,
  cleanupLogsCommand,
  getEnvironmentsCommand,
  getEnvironmentSnapshotsCommand,
  getEnvironmentSnapshotCommand,
  getEnvironmentPrHealthCommand,
  getEnvironmentCommand,
  getClaudeTerminalStateCommand,
  reorderEnvironmentsCommand,
  createEnvironmentCommand,
  ensureProjectHomeEnvironmentCommand,
  forkEnvironmentCommand,
  deleteEnvironmentCommand,
  moveEnvironmentCommand,
  renameEnvironmentCommand,
  renameEnvironmentFromPromptCommand,
  prepareEnvironmentFirstPromptCommand,
  reconcilePendingEnvironmentRenamesCommand,
  getEnvironmentStatusCommand,
  syncEnvironmentStatusCommand,
  syncAllEnvironmentsWithDockerCommand,
  startEnvironmentCommand,
  startEnvironmentBackgroundCommand,
  stopEnvironmentCommand,
  getContainerLifecycleSnapshotCommand,
  resolveContainerOperationCommand,
  getRebuildPreviewCommand,
  listRecoveryCopiesCommand,
  discardRecoveryCopyCommand,
  restoreRecoveryCopyCommand,
  getEnvironmentResourcesCommand,
  updateEnvironmentResourcesCommand,
  setContainerResourceLimitsCommand,
  getEnvironmentNetworkPolicyCommand,
  applyEnvironmentAllowedDomainsCommand,
  getEnvironmentInputsCommand,
  revokeProviderCredentialsCommand,
  restoreProviderCredentialsCommand,
  cancelContainerOperationCommand,
  recreateEnvironmentCommand,
  setEnvironmentPrCommand,
  clearEnvironmentPrCommand,
  getEnvironmentPrUrlCommand,
  overrideEnvironmentSetupCommand,
  getEnvironmentSetupApprovalCommand,
  approveEnvironmentSetupCommand,
  approveProjectSetupCommandsCommand,
  runEnvironmentSetupCommand,
  ensureEnvironmentSetupCommand,
  awaitEnvironmentSetupSessionCommand,
  updatePortMappingsCommand,
  updateEnvironmentAgentSettingsCommand,
  acknowledgeStartupAgentSessionCommand,
  getEnvironmentExtensionsCommand,
  updateEnvironmentAllowedDomainsCommand,
  removeEnvironmentDomainsCommand,
  teardownTabCommand,
  reconcileTabTeardownsCommand,
  reconcileOrphanedTabResourcesCommand,
} from "./commands.js";
import { environmentsDomain } from "./domain.js";

type Call<C extends AnyCommandDef> = (args: ArgsOf<C>) => Promise<ResultOf<C>>;

export interface EnvironmentsApi {
  getLogDirectory: Call<typeof getLogDirectoryCommand>;
  getLogStorageStats: Call<typeof getLogStorageStatsCommand>;
  cleanupLogs: Call<typeof cleanupLogsCommand>;
  getEnvironments: Call<typeof getEnvironmentsCommand>;
  getEnvironmentSnapshots: Call<typeof getEnvironmentSnapshotsCommand>;
  getEnvironmentSnapshot: Call<typeof getEnvironmentSnapshotCommand>;
  getEnvironmentPrHealth: Call<typeof getEnvironmentPrHealthCommand>;
  getEnvironment: Call<typeof getEnvironmentCommand>;
  getClaudeTerminalState: Call<typeof getClaudeTerminalStateCommand>;
  reorderEnvironments: Call<typeof reorderEnvironmentsCommand>;
  createEnvironment: Call<typeof createEnvironmentCommand>;
  ensureProjectHomeEnvironment: Call<typeof ensureProjectHomeEnvironmentCommand>;
  forkEnvironment: Call<typeof forkEnvironmentCommand>;
  deleteEnvironment: Call<typeof deleteEnvironmentCommand>;
  moveEnvironment: Call<typeof moveEnvironmentCommand>;
  renameEnvironment: Call<typeof renameEnvironmentCommand>;
  renameEnvironmentFromPrompt: Call<typeof renameEnvironmentFromPromptCommand>;
  prepareEnvironmentFirstPrompt: Call<typeof prepareEnvironmentFirstPromptCommand>;
  reconcilePendingEnvironmentRenames: Call<typeof reconcilePendingEnvironmentRenamesCommand>;
  getEnvironmentStatus: Call<typeof getEnvironmentStatusCommand>;
  syncEnvironmentStatus: Call<typeof syncEnvironmentStatusCommand>;
  syncAllEnvironmentsWithDocker: Call<typeof syncAllEnvironmentsWithDockerCommand>;
  startEnvironment: Call<typeof startEnvironmentCommand>;
  startEnvironmentBackground: Call<typeof startEnvironmentBackgroundCommand>;
  stopEnvironment: Call<typeof stopEnvironmentCommand>;
  getContainerLifecycleSnapshot: Call<typeof getContainerLifecycleSnapshotCommand>;
  resolveContainerOperation: Call<typeof resolveContainerOperationCommand>;
  getRebuildPreview: Call<typeof getRebuildPreviewCommand>;
  listRecoveryCopies: Call<typeof listRecoveryCopiesCommand>;
  discardRecoveryCopy: Call<typeof discardRecoveryCopyCommand>;
  restoreRecoveryCopy: Call<typeof restoreRecoveryCopyCommand>;
  getEnvironmentResources: Call<typeof getEnvironmentResourcesCommand>;
  updateEnvironmentResources: Call<typeof updateEnvironmentResourcesCommand>;
  setContainerResourceLimits: Call<typeof setContainerResourceLimitsCommand>;
  getEnvironmentNetworkPolicy: Call<typeof getEnvironmentNetworkPolicyCommand>;
  applyEnvironmentAllowedDomains: Call<typeof applyEnvironmentAllowedDomainsCommand>;
  getEnvironmentInputs: Call<typeof getEnvironmentInputsCommand>;
  revokeProviderCredentials: Call<typeof revokeProviderCredentialsCommand>;
  restoreProviderCredentials: Call<typeof restoreProviderCredentialsCommand>;
  cancelContainerOperation: Call<typeof cancelContainerOperationCommand>;
  recreateEnvironment: Call<typeof recreateEnvironmentCommand>;
  setEnvironmentPr: Call<typeof setEnvironmentPrCommand>;
  clearEnvironmentPr: Call<typeof clearEnvironmentPrCommand>;
  getEnvironmentPrUrl: Call<typeof getEnvironmentPrUrlCommand>;
  overrideEnvironmentSetup: Call<typeof overrideEnvironmentSetupCommand>;
  getEnvironmentSetupApproval: Call<typeof getEnvironmentSetupApprovalCommand>;
  approveEnvironmentSetup: Call<typeof approveEnvironmentSetupCommand>;
  approveProjectSetupCommands: Call<typeof approveProjectSetupCommandsCommand>;
  runEnvironmentSetup: Call<typeof runEnvironmentSetupCommand>;
  ensureEnvironmentSetup: Call<typeof ensureEnvironmentSetupCommand>;
  awaitEnvironmentSetupSession: Call<typeof awaitEnvironmentSetupSessionCommand>;
  updatePortMappings: Call<typeof updatePortMappingsCommand>;
  updateEnvironmentAgentSettings: Call<typeof updateEnvironmentAgentSettingsCommand>;
  acknowledgeStartupAgentSession: Call<typeof acknowledgeStartupAgentSessionCommand>;
  getEnvironmentExtensions: Call<typeof getEnvironmentExtensionsCommand>;
  updateEnvironmentAllowedDomains: Call<typeof updateEnvironmentAllowedDomainsCommand>;
  removeEnvironmentDomains: Call<typeof removeEnvironmentDomainsCommand>;
  teardownTab: Call<typeof teardownTabCommand>;
  reconcileTabTeardowns: Call<typeof reconcileTabTeardownsCommand>;
  reconcileOrphanedTabResources: Call<typeof reconcileOrphanedTabResourcesCommand>;
}

/** The API over any command call: both adapters. */
export function environmentsApi(call: CommandCall): EnvironmentsApi {
  return {
    getLogDirectory: (args) => call(getLogDirectoryCommand, args),
    getLogStorageStats: (args) => call(getLogStorageStatsCommand, args),
    cleanupLogs: (args) => call(cleanupLogsCommand, args),
    getEnvironments: (args) => call(getEnvironmentsCommand, args),
    getEnvironmentSnapshots: (args) => call(getEnvironmentSnapshotsCommand, args),
    getEnvironmentSnapshot: (args) => call(getEnvironmentSnapshotCommand, args),
    getEnvironmentPrHealth: (args) => call(getEnvironmentPrHealthCommand, args),
    getEnvironment: (args) => call(getEnvironmentCommand, args),
    getClaudeTerminalState: (args) => call(getClaudeTerminalStateCommand, args),
    reorderEnvironments: (args) => call(reorderEnvironmentsCommand, args),
    createEnvironment: (args) => call(createEnvironmentCommand, args),
    ensureProjectHomeEnvironment: (args) => call(ensureProjectHomeEnvironmentCommand, args),
    forkEnvironment: (args) => call(forkEnvironmentCommand, args),
    deleteEnvironment: (args) => call(deleteEnvironmentCommand, args),
    moveEnvironment: (args) => call(moveEnvironmentCommand, args),
    renameEnvironment: (args) => call(renameEnvironmentCommand, args),
    renameEnvironmentFromPrompt: (args) => call(renameEnvironmentFromPromptCommand, args),
    prepareEnvironmentFirstPrompt: (args) => call(prepareEnvironmentFirstPromptCommand, args),
    reconcilePendingEnvironmentRenames: (args) =>
      call(reconcilePendingEnvironmentRenamesCommand, args),
    getEnvironmentStatus: (args) => call(getEnvironmentStatusCommand, args),
    syncEnvironmentStatus: (args) => call(syncEnvironmentStatusCommand, args),
    syncAllEnvironmentsWithDocker: (args) => call(syncAllEnvironmentsWithDockerCommand, args),
    startEnvironment: (args) => call(startEnvironmentCommand, args),
    startEnvironmentBackground: (args) => call(startEnvironmentBackgroundCommand, args),
    stopEnvironment: (args) => call(stopEnvironmentCommand, args),
    getContainerLifecycleSnapshot: (args) => call(getContainerLifecycleSnapshotCommand, args),
    resolveContainerOperation: (args) => call(resolveContainerOperationCommand, args),
    getRebuildPreview: (args) => call(getRebuildPreviewCommand, args),
    listRecoveryCopies: (args) => call(listRecoveryCopiesCommand, args),
    discardRecoveryCopy: (args) => call(discardRecoveryCopyCommand, args),
    restoreRecoveryCopy: (args) => call(restoreRecoveryCopyCommand, args),
    getEnvironmentResources: (args) => call(getEnvironmentResourcesCommand, args),
    updateEnvironmentResources: (args) => call(updateEnvironmentResourcesCommand, args),
    setContainerResourceLimits: (args) => call(setContainerResourceLimitsCommand, args),
    getEnvironmentNetworkPolicy: (args) => call(getEnvironmentNetworkPolicyCommand, args),
    applyEnvironmentAllowedDomains: (args) => call(applyEnvironmentAllowedDomainsCommand, args),
    getEnvironmentInputs: (args) => call(getEnvironmentInputsCommand, args),
    revokeProviderCredentials: (args) => call(revokeProviderCredentialsCommand, args),
    restoreProviderCredentials: (args) => call(restoreProviderCredentialsCommand, args),
    cancelContainerOperation: (args) => call(cancelContainerOperationCommand, args),
    recreateEnvironment: (args) => call(recreateEnvironmentCommand, args),
    setEnvironmentPr: (args) => call(setEnvironmentPrCommand, args),
    clearEnvironmentPr: (args) => call(clearEnvironmentPrCommand, args),
    getEnvironmentPrUrl: (args) => call(getEnvironmentPrUrlCommand, args),
    overrideEnvironmentSetup: (args) => call(overrideEnvironmentSetupCommand, args),
    getEnvironmentSetupApproval: (args) => call(getEnvironmentSetupApprovalCommand, args),
    approveEnvironmentSetup: (args) => call(approveEnvironmentSetupCommand, args),
    approveProjectSetupCommands: (args) => call(approveProjectSetupCommandsCommand, args),
    runEnvironmentSetup: (args) => call(runEnvironmentSetupCommand, args),
    ensureEnvironmentSetup: (args) => call(ensureEnvironmentSetupCommand, args),
    awaitEnvironmentSetupSession: (args) => call(awaitEnvironmentSetupSessionCommand, args),
    updatePortMappings: (args) => call(updatePortMappingsCommand, args),
    updateEnvironmentAgentSettings: (args) => call(updateEnvironmentAgentSettingsCommand, args),
    acknowledgeStartupAgentSession: (args) => call(acknowledgeStartupAgentSessionCommand, args),
    getEnvironmentExtensions: (args) => call(getEnvironmentExtensionsCommand, args),
    updateEnvironmentAllowedDomains: (args) => call(updateEnvironmentAllowedDomainsCommand, args),
    removeEnvironmentDomains: (args) => call(removeEnvironmentDomainsCommand, args),
    teardownTab: (args) => call(teardownTabCommand, args),
    reconcileTabTeardowns: (args) => call(reconcileTabTeardownsCommand, args),
    reconcileOrphanedTabResources: (args) => call(reconcileOrphanedTabResourcesCommand, args),
  };
}

/**
 * A version-0 adapter's call: the command by name, without an envelope,
 * answered as the node sent it (not decoded). Shared with the `docker`
 * client.
 */
export function answeredAsSent(context: DomainAdapterContext): CommandCall {
  return ((command: AnyCommandDef, args: unknown) =>
    context.invoke(command.name, args as Readonly<Record<string, unknown>>)) as CommandCall;
}

export const environmentsClient = domainClient(environmentsDomain, {
  2: environmentsApi,
  // Version 2 only removed commands nothing called (2026-11-10), so version 1
  // peers take the same API. Adapter 1 goes when the support floor passes the
  // first Stable release with version 2.
  1: environmentsApi,
  0: (_call, context) => environmentsApi(answeredAsSent(context)),
});
