import { MachineDot } from "@/components/federation/MachineDot";
import { cn } from "@/lib/utils";
import type { AgentActivityState } from "@/types";

/** What the halo shows: a stopped environment, or a running one's agent activity. */
export type EnvironmentMarkerState = "inactive" | AgentActivityState;

// Settled states draw no halo; only an agent at work or awaiting input pulses.
const HALO_CLASSES: Record<EnvironmentMarkerState, string> = {
  inactive: "opacity-0",
  idle: "opacity-0",
  working: "bg-red-500/50 animate-pulse",
  waiting: "bg-yellow-400/50 animate-pulse",
};

/**
 * An environment row's leading marker: the owning machine's dot (a square for
 * a container, a circle for a local environment) over a halo that pulses red
 * while the agent works and yellow while it awaits input. Settled
 * environments have no halo. Only the halo pulses; the machine colour stays a
 * steady identity. Without a machine to name (a single-machine client) the
 * dot is a neutral fill.
 */
export function EnvironmentStatusMarker({
  local,
  state,
  machine,
}: {
  /** A local environment draws a circle; a container a square. */
  local: boolean;
  state: EnvironmentMarkerState;
  machine: { name: string; colorToken: string | undefined; status?: string } | null;
}) {
  const shape = local ? "circle" : "square";
  const rounded = shape === "square" ? "rounded-[4px]" : "rounded-full";
  return (
    <span
      data-testid="environment-status-marker"
      data-shape={shape}
      data-state={state}
      className="relative inline-flex size-4 shrink-0 items-center justify-center"
    >
      <span
        data-testid="environment-status-ring"
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 transition-colors forced-colors:hidden",
          rounded,
          HALO_CLASSES[state],
        )}
      />
      {machine ? (
        <MachineDot
          colorToken={machine.colorToken}
          machineName={machine.name}
          shape={shape}
          className="size-2 ring-0"
          {...(machine.status ? { status: machine.status } : {})}
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-2 shrink-0 bg-muted-foreground forced-colors:bg-[CanvasText]",
            shape === "square" ? "rounded-[1px]" : "rounded-full",
          )}
        />
      )}
    </span>
  );
}
