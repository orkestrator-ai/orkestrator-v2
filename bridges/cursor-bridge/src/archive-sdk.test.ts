/** Qualify archive metadata through the pinned SDK and its real disk store. */
import { expect, test } from "bun:test";
import { Agent, JsonlLocalAgentStore } from "@cursor/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the pinned local SDK exposes archived state and the bridge excludes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-archive-sdk-"));
  const previous = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "fixture-key-unused-by-local-list";
  const { workingDirectory } = await import("./config.js");
  const { useCursorLocalAgentStoreForTests } = await import("./sdk-runtime.js");
  const { useCursorAgentForTests, listResumableSessions } = await import("./agent-session.js");
  const store = new JsonlLocalAgentStore(root);
  const previousStore = useCursorLocalAgentStoreForTests(store);
  const restoreAgent = useCursorAgentForTests(Agent);
  try {
    for (const status of ["idle", "archived"] as const) {
      await store.agents.create({
        agent: {
          agentId: `fixture-${status}`,
          cwd: workingDirectory,
          status,
          name: status,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    }
    const listed = await Agent.list({ runtime: "local", cwd: workingDirectory, store });
    expect(listed.items.find((item) => item.agentId === "fixture-archived")?.archived).toBe(true);
    expect((await listResumableSessions()).map((item) => item.id)).toEqual(["fixture-idle"]);
  } finally {
    restoreAgent();
    useCursorLocalAgentStoreForTests(previousStore);
    if (previous === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});
