import { MachineDot } from "@/components/federation/MachineDot";
import { cn } from "@/lib/utils";
import type { AgentActivityState } from "@/types";

/** What the ring shows: a stopped environment, or a running one's agent activity. */
export type EnvironmentMarkerState = "inactive" | AgentActivityState;

const RING_CLASSES: Record<EnvironmentMarkerState, string> = {
  inactive: "border-muted-foreground/60",
  idle: "border-success",
  working: "border-blue-500 animate-pulse",
  waiting: "border-amber-500 animate-pulse",
};

/**
 * An environment row's leading marker: the owning machine's dot (a square for
 * a container, a circle for a local environment) inside a ring that carries
 * the environment's state. Only the ring pulses; the machine colour stays a
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
  const rounded = shape === "square" ? "rounded-[3px]" : "rounded-full";
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
          "absolute inset-0 border-[3px] transition-colors forced-colors:border-[CanvasText]",
          rounded,
          RING_CLASSES[state],
        )}
      />
      {machine ? (
        <MachineDot
          colorToken={machine.colorToken}
          machineName={machine.name}
          shape={shape}
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
