import { useCallback } from "react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { useMachineSystemUsage } from "@/hooks/useSystemUsage";
import type { MachineView } from "@/lib/federation/aggregate";
import type { NodeScope, NodeScopeTier } from "@/lib/node-scope/node-scope";
import { useScopesWithCommandFallback, useSignal } from "@/lib/node-scope/providers";
import { constantSignal } from "@/lib/node-scope/signal";

/** The cadence of the title bar's own meters, which the window's machine shares a read with. */
const MACHINE_CPU_POLL_INTERVAL_MS = 5_000;

/** The tier read for a machine the window holds no scope for. */
const NO_SCOPE_TIER = constantSignal<NodeScopeTier>("summary");

/**
 * The node scope each machine's CPU is read on: a machine shown in this
 * window's tree is read on its own scope, the read the title bar's meters join
 * while it is shown (plan item 5002); every other machine through the command
 * node. `useMachineCpu` uses the scope only while its tier is live.
 */
export function useMachineScopeLookup(): (
  machine: Pick<MachineView, "bound" | "backendId">,
) => NodeScope | null {
  const { windowScope } = useScopesWithCommandFallback();
  const scopes = useSignal(windowScope.nodeScopes);
  return useCallback(
    (machine) =>
      machine.bound
        ? null
        : (scopes.find((scope) => scope.role === "leaf" && scope.nodeId === machine.backendId) ??
          null),
    [scopes],
  );
}

/**
 * One machine's current CPU percentage, for its machine tile, or null while
 * it is unreachable, has no sample yet, or its sample has gone stale: never
 * an old figure.
 */
export function useMachineCpu({
  nodeId,
  bound,
  connected,
  scope,
}: {
  nodeId: BackendId;
  bound: boolean;
  connected: boolean;
  scope: NodeScope | null;
}): { cpu: number | null; sampledAt: string | null } {
  // A scope's reads pause while it is not shown (warm, suspended), and the
  // window keeps the scope of every machine opened in it. Reading a hidden
  // machine on its own scope would leave its figure stale ("—") until it is
  // shown again, so only a live scope is read on; any other machine is read
  // through the command node, which keeps polling.
  const tier = useSignal(scope?.tier ?? NO_SCOPE_TIER);
  const shownScope = scope && !scope.disposed && tier === "live" ? scope : null;
  const usage = useMachineSystemUsage({
    nodeId,
    bound,
    intervalMs: MACHINE_CPU_POLL_INTERVAL_MS,
    active: connected,
    scope: shownScope,
  });
  const cpu = connected && usage.sample && !usage.stale ? usage.sample.cpuPercent : null;
  return { cpu, sampledAt: cpu === null ? null : usage.sampledAt };
}
