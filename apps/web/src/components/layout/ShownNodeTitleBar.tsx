import type { ReactNode } from "react";
import { SystemUsageIndicator, SystemUsageMeters } from "@/components/layout/SystemUsageIndicator";
import { AgentInfoButton, AgentInfoTrigger } from "@/components/layout/AgentInfoButton";
import { useWorkspaceActiveTab } from "@/components/layout/NodeWorkspaceLayout";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import {
  NodeScopeProvider,
  useScopesWithCommandFallback,
  useSignal,
  WindowScopeProvider,
} from "@/lib/node-scope/providers";
import { useNodesInTree } from "@/stores/inTreeNodesStore";

/**
 * The title bar's meters and agent button for another node shown in the
 * window's own tree (plan item 5002, report §9 and Appendix C): the same
 * components the window shows for its own node, inside that node's scope, so
 * their readings and popovers are that node's. No realm reports a title bar
 * and no popover is drawn under a window trigger: the popovers are ordinary,
 * opened and dismissed (focus back on their trigger) where they sit.
 */

/**
 * Whether the window shows `nodeId` in its own tree, and that node's scope
 * once it is open there (`InTreeWorkspace` opens it). `null` for no node, or
 * one a realm shows.
 */
export function useShownInTreeNode(nodeId: string | null): { scope: NodeScope | null } | null {
  const { windowScope } = useScopesWithCommandFallback();
  // Re-read when the node's scope opens or closes.
  useSignal(windowScope.nodeScopes);
  const inTree = useNodesInTree();
  if (!nodeId || !inTree) return null;
  const scope = windowScope.get(nodeId as BackendId);
  return { scope: scope && !scope.disposed ? scope : null };
}

/** `scope`'s subtree, in the window it belongs to (the title bar may sit outside any provider). */
function InScope({ scope, children }: { scope: NodeScope; children: ReactNode }) {
  const { windowScope } = useScopesWithCommandFallback();
  return (
    <WindowScopeProvider windowScope={windowScope}>
      {/* Keyed by node: another node's popover is another popover. */}
      <NodeScopeProvider key={scope.nodeId} scope={scope}>
        {children}
      </NodeScopeProvider>
    </WindowScopeProvider>
  );
}

/** The shown node's host meters and their process popover; empty readings while its scope opens. */
export function NodeTitleBarUsage({ scope }: { scope: NodeScope | null }) {
  if (!scope) {
    return (
      <div className="relative flex items-center" data-testid="node-system-usage-opening">
        <SystemUsageMeters usage={null} stale={false} open={false} onToggle={() => undefined} />
      </div>
    );
  }
  return (
    <InScope scope={scope}>
      <SystemUsageIndicator />
    </InScope>
  );
}

function ScopedAgentInfo({ mobile }: { mobile: boolean }) {
  // The shown node's active tab: its own selection and pane layout.
  const activeTab = useWorkspaceActiveTab();
  return <AgentInfoButton activeTab={activeTab} mobile={mobile} />;
}

/** The shown node's agent-information button and popover; inert while its scope opens. */
export function NodeTitleBarAgentInfo({
  scope,
  mobile = false,
}: {
  scope: NodeScope | null;
  mobile?: boolean;
}) {
  if (!scope) {
    return (
      <div className={mobile ? "relative h-9 w-9" : "relative h-8 w-8"}>
        <AgentInfoTrigger open={false} mobile={mobile} remote onClick={() => undefined} />
      </div>
    );
  }
  return (
    <InScope scope={scope}>
      <ScopedAgentInfo mobile={mobile} />
    </InScope>
  );
}
