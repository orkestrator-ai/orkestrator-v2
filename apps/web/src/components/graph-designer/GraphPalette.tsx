import { Bot, Boxes, ChevronDown, Cog, GitMerge, Repeat, Split, UserRound } from "lucide-react";
import { GRAPH_SYSTEM_ACTION_SPECS } from "@orkestrator/protocol/graphs/system-actions";
import { GRAPH_SYSTEM_ACTIONS } from "@orkestrator/protocol/graphs/template";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { GraphTemplateSummary } from "@orkestrator/protocol/graphs/library";
import type { GraphPaletteItem } from "./graph-designer-edits";
import type { GraphSubgraphChoice } from "./graph-designer-subgraphs";
import { SideEffectBadge } from "./graph-form-controls";

/**
 * The palette of the editable canvas (report §7.2): Agent, System (a submenu
 * of actions), Gate, Merge, Human and Loop region. A node is added at the
 * centre of the visible canvas and selected, so its form opens. The System
 * submenu lists each action's label and description from its spec (item
 * 207) and marks the side-effecting ones. Loop region
 * wraps the selected node; more members join by dragging them onto the frame
 * or with "Move into loop". "Sub-graph" (item 402) lists the saved
 * templates by scope; picking one adds it as one node, pinned to its current
 * digest, with ports from its run inputs and outputs.
 */

const BUTTON = "h-7 gap-1.5 px-2 text-xs";

const SCOPES = [
  { scope: "builtin", label: "Built-in" },
  { scope: "user", label: "Your templates" },
  { scope: "project", label: "Project templates" },
] as const;

export function GraphPalette({
  onAdd,
  wrapTarget,
  onWrapInLoop,
  subgraphs,
  onAddSubgraph,
}: {
  onAdd: (item: GraphPaletteItem) => void;
  /** The selected node, which "Loop region" wraps; null when none is selected. */
  wrapTarget: string | null;
  onWrapInLoop: (nodeId: string) => void;
  /** Saved templates the "Sub-graph" menu offers (item 402). */
  subgraphs?: readonly GraphSubgraphChoice[];
  onAddSubgraph?: (summary: GraphTemplateSummary) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Add to the graph"
      aria-orientation="horizontal"
      data-graph-palette=""
      className="flex w-max flex-wrap items-center gap-0.5 rounded-lg border border-border bg-flow-node/95 p-1 shadow-md"
    >
      <span className="px-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        Add
      </span>
      <Button variant="ghost" size="sm" className={BUTTON} onClick={() => onAdd({ kind: "agent" })}>
        <Bot className="size-3.5" /> Agent
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className={BUTTON} aria-label="System node">
            <Cog className="size-3.5" /> System
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-80">
          <DropdownMenuLabel>System actions</DropdownMenuLabel>
          {GRAPH_SYSTEM_ACTIONS.map((action) => {
            const spec = GRAPH_SYSTEM_ACTION_SPECS[action];
            return (
              <DropdownMenuItem
                key={action}
                data-graph-system-action={action}
                onSelect={() => onAdd({ kind: "system", action })}
                title={spec.description}
                className="flex flex-col items-start gap-0"
              >
                <span className="flex w-full items-center gap-1.5 text-xs font-medium">
                  {spec.label}
                  {spec.sideEffect ? <SideEffectBadge className="ml-auto" /> : null}
                </span>
                <span className="line-clamp-2 text-[11px] text-muted-foreground">
                  {spec.description}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="sm" className={BUTTON} onClick={() => onAdd({ kind: "gate" })}>
        <Split className="size-3.5" /> Gate
      </Button>
      <Button variant="ghost" size="sm" className={BUTTON} onClick={() => onAdd({ kind: "merge" })}>
        <GitMerge className="size-3.5" /> Merge
      </Button>
      <Button variant="ghost" size="sm" className={BUTTON} onClick={() => onAdd({ kind: "human" })}>
        <UserRound className="size-3.5" /> Human
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={BUTTON}
        disabled={wrapTarget === null}
        title={
          wrapTarget === null
            ? "Select a node to wrap it in a loop region"
            : `Wrap ${wrapTarget} in a loop region`
        }
        onClick={() => wrapTarget && onWrapInLoop(wrapTarget)}
      >
        <Repeat className="size-3.5" /> Loop region
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={BUTTON}
            aria-label="Sub-graph node"
            disabled={!subgraphs || subgraphs.length === 0}
            title={
              !subgraphs || subgraphs.length === 0
                ? "No saved template to use as a sub-graph yet"
                : "Use a saved template as one node"
            }
          >
            <Boxes className="size-3.5" /> Sub-graph
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="max-h-96 w-80 overflow-y-auto">
          {SCOPES.map(({ scope, label }) => {
            const choices = (subgraphs ?? []).filter((choice) => choice.summary.scope === scope);
            if (choices.length === 0) return null;
            return (
              <div key={scope}>
                <DropdownMenuLabel>{label}</DropdownMenuLabel>
                {choices.map(({ summary, disabled }) => (
                  <DropdownMenuItem
                    key={`${summary.scope}:${summary.id}:${summary.ref.scope === "project" ? summary.ref.path : ""}`}
                    data-graph-subgraph-choice={`${summary.scope}:${summary.id}`}
                    disabled={disabled !== undefined}
                    onSelect={() => onAddSubgraph?.(summary)}
                    title={disabled ?? summary.description}
                    className="flex flex-col items-start gap-0"
                  >
                    <span className="flex w-full items-center gap-1.5 text-xs font-medium">
                      {summary.name}
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                        {summary.id}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-[11px] text-muted-foreground">
                      {disabled ??
                        (summary.engine
                          ? "Runs here as a copy on the graph runtime"
                          : (summary.description ?? `Revision ${summary.revision}`))}
                    </span>
                  </DropdownMenuItem>
                ))}
              </div>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
