import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { NodeScopeProvider, useNodeScope } from "@/lib/node-scope/providers";
import { cn } from "@/lib/utils";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { useFederation } from "./FederationProvider";
import { NodeErrorBoundary } from "./NodeErrorBoundary";
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

/**
 * Another node's workspace in this window's own React tree (plan item 4001,
 * report §5.2), in place of its realm while the window's `inTreeNodes`
 * setting has it.
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
 * stays mounted, as a hidden realm does, so switching back is instant.
 */
interface OpenedWorkspace {
  readonly scope: NodeScope;
  readonly pair: RealmLoopback;
  /** Counts documents, so a retried one mounts fresh. */
  readonly generation: number;
}

export function InTreeWorkspace({ nodeId, shown }: { nodeId: string; shown: boolean }) {
  const { portalState } = useFederation();
  const machine = nodeName(portalState.nodes, nodeId);
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<{ attempt: number; workspace: OpenedWorkspace } | null>(
    null,
  );
  const [failure, setFailure] = useState<{ attempt: number; message: string } | null>(null);
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
  const reopenDocument = () => {
    if (!workspace) return;
    workspace.pair.close();
    const pair = createRealmLoopback(restart());
    pairRef.current = pair;
    setOpened({ attempt, workspace: { ...workspace, pair, generation: workspace.generation + 1 } });
  };

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
      {!workspace || failed ? (
        <RealmStatus
          failure={failed}
          machine={machine}
          onRetry={() => setAttempt((value) => value + 1)}
        />
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
