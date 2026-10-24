import { House } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Z_FULLSCREEN_POPOVER } from "@/constants/z-index";
import {
  machineOutlineClass,
  machineTextClass,
  machineTintClass,
} from "@/lib/federation/machine-colors";
import { cn } from "@/lib/utils";
import type { AccountMachineOption } from "./account-machine";
import { MachineStatusDot } from "./machines/machine-ui";

/**
 * The machines Settings can edit, in its header: the command node first,
 * under its home, then every machine it controls. Each chip wears its
 * machine's colour. A section only the command node has (`locked`) keeps
 * the command node chosen and the others unavailable.
 */
export function SettingsMachineStrip({
  options,
  selected,
  locked,
  onSelect,
  className,
}: {
  options: readonly AccountMachineOption[];
  /** `null` is the command node. */
  selected: string | null;
  locked: boolean;
  onSelect: (nodeId: string | null) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Machine"
      data-slot="settings-machines"
      className={cn("flex min-w-0 items-center gap-2 overflow-x-auto", className)}
    >
      {options.map((option) => {
        const commandNode = option.nodeId === null;
        const current = (locked ? null : selected) === option.nodeId;
        const reason =
          locked && !commandNode
            ? "This section is shared from the command node"
            : !option.connected && !current
              ? `${option.name} is offline`
              : null;
        const chip = (
          <button
            type="button"
            aria-pressed={current}
            disabled={reason !== null}
            onClick={() => onSelect(option.nodeId)}
            data-machine-color={option.colorToken}
            className={cn(
              "flex h-7 shrink-0 items-center gap-2 rounded-md border px-2.5 text-xs transition-opacity",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              machineOutlineClass(option.colorToken),
              machineTintClass(option.colorToken),
              current
                ? "font-medium text-foreground"
                : "text-muted-foreground opacity-50 hover:opacity-100 hover:text-foreground",
              reason !== null && "cursor-not-allowed opacity-35 hover:opacity-35",
            )}
          >
            {commandNode ? (
              <House
                aria-hidden="true"
                className={cn("h-3.5 w-3.5 shrink-0", machineTextClass(option.colorToken))}
              />
            ) : (
              <MachineStatusDot
                colorToken={option.colorToken}
                connected={option.connected}
                label={option.name}
                decorative
              />
            )}
            <span className="max-w-40 truncate">{option.name}</span>
            {commandNode ? <span className="sr-only">(command node)</span> : null}
          </button>
        );
        if (reason === null) return <span key={option.nodeId ?? "command-node"}>{chip}</span>;
        return (
          <Tooltip key={option.nodeId ?? "command-node"}>
            <TooltipTrigger asChild>
              {/* A disabled button gets no pointer events; its wrapper shows why. */}
              <span tabIndex={0}>{chip}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6} className={Z_FULLSCREEN_POPOVER}>
              {reason}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
