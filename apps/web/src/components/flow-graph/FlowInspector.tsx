import type { ReactNode } from "react";
import type { RuntimeParts } from "@/lib/review/runtime-summary";
import { cn } from "@/lib/utils";
import type { FlowNodeState } from "./flow-graph-model";
import { FlowStateIcon, flowNodeElementId, type FlowNodeModel } from "./FlowGraph";

const PILL_CLASS: Record<FlowNodeState, string> = {
  "not-started": "border-border text-muted-foreground",
  running: "border-cyan-400/25 bg-cyan-400/8 text-cyan-300",
  paused: "border-amber-400/30 bg-amber-400/8 text-amber-300",
  complete: "border-success/30 bg-success/8 text-green-300",
  failed: "border-failure/30 bg-failure/8 text-failure",
  cancelling: "border-border text-muted-foreground",
  cancelled: "border-border text-muted-foreground",
};

function tokensInWords(runtime: RuntimeParts | null): string | null {
  if (runtime?.tokens) return `${runtime.tokens} tokens`;
  if (runtime?.tokensPending) return "Tokens pending";
  return null;
}

/** Icon, name, status pill and token count of the selected node, with its actions. */
export function FlowInspectorHeader({
  node,
  actions,
  testIdPrefix,
}: {
  node: FlowNodeModel;
  actions: ReactNode;
  /** Names the status pill for tests: `{prefix}-inspector-status`. */
  testIdPrefix: string;
}) {
  const tokens = tokensInWords(node.runtime);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
      <FlowStateIcon
        state={node.state}
        stalled={node.stalled}
        idleIcon={node.idleIcon}
        className="size-4"
      />
      <h2 className="min-w-0 truncate text-sm font-semibold">{node.title}</h2>
      <span
        data-testid={`${testIdPrefix}-inspector-status`}
        className={cn(
          "shrink-0 rounded-full border px-2 py-px text-[11px]",
          node.stalled && node.state === "running"
            ? "border-amber-500/30 bg-amber-500/8 text-amber-500"
            : PILL_CLASS[node.state],
        )}
      >
        {node.statusLabel}
      </span>
      {tokens ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{tokens}</span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>
    </div>
  );
}

/**
 * The inspector below a flow graph: the tab panel its nodes control, named by
 * the selected node. What it holds is the workflow's own.
 */
export function FlowInspectorPanel({
  panelId,
  selectedId,
  testId,
  className,
  children,
}: {
  panelId: string;
  selectedId: string;
  testId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      role="tabpanel"
      id={panelId}
      aria-labelledby={flowNodeElementId(panelId, selectedId)}
      data-testid={testId}
      className={className}
    >
      {children}
    </section>
  );
}
