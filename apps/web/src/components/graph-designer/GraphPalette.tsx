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
import type { GraphPaletteItem } from "./graph-designer-edits";
import { SideEffectBadge } from "./graph-form-controls";

/**
 * The palette of the editable canvas (report §7.2): Agent, System (a submenu
 * of actions), Gate, Merge, Human and Loop region. A node is added at the
 * centre of the visible canvas and selected, so its form opens. The System
 * submenu lists each action's label and description from its spec (item
 * 207) and marks the side-effecting ones. Loop region
 * wraps the selected node; more members join by dragging them onto the frame
 * or with "Move into loop". Sub-graphs arrive in Phase 4 (item 402).
 */

const BUTTON = "h-7 gap-1.5 px-2 text-xs";

export function GraphPalette({
  onAdd,
  wrapTarget,
  onWrapInLoop,
}: {
  onAdd: (item: GraphPaletteItem) => void;
  /** The selected node, which "Loop region" wraps; null when none is selected. */
  wrapTarget: string | null;
  onWrapInLoop: (nodeId: string) => void;
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
      <Button
        variant="ghost"
        size="sm"
        className={BUTTON}
        disabled
        title="Sub-graphs (another saved template as one node) arrive in Phase 4"
      >
        <Boxes className="size-3.5" /> Sub-graph
        <span className="rounded border border-border px-1 text-[9px] text-muted-foreground">
          Phase 4
        </span>
      </Button>
    </div>
  );
}
