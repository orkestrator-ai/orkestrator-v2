import { useMemo, useState } from "react";
import { graphNodeOutlets, type GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  GRAPH_NEW_PORT_HANDLE,
  graphConnectionVerdict,
  type GraphConnectEnd,
  type GraphConnectionVerdict,
} from "./graph-designer-connect";
import { graphLoopOf, graphNodeById } from "./graph-designer-edits";
import { GRAPH_INPUTS_NODE_ID, GRAPH_OUTPUTS_NODE_ID } from "./graph-designer-layout";
import { FIELD_CLASS } from "./graph-form-controls";

/**
 * Keyboard equivalents of drawing on the canvas (canvas spike notes):
 * "Connect to…" picks a source and one of the targets it may connect to
 * (the same compatibility the drag uses), and "Move into loop" moves a node
 * into a loop region, wraps it in a new one, or takes it out.
 */

interface EndOption {
  key: string;
  end: GraphConnectEnd;
  label: string;
}

function endKey(end: GraphConnectEnd): string {
  return `${end.node}|${end.handle}`;
}

/** Every handle a connection can start at: run inputs, outputs and outlets. */
function sourceOptions(template: GraphTemplateV1): EndOption[] {
  const options: EndOption[] = template.inputs.map((input) => ({
    key: endKey({ node: GRAPH_INPUTS_NODE_ID, handle: `out:${input.name}` }),
    end: { node: GRAPH_INPUTS_NODE_ID, handle: `out:${input.name}` },
    label: `Run input ${input.name} (${input.type})`,
  }));
  for (const node of template.nodes) {
    const outputs = node.kind === "gate" || node.kind === "human" ? [] : (node.outputs ?? []);
    for (const port of outputs) {
      const end = { node: node.id, handle: `out:${port.name}` };
      options.push({ key: endKey(end), end, label: `${node.id}.${port.name} (${port.type})` });
    }
    for (const outlet of graphNodeOutlets(node) ?? []) {
      const end = { node: node.id, handle: `outlet:${outlet}` };
      options.push({ key: endKey(end), end, label: `${node.id} → ${outlet} (outlet)` });
    }
  }
  return options;
}

/** Every handle a connection can end at, including the `+` handles. */
function targetOptions(template: GraphTemplateV1): EndOption[] {
  const options: EndOption[] = [];
  for (const node of template.nodes) {
    for (const port of node.inputs ?? []) {
      const end = { node: node.id, handle: `in:${port.name}` };
      options.push({ key: endKey(end), end, label: `${node.id}.${port.name} (${port.type})` });
    }
    if (node.kind !== "subgraph") {
      const end = { node: node.id, handle: GRAPH_NEW_PORT_HANDLE };
      options.push({ key: endKey(end), end, label: `${node.id}: new input` });
    }
  }
  for (const output of template.outputs ?? []) {
    const end = { node: GRAPH_OUTPUTS_NODE_ID, handle: `in:${output.name}` };
    options.push({ key: endKey(end), end, label: `Run output ${output.name} (${output.type})` });
  }
  const end = { node: GRAPH_OUTPUTS_NODE_ID, handle: GRAPH_NEW_PORT_HANDLE };
  options.push({ key: endKey(end), end, label: "New run output" });
  return options;
}

export function GraphConnectDialog({
  open,
  onOpenChange,
  template,
  library,
  nodeId,
  onConnect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: GraphTemplateV1;
  library: GraphTypeLibrary;
  /** The node the command was given on: its outputs come first, then its inputs as targets. */
  nodeId: string | null;
  onConnect: (verdict: Extract<GraphConnectionVerdict, { ok: true }>) => void;
}) {
  const sources = useMemo(() => sourceOptions(template), [template]);
  const targets = useMemo(() => targetOptions(template), [template]);
  const ownSource = sources.find((option) => option.end.node === nodeId);
  const [sourceKey, setSourceKey] = useState<string>(ownSource?.key ?? sources[0]?.key ?? "");
  const [targetKey, setTargetKey] = useState<string>("");
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      // A node without outputs is the target: connect something into it.
      setSourceKey(ownSource?.key ?? sources[0]?.key ?? "");
      setTargetKey("");
    }
  }
  const source = sources.find((option) => option.key === sourceKey);
  const verdicts = useMemo(
    () =>
      source
        ? targets.map((target) => ({
            target,
            verdict: graphConnectionVerdict(template, library, source.end, target.end),
          }))
        : [],
    [source, targets, template, library],
  );
  const compatible = verdicts.filter((entry) => entry.verdict.ok);
  // Targets on the node the command was given on come first.
  compatible.sort(
    (a, b) => Number(b.target.end.node === nodeId) - Number(a.target.end.node === nodeId),
  );
  const chosen = compatible.find((entry) => entry.target.key === targetKey) ?? compatible[0];
  const verdict = chosen?.verdict;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Connect</DialogTitle>
          <DialogDescription>
            Only targets the source can connect to are listed, as when dragging on the canvas.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">From</span>
            <select
              aria-label="From"
              value={sourceKey}
              onChange={(event) => {
                setSourceKey(event.target.value);
                setTargetKey("");
              }}
              className={FIELD_CLASS}
            >
              {sources.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">To ({compatible.length} compatible)</span>
            <select
              aria-label="To"
              value={chosen?.target.key ?? ""}
              onChange={(event) => setTargetKey(event.target.value)}
              className={FIELD_CLASS}
              disabled={compatible.length === 0}
            >
              {compatible.map((entry) => (
                <option key={entry.target.key} value={entry.target.key}>
                  {entry.target.label}
                </option>
              ))}
            </select>
          </label>
          <p role="status" className="text-xs text-muted-foreground" data-graph-connect-summary="">
            {verdict?.ok ? verdict.summary : "Nothing this source can connect to."}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!verdict?.ok}
            onClick={() => {
              if (verdict?.ok) {
                onConnect(verdict);
                onOpenChange(false);
              }
            }}
          >
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type GraphLoopChoice =
  { kind: "join"; loopId: string } | { kind: "new" } | { kind: "leave" };

export function GraphLoopDialog({
  open,
  onOpenChange,
  template,
  nodeId,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: GraphTemplateV1;
  nodeId: string | null;
  onChoose: (choice: GraphLoopChoice) => void;
}) {
  const current = nodeId ? graphLoopOf(template, nodeId) : undefined;
  const node = nodeId ? graphNodeById(template, nodeId) : undefined;
  const others = (template.loops ?? []).filter((loop) => loop.id !== current?.id);
  const choose = (choice: GraphLoopChoice) => {
    onChoose(choice);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Loop region for {node?.label ?? nodeId}</DialogTitle>
          <DialogDescription>
            {current ? `It is in ${current.label ?? current.id}.` : "It is not in a loop."} Loops
            are bounded regions that repeat until their condition holds.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          {others.map((loop) => (
            <Button
              key={loop.id}
              variant="outline"
              className="justify-start"
              onClick={() => choose({ kind: "join", loopId: loop.id })}
            >
              Move into {loop.label ?? loop.id}
            </Button>
          ))}
          <Button
            variant="outline"
            className="justify-start"
            onClick={() => choose({ kind: "new" })}
          >
            Wrap in a new loop region
          </Button>
          {current ? (
            <Button
              variant="outline"
              className="justify-start"
              onClick={() => choose({ kind: "leave" })}
            >
              Take out of {current.label ?? current.id}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
