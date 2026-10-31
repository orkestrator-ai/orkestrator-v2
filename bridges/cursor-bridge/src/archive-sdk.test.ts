/** Qualify archive and restore through the pinned SDK and its real disk store. */
import { expect, mock, test } from "bun:test";
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
  const { useCursorAgentForTests, listResumableSessions, setResumableAgentArchived } =
    await import("./agent-session.js");
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

    // Listed last and flagged when asked for, so the picker can offer a restore.
    expect(
      (await listResumableSessions({ includeArchived: true })).map((item) => [
        item.id,
        item.archived,
      ]),
    ).toEqual([
      ["fixture-idle", undefined],
      ["fixture-archived", true],
    ]);

    // A local agent round-trips through the SDK's default (configured) store.
    expect(await setResumableAgentArchived("fixture-archived", false)).toBe("unarchived");
    expect((await listResumableSessions()).map((item) => item.id).sort()).toEqual([
      "fixture-archived",
      "fixture-idle",
    ]);
    expect(await setResumableAgentArchived("fixture-idle", true)).toBe("archived");
    expect((await listResumableSessions()).map((item) => item.id)).toEqual(["fixture-archived"]);
    // The conversation is kept: the store still holds the archived agent.
    expect((await store.agents.get({ agentId: "fixture-idle" }))?.status).toBe("archived");
  } finally {
    restoreAgent();
    useCursorLocalAgentStoreForTests(previousStore);
    if (previous === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("archive refuses a tab's agent, a cloud id and an agent the SDK cannot find", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-archive-refusals-"));
  const { useCursorLocalAgentStoreForTests } = await import("./sdk-runtime.js");
  const { useCursorAgentForTests, setResumableAgentArchived } = await import("./agent-session.js");
  const { sessions } = await import("./state.js");
  const previousStore = useCursorLocalAgentStoreForTests(new JsonlLocalAgentStore(root));
  const archive = mock(async () => undefined);
  const restoreAgent = useCursorAgentForTests({ ...Agent, archive, unarchive: archive } as never);
  const previousWarn = console.warn;
  console.warn = () => undefined;
  try {
    sessions.set("tab", { agentId: "agent-in-tab" } as never);
    expect(await setResumableAgentArchived("agent-in-tab", true)).toBe("in-use");
    expect(await setResumableAgentArchived("bc-cloud-agent", true)).toBe("failed");
    expect(archive).not.toHaveBeenCalled();
    // Restoring cannot strand a tab, so a held agent may be restored.
    expect(await setResumableAgentArchived("agent-in-tab", false)).toBe("unarchived");

    archive.mockImplementation(async () => {
      throw new Error("Agent not found");
    });
    expect(await setResumableAgentArchived("agent-gone", true)).toBe("failed");
  } finally {
    console.warn = previousWarn;
    sessions.delete("tab");
    restoreAgent();
    useCursorLocalAgentStoreForTests(previousStore);
    await rm(root, { recursive: true, force: true });
  }
});
