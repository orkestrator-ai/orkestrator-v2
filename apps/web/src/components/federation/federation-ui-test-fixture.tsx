import type { ReactNode } from "react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import { FederationProvider } from "./FederationProvider";

export function renderWithFederation(node: ReactNode) {
  return renderInAppCommandScope(<FederationProvider>{node}</FederationProvider>);
}

export function machineView(overrides: Partial<MachineView> = {}): MachineView {
  const backendId = "bk_a" as BackendId;
  const project = {
    ref: projectRef(backendId, "project-1"),
    name: "app",
    order: 0,
  };
  const environment: FederatedEnvironment = {
    ref: environmentRef(backendId, "env-1"),
    key: environmentKey(environmentRef(backendId, "env-1")),
    projectId: "project-1",
    name: "feature",
    order: 0,
    status: "running",
    activity: "working",
    hasUnreadWork: false,
    deleting: false,
    isProjectHome: false,
  };
  return {
    connectionId: "a",
    backendId,
    name: "Machine A",
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport: "connected",
    projects: [{ ...project, key: projectKey(project.ref) }],
    environmentsByProject: new Map([["project-1", [environment]]]),
    truncated: false,
    loadedAt: 1,
    ...overrides,
  };
}

export function firstEnvironment(machine: MachineView): FederatedEnvironment {
  return machine.environmentsByProject.get("project-1")![0]!;
}
