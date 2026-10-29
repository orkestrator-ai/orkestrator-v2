import {
  graphMockPinIssues,
  graphMockPinTargetFromTemplate,
  graphMockValue,
  type GraphMockPin,
  type GraphMockPinIssue,
  type GraphMockPins,
  type GraphMockValueMode,
} from "@orkestrator/protocol/graphs/mock";
import type { GraphNodeSpec, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";

/**
 * The designer's side of mock runs (item 213): the template's stored pins
 * (`mockPins`, designer data outside the digest), their checks against the
 * draft's ports, and previews of what a mock node answers, computed with the
 * same protocol functions the backend's mock executors use.
 */

/** Node kinds a mock run answers for; gates and merges run as in a real run. */
export const GRAPH_MOCK_PINNABLE_KINDS = ["agent", "system", "human"] as const;

export function isGraphMockPinnable(node: GraphNodeSpec): boolean {
  return (GRAPH_MOCK_PINNABLE_KINDS as readonly string[]).includes(node.kind);
}

/** The node's stored pin sequence (empty when it has none). */
export function graphMockPinsOf(template: GraphTemplateV1, nodeId: string): GraphMockPin[] {
  const pins = template.mockPins;
  return pins && Object.hasOwn(pins, nodeId) ? pins[nodeId]! : [];
}

/** Replaces a node's pin sequence; an empty one removes the node (and `mockPins` when empty). */
export function setGraphMockPins(
  template: GraphTemplateV1,
  nodeId: string,
  sequence: readonly GraphMockPin[],
): GraphTemplateV1 {
  const pins: GraphMockPins = { ...template.mockPins };
  if (sequence.length > 0) pins[nodeId] = [...sequence];
  else delete pins[nodeId];
  const next = { ...template };
  if (Object.keys(pins).length > 0) next.mockPins = pins;
  else delete next.mockPins;
  return next;
}

/** `mockPins` after a node rename or removal (`to` null removes it). */
export function moveGraphMockPins(
  pins: GraphMockPins | undefined,
  from: string,
  to: string | null,
): GraphMockPins | undefined {
  if (!pins || !Object.hasOwn(pins, from)) return pins;
  const next: GraphMockPins = {};
  for (const [id, sequence] of Object.entries(pins)) {
    if (id !== from) next[id] = sequence;
    else if (to !== null) next[to] = sequence;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The node's pins checked against the draft (unknown ports, values that fail their type). */
export function graphMockPinIssuesFor(
  template: GraphTemplateV1,
  nodeId: string,
): GraphMockPinIssue[] {
  const sequence = graphMockPinsOf(template, nodeId);
  if (sequence.length === 0) return [];
  return graphMockPinIssues(graphMockPinTargetFromTemplate(template), { [nodeId]: sequence });
}

/**
 * What a mock agent or system node answers per output port in `mode`, as the
 * backend computes it (without the run's commit and ticket, which only fit
 * the values further). `workspace@1` ports are a fake commit at run time.
 */
export function graphMockPreview(
  node: GraphNodeSpec,
  library: GraphTypeLibrary,
  mode: GraphMockValueMode,
): Record<string, unknown> {
  const outputs = "outputs" in node ? (node.outputs ?? []) : [];
  const preview: Record<string, unknown> = {};
  for (const port of outputs) {
    if (port.type === "error@1") continue;
    const resolved = library.resolve(port.type);
    if (!resolved.ok || resolved.type.kind !== "named") continue;
    preview[port.name] = graphMockValue(
      resolved.type.definition,
      mode,
      port.choices ? { choices: port.choices } : {},
    ).value;
  }
  return preview;
}
