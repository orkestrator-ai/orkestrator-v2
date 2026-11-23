import {
  bugReportRuntimeId,
  bugReportIdFromRuntimeId,
  type BugReportAgent,
} from "@orkestrator/protocol/bug-report";
import {
  nativeAgentApprovalModes,
  type NativeAgentExecutionPolicy,
  type NativeAgentExecutionPolicyOverride,
} from "@orkestrator/protocol/native-agent";

import type { Environment } from "./models.js";
import type { BugReportRecord, BugReportsStorage } from "./storage/index.js";

/**
 * The project id a bug report's synthetic environment carries. A report
 * belongs to no project; this only keeps code that requires a non-blank
 * project id from tripping over one.
 */
export const BUG_REPORT_PROJECT_ID = "bug-report";

/** Report bridges enforce provider-specific write boundaries independently of the picker. */
export function bugReportExecutionPolicyOverride(
  agent: BugReportAgent | undefined,
): NativeAgentExecutionPolicyOverride {
  return {
    sandbox: "provider",
    approvals: agent && bugReportInitialApprovalMode(agent) ? "auto-approve" : "ask",
    projectResources: false,
  };
}

/**
 * The approval mode a new report session starts in: the asking mode, so a
 * report still asks before every command until the user picks another one.
 * Undefined for a platform with no approval-mode picker.
 */
export function bugReportInitialApprovalMode(agent: BugReportAgent): string | undefined {
  switch (agent) {
    case "claude":
      return "default";
    case "codex":
      return "on-request";
    case "opencode":
      return undefined;
  }
}

export function validBugReportApprovalMode(
  agent: BugReportAgent,
  policy: NativeAgentExecutionPolicy | undefined,
  mode: string | undefined,
): string | undefined {
  return nativeAgentApprovalModes(agent, policy).some(
    (option) => option.id === mode && !option.disabled,
  )
    ? mode
    : undefined;
}

export function isLegacyBugReportPolicy(
  policy: NativeAgentExecutionPolicy | undefined,
): policy is NativeAgentExecutionPolicy & { approvals: "ask" } {
  return policy?.sandbox === "provider" && policy.approvals === "ask" && !policy.projectResources;
}

export type BugReportRuntimeResolution =
  | { status: "not-bug-report" }
  | { status: "unavailable"; reportId: string; reason: "missing" | "unassigned" }
  | { status: "ready"; reportId: string; record: BugReportRecord & { agent: BugReportAgent } };

export async function resolveBugReportRuntime(
  storage: { bugReports?: Pick<BugReportsStorage, "getBugReport"> },
  runtimeId: string,
): Promise<BugReportRuntimeResolution> {
  const reportId = bugReportIdFromRuntimeId(runtimeId);
  if (!reportId) return { status: "not-bug-report" };
  const record = await storage.bugReports?.getBugReport(reportId);
  if (!record) return { status: "unavailable", reportId, reason: "missing" };
  if (!record.agent) return { status: "unavailable", reportId, reason: "unassigned" };
  return { status: "ready", reportId, record: { ...record, agent: record.agent } };
}

export function bugReportRuntimeUnavailableMessage(
  resolution: Extract<BugReportRuntimeResolution, { status: "unavailable" }>,
): string {
  switch (resolution.reason) {
    case "missing":
      return "This bug report was discarded";
    case "unassigned":
      return "This bug report has no agent yet; send its first message to choose one";
  }
}

/**
 * The bridge port and pid fields an environment row uses for `agent`: the
 * same pairs as `localServerFields`, which lives with the server lifecycle and
 * would pull it into everything that imports this module.
 */
export function bugReportBridgeFieldNames(agent: BugReportAgent): {
  port: keyof Environment;
  pid: keyof Environment;
} {
  switch (agent) {
    case "claude":
      return { port: "localClaudePort", pid: "claudeBridgePid" };
    case "codex":
      return { port: "localCodexPort", pid: "codexBridgePid" };
    case "opencode":
      return { port: "localOpencodePort", pid: "opencodePid" };
  }
}

/**
 * The synthetic environment a bug report presents to code written against
 * `Environment`: a local, running, ready environment whose worktree is the
 * report's scratch directory. Its bridge identity is projected into the field
 * pair the report's agent uses, so the local-server lifecycle reads it as it
 * would an environment's.
 */
export function bugReportRuntimeEnvironment(
  runtimeId: string,
  record: BugReportRecord,
  status: Environment["status"] = "running",
): Environment {
  const bridge: Record<string, number | undefined> = {};
  if (record.agent) {
    const fields = bugReportBridgeFieldNames(record.agent);
    bridge[fields.port] = record.bridgePort;
    bridge[fields.pid] = record.bridgePid;
  }
  return {
    id: runtimeId,
    projectId: BUG_REPORT_PROJECT_ID,
    name: "Bug report",
    branch: "",
    containerId: null,
    status,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: record.createdAt,
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: record.scratchDir,
    ...bridge,
    agentSettings: { executionPolicy: bugReportExecutionPolicyOverride(record.agent) },
    setupPhase: "ready",
    setupScriptsComplete: true,
  } as Environment;
}

/** The inverse of the projection: the bridge identity an Environment update writes. */
export function bugReportBridgeIdentityFromFields(
  agent: BugReportAgent | undefined,
  fields: Partial<Record<string, unknown>>,
): { changed: boolean; bridgePort?: number; bridgePid?: number } {
  if (!agent) return { changed: false };
  const names = bugReportBridgeFieldNames(agent);
  if (!(names.port in fields) && !(names.pid in fields)) return { changed: false };
  const port = fields[names.port];
  const pid = fields[names.pid];
  return {
    changed: true,
    ...(typeof port === "number" ? { bridgePort: port } : {}),
    ...(typeof pid === "number" ? { bridgePid: pid } : {}),
  };
}

/** Startup reaping uses the same identity projection as normal bridge liveness. */
export function bugReportReaperEnvironments(reports: BugReportRecord[]): Environment[] {
  return reports.flatMap((report) =>
    report.bridgePid === undefined || !report.agent
      ? []
      : [bugReportRuntimeEnvironment(bugReportRuntimeId(report.id), report, "stopped")],
  );
}

export async function updateBugReportBridgeFromEnvironment(
  storage: { bugReports: Pick<BugReportsStorage, "mutateBugReport"> },
  reportId: string,
  fields: Partial<Environment>,
): Promise<BugReportRecord | null> {
  return storage.bugReports.mutateBugReport(reportId, (current) => {
    const identity = bugReportBridgeIdentityFromFields(current.agent, fields);
    if (!identity.changed) return current;
    const { bridgePort: _port, bridgePid: _pid, ...rest } = current;
    return {
      ...rest,
      ...(identity.bridgePort !== undefined ? { bridgePort: identity.bridgePort } : {}),
      ...(identity.bridgePid !== undefined ? { bridgePid: identity.bridgePid } : {}),
    };
  });
}
