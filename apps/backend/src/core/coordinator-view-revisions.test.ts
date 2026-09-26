import { describe, expect, test } from "bun:test";
import type { CoordinatorSnapshot } from "@orkestrator/protocol/coordinator";
import { isViewSnapshotOutcome } from "@orkestrator/protocol/view-sync";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerCoordinatorCommands } from "./commands-registry-coordinator.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { CoordinatorViewRevisions } from "./coordinator-view-revisions.js";

function snapshot(projectId: string, title: string): CoordinatorSnapshot {
  return {
    workspace: {
      id: `coordinator-${projectId}`,
      projectId,
      conversations: [{ id: "c1", title }],
    },
    projectPath: `/work/${projectId}`,
    providerAvailability: {},
    controlMcp: { enabled: true, running: true, error: null },
    workflows: [],
  } as unknown as CoordinatorSnapshot;
}

const isSnapshot = (value: unknown): value is CoordinatorSnapshot =>
  typeof value === "object" && value !== null && "workspace" in value;

describe("CoordinatorViewRevisions", () => {
  test("answers unchanged without a body only for the body the client holds", async () => {
    const views = new CoordinatorViewRevisions(8, "gen-a");
    let current: CoordinatorSnapshot | null = snapshot("p1", "first");
    const capture = async () => current;

    const initial = await views.read("p1", { projectId: "p1" }, capture);
    expect(initial.status).toBe("snapshot");
    const known = { knownGeneration: initial.generation, knownRevision: initial.revision };

    const same = await views.read("p1", known, capture);
    expect(same).toEqual({ status: "unchanged", generation: "gen-a", revision: initial.revision });
    expect("snapshot" in same).toBe(false);

    current = snapshot("p1", "second");
    const changed = await views.read("p1", known, capture);
    expect(changed.status).toBe("snapshot");
    expect(changed.revision).toBeGreaterThan(initial.revision);
    expect(isViewSnapshotOutcome(changed, isSnapshot)).toBe(true);

    // A change that is reverted still gets a new revision: tokens are never reused.
    current = snapshot("p1", "first");
    const reverted = await views.read(
      "p1",
      { knownGeneration: "gen-a", knownRevision: changed.revision },
      capture,
    );
    expect(reverted.status).toBe("snapshot");
    expect(reverted.revision).toBeGreaterThan(changed.revision);
  });

  test("a backend restart resets and a removed workspace answers deleted", async () => {
    const before = new CoordinatorViewRevisions(8, "gen-a");
    const first = await before.read("p1", {}, async () => snapshot("p1", "x"));
    const after = new CoordinatorViewRevisions(8, "gen-b");
    const reset = await after.read(
      "p1",
      { knownGeneration: "gen-a", knownRevision: first.revision },
      async () => snapshot("p1", "x"),
    );
    expect(reset).toMatchObject({ status: "reset", reason: "generation", generation: "gen-b" });

    const deleted = await after.read(
      "p1",
      { knownGeneration: "gen-b", knownRevision: reset.revision },
      async () => null,
    );
    expect(deleted.status).toBe("deleted");
    expect(isViewSnapshotOutcome(deleted, isSnapshot)).toBe(true);
  });

  test("an evicted project never answers unchanged for a different body", async () => {
    const views = new CoordinatorViewRevisions(2, "gen-a");
    const held = await views.read("p1", {}, async () => snapshot("p1", "old"));
    await views.read("p2", {}, async () => snapshot("p2", "x"));
    await views.read("p3", {}, async () => snapshot("p3", "x"));
    // p1 was evicted; its body changed meanwhile.
    const next = await views.read(
      "p1",
      { knownGeneration: "gen-a", knownRevision: held.revision },
      async () => snapshot("p1", "new"),
    );
    expect(next.status).toBe("snapshot");
    expect(next.revision).toBeGreaterThan(held.revision);
  });

  test("the command answers conditional reads and rejects a blank project", async () => {
    const commands = new Map<string, CommandHandler>();
    registerCoordinatorCommands(
      (name, handler) => commands.set(name, handler),
      {} as RegistryDependencies,
    );
    let reads = 0;
    const context = {
      coordinators: {
        get: async (projectId: string) => {
          reads += 1;
          return snapshot(projectId, "same");
        },
      },
    } as unknown as CommandContext;
    const handler = commands.get("get_project_coordinator_view")!;
    const first = (await handler({ projectId: "p1" }, context)) as {
      status: string;
      generation: string;
      revision: number;
    };
    expect(first.status).toBe("snapshot");
    const second = await handler(
      { projectId: "p1", knownGeneration: first.generation, knownRevision: first.revision },
      context,
    );
    expect(second).toEqual({
      status: "unchanged",
      generation: first.generation,
      revision: first.revision,
    });
    expect(reads).toBe(2);
    await expect(
      Promise.resolve().then(() => handler({ projectId: " " }, context)),
    ).rejects.toThrow();
  });
});
