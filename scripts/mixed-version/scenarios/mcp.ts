/**
 * mcp across versions (plan item 7008): a current renderer's `mcp` client
 * against each node of the pair. Each backend runs with its own temporary
 * HOME, so the provider files written here are the run's own.
 *
 * On each node: the targets are listed (with `protocolVersion`), the
 * backend's Pi target is read as a passive catalog, a new HTTP server
 * definition is validated (nothing written), saved without applying, read
 * back as an editable definition and through its operation, and removed at
 * the revision it was saved with. A pre-contract node gets today's calls
 * through version 0. No server is started and no session is touched
 * (`save`, never `save-and-apply`).
 */
import { mcpClient } from "@orkestrator/protocol/contract/domains/mcp";
import {
  MCP_MANAGEMENT_PROTOCOL_VERSION,
  type McpMutation,
} from "@orkestrator/protocol/mcp-management";
import { defineScenario } from "../scenario.ts";
import { expectedRendererAdapter, pairNodes, rendererClient } from "./renderer-client.ts";

const COMMANDS = [
  "list_mcp_management_targets",
  "get_mcp_management_snapshot",
  "validate_mcp_mutation",
  "mutate_mcp_definition",
  "get_mcp_definition",
  "get_mcp_operation",
];

export default defineScenario({
  domain: "mcp",
  title:
    "MCP targets, catalog, validated save, definition read-back and removal, from a current renderer",
  requires: { command: COMMANDS, leaf: COMMANDS },
  async run(ctx) {
    for (const node of pairNodes(ctx.command, ctx.leaf)) {
      const tag = node.role === "command" ? "C" : "L";
      const { client, version, calls } = rendererClient(node, mcpClient);
      const mcp = client.api();
      ctx.check(
        `MC-${tag}1`,
        `the renderer picks the adapter ${node.label}'s hello implies`,
        version === expectedRendererAdapter(node, "mcp"),
        `picked ${version}`,
      );

      const list = await mcp.list_mcp_management_targets({});
      const target = list.targets.find(
        (entry) => entry.provider === "pi" && entry.context.kind === "backend",
      );
      ctx.check(
        `MC-${tag}2`,
        "the targets are listed under the management protocol version, with the backend's Pi target",
        list.protocolVersion === MCP_MANAGEMENT_PROTOCOL_VERSION && target !== undefined,
        `protocol ${list.protocolVersion}, ${list.targets.length} targets`,
      );
      if (!target) continue;

      const before = await mcp.get_mcp_management_snapshot({ targetId: target.targetId });
      const sourceId = target.defaultSourceId ?? before.sources[0]?.sourceId;
      const source = before.sources.find((entry) => entry.sourceId === sourceId);
      ctx.check(
        `MC-${tag}3`,
        "the passive catalog names a writable source to save to",
        before.protocolVersion === MCP_MANAGEMENT_PROTOCOL_VERSION && source?.writable === true,
        `source ${sourceId ?? "none"}`,
      );
      if (!source || !sourceId) continue;

      const name = `qualification-${tag.toLowerCase()}`;
      const add: McpMutation = {
        requestId: `qualification-add-${tag}-${Date.now()}`,
        targetId: target.targetId,
        applyIntent: "save",
        operation: {
          kind: "add",
          sourceId,
          expectedRevision: source.revision,
          definition: { name, transport: "http", url: "https://mcp.example.invalid/qualification" },
        },
      };
      const validation = await mcp.validate_mcp_mutation({ mutation: add });
      const unchanged = await mcp.get_mcp_management_snapshot({ targetId: target.targetId });
      ctx.check(
        `MC-${tag}4`,
        "a valid mutation is previewed and nothing is written",
        validation.valid &&
          !unchanged.definitions.some(
            (entry) => entry.name === name && entry.sourceId === sourceId,
          ),
        validation.fieldErrors.map((error) => error.field).join(", "),
      );

      const saved = await mcp.mutate_mcp_definition({ mutation: add });
      const entryId = saved.entryId;
      const definition = entryId
        ? await mcp.get_mcp_definition({ targetId: target.targetId, entryId })
        : null;
      const operation = await mcp.get_mcp_operation({ operationId: saved.operation.operationId });
      ctx.check(
        `MC-${tag}5`,
        "the save is answered with its operation, and the definition reads back by entry id",
        saved.operation.phase === "saved" &&
          definition?.name === name &&
          definition.transport === "http" &&
          operation.operationId === saved.operation.operationId,
        `phase ${saved.operation.phase}`,
      );

      if (entryId) {
        const removed = await mcp.mutate_mcp_definition({
          mutation: {
            requestId: `qualification-remove-${tag}-${Date.now()}`,
            targetId: target.targetId,
            applyIntent: "save",
            operation: { kind: "remove", entryId, expectedRevision: saved.savedRevision },
          },
        });
        const after = await mcp.get_mcp_management_snapshot({ targetId: target.targetId });
        ctx.check(
          `MC-${tag}6`,
          "the definition is removed at the revision it was saved with",
          removed.operation.phase === "saved" &&
            !after.definitions.some((entry) => entry.name === name && entry.sourceId === sourceId),
          `phase ${removed.operation.phase}`,
        );
      }
      ctx.note(`${node.role} mcp`, { adapter: version, calls: Object.fromEntries(calls) });
    }
  },
});
