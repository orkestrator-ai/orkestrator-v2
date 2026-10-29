/**
 * Compiler pass: workspace rules, version 1 (D3, report §6.7).
 *
 * 1. At most one writing activation per workspace at a time.
 * 2. No reader runs while a writer writes.
 * 3. Readers consume a pinned commit (a lint, in lint.ts).
 * 4. Replicated nodes are read-only or do not touch the workspace.
 *
 * "Can run at the same time" comes from the DAG: two nodes no path orders
 * may run concurrently, unless they sit on different outlets of one gate or
 * human node, or loop iterations order them (`graphNodesConcurrent`).
 */
import { graphNodesConcurrent } from "./compile-graph.js";
import { type GraphCompileState, graphNodeWorkspaceAccess } from "./compile-state.js";

export function checkGraphWorkspace(state: GraphCompileState): void {
  const { diagnostics, template } = state;
  const access = new Map(
    [...state.nodes.values()].map(({ node }) => [node.id, graphNodeWorkspaceAccess(node)]),
  );

  for (const { node, path } of state.nodes.values()) {
    const mode = access.get(node.id)!;
    if (mode === "none") continue;
    if (template.workspace.kind === "none") {
      diagnostics.add(
        "workspace-unavailable",
        `${node.id} ${mode === "write" ? "writes" : "reads"} the workspace, but the template runs without one (workspace.kind is "none")`,
        { nodeId: node.id, path: node.kind === "agent" ? `${path}.workspaceAccess` : path },
      );
      continue;
    }
    if (mode === "write" && state.isReplicated(node.id)) {
      diagnostics.add(
        "replicated-writer",
        `${node.id} is replicated and writes the workspace; in version 1 replicated nodes must be read-only or have no workspace access (D3)`,
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
