import { bugReportIdFromRuntimeId, type BugReportAgent } from "@orkestrator/protocol/bug-report";
import type { NativeAgentExecutionPolicyOverride } from "@orkestrator/protocol/native-agent";

import type { Environment } from "./models.js";
import type { BugReportRecord, BugReportsStorage } from "./storage-bug-reports.js";

/**
 * The project id a bug report's synthetic environment carries. A report
 * belongs to no project; this only keeps code that requires a non-blank
 * project id from tripping over one.
 */
export const BUG_REPORT_PROJECT_ID = "bug-report";

/**
 * Read-only, apart from the scratch directory, with a human in the loop.
 *
 * The provider sandbox lets the agent write only inside its working directory
 * (the report's scratch directory); approvals `ask` sends every escalation,
 * and every command Claude does not treat as read-only, to the user. The
 * filing itself never runs in the agent: the sheet's File issue button does it.
 */
export const BUG_REPORT_EXECUTION_POLICY_OVERRIDE: NativeAgentExecutionPolicyOverride = {
  sandbox: "provider",
  approvals: "ask",
  projectResources: false,
};

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
    agentSettings: { executionPolicy: BUG_REPORT_EXECUTION_POLICY_OVERRIDE },
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
