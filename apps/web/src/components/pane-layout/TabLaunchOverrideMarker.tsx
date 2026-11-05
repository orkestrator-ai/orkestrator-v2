import { useCoordinatorLaunchOverride } from "@/stores/coordinatorLaunchOverrideStore";

/**
 * Says a coordinator launched this worker tab on something other than the saved
 * default. The same word a Work row uses, kept apart from `DraggableTab` so an
 * answer re-renders only this marker. A tab with no override renders nothing.
 */
export function TabLaunchOverrideMarker({
  environmentId,
  tabId,
}: {
  environmentId: string;
  tabId: string;
}) {
  const override = useCoordinatorLaunchOverride(environmentId, tabId);
  if (!override) return null;
  const selection = [override.model, override.reasoning].filter(Boolean).join(" · ");
  return (
    <span
      data-testid="tab-launch-override"
      className="shrink-0 rounded-sm border border-amber-400/40 px-1 text-[10px] leading-4 text-amber-400"
      title={
        selection
          ? `The coordinator requested ${selection} instead of the saved default.`
          : "The coordinator overrode the saved default for this launch."
      }
    >
      requested
    </span>
  );
}
