import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useBlockingOverlay } from "@/components/browser/browser-tab-hooks";
import { browserPanelUrl } from "@/lib/federation/panel-realm";
import {
  closeLeafWorkspace,
  keepWorkspaceAlive,
  openLeafWorkspace,
  storeWorkspaceForFrame,
  type LeafWorkspace,
} from "@/lib/portal/workspaces";
import { cn } from "@/lib/utils";
import { useMachineViewStore, type MachinePanelSpec } from "@/stores/machineViewStore";
import { useFederation } from "./FederationProvider";
import { MachineDot, machineStatusText } from "./MachineDot";
import { useMachineViews } from "./useMachineViews";

/**
 * Workspace panels of other machines, side by side with this window's own
 * workspace. Each panel is its own renderer realm bound to one machine, so
 * its stores, subscriptions and credentials cannot reach another machine,
 * and a change of focus here never changes where its operations go.
 * Closing a panel releases observation; the machine's work keeps running.
 */
export function MachinePanelsRegion() {
  const panels = useMachineViewStore((state) => state.panels);
  const { kind, enabled } = useFederation();
  // With multi-machine views off, panels are hidden (and their observation
  // released); the outer layout is kept for when they are turned back on.
  if (panels.length === 0 || kind === "none" || !enabled) return null;
  return (
    <div className="flex h-full min-w-0 flex-1" data-testid="machine-panels">
      {panels.map((panel) => (
        <MachinePanel key={panel.id} spec={panel} />
      ))}
    </div>
  );
}

function MachinePanel({ spec }: { spec: MachinePanelSpec }) {
  const { kind } = useFederation();
  const machines = useMachineViews();
  const machine = machines.find((candidate) => candidate.connectionId === spec.connectionId);
  const closePanel = useMachineViewStore((state) => state.closePanel);
  const focusPanel = useMachineViewStore((state) => state.focusPanel);
  const focused = useMachineViewStore((state) => state.focusedPanelId === spec.id);
  const environmentName =
    (spec.environmentId &&
      machine?.environmentsByProject
        .get(spec.projectId)
        ?.find((environment) => environment.ref.environmentId === spec.environmentId)?.name) ||
    spec.title;
  const status = machine
    ? machineStatusText({
        transport: machine.transport,
        freshness: machine.freshness,
        loadedAt: machine.loadedAt,
      })
    : "Not saved on this device";

  return (
    <section
      className={cn(
        "flex h-full min-w-[320px] flex-1 flex-col border-l border-border",
        focused && "ring-1 ring-inset ring-primary/40",
      )}
      aria-label={`${environmentName} on ${machine?.name ?? "an unknown machine"}`}
      onFocusCapture={() => focusPanel(spec.id)}
      onMouseDown={() => focusPanel(spec.id)}
      data-testid="machine-panel"
      data-machine={spec.connectionId}
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-chrome px-2">
        {machine ? (
          <MachineDot colorToken={machine.colorToken} machineName={machine.name} status={status} />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {environmentName}
          <span className="font-normal text-muted-foreground">
            {" "}
            · {machine?.name ?? "Unknown machine"}
          </span>
        </span>
        {machine && machine.transport !== "connected" ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-amber-400">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {status}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => closePanel(spec.id)}
          aria-label={`Close ${environmentName} panel. Work on ${machine?.name ?? "that machine"} keeps running.`}
          title="Close panel (work keeps running)"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </header>
      <div className="relative min-h-0 flex-1 bg-background">
        {!machine ? (
          <MissingMachine />
        ) : kind === "desktop" ? (
          <NativePanelView spec={spec} />
        ) : (
          <FramePanelView spec={spec} title={`${environmentName} on ${machine.name}`} />
        )}
      </div>
    </section>
  );
}

function MissingMachine() {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      This machine is not registered on the node you are connected to. Add it in Settings →
      Connections → Nodes to open this workspace.
    </div>
  );
}

/** Desktop: a child renderer positioned over this placeholder by the native layer. */
function NativePanelView({ spec }: { spec: MachinePanelSpec }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [nativeId, setNativeId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const closePanel = useMachineViewStore((state) => state.closePanel);
  const blocked = useBlockingOverlay(true);

  const panelsAvailable = Boolean(window.orkestrator?.panels);

  useEffect(() => {
    const api = window.orkestrator?.panels;
    if (!api) return;
    let disposed = false;
    let opened: string | null = null;
    void api
      .open({
        connectionId: spec.connectionId,
        ...(spec.projectId ? { projectId: spec.projectId } : {}),
        ...(spec.environmentId ? { environmentId: spec.environmentId } : {}),
      })
      .then(({ panelId }) => {
        if (disposed) {
          void api.close(panelId).catch(() => undefined);
          return;
        }
        opened = panelId;
        setNativeId(panelId);
      })
      .catch((error: unknown) => {
        if (!disposed) setFailure(error instanceof Error ? error.message : String(error));
      });
    const unsubscribe = api.onEvent((event) => {
      if (event.panelId !== opened) return;
      if (event.type === "closed") closePanel(spec.id);
      else
        setFailure(
          event.type === "crashed"
            ? "This panel stopped responding."
            : "This panel could not load.",
        );
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (opened) void api.close(opened).catch(() => undefined);
    };
  }, [closePanel, spec.connectionId, spec.environmentId, spec.id, spec.projectId]);

  useEffect(() => {
    const api = window.orkestrator?.panels;
    const host = hostRef.current;
    if (!api || !host || !nativeId) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        void api
          .setBounds(nativeId, {
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
          })
          .catch(() => undefined);
        // A native view paints above the page; hide it while a dialog or
        // menu of this window is open so it never covers one.
        void api
          .setVisible(nativeId, !blocked && rect.width > 0 && rect.height > 0)
          .catch(() => undefined);
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(host);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      void api.setVisible(nativeId, false).catch(() => undefined);
    };
  }, [blocked, nativeId]);

  return (
    <div ref={hostRef} className="absolute inset-0" data-testid="native-machine-panel">
      {failure || !panelsAvailable ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-sm text-destructive">
          {failure ?? "Machine panels are not available in this window."}
        </div>
      ) : !nativeId ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Opening…
        </div>
      ) : null}
    </div>
  );
}

/**
 * Browser and iOS: a same-origin frame of this app bound to the node's
 * workspace. The command node issues a short-lived grant; the frame talks to
 * the node directly when it can, otherwise through the command node's relay.
 * Closing the panel revokes the grant; the node's work keeps running.
 */
function FramePanelView({ spec, title }: { spec: MachinePanelSpec; title: string }) {
  const { boundMachine } = useFederation();
  const [workspace, setWorkspace] = useState<LeafWorkspace | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The name only labels the path; a late profile load must not reopen the workspace.
  const commandNodeName = useRef(boundMachine?.name ?? "");
  commandNodeName.current = boundMachine?.name ?? commandNodeName.current;

  useEffect(() => {
    let disposed = false;
    let opened: LeafWorkspace | null = null;
    let stopRenewal: (() => void) | null = null;
    void openLeafWorkspace(spec.connectionId as never, {
      commandNodeName: commandNodeName.current,
    })
      .then((value) => {
        if (disposed) {
          void closeLeafWorkspace(value.workspaceId);
          return;
        }
        opened = value;
        storeWorkspaceForFrame(value);
        stopRenewal = keepWorkspaceAlive(value.workspaceId);
        setWorkspace(value);
      })
      .catch((error: unknown) => {
        if (!disposed) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
      stopRenewal?.();
      if (opened) void closeLeafWorkspace(opened.workspaceId);
    };
  }, [spec.connectionId]);

  if (failure) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-destructive">
        {failure}
      </div>
    );
  }
  if (!workspace) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Opening…
      </div>
    );
  }
  return (
    <iframe
      className="absolute inset-0 h-full w-full border-0"
      title={title}
      src={browserPanelUrl({
        workspaceId: workspace.workspaceId,
        nodeId: workspace.nodeId,
        connection: workspace,
        ...(spec.projectId ? { projectId: spec.projectId } : {}),
        ...(spec.environmentId ? { environmentId: spec.environmentId } : {}),
      })}
      data-testid="frame-machine-panel"
      data-connection-path={workspace.path}
    />
  );
}
