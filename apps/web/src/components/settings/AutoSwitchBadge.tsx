import type { AgentAccountAutoSwitchState } from "@orkestrator/protocol/agent-account-auto-switch";

/** Which state a machine's automatic switching is in, shown wherever its accounts are. */
export function AutoSwitchBadge({
  state,
  pinnedLabel,
}: {
  state: AgentAccountAutoSwitchState;
  pinnedLabel?: string;
}) {
  if (state.mode === "off") {
    return (
      <span className="rounded bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        Off
      </span>
    );
  }
  return state.mode === "automatic" ? (
    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
      Automatic
    </span>
  ) : (
    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
      {pinnedLabel ? `Pinned to ${pinnedLabel}` : "Pinned"}
    </span>
  );
}
