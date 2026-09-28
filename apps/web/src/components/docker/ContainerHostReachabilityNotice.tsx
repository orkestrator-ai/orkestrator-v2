import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  CONTAINER_HOST_REACHABILITY_CHANGED_EVENT,
  containerHostReachabilityNeedsAttention,
  isContainerHostReachability,
  type ContainerHostProbe,
  type ContainerHostReachability,
} from "@orkestrator/protocol/container-host-reachability";

import * as backend from "@/lib/backend";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT, listen, type NativeEvent } from "@/lib/native/events";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const DISMISSED_KEY = "orkestrator.containerHostReachability.dismissed";
const AUTO_OPENED_KEY = "orkestrator.containerHostReachability.autoOpened";

/** One problem, identified so a hidden warning comes back when the problem changes. */
function problemKey(value: ContainerHostReachability): string {
  return `${value.status}:${value.reason ?? ""}:${value.port ?? ""}`;
}

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Private mode or a full store: the warning simply shows again.
  }
}

/**
 * The backend's container → agent tools reachability snapshot, refreshed on
 * every change event and on event-stream reconnect (events may be missed).
 */
export function useContainerHostReachability(): {
  value: ContainerHostReachability | null;
  checking: boolean;
  recheck: () => Promise<void>;
} {
  const [value, setValue] = useState<ContainerHostReachability | null>(null);
  const [checking, setChecking] = useState(false);
  const refreshRef = useRef<() => void>(() => undefined);

  refreshRef.current = () => {
    // Inside an async function so an older backend, or a stub without the
    // command, is a quiet no-op rather than a synchronous render error.
    void (async () => {
      try {
        const next = await backend.getContainerHostReachability();
        if (isContainerHostReachability(next)) setValue(next);
      } catch {
        // The next change event, reconnect or remount refreshes it.
      }
    })();
  };

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const subscribe = (event: string, handler: (event: NativeEvent<unknown>) => void) => {
      void listen(event, handler)
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => undefined);
    };
    subscribe(CONTAINER_HOST_REACHABILITY_CHANGED_EVENT, ({ payload }) => {
      if (isContainerHostReachability(payload)) setValue(payload);
      else refreshRef.current();
    });
    subscribe(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => refreshRef.current());
    refreshRef.current();
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      const next = await backend.checkContainerHostReachability();
      if (isContainerHostReachability(next)) {
        setValue(next);
        if (next.status === "reachable") {
          toast.success("Docker containers can now reach Orkestrator");
        } else if (containerHostReachabilityNeedsAttention(next)) {
          toast.error("Docker containers still can't reach Orkestrator");
        }
      }
    } catch (error) {
      toast.error(
        `Couldn't run the container connectivity check: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setChecking(false);
    }
  }, []);

  return { value, checking, recheck };
}

function probeLabel(probe: ContainerHostProbe): string {
  switch (probe.scope) {
    case "default-bridge":
      return "Default Docker network";
    case "environment-network":
      return "Environment network";
    case "environment-container":
      return "Environment container";
  }
}

function outcomeLabel(probe: ContainerHostProbe): string {
  switch (probe.outcome) {
    case "reachable":
      return probe.httpStatus ? `reachable (HTTP ${probe.httpStatus})` : "reachable";
    case "timeout":
      return "timed out (dropped by a firewall)";
    case "refused":
      return "connection refused";
    case "unreachable":
      return "no route to host";
    case "dns":
      return "host name did not resolve";
    case "error":
      return "probe failed to run";
  }
}

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    toast.error("Failed to copy to clipboard");
  }
}

export function ContainerHostReachabilityDialog({
  value,
  open,
  onOpenChange,
  checking,
  onRecheck,
}: {
  value: ContainerHostReachability;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checking: boolean;
  onRecheck: () => void;
}) {
  const blocked = value.status === "blocked";
  const remediation = value.remediation;
  const commands = remediation?.commands ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            {blocked
              ? "Docker containers can't reach Orkestrator"
              : "Couldn't check container connectivity"}
          </DialogTitle>
          <DialogDescription>{value.summary}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {blocked && (
            <p className="text-muted-foreground">
              Review, build pipeline and planning stages that run in a container will stop before
              they start, with this explanation, rather than running and never reporting back. Local
              worktree environments are not affected.
            </p>
          )}

          {remediation && (
            <div className="space-y-2">
              <p className="font-medium text-foreground">{remediation.title}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                {remediation.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              {commands.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      Run in a terminal on this computer
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => void copyText(commands.join("\n"), "Command")}
                    >
                      <Copy className="mr-2 h-3.5 w-3.5" />
                      Copy
                    </Button>
                  </div>
                  <pre
                    data-testid="container-host-reachability-commands"
                    className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs text-foreground"
                  >
                    {commands.join("\n")}
                  </pre>
                </div>
              )}
            </div>
          )}

          <details className="rounded-md border border-border p-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Check details
            </summary>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Agent tools URL</dt>
              <dd className="font-mono">{value.url ?? "unknown"}</dd>
              <dt className="text-muted-foreground">Host firewall</dt>
              <dd>{value.firewall.detail ?? value.firewall.kind}</dd>
              <dt className="text-muted-foreground">Docker subnets</dt>
              <dd className="font-mono">{value.subnets.join(", ") || "unknown"}</dd>
              <dt className="text-muted-foreground">Probe image</dt>
              <dd className="break-all font-mono">{value.probeImage ?? "none"}</dd>
              <dt className="text-muted-foreground">Checked</dt>
              <dd>{value.checkedAt ? new Date(value.checkedAt).toLocaleString() : "never"}</dd>
            </dl>
            {value.probes.length > 0 && (
              <ul className="mt-3 space-y-2 text-xs">
                {value.probes.map((probe, index) => (
                  <li key={`${probe.scope}-${probe.network ?? index}`} className="space-y-0.5">
                    <div>
                      <span className="font-medium">{probeLabel(probe)}</span>{" "}
                      <span className="text-muted-foreground">
                        ({probe.network ?? "?"}
                        {probe.subnet ? `, ${probe.subnet}` : ""}):
                      </span>{" "}
                      {outcomeLabel(probe)} after {Math.round(probe.elapsedMs / 100) / 10}s
                    </div>
                    {probe.detail && (
                      <div className="break-all font-mono text-muted-foreground">
                        {probe.detail}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={onRecheck} disabled={checking}>
            {checking ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Checking...
              </>
            ) : (
              "Check again"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Warns as soon as the startup check finds that agents in Docker containers
 * cannot reach the agent tools server, instead of the user discovering it when
 * a review stage fails to submit its result. The dialog opens by itself once
 * per problem per app session; the banner stays until the problem is fixed or
 * the user hides it.
 */
export function ContainerHostReachabilityNotice() {
  const { value, checking, recheck } = useContainerHostReachability();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => readSession(DISMISSED_KEY));

  const attention = value !== null && containerHostReachabilityNeedsAttention(value);
  const key = value ? problemKey(value) : null;

  useEffect(() => {
    if (!value || value.status !== "blocked" || !key) return;
    if (readSession(AUTO_OPENED_KEY) === key) return;
    writeSession(AUTO_OPENED_KEY, key);
    setDialogOpen(true);
  }, [value, key]);

  useEffect(() => {
    if (value?.status === "reachable") setDialogOpen(false);
  }, [value?.status]);

  if (!value || (!attention && !dialogOpen)) return null;

  const hidden = key !== null && dismissedKey === key;
  return (
    <>
      {/* Hidden under the open dialog, whose footer it would cover. */}
      {attention && !hidden && !dialogOpen && (
        <div
          role="alert"
          data-testid="container-host-reachability-banner"
          className="fixed bottom-4 right-4 z-[89] flex max-w-md flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-950/95 px-4 py-3 text-sm text-amber-100 shadow-xl"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
            <span>
              {value.status === "blocked"
                ? "Agents in Docker containers can't reach Orkestrator, so container review and pipeline stages can't report results."
                : value.summary}
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-amber-100 hover:bg-amber-900/60"
              onClick={() => {
                if (!key) return;
                writeSession(DISMISSED_KEY, key);
                setDismissedKey(key);
              }}
            >
              Hide
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
              {value.status === "blocked" ? "How to fix" : "Details"}
            </Button>
          </div>
        </div>
      )}
      <ContainerHostReachabilityDialog
        value={value}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        checking={checking || value.status === "checking"}
        onRecheck={() => void recheck()}
      />
    </>
  );
}
