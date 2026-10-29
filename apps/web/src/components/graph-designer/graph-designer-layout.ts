import type { GraphLayoutPoint, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { isGraphRunInputRef } from "@orkestrator/protocol/graphs/template";

/**
 * Canvas geometry for the Graphs designer: where each node sits, before the
 * loop groups make member positions relative. A template's own `layout` wins
 * when it places every node; otherwise every node is laid out automatically
 * in layers (longest path from the run inputs), so a partly saved layout never
 * overlaps automatic positions. Item 212 saves positions back to `layout`.
 */

/** Width of every node face, in canvas units. */
export const GRAPH_NODE_WIDTH = 240;
/** Run inputs and outputs: the pseudo-nodes at either end. */
export const GRAPH_IO_NODE_WIDTH = 180;
const NODE_HEADER_HEIGHT = 78;
const PORT_ROW_HEIGHT = 20;
const LAYER_GAP = 90;
const ROW_GAP = 40;
/** Space between a loop group's frame and its members (the top holds the label). */
export const GRAPH_LOOP_PADDING = { top: 36, side: 20, bottom: 20 } as const;

/** Ids of the run-input and run-output pseudo-nodes; `$` is outside the node-id grammar. */
export const GRAPH_INPUTS_NODE_ID = "$inputs";
export const GRAPH_OUTPUTS_NODE_ID = "$outputs";

export interface GraphLayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphDesignerLayout {
  /** Absolute boxes of template nodes and the I/O pseudo-nodes. */
  boxes: Map<string, GraphLayoutBox>;
  /** Absolute boxes of loop regions, around their members. */
  loops: Map<string, GraphLayoutBox>;
  /** Whether the template's own `layout` was used. */
  fromTemplate: boolean;
  /** Template nodes in a topological order (ties in template order); cycles last. */
  order: string[];
}

/** The estimated height of a face with this many port rows. */
export function graphNodeHeight(portRows: number): number {
  return NODE_HEADER_HEIGHT + Math.max(1, portRows) * PORT_ROW_HEIGHT;
}

function portRows(template: GraphTemplateV1, nodeId: string): number {
  const node = template.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return 1;
  const inputs = node.inputs?.length ?? 0;
  const outputs =
    node.kind === "gate"
      ? node.branches.length + (node.otherwise === undefined ? 0 : 1)
      : node.kind === "human"
        ? node.form.kind === "choose"
          ? node.form.options.length
          : 2
        : (node.outputs?.length ?? 0);
  return Math.max(inputs, outputs);
}

/**
 * A topological order of the template's nodes by its edges (Kahn's algorithm,
 * ties in template order). Nodes left on a cycle, which the compiler reports,
 * follow in template order, so the order always covers every node once.
 */
export function graphTemplateOrder(template: GraphTemplateV1): string[] {
  const ids = template.nodes.map((node) => node.id);
  const known = new Set(ids);
  const incoming = new Map<string, number>(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of template.edges) {
    if (isGraphRunInputRef(edge.from)) continue;
    const from = edge.from.node;
    const to = edge.to.node;
    if (!known.has(from) || !known.has(to) || from === to) continue;
    outgoing.get(from)!.push(to);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  const position = new Map(ids.map((id, index) => [id, index]));
  const ready = ids.filter((id) => incoming.get(id) === 0);
  const order: string[] = [];
  const placed = new Set<string>();
  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const id = ready.shift()!;
    order.push(id);
    placed.add(id);
    for (const next of outgoing.get(id)!) {
      const remaining = incoming.get(next)! - 1;
      incoming.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  for (const id of ids) if (!placed.has(id)) order.push(id);
  return order;
}

/** Longest-path layer of each node over the edges, in `order`. */
function layers(template: GraphTemplateV1, order: readonly string[]): Map<string, number> {
  const layer = new Map<string, number>(order.map((id) => [id, 0]));
  const rank = new Map(order.map((id, index) => [id, index]));
  const preds = new Map<string, string[]>(order.map((id) => [id, []]));
  for (const edge of template.edges) {
    if (isGraphRunInputRef(edge.from)) continue;
    const from = edge.from.node;
    const to = edge.to.node;
    // Only forward edges in the order count, so a cycle cannot loop forever.
    if (!rank.has(from) || !rank.has(to) || rank.get(from)! >= rank.get(to)!) continue;
    preds.get(to)!.push(from);
  }
  for (const id of order) {
    for (const pred of preds.get(id)!) {
      layer.set(id, Math.max(layer.get(id)!, layer.get(pred)! + 1));
    }
  }
  return layer;
}

function templatePlacesEveryNode(
  template: GraphTemplateV1,
): template is GraphTemplateV1 & { layout: Record<string, GraphLayoutPoint> } {
  const layout = template.layout;
  if (!layout || template.nodes.length === 0) return false;
  return template.nodes.every((node) => {
    const point = layout[node.id];
    return Boolean(point) && Number.isFinite(point!.x) && Number.isFinite(point!.y);
  });
}

/**
 * Lays the template out. Automatic layout puts each node in its layer's
 * column and gives every loop its own band of rows, so a loop's frame holds
 * only its members; nodes outside loops share the last band.
 */
export function layoutGraphTemplate(template: GraphTemplateV1): GraphDesignerLayout {
  const order = graphTemplateOrder(template);
  const boxes = new Map<string, GraphLayoutBox>();
  const height = (id: string) => graphNodeHeight(portRows(template, id));
  const hasInputs = template.inputs.length > 0;
  const hasOutputs = (template.outputs?.length ?? 0) > 0;
  const ioHeight = (count: number) => graphNodeHeight(count);

  const loopOf = new Map<string, string>();
  for (const loop of template.loops ?? []) {
    for (const member of loop.nodes) if (!loopOf.has(member)) loopOf.set(member, loop.id);
  }

  const fromTemplate = templatePlacesEveryNode(template);
  if (fromTemplate) {
    for (const node of template.nodes) {
      const point = template.layout[node.id]!;
      boxes.set(node.id, {
        x: point.x,
        y: point.y,
        width: GRAPH_NODE_WIDTH,
        height: height(node.id),
      });
    }
    const all = Array.from(boxes.values());
    const minX = Math.min(...all.map((box) => box.x));
    const maxX = Math.max(...all.map((box) => box.x + box.width));
    const minY = Math.min(...all.map((box) => box.y));
    if (hasInputs) {
      boxes.set(GRAPH_INPUTS_NODE_ID, {
        x: minX - GRAPH_IO_NODE_WIDTH - LAYER_GAP,
        y: minY,
        width: GRAPH_IO_NODE_WIDTH,
        height: ioHeight(template.inputs.length),
      });
    }
    if (hasOutputs) {
      boxes.set(GRAPH_OUTPUTS_NODE_ID, {
        x: maxX + LAYER_GAP,
        y: minY,
        width: GRAPH_IO_NODE_WIDTH,
        height: ioHeight(template.outputs!.length),
      });
    }
  } else {
    const layer = layers(template, order);
    const offset = hasInputs ? 1 : 0;
    // Bands: one per loop (in template order), then the rest.
    const loopIds = (template.loops ?? []).map((loop) => loop.id);
    const bandOf = (id: string) => {
      const loop = loopOf.get(id);
      return loop === undefined ? loopIds.length : loopIds.indexOf(loop);
    };
    const bandCount = loopIds.length + 1;
    // Rows used per (band, layer), and the tallest stack per band.
    const cells = new Map<string, string[]>();
    for (const id of order) {
      const key = `${bandOf(id)}:${layer.get(id)!}`;
      const cell = cells.get(key) ?? [];
      cell.push(id);
      cells.set(key, cell);
    }
    const bandHeight = Array.from({ length: bandCount }, () => 0);
    for (const [key, ids] of cells) {
      const band = Number(key.split(":")[0]);
      const stack = ids.reduce((sum, id) => sum + height(id) + ROW_GAP, 0);
      bandHeight[band] = Math.max(bandHeight[band]!, stack);
    }
    const bandTop: number[] = [];
    let top = 0;
    for (let band = 0; band < bandCount; band += 1) {
      bandTop.push(top);
      const used = bandHeight[band]!;
      if (used > 0) {
        top +=
          used + (band < loopIds.length ? GRAPH_LOOP_PADDING.top + GRAPH_LOOP_PADDING.bottom : 0);
      }
    }
    for (const [key, ids] of cells) {
      const [bandText, layerText] = key.split(":");
      const band = Number(bandText);
      const column = Number(layerText) + offset;
      let y = bandTop[band]! + (band < loopIds.length ? GRAPH_LOOP_PADDING.top : 0);
      for (const id of ids) {
        boxes.set(id, {
          x: column * (GRAPH_NODE_WIDTH + LAYER_GAP),
          y,
          width: GRAPH_NODE_WIDTH,
          height: height(id),
        });
        y += height(id) + ROW_GAP;
      }
    }
    const lastLayer = Math.max(0, ...Array.from(layer.values()));
    if (hasInputs) {
      boxes.set(GRAPH_INPUTS_NODE_ID, {
        // Column 0, right-aligned towards the first layer.
        x: GRAPH_NODE_WIDTH - GRAPH_IO_NODE_WIDTH,
        y: 0,
        width: GRAPH_IO_NODE_WIDTH,
        height: ioHeight(template.inputs.length),
      });
    }
    if (hasOutputs) {
      boxes.set(GRAPH_OUTPUTS_NODE_ID, {
        x: (lastLayer + offset + 1) * (GRAPH_NODE_WIDTH + LAYER_GAP),
        y: 0,
        width: GRAPH_IO_NODE_WIDTH,
        height: ioHeight(template.outputs!.length),
      });
    }
  }

  const loops = new Map<string, GraphLayoutBox>();
  for (const loop of template.loops ?? []) {
    const members = loop.nodes
      .filter((id) => loopOf.get(id) === loop.id)
      .map((id) => boxes.get(id))
      .filter((box): box is GraphLayoutBox => Boolean(box));
    if (members.length === 0) continue;
    const minX = Math.min(...members.map((box) => box.x));
    const minY = Math.min(...members.map((box) => box.y));
    const maxX = Math.max(...members.map((box) => box.x + box.width));
    const maxY = Math.max(...members.map((box) => box.y + box.height));
    loops.set(loop.id, {
      x: minX - GRAPH_LOOP_PADDING.side,
      y: minY - GRAPH_LOOP_PADDING.top,
      width: maxX - minX + 2 * GRAPH_LOOP_PADDING.side,
      height: maxY - minY + GRAPH_LOOP_PADDING.top + GRAPH_LOOP_PADDING.bottom,
    });
  }
  return { boxes, loops, fromTemplate, order };
}
