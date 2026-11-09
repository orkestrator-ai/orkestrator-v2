import { afterEach, expect, test } from "bun:test";
import { controlMcpHarness } from "./control-mcp-test-support.js";
import { cleanupSessionHarnesses } from "./public-api/test-provider.js";

afterEach(cleanupSessionHarnesses);

test("operator ticket reads compare the owning environment HEAD and tolerate its absence", async () => {
  const mcp = await controlMcpHarness();
  try {
    const { harness, projectId } = mcp;
    const environmentId = "env-1";
    const judged = "a".repeat(40);
    const ticket = await harness.context.storage.kanban.addKanbanTask(projectId, "Ticket", "");
    await harness.context.storage.kanban.updateKanbanTask(ticket.id, {
      environmentId,
      sections: { acceptanceCriteria: [{ id: "ac-1", text: "Works" }] },
    });
    await harness.storage.kanban.recordKanbanCriteriaChecks(ticket.id, [
      {
        id: "ac-1",
        text: "Works",
        check: {
          status: "passed",
          evidence: "test passes",
          source: "verify",
          checkedAt: new Date(0).toISOString(),
          commit: judged,
        },
      },
    ]);
    let head: string | Error = "b".repeat(40);
    harness.commands.set("get_environment_uncommitted_paths", async (args) => {
      expect(args.environmentId).toBe(environmentId);
      if (head instanceof Error) throw head;
      return { head, paths: [] };
    });
    const read = async () => {
      const result = await mcp.call(mcp.defaultToken, "get_ticket", {
        projectId,
        ticketId: ticket.id,
      });
      expect(result.isError).not.toBe(true);
      return result.structuredContent?.ticket as {
        criteria: Array<{ judged: string; commit: string }>;
      };
    };
    expect((await read()).criteria[0]).toMatchObject({
      commit: judged,
      judged: "on aaaaaaa; the branch has moved since",
    });
    head = judged;
    expect((await read()).criteria[0]?.judged).toBe("on aaaaaaa");
    head = new Error("Environment unavailable");
    expect((await read()).criteria[0]).toMatchObject({ commit: judged, judged: "on aaaaaaa" });
  } finally {
    await mcp.close();
  }
}, 30_000);
