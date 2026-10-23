import type { ReactNode } from "react";
import { Globe, House, Laptop, Network, Shield } from "lucide-react";
import { machineDotClass } from "@/lib/federation/machine-colors";
import { cn } from "@/lib/utils";

/** What an environment's hover card can show; another machine's may be partial until read. */
export interface EnvironmentTooltipDetails {
  createdAt?: string;
  projectHome?: boolean;
  branch?: string;
  environmentType?: string;
  networkAccessMode?: string;
  entryPort?: number;
  hostEntryPort?: number;
  prUrl?: string | null;
}

export interface EnvironmentTooltipMachine {
  name: string;
  colorToken: string | undefined;
  /** Shown after the name, e.g. "this window" or "connection lost". */
  status?: string;
}

/**
 * The body of an environment's hover card, for this machine's rows and for
 * other machines' rows alike. Every card names the machine the environment
 * is on whenever this client can show machines.
 */
export function EnvironmentTooltipBody({
  name,
  machine,
  details,
  agentSummary,
  changes,
  onCopyAddress,
}: {
  name: string;
  machine: EnvironmentTooltipMachine | null;
  details: EnvironmentTooltipDetails;
  agentSummary?: ReactNode;
  changes?: ReactNode;
  onCopyAddress?: () => void;
}) {
  const isLocal = details.environmentType === "local";
  return (
    <div className="space-y-1">
      <p className="font-medium">{name}</p>
      {machine && (
        <p
          className="text-xs text-muted-foreground flex items-center gap-1.5"
          data-testid="environment-tooltip-machine"
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-block size-2 shrink-0 rounded-full ring-1 ring-black/25 dark:ring-white/35",
              machineDotClass(machine.colorToken),
            )}
          />
          On {machine.name}
          {machine.status ? ` · ${machine.status}` : null}
        </p>
      )}
      {details.createdAt && (
        <p className="text-xs text-muted-foreground">
          Created: {new Date(details.createdAt).toLocaleDateString()}
        </p>
      )}
      {agentSummary}
      {details.projectHome ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <House className="h-3 w-3" />
          Project checkout{details.branch ? ` · ${details.branch}` : ""}
        </p>
      ) : isLocal ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Laptop className="h-3 w-3" />
          Local worktree
        </p>
      ) : details.environmentType ? (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          {details.networkAccessMode === "full" ? (
            <>
              <Globe className="h-3 w-3" />
              Full network access
            </>
          ) : (
            <>
              <Shield className="h-3 w-3" />
              Restricted network
            </>
          )}
        </p>
      ) : null}
      {!isLocal && details.entryPort && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Network className="h-3 w-3" />
          {details.hostEntryPort ? (
            <>
              Port:{" "}
              {onCopyAddress ? (
                <span
                  role="button"
                  className="underline decoration-dotted cursor-pointer hover:text-foreground transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCopyAddress();
                  }}
                >
                  localhost:{details.hostEntryPort}
                </span>
              ) : (
                <span>port {details.hostEntryPort} on that machine</span>
              )}{" "}
              → {details.entryPort}/tcp
            </>
          ) : (
            <>Port: {details.entryPort}/tcp (not mapped)</>
          )}
        </p>
      )}
      {changes}
      {details.prUrl && <p className="text-xs text-blue-400">PR: {details.prUrl}</p>}
    </div>
  );
}
