import type { NodeSummariesResult } from "@orkestrator/protocol/node-summaries";
import { isUnknownCommandError } from "@orkestrator/protocol/unknown-command";

import type { NodeFileInvoker } from "./node-file-transfer.js";

/**
 * "Approve on every machine" for a project's setup commands (option C of the
 * M5 decision): the command node records the same approved hash on every
 * machine it controls that has a copy of the project, itself included.
 *
 * Each machine keeps its own approvals and is written only through its own
 * `approve_project_setup_commands`, so a leaf's trust never lives on another
 * node. Copies are matched by repository identity (`repositoryHint`), as the
 * project file tools match them; one machine may hold several copies.
 */

/** Each node's own write; an older node without it answers as unknown. */
const APPROVE_PROJECT_SETUP_COMMANDS = "approve_project_setup_commands";

export type SetupApprovalNodeStatus =
  "approved" | "no-project" | "not-connected" | "outcome-unknown" | "needs-update" | "failed";

export interface SetupApprovalNodeResult {
  nodeId: string;
  nodeName: string;
  status: SetupApprovalNodeStatus;
  /** Copies approved on that machine. */
  projectIds: string[];
  error?: string;
}

export async function approveSetupCommandsOnNodes(
  deps: {
    summaries: () => Promise<NodeSummariesResult>;
    invokerFor: NodeFileInvoker;
  },
  input: { nodeId: string; projectId: string; hash: string },
): Promise<{ nodes: SetupApprovalNodeResult[] }> {
  const all = await deps.summaries();
  const self = all.self;
  const machines = [
    ...(self
      ? [{ nodeId: self.nodeId, name: self.displayName, available: true, projects: self.projects }]
      : []),
    ...all.nodes.map((node) => ({
      nodeId: node.nodeId,
      name: node.view.displayName,
      available: node.available,
      projects: node.projects,
    })),
  ];
  const source = machines
    .find((machine) => machine.nodeId === input.nodeId)
    ?.projects.find((project) => project.ref.projectId === input.projectId);
  if (!source) throw new Error("That project is not on a machine this command node controls.");
  const hint = source.repositoryHint;
  if (!hint) {
    throw new Error(
      "This project has no repository remote to find it on other machines. Approve it for this project instead.",
    );
  }

  const results: SetupApprovalNodeResult[] = [];
  for (const machine of machines) {
    const projectIds = machine.projects
      .filter((project) => project.repositoryHint === hint)
      .map((project) => project.ref.projectId);
    const entry: SetupApprovalNodeResult = {
      nodeId: machine.nodeId,
      nodeName: machine.name,
      status: "approved",
      projectIds: [],
    };
    if (projectIds.length === 0) entry.status = "no-project";
    else if (!machine.available) entry.status = "not-connected";
    else {
      const invoke = deps.invokerFor(machine.nodeId);
      for (const projectId of projectIds) {
        try {
          await invoke(APPROVE_PROJECT_SETUP_COMMANDS, { projectId, hash: input.hash });
          entry.projectIds.push(projectId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          entry.status =
            (error as { code?: unknown })?.code === "outcome-unknown"
              ? "outcome-unknown"
              : isUnknownCommandError(error, APPROVE_PROJECT_SETUP_COMMANDS)
                ? "needs-update"
                : "failed";
          entry.error = message.slice(0, 200) || "Approval failed.";
          break;
        }
      }
    }
    results.push(entry);
  }
  return { nodes: results };
}
