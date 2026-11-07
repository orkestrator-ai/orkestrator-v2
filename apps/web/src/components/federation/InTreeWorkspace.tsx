import { useCallback, useEffect, useState } from "react";
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
import { NodeWorkspaceHost } from "./NodeWorkspaceHost";
import { nodeName, NodeWorkspaceStatus } from "./NodeWorkspaceStatus";

/**
 * The node's workspace inside its scope. `NodeWorkspaceHost` applies the
 * window's requests and keeps the node's projects and environments loaded;
 * the workspace's services and boot restores run for this scope; and the
 * layout draws the node's toolbar, content and files panel under the
 * window's title bar.
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
        <NodeWorkspaceHost />
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
 * report §5.2): how every node is shown.
 *
 * It holds the node's scope (`holdInTreeScope`: the node-client registry in a
 * browser, main's node scope on the desktop, then the warm services) and
 * mounts the node's workspace in it. The window's requests reach the
 * workspace through the window's own store (`remoteWorkspaceStore.requests`,
 * applied by `NodeWorkspaceHost`). Each document (first open, or Try again
 * after a crash) is a fresh mount of the views on the same scope.
 *
 * Fixed-position descendants are placed in this region (it is their
 * containing block). A hidden node stays mounted while its scope is warm, so
 * switching back is instant. Its tier (plan item 4002, the window's
 * lifecycle) decides the rest: a suspended hidden node unmounts its views
 * (its light stores stay; showing it again opens a fresh document on them),
 * and a node pressure took back to summary is reopened when it is shown.
 */
interface OpenedWorkspace {
  readonly scope: NodeScope;
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
  const [parked, setParked] = useState<OpenedWorkspace | null>(null);
  const windowScope = useWindowScope();
  const workspace = opened?.attempt === attempt ? opened.workspace : null;

  useEffect(() => {
    let current = true;
    const hold = holdInTreeScope(nodeId);
    hold.scope.then(
      (scope) => {
        if (!current) return;
        setOpened({ attempt, workspace: { scope, generation: 0 } });
      },
      (error: unknown) => {
        if (current) {
          setFailure({ attempt, message: error instanceof Error ? error.message : String(error) });
        }
      },
    );
    return () => {
      current = false;
      // After the grace period this closes the window's streams; the node's
      // work keeps running (invariant 2).
      hold.release();
    };
  }, [attempt, nodeId]);

  /** Try again after a crash: a new document on the same scope. */
  const reopenDocument = useCallback(() => {
    if (!workspace) return;
    setOpened({ attempt, workspace: { ...workspace, generation: workspace.generation + 1 } });
  }, [attempt, workspace]);

  // The scope's tier (4002): views mount while it is warm or live, or shown.
  const tier = useSignal(workspace?.scope.tier ?? NO_TIER);
  const health = useSignal(workspace?.scope.health ?? NO_HEALTH);
  const evicted = workspace !== null && (tier === "summary" || health.state === "disposed");
  const showViews =
    workspace !== null &&
    !evicted &&
    parked !== workspace &&
    (shown || tier === "warm" || tier === "live");
  // Follows the scope's tier and the window's selection (the lifecycle's
  // inputs): suspended and hidden, the document goes and the scope's light
  // stores stay; resumed, a fresh document opens on them; taken back to
  // summary, the node opens afresh once it is the shown node again.
  useEffect(() => {
    if (!workspace) return;
    const { scope } = workspace;
    const apply = () => {
      const tierNow = scope.tier.get();
      const shownNow = windowScope.selection.get()?.nodeId === nodeId;
      if (scope.disposed || tierNow === "summary") {
        if (shownNow) setAttempt((value) => value + 1);
      } else if (tierNow === "suspended" && !shownNow) {
        if (parked !== workspace) setParked(workspace);
      } else if ((tierNow === "warm" || tierNow === "live") && parked === workspace) {
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
        <NodeWorkspaceStatus
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
          <NodeWorkspaceStatus failure={null} machine={machine} onRetry={() => undefined} />
        )
      ) : !showViews ? (
        shown ? (
          <NodeWorkspaceStatus failure={null} machine={machine} onRetry={() => undefined} />
        ) : null
      ) : (
        <NodeScopeProvider key={workspace.generation} scope={workspace.scope}>
          <NodeErrorBoundary nodeId={nodeId} machine={machine} onRetry={reopenDocument}>
            <InTreeNodeWorkspace shown={shown} />
          </NodeErrorBoundary>
        </NodeScopeProvider>
      )}
    </div>
  );
}
