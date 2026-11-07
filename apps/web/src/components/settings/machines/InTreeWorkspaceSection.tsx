import { Switch } from "@/components/ui/switch";
import {
  developmentInTreeOverride,
  isInTreeNode,
  useInTreeNodesStore,
} from "@/stores/inTreeNodesStore";
import { MachineSection } from "./machine-ui";

/**
 * Whether this window shows the machine's workspace in its own tree rather
 * than in a separate workspace view (plan item 4001). Saved for this window
 * on this device; turning it off goes back to the separate view and never
 * stops work on the machine.
 */
export function InTreeWorkspaceSection({ nodeId, name }: { nodeId: string; name: string }) {
  const stored = useInTreeNodesStore((state) => state.nodes);
  const setInTree = useInTreeNodesStore((state) => state.setInTree);
  const override = developmentInTreeOverride();
  const forced = override === "*" || override.has(nodeId);
  const checked = isInTreeNode(nodeId, stored, override);
  const label = `Show ${name}'s workspace in this window`;
  return (
    <MachineSection
      title="Workspace in this window"
      description={
        forced
          ? "On for this development build (VITE_ORKESTRATOR_IN_TREE_NODES)."
          : "Experimental. Draws this machine's workspace directly in this window instead of a separate view. Turn it off to go back. Its work keeps running either way."
      }
      testId="machine-in-tree-workspace"
      action={
        <Switch
          checked={checked}
          disabled={forced}
          aria-label={label}
          onCheckedChange={(value) => setInTree(nodeId, value)}
        />
      }
    >
      {null}
    </MachineSection>
  );
}
