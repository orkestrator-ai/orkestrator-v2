/**
 * Agent Capabilities on the window's command node
 * (docs/architecture/agent-capabilities-management.md). Every call goes
 * through the `capabilities` domain client (`lib/node-scope/domains/capabilities.ts`).
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CapabilityActivityList,
  CapabilityChangeResult,
  CapabilityDriftList,
  CapabilityExport,
  CapabilityImportPreview,
  CapabilityInventory,
  CapabilityLibrary,
  CapabilityMachineList,
  CapabilityOperationList,
  CapabilitySessionView,
  CapabilitySetupList,
  CapabilitySourceInspection,
  CapabilityTargetSupportResult,
  CapabilityUpdateList,
  CapabilityVerification,
} from "@orkestrator/protocol/capability-resources-api";
import type {
  CapabilityDriftEntry,
  CapabilityMachineSummary,
  CapabilityOperationSnapshot,
  CapabilityPackageDetail,
  CapabilityPackageSummary,
  CapabilitySetup,
  CapabilityTarget,
  EffectiveAgentResources,
  PackageSource,
} from "@orkestrator/protocol/capability-resources";

import { capabilitiesOn } from "@/lib/node-scope/domains/capabilities";
import { commandBackendClient, type BackendClient } from "./client";

export type CapabilityChangeInput =
  | {
      kind: "add-to-setup";
      inspectionId: string;
      expectedArtifactDigest?: string;
      setupId?: string;
      components?: string[];
      required?: boolean;
      excludedProviders?: AgentPlatform[];
      excludedMachines?: string[];
      pin?: boolean;
    }
  | { kind: "remove-from-setup"; packageId: string; setupId?: string }
  | { kind: "reconcile"; nodeIds?: string[] }
  | { kind: "adopt-drift"; driftId: string }
  | { kind: "adopt"; inspectionId: string; setupId?: string };

export interface AuthoredCapabilityInput {
  managedId?: string;
  kind: "skill" | "command" | "prompt" | "subagent" | "hook" | "mcp-server" | "upload";
  name: string;
  description?: string;
  content?: string;
  files?: Array<{
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    executable?: boolean;
  }>;
  hook?: { trigger: string; matcher?: string; command: string };
  mcp?: {
    transport: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    envKeys?: string[];
  };
}

/** This file's commands on `client`'s node (the command scope by default). */
export function createCapabilitiesApi(client: BackendClient) {
  const api = () => capabilitiesOn(client);
  return {
    listCapabilityPackages: (args: { query?: string; kind?: string; setupId?: string } = {}) =>
      api().list_capability_packages(args) as Promise<CapabilityLibrary>,
    getCapabilityPackage: (packageId: string) =>
      api().get_capability_package({ packageId }) as Promise<CapabilityPackageDetail>,
    readCapabilityFile: (packageId: string, path: string) =>
      api().read_capability_file({ packageId, path }) as Promise<{
        path: string;
        content: string;
        truncated: boolean;
      }>,
    listCapabilitySetups: () => api().list_capability_setups({}) as Promise<CapabilitySetupList>,
    getCapabilityInventory: (nodeId?: string, refresh?: boolean) =>
      api().get_capability_inventory({
        ...(nodeId ? { nodeId } : {}),
        ...(refresh ? { refresh } : {}),
      }) as Promise<CapabilityInventory>,
    getCapabilityTargetSupport: (nodeId?: string) =>
      api().get_capability_target_support(
        nodeId ? { nodeId } : {},
      ) as Promise<CapabilityTargetSupportResult>,
    getEffectiveAgentResources: (args: {
      target: Partial<CapabilityTarget> & { provider: AgentPlatform };
      setupIds?: string[];
      templateId?: string;
      graphNode?: string;
      ceiling?: { denied: string[]; userMcpServers?: string[] | null };
    }) => api().get_effective_agent_resources(args) as Promise<EffectiveAgentResources>,
    getCapabilitySessionView: (args: {
      sessionKey: string;
      target: Partial<CapabilityTarget> & { provider: AgentPlatform };
      sessionRunning?: boolean;
      catalogue?: { state: string; names: string[]; generation?: string };
      ceiling?: { denied: string[]; userMcpServers?: string[] | null };
    }) => api().get_capability_session_view(args) as Promise<CapabilitySessionView>,
    listCapabilityMachines: () =>
      api().list_capability_machines({}) as Promise<CapabilityMachineList>,
    listCapabilityDrift: () => api().list_capability_drift({}) as Promise<CapabilityDriftList>,
    listCapabilityActivity: (packageId?: string) =>
      api().list_capability_activity(
        packageId ? { packageId } : {},
      ) as Promise<CapabilityActivityList>,
    listCapabilityOperations: (active?: boolean) =>
      api().list_capability_operations(
        active ? { active } : {},
      ) as Promise<CapabilityOperationList>,
    getCapabilityOperation: (operationId: string) =>
      api().get_capability_operation({ operationId }) as Promise<CapabilityOperationSnapshot>,
    listCapabilityUpdates: () => api().list_capability_updates({}) as Promise<CapabilityUpdateList>,
    inspectCapabilitySource: (source: PackageSource) =>
      api().inspect_capability_source({ source }) as Promise<CapabilitySourceInspection>,
    authorCapabilityPackage: (input: AuthoredCapabilityInput) =>
      api().author_capability_package(input) as Promise<CapabilitySourceInspection>,
    adoptExternalCapability: (itemId: string, nodeId?: string) =>
      api().adopt_external_capability({
        itemId,
        ...(nodeId ? { nodeId } : {}),
      }) as Promise<CapabilitySourceInspection>,
    previewCapabilityChange: (change: CapabilityChangeInput, requestKey?: string) =>
      api().preview_capability_change({
        change,
        ...(requestKey ? { requestKey } : {}),
      }) as Promise<CapabilityChangeResult>,
    applyCapabilityChange: (operationId: string, approvedDigest: string, requestKey?: string) =>
      api().apply_capability_change({
        operationId,
        approvedDigest,
        ...(requestKey ? { requestKey } : {}),
      }) as Promise<CapabilityChangeResult>,
    cancelCapabilityOperation: (operationId: string) =>
      api().cancel_capability_operation({ operationId }) as Promise<CapabilityOperationSnapshot>,
    setCapabilitySetup: (
      setup: Partial<CapabilitySetup> & { name: string },
      expectedRevision?: number,
    ) =>
      api().set_capability_setup({
        setup,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }) as Promise<CapabilitySetup>,
    deleteCapabilitySetup: (setupId: string, expectedRevision: number) =>
      api().delete_capability_setup({ setupId, expectedRevision }) as Promise<CapabilitySetupList>,
    assignCapabilitySetup: (
      scope: "project" | "environment" | "template" | "graph-node" | "session",
      scopeId: string,
      setupIds: string[],
    ) =>
      api().assign_capability_setup({ scope, scopeId, setupIds }) as Promise<{
        setupIds: string[];
      }>,
    manageCapabilityException: (
      setupId: string,
      exception: string,
      action: "add" | "remove",
      expectedRevision?: number,
    ) =>
      api().manage_capability_exception({
        setupId,
        exception,
        action,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }) as Promise<CapabilitySetup>,
    setCapabilityMachineEnrollment: (
      nodeId: string,
      input: { enrolled?: boolean; groups?: string[] },
    ) =>
      api().set_capability_machine_enrollment({
        nodeId,
        ...input,
      }) as Promise<CapabilityMachineSummary>,
    setCapabilityPackageState: (packageId: string, state: { pinned?: boolean; paused?: boolean }) =>
      api().set_capability_package_state({
        packageId,
        ...state,
      }) as Promise<CapabilityPackageSummary>,
    resolveCapabilityDrift: (driftId: string, decision: "keep-local" | "adopt" | "replace") =>
      api().resolve_capability_drift({ driftId, decision }) as Promise<CapabilityDriftEntry>,
    refreshCapabilityUpdates: () =>
      api().refresh_capability_updates({}) as Promise<CapabilityUpdateList>,
    previewCapabilityUpdate: (updateId: string) =>
      api().preview_capability_update({ updateId }) as Promise<CapabilityChangeResult>,
    approveCapabilityUpdate: (updateId: string, approvedDigest: string) =>
      api().approve_capability_update({
        updateId,
        approvedDigest,
      }) as Promise<CapabilityChangeResult>,
    dismissCapabilityUpdate: (updateId: string) =>
      api().approve_capability_update({
        updateId,
        dismiss: true,
      }) as Promise<CapabilityChangeResult>,
    setCapabilityUpdatePolicy: (
      setupId: string,
      policy: CapabilitySetup["updatePolicy"],
      trustedSources?: string[],
    ) =>
      api().set_capability_update_policy({
        setupId,
        policy,
        ...(trustedSources ? { trustedSources } : {}),
      }) as Promise<CapabilitySetup>,
    rollbackCapabilityPackage: (packageId: string, toRevision: string) =>
      api().rollback_capability_package({
        packageId,
        toRevision,
      }) as Promise<CapabilityChangeResult>,
    exportCapabilitySetup: (setupIds: string[], projectId?: string, write?: boolean) =>
      api().export_capability_setup({
        setupIds,
        ...(projectId ? { projectId } : {}),
        ...(write ? { write } : {}),
      }) as Promise<CapabilityExport>,
    previewCapabilityImport: (input: { intent?: string; lock?: string; projectId?: string }) =>
      api().preview_capability_import(input) as Promise<CapabilityImportPreview>,
    importCapabilitySetup: (previewId: string) =>
      api().import_capability_setup({ previewId }) as Promise<CapabilitySetupList>,
    verifyAgentCapability: (
      target: Partial<CapabilityTarget> & { provider: AgentPlatform },
      componentIds: string[],
    ) =>
      api().verify_agent_capability({
        target,
        componentIds,
        consent: true,
      }) as Promise<CapabilityVerification>,
  };
}

export type CapabilitiesBackendApi = ReturnType<typeof createCapabilitiesApi>;

/** The window's command-scope binding. */
export const capabilitiesApi: CapabilitiesBackendApi = createCapabilitiesApi(commandBackendClient);

export const {
  listCapabilityPackages,
  getCapabilityPackage,
  readCapabilityFile,
  listCapabilitySetups,
  getCapabilityInventory,
  getCapabilityTargetSupport,
  getEffectiveAgentResources,
  getCapabilitySessionView,
  listCapabilityMachines,
  listCapabilityDrift,
  listCapabilityActivity,
  listCapabilityOperations,
  getCapabilityOperation,
  listCapabilityUpdates,
  inspectCapabilitySource,
  authorCapabilityPackage,
  adoptExternalCapability,
  previewCapabilityChange,
  applyCapabilityChange,
  cancelCapabilityOperation,
  setCapabilitySetup,
  deleteCapabilitySetup,
  assignCapabilitySetup,
  manageCapabilityException,
  setCapabilityMachineEnrollment,
  setCapabilityPackageState,
  resolveCapabilityDrift,
  refreshCapabilityUpdates,
  previewCapabilityUpdate,
  approveCapabilityUpdate,
  dismissCapabilityUpdate,
  setCapabilityUpdatePolicy,
  rollbackCapabilityPackage,
  exportCapabilitySetup,
  previewCapabilityImport,
  importCapabilitySetup,
  verifyAgentCapability,
} = capabilitiesApi;
