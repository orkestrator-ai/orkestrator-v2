import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { House } from "lucide-react";
import {
  machineColorLabel,
  machineDotClass,
  machineTextClass,
} from "@/lib/federation/machine-colors";
import { cn } from "@/lib/utils";

/**
 * The owning machine's colour. It identifies the backend only — never
 * activity, health, provider or route — so it never pulses or turns red, and
 * an unavailable machine keeps its colour (the row dims instead). Colour is
 * never the only identity: callers render the machine name as text or in
 * the row's accessible label, and in forced-colour mode the dot keeps a
 * visible outline.
 */
export function MachineDot({
  colorToken,
  machineName,
  status,
  decorative = true,
  shape = "circle",
  className,
}: {
  colorToken: string | undefined;
  machineName: string;
  /** Route/status line for the tooltip, e.g. "Connected via SSH". */
  status?: string;
  /** The surrounding label already names the machine. */
  decorative?: boolean;
  /** Environment rows draw a container's dot as a square. */
  shape?: "circle" | "square";
  className?: string;
}) {
  const dot = (
    <span
      data-testid="machine-dot"
      data-machine-color={colorToken ?? "neutral"}
      data-shape={shape}
      className={cn(
        "inline-block size-2 shrink-0 ring-1 ring-black/25 dark:ring-white/35",
        shape === "square" ? "rounded-[1px]" : "rounded-full",
        "forced-colors:border forced-colors:border-[CanvasText] forced-colors:bg-[CanvasText]",
        machineDotClass(colorToken),
        className,
      )}
      {...(decorative
        ? { "aria-hidden": true }
        : {
            role: "img",
            "aria-label": `${machineName} (${machineColorLabel(colorToken)})`,
          })}
    />
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{dot}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        <span className="font-medium">{machineName}</span>
        {status ? <span className="text-muted-foreground"> · {status}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A home in the owning machine's colour, leading a repository group's member
 * row: the row is that machine's copy of the repository. The same colour rules
 * as `MachineDot` apply.
 */
export function MachineHomeIcon({
  colorToken,
  machineName,
  status,
}: {
  colorToken: string | undefined;
  machineName: string;
  status?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <House
          data-testid="machine-home-icon"
          data-machine-color={colorToken ?? "neutral"}
          aria-hidden="true"
          className={cn("h-3.5 w-3.5 shrink-0", machineTextClass(colorToken))}
        />
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        <span className="font-medium">{machineName}</span>
        {status ? <span className="text-muted-foreground"> · {status}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Dot plus a compact machine name, for mixed-machine lists. */
export function MachineBadge({
  colorToken,
  machineName,
  status,
  compact = false,
  className,
}: {
  colorToken: string | undefined;
  machineName: string;
  status?: string;
  /** Dot only (the name stays in the tooltip and accessible label). */
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground",
        className,
      )}
      data-testid="machine-badge"
    >
      <MachineDot
        colorToken={colorToken}
        machineName={machineName}
        {...(status ? { status } : {})}
        decorative={!compact}
      />
      <span className={cn("truncate", compact && "sr-only forced-colors:not-sr-only")}>
        {machineName}
      </span>
    </span>
  );
}

/** Short human text for a machine's transport state. */
export function machineStatusText(input: {
  transport: string;
  freshness?: string;
  transportDetail?: string;
  loadedAt?: number | null;
}): string {
  switch (input.transport) {
    case "connected":
      return input.freshness === "catching-up" ? "Catching up" : "Connected";
    case "connecting":
    case "authenticating":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "authentication-required":
      return "Sign-in needed";
    case "trust-blocked":
      return "Blocked: verify this machine";
    case "incompatible":
      return "Not supported by this client";
    case "disabled":
      return "Not connected";
    default:
      return input.loadedAt
        ? `Unavailable · last seen ${formatAgo(input.loadedAt)}`
        : "Unavailable";
  }
}

function formatAgo(timestamp: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}
