/**
 * Compiler pass: workspace rules (D3, report §6.7).
 *
 * 1. At most one writing activation per workspace at a time.
 * 2. No reader runs while a writer writes.
 * 3. Readers consume a pinned commit (a lint, in lint.ts).
 * 4. Replicated nodes are read-only or do not touch the workspace, unless
 *    they write isolated worktrees (`isolation: "worktree"`, item 403): then
 *    each branch writes its own worktree, and the node counts as a *reader*
 *    of the run's workspace for rules 1 and 2. Isolation needs a replicated
 *    writer with exactly one single `workspace@1` input (its worktrees' base)
 *    and at most 8 branches.
 * 5. A `select-workspace` node's candidates come from an isolated node.
 *
 * "Can run at the same time" comes from the DAG: two nodes no path orders
 * may run concurrently, unless they sit on different outlets of one gate or
 * human node, or loop iterations order them (`graphNodesConcurrent`).
 */
import { graphNodesConcurrent } from "./compile-graph.js";
import { type GraphCompileState, graphNodeWorkspaceAccess } from "./compile-state.js";
import { GRAPH_ISOLATION_BOUNDS } from "./isolation.js";
import { parseGraphTypeRef } from "./grammar.js";
import { isGraphRunInputRef, type GraphEdgeSource, type GraphNodeSpec } from "./template-model.js";

function isolated(node: GraphNodeSpec): boolean {
  return node.kind === "agent" && node.isolation === "worktree";
}

/** What a node holds on the run's own workspace (an isolated writer reads it). */
function mainAccess(node: GraphNodeSpec) {
  const access = graphNodeWorkspaceAccess(node);
  return isolated(node) && access === "write" ? "read" : access;
}

/** Rule 4's isolation checks for one node. */
function checkIsolation(state: GraphCompileState, node: GraphNodeSpec, path: string): void {
  if (node.kind !== "agent" || node.isolation === undefined) return;
  const at = { nodeId: node.id, path: `${path}.isolation` };
  const { diagnostics } = state;
  if (!state.isReplicated(node.id)) {
    diagnostics.add(
      "isolation-not-replicated",
      `${node.id} asks for isolated worktrees but is not replicated; only a replicated node's branches can each get one`,
      at,
    );
  }
  if (node.workspaceAccess !== "write") {
    diagnostics.add(
      "isolation-not-writer",
      `${node.id} asks for isolated worktrees but does not write the workspace (workspaceAccess is "${node.workspaceAccess}")`,
      at,
    );
  }
  const bases = (node.inputs ?? []).filter((port) => {
    const parsed = parseGraphTypeRef(port.type);
    return parsed?.name === "workspace" && parsed.listDepth === 0;
  });
  if (bases.length !== 1) {
    diagnostics.add(
      "isolation-unpinned",
      bases.length === 0
        ? `${node.id} has no workspace@1 input; its worktrees need the commit they start from`
        : `${node.id} has ${bases.length} workspace@1 inputs; its worktrees start from exactly one`,
      { nodeId: node.id, path: `${path}.inputs` },
    );
  }
  const branches = state.branches.get(node.id);
  if (branches && branches.max > GRAPH_ISOLATION_BOUNDS.maxBranches) {
    diagnostics.add(
      "isolation-branch-limit",
      `${node.id} can run ${branches.max} branches; an isolated node runs at most ${GRAPH_ISOLATION_BOUNDS.maxBranches}, each with its own worktree`,
      { nodeId: node.id, path: `${path}.replicate` },
    );
  }
}

/** The node producing a source, followed through gate and human outlets (bounded). */
function producingNodes(
  state: GraphCompileState,
  source: GraphEdgeSource,
  seen = new Set<string>(),
): GraphNodeSpec[] {
  if (isGraphRunInputRef(source)) return [];
  const node = state.nodes.get(source.node)?.node;
  if (!node || seen.has(`${source.node}.${source.port}`) || seen.size > 64) return [];
  seen.add(`${source.node}.${source.port}`);
  if (source.outlet === undefined) return [node];
  return state
    .producersOf(source.node, source.port)
    .flatMap((producer) => producingNodes(state, producer.from, seen));
}

/** Rule 5: a select's candidates are an isolated node's branches. */
function checkSelect(state: GraphCompileState, node: GraphNodeSpec, path: string): void {
  if (node.kind !== "system" || node.action !== "select-workspace") return;
  (node.inputs ?? []).forEach((port, index) => {
    if (port.type !== "list<workspace@1>") return;
    const sources = state
      .producersOf(node.id, port.name)
      .flatMap((producer) => producingNodes(state, producer.from));
    if (sources.length > 0 && sources.every(isolated)) return;
    state.diagnostics.add(
      "select-without-isolated-branches",
      `${node.id} selects among ${port.name}, which no replicated node with isolation: worktree feeds; only isolated branches have commits of their own to choose from`,
      { nodeId: node.id, port: port.name, path: `${path}.inputs[${index}]` },
    );
  });
}

export function checkGraphWorkspace(state: GraphCompileState): void {
  const { diagnostics, template } = state;
  const access = new Map([...state.nodes.values()].map(({ node }) => [node.id, mainAccess(node)]));
  for (const { node, path } of state.nodes.values()) {
    checkIsolation(state, node, path);
    checkSelect(state, node, path);
  }

  for (const { node, path } of state.nodes.values()) {
    const mode = graphNodeWorkspaceAccess(node);
    if (mode === "none") continue;
    if (template.workspace.kind === "none") {
      diagnostics.add(
        "workspace-unavailable",
        `${node.id} ${mode === "write" ? "writes" : "reads"} the workspace, but the template runs without one (workspace.kind is "none")`,
        { nodeId: node.id, path: node.kind === "agent" ? `${path}.workspaceAccess` : path },
      );
      continue;
    }
    if (mode === "write" && state.isReplicated(node.id) && !isolated(node)) {
      diagnostics.add(
        "replicated-writer",
        `${node.id} is replicated and writes the workspace; give it isolation: worktree so each branch writes its own worktree, or make it read-only (D3)`,
        { nodeId: node.id, path: node.kind === "agent" ? `${path}.workspaceAccess` : path },
      );
    }
  }
  if (template.workspace.kind === "none" || !state.order) return;

  const users = state.order.filter((id) => access.get(id) !== "none");
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const a = users[i]!;
      const b = users[j]!;
      const modeA = access.get(a)!;
      const modeB = access.get(b)!;
      if (modeA !== "write" && modeB !== "write") continue;
      if (!graphNodesConcurrent(state, a, b)) continue;
      if (modeA === "write" && modeB === "write") {
        diagnostics.add(
          "workspace-concurrent-writers",
          `${a} and ${b} both write the workspace and nothing orders them; connect them with a workspace edge so one starts from the other's commit`,
          state.nodeAt(b),
        );
      } else {
        const [writer, reader] = modeA === "write" ? [a, b] : [b, a];
        diagnostics.add(
          "workspace-read-write-race",
          `${reader} reads the workspace while ${writer} may be writing it; order them with an edge, or give ${reader} the commit it should read`,
          state.nodeAt(reader),
        );
      }
    }
  }
}
