import { memo, useMemo } from "react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { formatSampleTime, useMachineSystemUsage } from "@/hooks/useSystemUsage";
import { machineTextClass } from "@/lib/federation/machine-colors";
import { inMachineOrder } from "@/lib/federation/sidebar-layout";
import { usePortalLayout } from "@/lib/portal/portal-layout";
import type { NodeScope, NodeScopeTier } from "@/lib/node-scope/node-scope";
import { useScopesWithCommandFallback, useSignal } from "@/lib/node-scope/providers";
import { constantSignal } from "@/lib/node-scope/signal";
import { cn } from "@/lib/utils";
import { useFederation } from "./FederationProvider";
import { useMachineViews } from "./useMachineViews";

/** The cadence of the title bar's own meters, which the window's machine shares a read with. */
const MACHINE_CPU_POLL_INTERVAL_MS = 5_000;

/** The tier read for a machine the window holds no scope for. */
const NO_SCOPE_TIER = constantSignal<NodeScopeTier>("summary");

/**
 * Each machine's CPU use for the title bar, beside the meters of the machine on
 * screen: the command node first, then the order the command node keeps, each
 * figure in its machine's colour. A machine that is unreachable, or whose sample
 * has gone stale, shows "—" rather than an old figure.
 */
export function MachineCpuReadings() {
  const { enabled } = useFederation();
  return enabled ? <Readings /> : null;
}

function Readings() {
  const { portalState } = useFederation();
  const views = useMachineViews();
  const { machineOrder } = usePortalLayout();
  const machines = useMemo(
    () =>
      inMachineOrder(views, (machine) => machine.connectionId, machineOrder, portalState.selfId),
    [machineOrder, portalState.selfId, views],
  );
  // A machine shown in this window's tree is read on its own scope, the read
  // the title bar's meters join while it is shown (plan item 5002). Each
  // reading uses that scope only while its tier is live (below).
  const { windowScope } = useScopesWithCommandFallback();
  const scopes = useSignal(windowScope.nodeScopes);
  if (machines.length < 2) return null;
  return (
    <>
      <div
        role="group"
        aria-label="CPU usage by machine"
        data-testid="machine-cpu-readings"
        className="flex items-center gap-1.5"
      >
        {machines.map((machine) => (
          <MachineCpuReading
            key={machine.connectionId}
            nodeId={machine.backendId}
            name={machine.name}
            colorToken={machine.colorToken}
            bound={machine.bound}
            connected={machine.bound || machine.transport === "connected"}
            scope={
              machine.bound
                ? null
                : (scopes.find(
                    (scope) => scope.role === "leaf" && scope.nodeId === machine.backendId,
                  ) ?? null)
            }
          />
        ))}
      </div>
      <span aria-hidden="true" className="mx-2 h-3 w-px self-center bg-border/50" />
    </>
  );
}

const MachineCpuReading = memo(function MachineCpuReading({
  nodeId,
  name,
  colorToken,
  bound,
  connected,
  scope,
}: {
  nodeId: BackendId;
  name: string;
  colorToken: string | undefined;
  bound: boolean;
  connected: boolean;
  scope: NodeScope | null;
}) {
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
  const cpu = usage.sample && !usage.stale ? usage.sample.cpuPercent : null;
  const reading = cpu === null ? "—" : `${Math.round(cpu)}%`;
  const label = `${name} CPU usage: ${cpu === null ? "unavailable" : reading}`;
  const sampleTime = cpu === null ? null : formatSampleTime(usage.sampledAt);
  return (
    <span
      role="img"
      aria-label={label}
      title={sampleTime ? `${label} (Sampled at ${sampleTime})` : label}
      data-machine={nodeId}
      data-machine-color={colorToken ?? "neutral"}
      className={cn("font-mono text-[10px] tabular-nums", machineTextClass(colorToken))}
    >
      {reading}
    </span>
  );
});
