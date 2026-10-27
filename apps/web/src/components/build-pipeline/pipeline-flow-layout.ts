/**
 * Where the build pipeline's nodes sit: one column per step, left to right,
 * at a fixed width. A long pipeline is wider than any panel, so the canvas
 * scrolls sideways rather than squeezing names; a short one is centred.
 * Reviewers stack in their pass's column, and the other nodes centre on the
 * tallest stack.
 */

import {
  FLOW_NODE_HEIGHT,
  type FlowGraphGeometry,
  type FlowRect,
} from "@/components/flow-graph/flow-graph-model";

/** The shortest the graph sizes itself to, so the inspector keeps the room. */
export const PIPELINE_FLOW_MIN_HEIGHT = 240;

export const PIPELINE_COLUMN_WIDTH = 216;
export const PIPELINE_COLUMN_GAP = 56;
const PAD_X = 16;
/** Room above the nodes for the column labels. */
const NODE_TOP = 48;
const PAD_BOTTOM = 24;
const STACK_GAP = 14;

export interface PipelineLayoutColumn {
  key: string;
  label: string;
  title?: string;
  /** Node ids top to bottom, with each node's height (see `flowNodeHeight`). */
  nodes: readonly { id: string; height: number }[];
}

export function pipelineFlowLayout({
  width,
  columns,
}: {
  width: number;
  columns: readonly PipelineLayoutColumn[];
}): FlowGraphGeometry {
  const used =
    columns.length * PIPELINE_COLUMN_WIDTH + Math.max(0, columns.length - 1) * PIPELINE_COLUMN_GAP;
  const contentWidth = Math.max(width, used + PAD_X * 2);
  const left = Math.max(PAD_X, Math.floor((contentWidth - used) / 2));
  const stackHeight = (column: PipelineLayoutColumn) =>
    column.nodes.reduce((total, node) => total + node.height, 0) +
    Math.max(0, column.nodes.length - 1) * STACK_GAP;
  const tallest = Math.max(FLOW_NODE_HEIGHT, ...columns.map(stackHeight));
  const height = Math.max(PIPELINE_FLOW_MIN_HEIGHT, NODE_TOP + tallest + PAD_BOTTOM);
  const centerY = NODE_TOP + (height - NODE_TOP - PAD_BOTTOM) / 2;

  const rects = new Map<string, FlowRect>();
  const labels: FlowGraphGeometry["labels"][number][] = [];
  columns.forEach((column, index) => {
    const x = left + index * (PIPELINE_COLUMN_WIDTH + PIPELINE_COLUMN_GAP);
    labels.push({ key: column.key, x, text: column.label, title: column.title });
    let y = Math.round(centerY - stackHeight(column) / 2);
    for (const node of column.nodes) {
      rects.set(node.id, { x, y, width: PIPELINE_COLUMN_WIDTH, height: node.height });
      y += node.height + STACK_GAP;
    }
  });
  return { width: contentWidth, height, rects, labels };
}
