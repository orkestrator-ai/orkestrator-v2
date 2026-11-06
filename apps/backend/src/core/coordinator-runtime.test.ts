import { describe, expect, test } from "bun:test";
import { coordinatorRuntimeId, type CoordinatorWorkspace } from "@orkestrator/protocol/coordinator";
import {
  coordinatorRuntimeUnavailableMessage,
  heldCoordinatorConversation,
  resolveCoordinatorRuntime,
} from "./coordinator-runtime.js";

function storageWith(
  lifecycleState: CoordinatorWorkspace["lifecycleState"] = "ready",
  global: Record<string, unknown> = { coordinatorProviderTiers: "advisory" },
  loadConfig: () => Promise<{ global: Record<string, unknown> }> = async () => ({ global }),
) {
  const workspace = {
    id: "coordinator-1",
    projectId: "project-1",
    lifecycleState,
    conversations: [
      { id: "main", agent: "codex", role: "main" },
      { id: "side", agent: "codex", role: "side", startupError: "bridge failed" },
      { id: "safety", agent: "grok", role: "side" },
      { id: "unassigned", role: "side" },
    ],
  } as unknown as CoordinatorWorkspace;
  return {
    coordinators: { getCoordinatorWorkspaceById: async () => workspace },
    loadConfig,
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

  test("holds a conversation whose platform is off or below the safety level", async () => {
    const off = storageWith("ready", {
      coordinatorProviderTiers: "advisory",
      enabledAgentPlatforms: ["claude"],
    });
    expect((await heldCoordinatorConversation(off, runtime("main")))?.message).toBe(
      "Codex is unavailable for Coordinator; showing saved history",
    );
    const belowLevel = storageWith("ready", { coordinatorProviderTiers: "enforced" });
    expect((await heldCoordinatorConversation(belowLevel, runtime("safety")))?.message).toBe(
      "Grok Build is unavailable for Coordinator; showing saved history",
    );
    // The level that refused Grok Build leaves a platform that meets it alone.
    expect(await heldCoordinatorConversation(belowLevel, runtime("main"))).toBeNull();
  });

  test("agrees with the runtime check about every platform", async () => {
    for (const global of [
      { coordinatorProviderTiers: "advisory" },
      { coordinatorProviderTiers: "enforced" },
      { coordinatorProviderTiers: "advisory", enabledAgentPlatforms: ["claude"] },
    ]) {
      const storage = storageWith("ready", global);
      for (const id of ["main", "safety"]) {
        const refused =
          (await resolveCoordinatorRuntime(storage, runtime(id))).status === "unavailable";
        expect((await heldCoordinatorConversation(storage, runtime(id))) !== null).toBe(refused);
      }
    }
  });

  test("reads the settings once, and only when they can change the answer", async () => {
    let reads = 0;
    const counting = (lifecycleState: CoordinatorWorkspace["lifecycleState"] = "ready") =>
      storageWith(lifecycleState, {}, async () => {
        reads += 1;
        return { global: { coordinatorProviderTiers: "advisory" } };
      });

    await heldCoordinatorConversation(counting(), runtime("main"));
    expect(reads).toBe(1);

    reads = 0;
    await heldCoordinatorConversation(counting("paused"), runtime("main"));
    await heldCoordinatorConversation(counting(), runtime("side"));
    await heldCoordinatorConversation(counting(), runtime("unassigned"));
    await heldCoordinatorConversation(counting(), runtime("unknown"));
    expect(reads).toBe(0);
  });

  test("an unreadable config falls back as the runtime check does", async () => {
    const storage = storageWith("ready", {}, async () => {
      throw new Error("unreadable");
    });
    expect(await heldCoordinatorConversation(storage, runtime("main"))).toBeNull();
    expect(await resolveCoordinatorRuntime(storage, runtime("main"))).toMatchObject({
      status: "ready",
    });
  });
});
