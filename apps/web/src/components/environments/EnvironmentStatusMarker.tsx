import { MachineDot } from "@/components/federation/MachineDot";
import { cn } from "@/lib/utils";
import type { AgentActivityState } from "@/types";

/** What the halo shows: a stopped environment, or a running one's agent activity. */
export type EnvironmentMarkerState = "inactive" | AgentActivityState;

// Stopped environments have a faint outline; only running agents pulse.
const HALO_CLASSES: Record<EnvironmentMarkerState, string> = {
  inactive: "border border-muted-foreground/40 forced-colors:hidden",
  idle: "opacity-0 forced-colors:hidden",
  working: "bg-red-500/50 animate-pulse forced-colors:border-solid",
  waiting: "bg-yellow-400/50 animate-pulse forced-colors:border-dashed",
};

/**
 * An environment row's leading marker: the owning machine's dot (a square for
 * a container, a circle for a local environment) over a halo that pulses red
 * while the agent works and yellow while it awaits input. Stopped environments
 * have a faint outline; running idle environments have no halo. Only the halo
 * pulses; the machine colour stays a steady identity. Forced colours replace
 * activity halos with static solid (working) or dashed (waiting) system-colour
 * outlines. Without a machine to name (a single-machine client) the dot is a
 * neutral fill.
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
      className="relative isolate inline-flex size-4 shrink-0 items-center justify-center"
    >
      <span
        data-testid="environment-status-ring"
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 transition-colors forced-colors:animate-none forced-colors:border-2 forced-colors:border-[CanvasText] forced-colors:bg-transparent",
          rounded,
          HALO_CLASSES[state],
        )}
      />
      {machine ? (
        <MachineDot
          colorToken={machine.colorToken}
          machineName={machine.name}
          shape={shape}
          className="relative z-10 size-2 ring-0"
          {...(machine.status ? { status: machine.status } : {})}
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "relative z-10 size-2 shrink-0 bg-muted-foreground forced-colors:bg-[CanvasText]",
            shape === "square" ? "rounded-[1px]" : "rounded-full",
          )}
        />
      )}
    </span>
  );
}
