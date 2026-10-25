import type { PublicActionName } from "@orkestrator/protocol/public-api";
import type { PublicNodeReadResult } from "@orkestrator/protocol/public-api-resources";
import { onNode, runPublicAction, type ControlMcpCaller } from "./control-mcp-caller.js";
import type { ControlMcpEnvelope } from "./control-mcp-results.js";

/** Drain aggregate continuations on their owning nodes, retaining partial failures. */
export async function allPublicPages<T>(
  caller: ControlMcpCaller,
  action: PublicActionName,
  input: Record<string, unknown>,
): Promise<
  | { items: T[]; nodes: PublicNodeReadResult[]; warnings: string[] }
  | { envelope: ControlMcpEnvelope }
> {
  const items: T[] = [];
  const nodes: PublicNodeReadResult[] = [];
  const warnings = new Set<string>();
  const pending: Array<{ caller: ControlMcpCaller; cursor?: string; node?: PublicNodeReadResult }> =
    [{ caller }];
  for (let index = 0; index < pending.length; index += 1) {
    const target = pending[index]!;
    let cursor = target.cursor;
    for (let page = 0; ; page += 1) {
      if (page === 50) {
        warnings.add(
          `${target.node?.name ?? "This node"}: paging limit reached; results are incomplete`,
        );
        break;
      }
      const envelope = await runPublicAction(
        target.caller,
        action,
        { ...input, limit: 200, ...(cursor ? { cursor } : {}) },
        undefined,
        undefined,
      );
      if (!envelope.ok) {
        if (!target.node) return { envelope };
        target.node.ok = false;
        target.node.error = { code: envelope.error.code, message: envelope.error.message };
        warnings.add(`${target.node.name}: ${envelope.error.message}`);
        break;
      }
      for (const warning of envelope.warnings ?? []) warnings.add(warning);
      const result = envelope.result as {
        items: T[];
        nextCursor?: string;
        nodes?: PublicNodeReadResult[];
      };
      items.push(
        ...result.items.map((item) =>
          target.node ? { ...item, nodeId: target.node.nodeId, nodeName: target.node.name } : item,
        ),
      );
      if (result.nodes) {
        for (const entry of result.nodes) {
          const node = { ...entry };
          nodes.push(node);
          if (!node.ok) warnings.add(`${node.name}: ${node.error?.message ?? "unavailable"}`);
          else if (node.nextCursor)
            pending.push({ caller: onNode(caller, node.nodeId), cursor: node.nextCursor, node });
        }
      }
      cursor = result.nextCursor;
      if (target.node) {
        if (cursor) target.node.nextCursor = cursor;
        else delete target.node.nextCursor;
      }
      if (!cursor) break;
    }
  }
  return { items, nodes, warnings: [...warnings] };
}
