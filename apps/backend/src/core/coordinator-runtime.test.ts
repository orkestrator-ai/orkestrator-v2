import { describe, expect, test } from "bun:test";
import { coordinatorRuntimeId, type CoordinatorWorkspace } from "@orkestrator/protocol/coordinator";
import {
  coordinatorRuntimeUnavailableMessage,
  heldCoordinatorConversation,
  resolveCoordinatorRuntime,
} from "./coordinator-runtime.js";

function storageWith(lifecycleState: CoordinatorWorkspace["lifecycleState"] = "ready") {
  const workspace = {
    id: "coordinator-1",
    projectId: "project-1",
    lifecycleState,
    conversations: [
      { id: "main", agent: "codex", role: "main" },
      { id: "side", agent: "codex", role: "side", startupError: "bridge failed" },
    ],
  } as unknown as CoordinatorWorkspace;
  return {
    coordinators: { getCoordinatorWorkspaceById: async () => workspace },
    loadConfig: async () => ({ global: { coordinatorProviderTiers: "advisory" } }),
    getProject: async () => ({ id: "project-1", localPath: "/checkout" }),
  } as never;
}

const runtime = (id: string) => coordinatorRuntimeId("coordinator-1", id);

describe("resolveCoordinatorRuntime", () => {
  test("refuses the conversation that failed to start, and only that one", async () => {
    const storage = storageWith();
    expect(await resolveCoordinatorRuntime(storage, runtime("main"))).toMatchObject({
      status: "ready",
      conversationId: "main",
    });
    const failed = await resolveCoordinatorRuntime(storage, runtime("side"));
    expect(failed).toMatchObject({
      status: "unavailable",
      reason: "startup-failed",
      startupError: "bridge failed",
    });
    if (failed.status !== "unavailable") throw new Error("expected unavailable");
    // An older renderer has no pane notice, so this message is what it shows.
    expect(coordinatorRuntimeUnavailableMessage(failed)).toContain("bridge failed");
  });

  test("a paused workspace refuses every conversation", async () => {
    expect(await resolveCoordinatorRuntime(storageWith("paused"), runtime("main"))).toMatchObject({
      reason: "workspace-not-ready",
    });
  });
});

describe("heldCoordinatorConversation", () => {
  test("holds what cannot run and nothing else, saying why", async () => {
    expect(await heldCoordinatorConversation(storageWith(), runtime("main"))).toBeNull();
    expect((await heldCoordinatorConversation(storageWith(), runtime("side")))?.message).toContain(
      "could not start",
    );
    expect(
      (await heldCoordinatorConversation(storageWith("paused"), runtime("main")))?.message,
    ).toContain("paused");
    // A record an older backend stored.
    expect(
      (await heldCoordinatorConversation(storageWith("error"), runtime("main")))?.message,
    ).toContain("could not start");
    expect(await heldCoordinatorConversation(storageWith(), runtime("unknown"))).toBeNull();
  });
});
