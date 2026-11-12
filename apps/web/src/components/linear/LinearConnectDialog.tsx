/**
 * Connect Linear on this machine and, optionally, on every other machine
 * with the same repository (docs/todo/cross-cutting/7767-linear-boards-per-
 * project-and-coordinator-tools.md, task 1). The window sends the pasted key
 * to each ticked machine's own backend, which verifies and stores it; no
 * backend sends it to another. The key lives only in this dialog's state: it
 * is never logged, persisted, put in a URL or shown.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, AlertTriangle, Check, ExternalLink, Loader2, WifiOff, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { OutcomeUnknownError } from "@/lib/portal/portal-store";
import { cn } from "@/lib/utils";
import type { LinearBoardLink, LinearConnectionStatus, LinearNodeConnection } from "@/types/linear";
import {
  linearKeyFingerprint,
  useLinearMachineTargets,
  type LinearMachineTarget,
} from "./linear-machines";

/** What the dialog knows of a machine's connection before it sends anything. */
type MachineStatus =
  | { state: "loading" }
  | { state: "unknown" }
  | {
      state: "known";
      connected: boolean;
      hasToken: boolean;
      viewerName?: string;
      keyFingerprint?: string;
    };

/** The answer to sending the key to one machine. */
type MachineResult =
  | { state: "connecting" }
  | { state: "connected"; viewerName?: string }
  | { state: "rejected"; message: string }
  | { state: "unreachable"; message: string };

const UNREACHABLE =
  /unavailable|unreachable|not connected|offline|timed? ?out|timeout|network|failed to fetch|ECONN|unknown-node/i;

/** A rejected key and an unreachable machine need different next steps. */
export function classifyConnectError(error: unknown): MachineResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof OutcomeUnknownError || UNREACHABLE.test(message)) {
    return { state: "unreachable", message: message || "The machine did not answer" };
  }
  return { state: "rejected", message: message || "Linear rejected the key" };
}

function statusFromConnection(status: LinearConnectionStatus): MachineStatus {
  return {
    state: "known",
    connected: status.connected,
    hasToken: status.hasToken,
    viewerName: status.viewer?.name,
    keyFingerprint: status.keyFingerprint,
  };
}

function statusFromNodeConnection(connection: LinearNodeConnection): MachineStatus {
  return {
    state: "known",
    connected: connection.connected,
    hasToken: connection.connected || connection.keyFingerprint !== undefined,
    viewerName: connection.viewerName,
    keyFingerprint: connection.keyFingerprint,
  };
}

/** A machine holding a different key than the one pasted, which connecting would replace. */
export function holdsDifferentKey(status: MachineStatus | undefined, fingerprint: string | null) {
  return (
    !!fingerprint &&
    status?.state === "known" &&
    status.hasToken &&
    !!status.keyFingerprint &&
    status.keyFingerprint !== fingerprint
  );
}

/**
 * Whether connecting there can only add or refresh this key: the machine's
 * state is known, and it holds no key or this same one. A machine still
 * loading, unknown, or holding a key whose fingerprint it did not report
 * might hold another account's key, so it is left for the user to tick.
 */
export function safeToConnectByDefault(
  status: MachineStatus | undefined,
  fingerprint: string | null,
) {
  if (status?.state !== "known") return false;
  if (!status.hasToken) return true;
  return !!fingerprint && status.keyFingerprint === fingerprint;
}

function StatusLine({
  target,
  status,
  fingerprint,
}: {
  target: LinearMachineTarget;
  status: MachineStatus | undefined;
  fingerprint: string | null;
}) {
  if (!target.available) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <WifiOff className="h-3 w-3" />
        Offline: connect it there later
      </span>
    );
  }
  if (!status || status.state === "loading") {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking
      </span>
    );
  }
  if (status.state === "unknown") {
    return (
      <span className="text-muted-foreground">
        Status unknown: tick it to connect anyway (it may hold another key)
      </span>
    );
  }
  const as = status.viewerName ? ` as ${status.viewerName}` : "";
  if (holdsDifferentKey(status, fingerprint)) {
    return (
      <span className="inline-flex items-start gap-1 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>Uses a different key{as}. Connecting replaces it.</span>
      </span>
    );
  }
  if (status.connected) {
    const same = fingerprint && status.keyFingerprint === fingerprint;
    return (
      <span className="text-muted-foreground">
        {same ? `Already connected with this key${as}` : `Connected${as}`}
      </span>
    );
  }
  if (status.hasToken) {
    return <span className="text-muted-foreground">Has a key that no longer works{as}</span>;
  }
  return <span className="text-muted-foreground">Not connected</span>;
}

function ResultLine({ result }: { result: MachineResult }) {
  switch (result.state) {
    case "connecting":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Connecting
        </span>
      );
    case "connected":
      return (
        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-500">
          <Check className="h-3 w-3" />
          Connected{result.viewerName ? ` as ${result.viewerName}` : ""}
        </span>
      );
    case "rejected":
      return (
        <span className="inline-flex items-start gap-1 text-destructive">
          <X className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">Key rejected: {result.message}</span>
        </span>
      );
    case "unreachable":
      return (
        <span className="inline-flex items-start gap-1 text-destructive">
          <WifiOff className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="break-words">Unreachable: {result.message}</span>
        </span>
      );
  }
}

export function LinearConnectDialog({
  open,
  onOpenChange,
  projectId,
  currentConnection,
  boardLink,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** This machine's connection as the tab last read it. */
  currentConnection: LinearConnectionStatus | null;
  /** This project's board, when linked: given to the machines just connected. */
  boardLink?: LinearBoardLink | null;
  /** This machine's new connection. */
  onConnected: (status: LinearConnectionStatus) => void;
}) {
  const nodeBackend = useScopeBackend();
  const onCommandNode = useScopesWithCommandFallback().scope.role === "command";
  const targets = useLinearMachineTargets(projectId);
  const [apiKey, setApiKey] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<ReadonlyMap<string, MachineStatus>>(new Map());
  const [results, setResults] = useState<ReadonlyMap<string, MachineResult>>(new Map());
  // Only the machines the user ticked or unticked; the rest use the default.
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  const statusRequestRef = useRef(0);

  const others = useMemo(() => targets.filter((target) => !target.current), [targets]);
  const trimmedKey = apiKey.trim();
  const fingerprint = useMemo(
    () => (trimmedKey ? linearKeyFingerprint(trimmedKey) : null),
    [trimmedKey],
  );

  // Each other machine's status: the command node's last synced reading
  // first, then a live read through the machine routing. Re-read only when
  // the set of machines changes, not on every summary refresh.
  const otherKeys = others.map((target) => target.key).join("\n");
  const othersRef = useRef(others);
  useLayoutEffect(() => {
    othersRef.current = others;
  }, [others]);
  useEffect(() => {
    const list = othersRef.current;
    if (!open || list.length === 0) return;
    const requestId = statusRequestRef.current + 1;
    statusRequestRef.current = requestId;
    const update = (key: string, status: MachineStatus) => {
      if (statusRequestRef.current !== requestId) return;
      setStatuses((current) => {
        // A failed live read keeps the synced reading.
        if (status.state === "unknown" && current.get(key)?.state === "known") return current;
        return new Map(current).set(key, status);
      });
    };
    setStatuses(new Map(list.map((target) => [target.key, { state: "loading" }])));
    void nodeBackend
      // From a leaf's workspace, `null` asks the window's command node.
      .getLinearNodeConnections(onCommandNode ? undefined : null)
      .then((connections) => {
        for (const connection of connections) {
          const target = list.find((entry) => entry.nodeId === connection.nodeId);
          if (target) update(target.key, statusFromNodeConnection(connection));
        }
      })
      .catch(() => undefined);
    for (const target of list) {
      if (!target.available) {
        update(target.key, { state: "unknown" });
        continue;
      }
      nodeBackend
        .getLinearConnection(target.machine)
        .then((status) => update(target.key, statusFromConnection(status)))
        .catch(() => update(target.key, { state: "unknown" }));
    }
    return () => {
      statusRequestRef.current += 1;
    };
  }, [open, otherKeys, nodeBackend, onCommandNode]);

  const currentStatus: MachineStatus | undefined = currentConnection
    ? statusFromConnection(currentConnection)
    : undefined;
  const statusOf = (target: LinearMachineTarget) =>
    target.current ? currentStatus : statuses.get(target.key);
  const isChecked = (target: LinearMachineTarget) => {
    if (target.current) return true;
    if (!target.available) return false;
    const choice = choices.get(target.key);
    if (choice !== undefined) return choice;
    // Ticked by default only when connecting cannot replace another key there.
    return safeToConnectByDefault(statusOf(target), fingerprint);
  };

  const reset = () => {
    setApiKey("");
    setError(null);
    setResults(new Map());
    setChoices(new Map());
  };

  const handleOpenChange = (next: boolean) => {
    if (!next && !isConnecting) reset();
    onOpenChange(next);
  };

  const handleConnect = async () => {
    const key = apiKey.trim();
    if (!key) return;
    const chosen = targets.filter(isChecked);
    setIsConnecting(true);
    setError(null);
    setResults(new Map(chosen.map((target) => [target.key, { state: "connecting" }])));
    const settled = await Promise.all(
      chosen.map(async (target) => {
        try {
          // This tab's own node takes the plain call.
          const status = target.current
            ? await nodeBackend.connectLinear(key)
            : await nodeBackend.connectLinear(key, target.machine);
          return {
            target,
            status,
            result: { state: "connected", viewerName: status.viewer?.name },
          };
        } catch (connectError) {
          return { target, status: null, result: classifyConnectError(connectError) };
        }
      }),
    );
    setIsConnecting(false);
    setResults(new Map(settled.map(({ target, result }) => [target.key, result as MachineResult])));

    // Backend sync takes the board link to every machine with the repository;
    // giving it to the machines just connected makes it immediate there.
    // Best effort: a machine that already has a link keeps it.
    const teamId = boardLink?.teamId;
    if (teamId) {
      for (const { target, status } of settled) {
        if (target.current || !status) continue;
        void nodeBackend
          .getLinearBoardLink(target.projectId, target.machine)
          .then((existing) =>
            existing
              ? undefined
              : nodeBackend.setLinearBoardLink(
                  target.projectId,
                  teamId,
                  boardLink.linearProjectId,
                  target.machine,
                ),
          )
          .catch(() => undefined);
      }
    }

    const current = settled.find(({ target }) => target.current);
    if (current?.status) onConnected(current.status);
    const failed = settled.filter(({ status }) => !status);
    if (failed.length === 0) {
      reset();
      onOpenChange(false);
      toast.success(
        settled.length > 1 ? `Linear connected on ${settled.length} machines` : "Linear connected",
      );
      return;
    }
    // Keep the dialog open on the per-machine report; successes stand.
    if (current && !current.status) {
      const result = current.result as MachineResult;
      setError("message" in result ? result.message : "Failed to connect Linear");
    }
  };

  const showChecklist = trimmedKey.length > 0 && others.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="[--modal-max-width:540px]">
        <DialogHeader>
          <DialogTitle>Connect Linear</DialogTitle>
          <DialogDescription>
            Paste a Linear personal API key. Each machine verifies it and keeps its own copy.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setResults(new Map());
            }}
            placeholder="lin_api_..."
            aria-label="Linear API key"
            autoComplete="off"
            disabled={isConnecting}
          />
          {showChecklist && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium text-foreground">
                Connect on these machines
              </legend>
              <div className="overflow-hidden rounded-md border border-border">
                {targets.map((target, index) => {
                  const checked = isChecked(target);
                  const result = results.get(target.key);
                  const different = holdsDifferentKey(statusOf(target), fingerprint);
                  const id = `linear-machine-${index}`;
                  return (
                    <div
                      key={target.key}
                      className={cn(
                        "flex items-start gap-3 p-3",
                        index > 0 && "border-t border-border",
                        different && !result && "bg-amber-500/5",
                      )}
                    >
                      <Checkbox
                        id={id}
                        checked={checked}
                        disabled={target.current || !target.available || isConnecting}
                        onCheckedChange={(value) =>
                          setChoices((current) => new Map(current).set(target.key, value === true))
                        }
                        className="mt-0.5"
                      />
                      <label htmlFor={id} className="min-w-0 flex-1 space-y-0.5">
                        <div className="text-sm font-medium text-foreground">
                          {target.name}
                          {target.current && target.name !== "This machine" && (
                            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                              this machine
                            </span>
                          )}
                        </div>
                        <div className="text-xs">
                          {result ? (
                            <ResultLine result={result} />
                          ) : (
                            <StatusLine
                              target={target}
                              status={statusOf(target)}
                              fingerprint={fingerprint}
                            />
                          )}
                        </div>
                      </label>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => void nodeBackend.openInBrowser("https://linear.app/settings/api")}
          >
            <ExternalLink className="h-4 w-4" />
            API settings
          </Button>
          <Button
            type="button"
            onClick={() => void handleConnect()}
            disabled={isConnecting || !trimmedKey}
          >
            {isConnecting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
