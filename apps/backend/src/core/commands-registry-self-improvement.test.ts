import { describe, expect, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import {
  kanbanBoard,
  registerSelfImprovementCommands,
  selfImprovementFleet,
} from "./commands-registry-self-improvement.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { NODE_ROUTING_EXCLUDED_COMMANDS } from "./nodes/node-routing.js";
import { withTemporaryStorage } from "./storage-test-support.js";

describe("the self-improvement board over Kanban storage", () => {
  test("files, labels, comments and moves tickets on its own project only", async () => {
    await withTemporaryStorage(async (storage) => {
      const context = { storage } as unknown as CommandContext;
      const board = kanbanBoard(context, "p1");
      const other = await storage.kanban.addKanbanTask("p2", "Another project's ticket", "");

      await board.ensureLabels([
        { name: "insight", color: "#7C3AED", description: "conversations" },
        { name: "improvement", color: "#0EA5E9", description: "diagnostics" },
      ]);
      await board.ensureLabels([{ name: "insight", color: "#7C3AED", description: "again" }]);
      expect(
        (await storage.kanban.getKanbanLabels("p1")).map((label) => label.name).sort(),
      ).toEqual(["improvement", "insight"]);

      const input = {
        title: "Agents keep reaching for npm",
        description: "Theme `insight:use-mise-not-npm`.",
        criteria: "No reminders needed.",
        label: "insight",
        requestId: "self-improvement-d1-abc",
      };
      const id = await board.create(input);
      // The same request id replays rather than filing a second ticket.
      expect(await board.create(input)).toBe(id);
      const task = await storage.kanban.getKanbanTask(id);
      expect(task).toMatchObject({ projectId: "p1", status: "backlog", labels: ["insight"] });
      expect(task?.acceptanceCriteria).toContain("No reminders needed.");

      await storage.kanban.updateKanbanTask(id, { status: "done" }, "p1");
      expect(await board.get(id)).toMatchObject({ id, status: "done" });
      await board.comment(id, "Self-improvement: the fix did not change the rate.", "verdict-1");
      // A retry under the same id posts nothing, even with other numbers in the text.
      await board.comment(id, "Self-improvement: the fix did not change the rate.", "verdict-1");
      await board.comment(id, "Self-improvement: other numbers.", "verdict-1");
      await board.moveToBacklog(id);
      const moved = await storage.kanban.getKanbanTask(id);
      expect(moved?.status).toBe("backlog");
      expect(moved?.comments).toHaveLength(1);
      expect(moved?.comments?.at(-1)?.text).toContain("did not change the rate");

      expect(board.projectId).toBe("p1");
      expect(await board.get(other.id)).toBeNull();
      // Another project's ticket is not on this board, but it is not deleted either.
      expect(await board.locate!(other.id)).toBe("p2");
      expect(await kanbanBoard(context, "p2").get(other.id)).toMatchObject({ id: other.id });
      expect(await board.get("missing")).toBeNull();
      expect(await board.locate!("missing")).toBeNull();
      expect((await board.list()).map((ticket) => ticket.id)).toEqual([id]);
    });
  });
});

describe("the leaf side of a command node's run", () => {
  function handlers() {
    const registered = new Map<string, (args: unknown, context: CommandContext) => unknown>();
    const register = ((target: string | { name: string }, handler: never) => {
      registered.set(typeof target === "string" ? target : target.name, handler);
    }) as unknown as CommandRegistrar;
    registerSelfImprovementCommands(register);
    return registered;
  }

  test("answers only a command node attached to this node", async () => {
    const leafHandlers = handlers();
    const context = {
      nodes: { listControllers: () => [{ controllerId: "bk_command" }] },
    } as unknown as CommandContext;
    for (const name of [
      "collect_self_improvement_diagnostics",
      "collect_self_improvement_conversations",
    ]) {
      const handler = leafHandlers.get(name)!;
      await expect(Promise.resolve().then(() => handler({}, context))).rejects.toThrow(
        "Expected controllerId",
      );
      await expect(
        Promise.resolve().then(() => handler({ controllerId: "bk_stranger" }, context)),
      ).rejects.toThrow("not attached");
      // Never reachable through another node's routing.
      expect(NODE_ROUTING_EXCLUDED_COMMANDS.has(name)).toBe(true);
    }
  });
});

describe("the leaves a command node's run reads", () => {
  test("are its connected nodes, called over its own link; other nodes have none", async () => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const link = {
      connected: true,
      hello: null,
      invoke: async (command: string, args: Record<string, unknown>) => {
        calls.push({ command, args });
        return command === "collect_self_improvement_diagnostics"
          ? { archive: Buffer.from("bundle").toString("base64") }
          : { segments: [], skipped: [], waiting: 4 };
      },
    };
    const nodes = {
      mode: () => "command",
      selfIdentity: async () => "bk_desk",
      selfProfile: async () => ({ displayName: "Desk" }),
      listNodes: async () => ({
        nodes: [
          {
            nodeId: "bk_vps",
            displayName: "VPS",
            fallbackName: "vps",
            connection: { state: "connected" },
          },
          {
            nodeId: "bk_off",
            displayName: "Off",
            fallbackName: "off",
            connection: { state: "offline" },
          },
        ],
      }),
      link: (nodeId: string) => (nodeId === "bk_vps" ? link : null),
    };
    const fleet = await selfImprovementFleet({ nodes } as unknown as CommandContext);
    expect(fleet?.self).toEqual({ nodeId: "bk_desk", name: "Desk" });
    expect(fleet?.leaves.map((leaf) => [leaf.nodeId, leaf.name])).toEqual([["bk_vps", "VPS"]]);
    const leaf = fleet!.leaves[0]!;
    expect((await leaf.diagnostics()).toString()).toBe("bundle");
    const cursor = { schemaVersion: 1 as const, conversations: {} };
    expect(await leaf.conversations({ cursor, maxSegments: 10 })).toEqual({
      segments: [],
      skipped: [],
      waiting: 4,
    });
    expect(calls.map((call) => [call.command, call.args.controllerId])).toEqual([
      ["collect_self_improvement_diagnostics", "bk_desk"],
      ["collect_self_improvement_conversations", "bk_desk"],
    ]);
    expect(calls[1]!.args).toMatchObject({ cursor, maxSegments: 10 });

    expect(
      await selfImprovementFleet({
        nodes: { ...nodes, mode: () => "leaf" },
      } as unknown as CommandContext),
    ).toBeNull();
    expect(await selfImprovementFleet({} as CommandContext)).toBeNull();
  });
});
