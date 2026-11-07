import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AgentMailPanel } from "@/components/agent-mail/AgentMailPanel";
import { NodeWorkspaceLayout } from "@/components/layout/NodeWorkspaceLayout";
import { OpenFileDialog } from "@/components/layout/OpenFileDialog";
import {
  useNodeBootHydration,
  useNodeWorkspaceServices,
  WorkspaceContent,
} from "@/components/layout/WorkspaceContent";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { TerminalProvider } from "@/contexts";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useNodeDockerAvailability } from "@/hooks/useNodeDockerAvailability";
import { useProjectHomeActivation } from "@/hooks/useProjectHomeActivation";
import { holdInTreeScope } from "@/lib/federation/in-tree-scopes";
import {
  createRealmLoopback,
  RealmChannelContext,
  type RealmLoopback,
} from "@/lib/federation/realm-channel";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/lib/mobile-shell";
import type { NodeScope, NodeScopeHealth, NodeScopeTier } from "@/lib/node-scope/node-scope";
import {
  NodeScopeProvider,
  useNodeScope,
  useSignal,
  useWindowScope,
} from "@/lib/node-scope/providers";
import { constantSignal } from "@/lib/node-scope/signal";
import { useInTreeLeafMount } from "@/lib/node-scope/shim-under-leaf-guard";
import { cn } from "@/lib/utils";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { useFederation } from "./FederationProvider";
import { NodeErrorBoundary } from "./NodeErrorBoundary";
import { NodeSnapshotPreview, useNodeSnapshot, useScopeSnapshotSync } from "./NodeSnapshotPreview";
import { nodeName, RealmStatus, useRealmRequests } from "./realm-requests";
import { WorkspaceRealmHost } from "./WorkspaceRealmHost";

/**
 * The node's workspace inside its scope: what a realm document would run for
 * it. `WorkspaceRealmHost` takes the window's requests (over the loopback in
 * context) and keeps the node's projects and environments loaded; the
 * workspace's services and boot restores run for this scope; and the layout
 * draws the node's toolbar, content and files panel under the window's title
 * bar, as a realm does.
 */
function InTreeNodeWorkspace({ shown }: { shown: boolean }) {
  const scope = useNodeScope();
  useNodeWorkspaceServices();
  useNodeBootHydration(scope);
  const projectHomeActivation = useProjectHomeActivation();
  const dockerAvailable = useNodeDockerAvailability(scope);
  const filesPanelOpen = useFilesPanelChromeStore((state) => state.isOpen);
  const phone = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  return (
    <TerminalProvider>
      <DockerAvailabilityProvider
        available={dockerAvailable === true}
        ready={dockerAvailable !== null}
      >
        <WorkspaceRealmHost />
        {/* The window's ⌘⇧P steps aside while this node is shown (`AppShell`). */}
        <OpenFileDialog enabled={shown} />
        {/* This node's tabs and their mail live here; the messages panel opens over it. */}
        <AgentMailPanel />
        <NodeWorkspaceLayout
          main={
            <WorkspaceContent
              projectHomeActivation={projectHomeActivation}
              // Another machine's starts are not gated on this host's macOS access.
              startAllowed
              dockerAvailable={dockerAvailable}
            />
          }
          filesPanelOpen={filesPanelOpen}
          phone={phone}
        />
      </DockerAvailabilityProvider>
    </TerminalProvider>
  );
}

/** Before a scope is open: no tier, no health. */
const NO_TIER = constantSignal<NodeScopeTier>("summary");
const NO_HEALTH = constantSignal<NodeScopeHealth>({ state: "disposed" });

/**
 * Another node's workspace in this window's own React tree (plan item 4001,
 * report §5.2): how every node is shown by default (6001), in place of the
 * realm the window's rollback setting brings back.
 *
 * It holds the node's scope (`holdInTreeScope`: the node-client registry in a
 * browser, main's node scope on the desktop, then the warm services), and
 * runs the realm protocol over an in-memory loopback: the window's side is
 * the same `useRealmRequests` a realm uses, the realm's side is the same
 * `WorkspaceRealmHost` and title-bar panels, reading the loopback from
 * context. Each document (first open, or Try again after a crash) is a fresh
 * loopback opened on the latest request, as a realm reload is.
 *
 * Fixed-position descendants are placed in this region (it is their
 * containing block), as they are in a realm's own viewport. A hidden node
 * stays mounted while its scope is warm, as a hidden realm does, so
 * switching back is instant. Its tier (plan item 4002, the window's
 * lifecycle) decides the rest: a suspended hidden node unmounts its views
 * (its light stores stay; showing it again opens a fresh document on them),
 * and a node pressure took back to summary is reopened when it is shown.
 */
interface OpenedWorkspace {
  readonly scope: NodeScope;
  readonly pair: RealmLoopback;
  /** Counts documents, so a retried one mounts fresh. */
  readonly generation: number;
}

export function InTreeWorkspace({ nodeId, shown }: { nodeId: string; shown: boolean }) {
  // Plan item 4004: while mounted, a command-scope shim use of a workspace store is caught.
  useInTreeLeafMount(nodeId);
  const { portalState } = useFederation();
  const machine = nodeName(portalState.nodes, nodeId);
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<{ attempt: number; workspace: OpenedWorkspace } | null>(
    null,
  );
  const [failure, setFailure] = useState<{ attempt: number; message: string } | null>(null);
  /** The document whose views went while the node was suspended and hidden (4002). */
  const [parked, setParked] = useState<RealmLoopback | null>(null);
  const windowScope = useWindowScope();
  const workspace = opened?.attempt === attempt ? opened.workspace : null;
  const send = useMemo(() => (workspace ? workspace.pair.send : null), [workspace]);
  const { restart, onMessage } = useRealmRequests(nodeId, send, shown, { inTree: true });
  // The document currently open, for the unmount below and a retry.
  const pairRef = useRef<RealmLoopback | null>(null);

  useEffect(() => {
    let current = true;
    const hold = holdInTreeScope(nodeId);
    hold.scope.then(
      (scope) => {
        if (!current) return;
        // The first document, opened on the latest request.
        const pair = createRealmLoopback(restart());
        pairRef.current = pair;
        setOpened({ attempt, workspace: { scope, pair, generation: 0 } });
      },
      (error: unknown) => {
        if (current) {
          setFailure({ attempt, message: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      current = false;
      pairRef.current?.close();
      pairRef.current = null;
      // After the grace period this closes the window's streams; the node's
      // work keeps running (invariant 2).
      hold.release();
    };
  }, [attempt, nodeId, restart]);

  // Before the realm side's passive effects, which say `ready`.
  useLayoutEffect(() => workspace?.pair.onRealmMessage(onMessage), [workspace, onMessage]);

  /** Try again after a crash: a new document on the same scope, as a realm reload. */
  const reopenDocument = useCallback(() => {
    if (!workspace) return;
    workspace.pair.close();
    const pair = createRealmLoopback(restart());
    pairRef.current = pair;
    setOpened({ attempt, workspace: { ...workspace, pair, generation: workspace.generation + 1 } });
  }, [attempt, restart, workspace]);

  // The scope's tier (4002): views mount while it is warm or live, or shown.
  const tier = useSignal(workspace?.scope.tier ?? NO_TIER);
  const health = useSignal(workspace?.scope.health ?? NO_HEALTH);
  const evicted = workspace !== null && (tier === "summary" || health.state === "disposed");
  const showViews =
    workspace !== null &&
    !evicted &&
    parked !== workspace.pair &&
    (shown || tier === "warm" || tier === "live");
  // Follows the scope's tier and the window's selection (the lifecycle's
  // inputs): suspended and hidden, the document goes and the scope's light
  // stores stay; resumed, a fresh document opens on them; taken back to
  // summary, the node opens afresh once it is the shown node again.
  useEffect(() => {
    if (!workspace) return;
    const { scope, pair } = workspace;
    const apply = () => {
      const tierNow = scope.tier.get();
      const shownNow = windowScope.selection.get()?.nodeId === nodeId;
      if (scope.disposed || tierNow === "summary") {
        if (shownNow) setAttempt((value) => value + 1);
      } else if (tierNow === "suspended" && !shownNow) {
        if (parked !== pair) {
          pair.close();
          setParked(pair);
        }
      } else if ((tierNow === "warm" || tierNow === "live") && parked === pair) {
        reopenDocument();
      }
    };
    const stops = [
      scope.tier.subscribe(apply),
      scope.health.subscribe(apply),
      windowScope.selection.subscribe(apply),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [workspace, parked, windowScope, nodeId, reopenDocument]);

  // Plan item 4003: the node's local snapshot paints at once, read-only and
  // marked stale, until the scope's first authoritative read has landed.
  const snapshot = useNodeSnapshot(nodeId, attempt);
  const snapshotSync = useScopeSnapshotSync(workspace?.scope ?? null);

  const failed = failure?.attempt === attempt ? failure.message : null;
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col overflow-hidden bg-background [transform:translateZ(0)]",
        !shown && "hidden",
      )}
      data-testid="in-tree-workspace"
      data-node={nodeId}
    >
      {!workspace && !failed && snapshot ? (
        <NodeSnapshotPreview snapshot={snapshot} machine={machine} phase="connecting" />
      ) : !workspace || failed ? (
        <RealmStatus
          failure={failed}
          machine={machine}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : snapshotSync.state === "resyncing" ? (
        // The views mount on authoritative data only: a stale environment
        // would start terminals and boot restores against what it was.
        snapshot ? (
          <NodeSnapshotPreview snapshot={snapshot} machine={machine} phase="refreshing" />
        ) : (
          <RealmStatus failure={null} machine={machine} onRetry={() => undefined} />
        )
      ) : !showViews ? (
        shown ? (
          <RealmStatus failure={null} machine={machine} onRetry={() => undefined} />
        ) : null
      ) : (
        <RealmChannelContext.Provider key={workspace.generation} value={workspace.pair.realm}>
          <NodeScopeProvider scope={workspace.scope}>
            <NodeErrorBoundary nodeId={nodeId} machine={machine} onRetry={reopenDocument}>
              <InTreeNodeWorkspace shown={shown} />
            </NodeErrorBoundary>
          </NodeScopeProvider>
        </RealmChannelContext.Provider>
      )}
    </div>
  );
}
