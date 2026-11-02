import { memo, useMemo } from "react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { formatSampleTime, useMachineSystemUsage } from "@/hooks/useSystemUsage";
import { machineTextClass } from "@/lib/federation/machine-colors";
import { inMachineOrder } from "@/lib/federation/sidebar-layout";
import { usePortalLayout } from "@/lib/portal/portal-layout";
import { cn } from "@/lib/utils";
import { useFederation } from "./FederationProvider";
import { useMachineViews } from "./useMachineViews";

/** The cadence of the title bar's own meters, which the window's machine shares a read with. */
const MACHINE_CPU_POLL_INTERVAL_MS = 5_000;

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
}: {
  nodeId: BackendId;
  name: string;
  colorToken: string | undefined;
  bound: boolean;
  connected: boolean;
}) {
  const usage = useMachineSystemUsage({
    nodeId,
    bound,
    intervalMs: MACHINE_CPU_POLL_INTERVAL_MS,
    active: connected,
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
