import { Switch } from "@/components/ui/switch";
import { useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { MachineSection } from "./machine-ui";

/** The rollback switch's label (plan item 6001). */
export const USE_REALMS_LABEL = "Use separate workspace windows (realms)";

/**
 * Other machines' workspaces open directly in this window by default (plan
 * item 6001). This section holds the one-release rollback: separate
 * workspace views for every other machine in this window. Saved for this
 * window on this device; turning it on or off never stops work on a machine.
 */
export function InTreeWorkspaceSection() {
  const useRealms = useInTreeNodesStore((state) => state.useRealmsForRemoteMachines);
  const setUseRealms = useInTreeNodesStore((state) => state.setUseRealmsForRemoteMachines);
  return (
    <MachineSection
      title="Workspace in this window"
      description={
        useRealms
          ? "Other machines' workspaces open in separate workspace views, as in earlier releases."
          : "Other machines' workspaces open directly in this window."
      }
      testId="machine-in-tree-workspace"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-200">{USE_REALMS_LABEL}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
            A fallback if something looks wrong. Applies to every machine in this window, and work
            keeps running either way. Temporary: it goes away in a later release.
          </p>
        </div>
        <Switch
          checked={useRealms}
          aria-label={USE_REALMS_LABEL}
          onCheckedChange={(value) => setUseRealms(value)}
        />
      </div>
    </MachineSection>
  );
}
