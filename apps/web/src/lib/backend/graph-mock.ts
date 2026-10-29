import type { GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import type { GraphMockPins } from "@orkestrator/protocol/graphs/mock";
import type { GraphRunBindings, GraphRunTemplateRef } from "@orkestrator/protocol/graphs/run";
import type { GraphScalarValue } from "@orkestrator/protocol/graphs/template";
import { machineInvoke, type AccountMachine } from "./agent-accounts";

/**
 * Mock runs (item 213): `graph_run_mock` compiles a stored template and
 * starts a run with no provider sessions, no tokens and no side effects
 * (placeholder role bindings, example run inputs, no environment unless one
 * is named). `graph_run_effects` lists what a run's system nodes did or, in a
 * mock run, would have done (`state: "simulated"`, `data.wouldRun`).
 */

export interface GraphMockLaunchRequest {
  ref: GraphTemplateRef;
  projectId: string;
  environmentId?: string;
  inputs?: Record<string, unknown>;
  params?: Record<string, GraphScalarValue>;
  roles?: GraphRunBindings["roles"];
  pins?: GraphMockPins;
  panel?: number;
  stepMs?: number;
}

export interface GraphMockLaunchResponse {
  run: {
    id: string;
    projectId: string;
    environmentId?: string;
    status: string;
    mock: true;
    template: GraphRunTemplateRef;
    createdAt: string;
  };
  pins: GraphMockPins | null;
  exampleInputs: string[];
  placeholderRoles: string[];
}

export interface GraphRunEffect {
  id: string;
  runId: string;
  key: string;
  action: string;
  nodeId: string;
  activation: string;
  state: "intended" | "done" | "failed" | "simulated";
  attempts: number;
  intendedAt: string;
  settledAt?: string;
  data?: Record<string, unknown>;
  error?: string;
}

export function launchGraphMockRun(
  request: GraphMockLaunchRequest,
  machine?: AccountMachine,
): Promise<GraphMockLaunchResponse> {
  return machineInvoke(machine, "graph_run_mock", { ...request });
}

export function listGraphRunEffects(
  runId: string,
  machine?: AccountMachine,
): Promise<{ effects: GraphRunEffect[] }> {
  return machineInvoke(machine, "graph_run_effects", { runId });
}
