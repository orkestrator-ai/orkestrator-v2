/**
 * The machines the Linear connect dialog offers (docs/todo/cross-cutting/
 * 7767-linear-boards-per-project-and-coordinator-tools.md, task 1): the one
 * this tab is on, plus every other machine the window knows of that has a
 * project for the same repository (matched by `repositoryHint`, as ticket
 * sync pairs projects). Without a Git remote there is nothing to match on, so
 * only this machine is offered.
 */
import { useMemo } from "react";
import { useStore } from "zustand";
import { sha256Hex } from "@orkestrator/protocol/graphs/sha256";
import { repositoryHint, type NodeSummary } from "@orkestrator/protocol/node-summaries";
import type { AccountMachine } from "@/lib/backend/client";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { portalStore } from "@/lib/portal/portal-store";
import { useFederation } from "@/components/federation/FederationProvider";
import { projectStore } from "@/stores/projectStore";
import type { Project } from "@/types";

export interface LinearMachineTarget {
  /** Stable key for React and the checklist state. */
  key: string;
  /**
   * How to reach it (`AccountMachine`): `undefined` is this tab's node,
   * `null` the window's command node, a node id any other machine.
   */
  machine: AccountMachine;
  /** The machine's node id, when known. */
  nodeId: string | null;
  name: string;
  /** The same repository's project on that machine. */
  projectId: string;
  /** This tab's machine: always included. */
  current: boolean;
  /** The command node can reach it now (a summary says it is available). */
  available: boolean;
  /**
   * That project has a checkout on its machine, so it can own local
   * worktrees. A peer's summary says so through `pathName`; one read before
   * `pathName` existed reports none, so the answer is "no" rather than a guess.
   */
  hasCheckout: boolean;
}

interface TargetInput {
  currentNodeId: string;
  currentRole: "command" | "leaf";
  projectId: string;
  gitUrl: string | undefined;
  commandNodeId: string | null;
  commandName: string;
  commandProjects: readonly (Pick<Project, "id" | "gitUrl"> & { localPath?: string | null })[];
  nodes: readonly NodeSummary[];
  /** Whether this tab's own project has a checkout; true when unknown. */
  currentHasCheckout?: boolean;
}

export function linearMachineTargets(input: TargetInput): LinearMachineTarget[] {
  const hint = repositoryHint(input.gitUrl);
  const currentSummary = input.nodes.find((node) => node.nodeId === input.currentNodeId);
  const current: LinearMachineTarget = {
    key: `node:${input.currentNodeId}`,
    machine: undefined,
    nodeId: input.currentNodeId,
    name:
      input.currentRole === "command"
        ? input.commandName
        : currentSummary?.view.displayName || "This machine",
    projectId: input.projectId,
    current: true,
    available: true,
    hasCheckout: input.currentHasCheckout ?? true,
  };
  if (!hint) return [current];

  const targets = [current];
  if (input.currentRole === "leaf") {
    const commandProject = input.commandProjects.find(
      (project) => repositoryHint(project.gitUrl) === hint,
    );
    if (commandProject) {
      targets.push({
        key: `node:${input.commandNodeId ?? "command"}`,
        machine: null,
        nodeId: input.commandNodeId,
        name: input.commandName,
        projectId: commandProject.id,
        current: false,
        available: true,
        hasCheckout: Boolean(commandProject.localPath),
      });
    }
  }
  for (const node of input.nodes) {
    if (node.nodeId === input.currentNodeId || node.nodeId === input.commandNodeId) continue;
    const project = node.projects.find((entry) => entry.repositoryHint === hint);
    if (!project) continue;
    targets.push({
      key: `node:${node.nodeId}`,
      machine: node.nodeId,
      nodeId: node.nodeId,
      name: node.view.displayName || "Unnamed machine",
      projectId: project.ref.projectId,
      current: false,
      available: node.available,
      hasCheckout: Boolean(project.pathName),
    });
  }
  return targets;
}

/** The connect dialog's machines for `projectId` on this tab's node. */
export function useLinearMachineTargets(projectId: string): LinearMachineTarget[] {
  const { windowScope, scope } = useScopesWithCommandFallback();
  const commandScope = windowScope.commandScope();
  const projects = useStore(scope.store(projectStore), (state) => state.projects);
  const commandProjects = useStore(commandScope.store(projectStore), (state) => state.projects);
  const nodes = useStore(portalStore.store, (state) => state.nodes);
  const selfId = useStore(portalStore.store, (state) => state.selfId);
  const { boundMachine } = useFederation();
  const commandName = boundMachine?.name ?? "This machine";
  const currentProject = projects.find((project) => project.id === projectId);
  const gitUrl = currentProject?.gitUrl;
  // As `useLocalEnvironmentAvailable`: an unknown project is not refused here.
  const currentHasCheckout = currentProject ? Boolean(currentProject.localPath) : true;
  return useMemo(
    () =>
      linearMachineTargets({
        currentNodeId: scope.nodeId,
        currentRole: scope.role,
        projectId,
        gitUrl,
        commandNodeId: selfId ?? (scope.role === "command" ? scope.nodeId : null),
        commandName,
        commandProjects,
        nodes,
        currentHasCheckout,
      }),
    [commandName, commandProjects, currentHasCheckout, gitUrl, nodes, projectId, scope, selfId],
  );
}

/**
 * The fingerprint each backend reports for its stored key (the first 16 hex
 * characters of the trimmed key's SHA-256), so the dialog can tell whether a
 * machine already holds the pasted key. Not a credential.
 */
export function linearKeyFingerprint(apiKey: string): string {
  return sha256Hex(apiKey.trim()).slice(0, 16);
}
