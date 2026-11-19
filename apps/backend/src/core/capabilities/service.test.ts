/**
 * Agent Capabilities end to end over real storage and real files: a command
 * node and two leaves, each with its own SQLite store and provider homes,
 * joined by fake node links that call the leaves' own executor handlers.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";
import type { AnyCommandDef } from "@orkestrator/protocol/contract/command";

import { StorageService } from "../storage.js";
import { testCapabilityHomes } from "./native-ownership.js";
import { CapabilityService } from "./service.js";
import { parseNodePlanTargets } from "./executor.js";
import { CapabilityArtifactStore } from "./artifact-store.js";
import { treeDigest, validatePackageFiles } from "./security.js";
import { CAPABILITY_LIMITS } from "@orkestrator/protocol/capability-resources";

interface Node {
  id: string;
  dir: string;
  home: string;
  storage: StorageService;
  service: CapabilityService;
  connected: boolean;
  /** Throw after a successful apply, as a dropped link would. */
  loseNextApplyAnswer: boolean;
  beforeStage?: () => Promise<void>;
  beforeApply?: (targets: ReturnType<typeof parseNodePlanTargets>) => Promise<void>;
  applyCalls: Array<{ key: string; action: string; digest?: string }>;
}

const nodes: Node[] = [];

afterEach(async () => {
  for (const node of nodes.splice(0)) {
    node.service.dispose();
    node.storage.close?.();
    await fs.rm(node.dir, { recursive: true, force: true });
  }
});

async function makeNode(id: string, others: () => Node[], isCommand: boolean): Promise<Node> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `capabilities-${id}-`));
  const home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  const storage = new StorageService(path.join(dir, "data"));
  await storage.init();
  const node = {
    id,
    dir,
    home,
    storage,
    connected: true,
    loseNextApplyAnswer: false,
    applyCalls: [],
  } as unknown as Node;
  node.service = new CapabilityService({
    storage: { capabilities: storage.capabilities },
    dataDir: path.join(dir, "data"),
    selfId: async () => id,
    selfName: async () => id,
    machines: async () =>
      isCommand
        ? others().map((other) => ({
            nodeId: other.id,
            name: other.id,
            connected: other.connected,
          }))
        : [],
    link: (nodeId) => {
      const leaf = others().find((other) => other.id === nodeId);
      if (!leaf) return null;
      return {
        get connected() {
          return leaf.connected;
        },
        invokeCommand: async (def: AnyCommandDef, args: unknown) => {
          if (!leaf.connected) throw new Error("link down");
          const record = args as Record<string, unknown>;
          switch (def.name) {
            case "get_capability_node_observation":
              return leaf.service.executorObserve(record) as never;
            case "stage_capability_node_artifact":
              await leaf.beforeStage?.();
              return leaf.service.executorStage(record) as never;
            case "apply_capability_node_plan": {
              for (const target of record.targets as Array<Record<string, string>>) {
                leaf.applyCalls.push({
                  key: target.key!,
                  action: target.action!,
                  digest: target.artifactDigest,
                });
              }
              await leaf.beforeApply?.(parseNodePlanTargets(record.targets));
              const answer = await leaf.service.executorApply(record);
              if (leaf.loseNextApplyAnswer) {
                leaf.loseNextApplyAnswer = false;
                throw new Error("socket hang up");
              }
              return answer as never;
            }
            case "export_capability_node_item":
              return leaf.service.executorExportItem(record) as never;
            default:
              throw new Error(`unexpected ${def.name}`);
          }
        },
      };
    },
    isAuthority: () => isCommand,
    emit: () => undefined,
    homes: () => testCapabilityHomes(home),
    inventory: {
      providers: async () => AGENT_PLATFORMS.map((provider) => ({ provider, available: true })),
    },
  });
  await node.service.init();
  nodes.push(node);
  return node;
}

async function fleet() {
  const all: Node[] = [];
  const command = await makeNode("bk_command", () => all.slice(1), true);
  const leafA = await makeNode("bk_leaf_a", () => [], false);
  const leafB = await makeNode("bk_leaf_b", () => [], false);
  all.push(command, leafA, leafB);
  return { command, leafA, leafB };
}

async function addSkill(
  command: Node,
  name: string,
  body: string,
  setupId = MY_SETUP_ID,
  managedId?: string,
) {
  const inspection = await command.service.authorPackage({
    kind: "skill",
    name,
    ...(managedId ? { managedId } : {}),
    description: `${name} skill`,
    content: body,
  });
  const preview = await command.service.previewChange({
    change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, setupId },
  });
  const applied = await command.service.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await command.service.reconciler.idle();
  return { inspection, preview, applied };
}

const skillFile = (node: Node, root: string, name: string) =>
  path.join(node.home, root, "skills", name, "SKILL.md");

describe("add once, use wherever compatible", () => {
  test("one skill reaches every enrolled machine as two shared copies, with honest statuses", async () => {
    const { command, leafA, leafB } = await fleet();
    const { inspection, preview } = await addSkill(
      command,
      "review",
      "Review the change carefully.",
    );
    expect(inspection.compatibleProviders).toEqual([...AGENT_PLATFORMS]);
    expect(preview.operation.requiresApproval).toBe(false);
    // Two locations (Claude's and the shared one) on each of three machines.
    expect(preview.operation.targets.filter((target) => target.action === "install")).toHaveLength(
      6,
    );
    for (const node of [command, leafA, leafB]) {
      expect(await fs.readFile(skillFile(node, ".claude", "review"), "utf8")).toContain(
        "Review the change carefully.",
      );
      expect(await fs.readFile(skillFile(node, ".agents", "review"), "utf8")).toContain(
        "Review the change carefully.",
      );
      const marker = JSON.parse(
        await fs.readFile(
          path.join(node.home, ".claude", "skills", "review", ".orkestrator-capability.json"),
          "utf8",
        ),
      );
      expect(marker.packageId).toBe(inspection.packageId);
    }
    const detail = await command.service.getPackage({ packageId: inspection.packageId });
    // 3 machines x 6 providers.
    expect(detail.availability).toHaveLength(18);
    // A copy is never "ready" without runtime evidence.
    expect(detail.availability.every((cell) => cell.status === "installed-next-session")).toBe(
      true,
    );
    const cursor = detail.availability.find((cell) => cell.target.provider === "cursor");
    expect(cursor?.verification).toBe("present");

    // The library row says the same: installed, not "Ready", until a session reports it.
    expect((await command.service.listPackages({})).packages[0]?.readiness).toBe("installed");
    const operation = await command.service.getOperation({ operationId: preview.operation.id });
    expect(operation.state).toBe("completed");

    // Re-applying the same desired state writes nothing.
    leafA.applyCalls.length = 0;
    await command.service.reconciler.reconcileAll("test");
    expect(leafA.applyCalls).toEqual([]);
  });

  test("approval is for the exact plan: a changed plan invalidates it", async () => {
    const { command } = await fleet();
    const inspection = await command.service.authorPackage({
      kind: "skill",
      name: "lint",
      content: "Lint.",
    });
    const preview = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: inspection.inspectionId },
    });
    await expect(
      command.service.applyChange({
        operationId: preview.operation.id,
        approvedDigest: "sha256:wrong",
      }),
    ).rejects.toThrow("different plan");
    // A machine leaving the setup changes the plan, so the approval no longer holds.
    await command.service.setMachineEnrollment({ nodeId: "bk_leaf_a", enrolled: false });
    await expect(
      command.service.applyChange({
        operationId: preview.operation.id,
        approvedDigest: preview.operation.planDigest,
      }),
    ).rejects.toThrow("changed since the preview");
    const fresh = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: inspection.inspectionId },
    });
    await expect(
      command.service.applyChange({
        operationId: fresh.operation.id,
        approvedDigest: fresh.operation.planDigest,
      }),
    ).resolves.toBeDefined();
  });

  test("a hook package needs approval and is never installed as a standalone hook", async () => {
    const { command } = await fleet();
    const inspection = await command.service.authorPackage({
      kind: "hook",
      name: "guard",
      hook: { trigger: "PreToolUse", command: "./guard.sh" },
    });
    expect(inspection.approvalReasons[0]).toContain("./guard.sh");
    const preview = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: inspection.inspectionId },
    });
    expect(preview.operation.requiresApproval).toBe(true);
    expect(
      preview.operation.targets.every(
        (target) => target.action === "skip" && target.status === "unsupported",
      ),
    ).toBe(true);
  });

  test("a package with a secret cannot be added", async () => {
    const { command } = await fleet();
    await expect(
      command.service.authorPackage({
        kind: "skill",
        name: "leaky",
        content: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      }),
    ).rejects.toThrow("GitHub token");
  });

  test("a cached secret-bearing revision cannot be approved through update or rollback", async () => {
    const { command, leafA } = await fleet();
    const { inspection } = await addSkill(command, "safe", "Clean revision.");
    const files = validatePackageFiles([
      { path: "SKILL.md", content: Buffer.from("Synthetic test fixture"), executable: false },
      { path: ".env", content: Buffer.from("EXAMPLE=fixture"), executable: false },
    ]);
    const digest = await command.service.artifacts.put(files);
    const now = new Date().toISOString();
    const updateId = "legacy-secret-update";
    command.storage.capabilities.mutateCapabilityState((state) => {
      const pkg = state.packages[inspection.packageId]!;
      state.updates[updateId] = {
        id: updateId,
        packageId: pkg.id,
        fromRevision: pkg.revision,
        toRevision: "legacy",
        fromDigest: pkg.artifactDigest,
        toDigest: digest,
        detectedAt: now,
        state: "pending",
        requiresApproval: true,
        reasons: [],
        changes: [],
      };
      state.inspections[`update:${updateId}`] = {
        id: `update:${updateId}`,
        packageId: pkg.id,
        source: pkg.source,
        displayName: pkg.displayName,
        revision: "legacy",
        artifactDigest: digest,
        components: inspection.components,
        createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      pkg.previousRevisions = [{ revision: "legacy", artifactDigest: digest, replacedAt: now }];
      state.artifacts[digest] = {
        digest,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        files: files.map(({ path, bytes, executable, sha256 }) => ({
          path,
          bytes,
          executable,
          sha256,
        })),
        refs: [`package:${pkg.id}@legacy`],
        createdAt: now,
      };
      return { result: undefined, changed: true };
    });
    const calls = leafA.applyCalls.length;
    await expect(
      command.service.approveUpdate({ updateId, approvedDigest: "legacy-approval" }),
    ).rejects.toHaveProperty("code", "secrets-detected");
    await expect(
      command.service.rollbackPackage({ packageId: inspection.packageId, toRevision: "legacy" }),
    ).rejects.toHaveProperty("code", "secrets-detected");
    expect(leafA.applyCalls).toHaveLength(calls);
    expect(
      (await command.service.getPackage({ packageId: inspection.packageId })).package
        .artifactDigest,
    ).toBe(inspection.artifactDigest);
  });
});

describe("remote safety", () => {
  test("an offline machine gets the latest revision on reconnect, never the obsolete one", async () => {
    const { command, leafB } = await fleet();
    leafB.connected = false;
    const first = await addSkill(command, "docs", "Version one.");
    const firstDigest = first.inspection.artifactDigest;
    const second = await command.service.authorPackage({
      kind: "skill",
      name: "docs",
      content: "Version two.",
      managedId:
        first.inspection.source.kind === "managed" ? first.inspection.source.managedId : "",
    });
    const preview = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: second.inspectionId },
    });
    await command.service.applyChange({
      operationId: preview.operation.id,
      approvedDigest: preview.operation.planDigest,
    });
    await command.service.reconciler.idle();
    expect(leafB.applyCalls).toEqual([]);
    const offlineCells = (
      await command.service.getPackage({ packageId: second.packageId })
    ).availability.filter((cell) => cell.target.nodeId === leafB.id);
    expect(offlineCells.every((cell) => cell.status === "offline")).toBe(true);

    leafB.connected = true;
    command.service.noteNodeConnected(leafB.id);
    await command.service.reconciler.idle();
    expect(leafB.applyCalls.length).toBeGreaterThan(0);
    expect(leafB.applyCalls.every((call) => call.digest !== firstDigest)).toBe(true);
    expect(await fs.readFile(skillFile(leafB, ".claude", "docs"), "utf8")).toContain(
      "Version two.",
    );
  });

  test("rechecks desired state after staging before dispatching the write", async () => {
    const { command, leafA } = await fleet();
    let staged = false;
    leafA.beforeStage = async () => {
      if (staged) return;
      staged = true;
      command.storage.capabilities.mutateCapabilityState((state) => {
        state.setups[MY_SETUP_ID]!.packageSelections = [];
        return { result: undefined, changed: true };
      });
    };
    await addSkill(command, "notes", "Take notes.");
    expect(staged).toBe(true);
    expect(leafA.applyCalls).toEqual([]);
  });

  test("a coded remote refusal settles the operation rather than leaving an unknown write", async () => {
    const { command, leafA } = await fleet();
    leafA.beforeApply = async () => {
      throw Object.assign(new Error("refused"), { code: "stale-epoch" });
    };
    const { applied } = await addSkill(command, "policy-refusal", "Take notes.");
    const operation = await command.service.getOperation({ operationId: applied.operation.id });
    expect(operation.targets.filter((target) => target.target.nodeId === leafA.id)).toContainEqual(
      expect.objectContaining({ status: "blocked-policy" }),
    );
    const state = await command.storage.capabilities.loadCapabilityState();
    expect(Object.values(state.receipts).some((receipt) => receipt.nodeId === leafA.id)).toBe(
      false,
    );
  });

  test("keeps a first-install intent before the remote executor can mutate files", async () => {
    const { command, leafA } = await fleet();
    let journaled = false;
    leafA.beforeApply = async (targets) => {
      const state = await command.storage.capabilities.loadCapabilityState();
      journaled =
        targets.length > 0 &&
        targets.every(
          (target) =>
            state.receipts[target.key]?.pendingWrite?.action === "install" &&
            state.receipts[target.key]?.outcomeUnknown === true,
        );
    };
    await addSkill(command, "notes", "Take notes.");
    expect(journaled).toBe(true);
  });

  test("an unknown outcome is read back before anything is sent again", async () => {
    const { command, leafA } = await fleet();
    leafA.loseNextApplyAnswer = true;
    const { inspection } = await addSkill(command, "notes", "Take notes.");
    const unknown = (
      await command.service.getPackage({ packageId: inspection.packageId })
    ).availability.filter(
      (cell) => cell.target.nodeId === leafA.id && cell.target.provider === "claude",
    );
    expect(unknown[0]?.status).toBe("outcome-unknown");
    const calls = leafA.applyCalls.length;
    await command.service.reconciler.reconcileNode(leafA.id, "recheck");
    await command.service.reconciler.idle();
    // The bytes were there, so nothing was re-sent.
    expect(leafA.applyCalls.length).toBe(calls);
    const settled = (
      await command.service.getPackage({ packageId: inspection.packageId })
    ).availability.filter(
      (cell) => cell.target.nodeId === leafA.id && cell.target.provider === "claude",
    );
    expect(settled[0]?.status).toBe("installed-next-session");
  });

  test("a lost update reply settles the attempted digest without writing again", async () => {
    const { command, leafA } = await fleet();
    const first = await addSkill(command, "notes", "Version one.");
    leafA.loseNextApplyAnswer = true;
    const source = first.inspection.source;
    if (source.kind !== "managed") throw new Error("Expected an authored package.");
    const second = await addSkill(command, "notes", "Version two.", MY_SETUP_ID, source.managedId);
    expect(first.inspection.artifactDigest).not.toBe(second.inspection.artifactDigest);
    const calls = leafA.applyCalls.length;
    await command.service.reconciler.reconcileNode(leafA.id, "recheck");
    expect(leafA.applyCalls).toHaveLength(calls);
    expect(await fs.readFile(skillFile(leafA, ".claude", "notes"), "utf8")).toContain(
      "Version two.",
    );
    const settled = await command.service.getOperation({
      operationId: second.applied.operation.id,
    });
    expect(settled.state).toBe("completed");
  });

  test("an unenrolled node is observed without receiving toolkit writes", async () => {
    const { command, leafA } = await fleet();
    await command.service.setMachineEnrollment({ nodeId: leafA.id, enrolled: false });
    await addSkill(command, "notes", "Keep this on enrolled machines.");
    command.service.noteNodeConnected(leafA.id);
    await command.service.getInventory({ nodeId: leafA.id, refresh: true });
    await command.service.reconciler.idle();
    expect(leafA.applyCalls).toEqual([]);
  });

  test("executor refuses an unknown provider before native routing", () => {
    expect(() =>
      parseNodePlanTargets([{ action: "install", kind: "mcp-server", provider: "imaginary" }]),
    ).toThrow("Plan provider is not valid");
  });

  test("artifact transfer preserves a supplementary character at a chunk boundary", async () => {
    const { command } = await fleet();
    const max = CAPABILITY_LIMITS.artifactChunkBytes;
    const prefix = Buffer.alloc((((max - 128) / 4) | 0) * 3);
    const padding = max - prefix.toString("base64").length - 63;
    const files = validatePackageFiles([
      { path: "a".repeat(padding) + ".txt", content: prefix, executable: false },
      { path: "b📦.md", content: Buffer.from("hello"), executable: false },
    ]);
    const digest = treeDigest(files);
    const target = new CapabilityArtifactStore(path.join(command.dir, "transfers"));
    const chunks = CapabilityArtifactStore.bundleChunks(files);
    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      await target.stageChunk(digest, index, chunks.length, chunk);
    }
    expect((await target.get(digest)).map((file) => file.path)).toContain("b📦.md");
  });

  test("a leaf refuses a plan from an older command-node epoch", async () => {
    const { leafA } = await fleet();
    await leafA.service.executorObserve({ controllerId: "bk_new", epoch: 5 });
    await expect(
      leafA.service.executorObserve({ controllerId: "bk_old", epoch: 4 }),
    ).rejects.toThrow("newer command node");
    await expect(
      leafA.service.executorObserve({ controllerId: "bk_other", epoch: 5 }),
    ).rejects.toThrow("Another command node");
  });

  test("a leaf does not act as an authority", async () => {
    const { leafA } = await fleet();
    await expect(
      leafA.service.authorPackage({ kind: "skill", name: "x", content: "y" }),
    ).rejects.toThrow("command node");
  });
});

describe("ownership and drift", () => {
  test("adoption refuses directory links outside the provider root locally and remotely", async () => {
    const { command, leafA } = await fleet();
    for (const node of [command, leafA]) {
      const outside = path.join(node.dir, "private");
      const location = path.join(node.home, ".claude", "skills");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "SKILL.md"), "Private fixture");
      await fs.mkdir(location, { recursive: true });
      await fs.symlink(outside, path.join(location, "escape"), "dir");
      await expect(
        command.service.adoptExternal({ nodeId: node.id, itemId: "claude-user-skills/escape" }),
      ).rejects.toThrow();
    }
    expect(
      Object.keys((await command.storage.capabilities.loadCapabilityState()).inspections),
    ).toEqual([]);
  });

  test("a manually edited skill is reported and kept until the user decides", async () => {
    const { command, leafA } = await fleet();
    const { inspection } = await addSkill(command, "style", "Original.");
    await fs.writeFile(skillFile(leafA, ".claude", "style"), "Edited by hand.");
    await command.service.reconciler.reconcileNode(leafA.id, "test");
    await command.service.reconciler.idle();
    const drift = (await command.service.listDrift({})).drift.filter(
      (entry) => entry.nodeId === leafA.id,
    );
    expect(drift).toHaveLength(1);
    expect(drift[0]?.kind).toBe("modified");
    expect(await fs.readFile(skillFile(leafA, ".claude", "style"), "utf8")).toBe("Edited by hand.");

    await command.service.resolveDrift({ driftId: drift[0]!.id, decision: "replace" });
    await command.service.reconciler.idle();
    expect(await fs.readFile(skillFile(leafA, ".claude", "style"), "utf8")).toContain("Original.");
    expect(
      (await command.service.listDrift({})).drift.filter((entry) => entry.state === "open"),
    ).toEqual([]);
    expect(inspection.packageId).toBeTruthy();
  });

  test("approving adoption publishes observed local bytes as an authored revision", async () => {
    const { command, leafA, leafB } = await fleet();
    const { inspection } = await addSkill(command, "style", "Original.");
    const filename = skillFile(leafA, ".claude", "style");
    const original = await fs.readFile(filename, "utf8");
    await fs.writeFile(filename, original.replace("Original.", "Local edit."));
    await command.service.reconciler.reconcileNode(leafA.id, "recheck");
    const drift = (await command.service.listDrift({})).drift.find(
      (entry) => entry.nodeId === leafA.id && entry.packageId === inspection.packageId,
    );
    expect(drift?.state).toBe("open");
    const preview = await command.service.previewChange({
      change: { kind: "adopt-drift", driftId: drift!.id },
    });
    expect(preview.operation.requiresApproval).toBe(true);
    expect(await fs.readFile(skillFile(leafB, ".claude", "style"), "utf8")).toContain("Original.");
    await command.service.applyChange({
      operationId: preview.operation.id,
      approvedDigest: preview.operation.planDigest,
    });
    await command.service.reconciler.idle();
    expect(await fs.readFile(skillFile(leafB, ".claude", "style"), "utf8")).toContain(
      "Local edit.",
    );
  });

  test("an external skill with the same name is never overwritten", async () => {
    const { command, leafA } = await fleet();
    await fs.mkdir(path.join(leafA.home, ".claude", "skills", "mine"), { recursive: true });
    await fs.writeFile(skillFile(leafA, ".claude", "mine"), "My own skill.");
    await addSkill(command, "mine", "Managed version.");
    expect(await fs.readFile(skillFile(leafA, ".claude", "mine"), "utf8")).toBe("My own skill.");
    const drift = (await command.service.listDrift({})).drift.find(
      (entry) => entry.nodeId === leafA.id,
    );
    expect(drift?.kind).toBe("unmanaged");
  });

  test("an existing installation can be adopted in place", async () => {
    const { command } = await fleet();
    await fs.mkdir(path.join(command.home, ".claude", "skills", "adopted"), { recursive: true });
    await fs.writeFile(
      skillFile(command, ".claude", "adopted"),
      "---\nname: adopted\ndescription: x\n---\nMine",
    );
    const inventory = await command.service.getInventory({});
    const item = inventory.items.find((entry) => entry.name === "adopted");
    expect(item?.ownership).toBe("external");
    const inspection = await command.service.adoptExternal({ itemId: item!.id });
    const preview = await command.service.previewChange({
      change: { kind: "adopt", inspectionId: inspection.inspectionId },
    });
    await command.service.applyChange({
      operationId: preview.operation.id,
      approvedDigest: preview.operation.planDigest,
    });
    await command.service.reconciler.idle();
    const after = await command.service.getInventory({});
    expect(
      after.items.find(
        (entry) => entry.name === "adopted" && entry.locationId === "claude-user-skills",
      )?.ownership,
    ).toBe("managed");
    expect(await fs.readFile(skillFile(command, ".claude", "adopted"), "utf8")).toContain("Mine");
  });

  test("removing a package from My setup keeps copies another setup still uses", async () => {
    const { command } = await fleet();
    const toolkit = await command.service.setSetup({
      setup: { name: "Frontend", machineSelectors: ["*"] },
    });
    const { inspection } = await addSkill(command, "shared", "Shared skill.");
    const again = await command.service.authorPackage({
      kind: "skill",
      name: "shared",
      content: "Shared skill.",
      managedId: (inspection.source as { managedId: string }).managedId,
    });
    const addToToolkit = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: again.inspectionId, setupId: toolkit.id },
    });
    await command.service.applyChange({
      operationId: addToToolkit.operation.id,
      approvedDigest: addToToolkit.operation.planDigest,
    });
    await command.service.reconciler.idle();
    const removal = await command.service.previewChange({
      change: { kind: "remove-from-setup", packageId: inspection.packageId, setupId: MY_SETUP_ID },
    });
    expect(removal.operation.targets.some((target) => target.action === "remove")).toBe(false);
    await command.service.applyChange({
      operationId: removal.operation.id,
      approvedDigest: removal.operation.planDigest,
    });
    await command.service.reconciler.idle();
    expect(await fs.readFile(skillFile(command, ".claude", "shared"), "utf8")).toContain(
      "Shared skill.",
    );

    const last = await command.service.previewChange({
      change: { kind: "remove-from-setup", packageId: inspection.packageId, setupId: toolkit.id },
    });
    expect(last.operation.targets.some((target) => target.action === "remove")).toBe(true);
    await command.service.applyChange({
      operationId: last.operation.id,
      approvedDigest: last.operation.planDigest,
    });
    await command.service.reconciler.idle();
    await expect(fs.stat(skillFile(command, ".claude", "shared"))).rejects.toThrow();
  });
});

describe("setups", () => {
  test("a stale write is refused instead of overwriting", async () => {
    const { command } = await fleet();
    const created = await command.service.setSetup({ setup: { name: "Research" } });
    await command.service.setSetup({
      setup: { id: created.id, name: "Research v2" },
      expectedRevision: created.revision,
    });
    await expect(
      command.service.setSetup({
        setup: { id: created.id, name: "Stale" },
        expectedRevision: created.revision,
      }),
    ).rejects.toThrow("Someone else changed");
  });

  test("My setup cannot be deleted; a toolkit can", async () => {
    const { command } = await fleet();
    await expect(
      command.service.deleteSetup({ setupId: MY_SETUP_ID, expectedRevision: 1 }),
    ).rejects.toThrow("cannot be deleted");
    const created = await command.service.setSetup({ setup: { name: "Review" } });
    const list = await command.service.deleteSetup({
      setupId: created.id,
      expectedRevision: created.revision,
    });
    expect(list.setups.map((setup) => setup.id)).toEqual([MY_SETUP_ID]);
  });

  test("a session selection is narrowed by its permission ceiling", async () => {
    const { command } = await fleet();
    const inspection = await command.service.authorPackage({
      kind: "mcp-server",
      name: "docs",
      mcp: { transport: "http", url: "https://docs.example.com/mcp" },
    });
    const preview = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: inspection.inspectionId },
    });
    await command.service.applyChange({
      operationId: preview.operation.id,
      approvedDigest: preview.operation.planDigest,
    });
    const effective = await command.service.getEffectiveResources({
      target: { provider: "claude" },
      ceiling: { denied: ["mcp:docs"] },
    });
    expect(effective.resolvedPackages).toEqual([]);
    expect(effective.blocked[0]?.reason).toContain("mcp:docs");
  });
});

describe("editing and rollback", () => {
  test("editing an authored package is a new revision of the same package; rollback restores the previous one", async () => {
    const { command, leafA } = await fleet();
    const first = await command.service.authorPackage({
      kind: "skill",
      name: "tone",
      content: "Be brief.",
    });
    const add = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: first.inspectionId, excludedProviders: ["pi"] },
    });
    await command.service.applyChange({
      operationId: add.operation.id,
      approvedDigest: add.operation.planDigest,
    });
    await command.service.reconciler.idle();
    const managedId = (first.source as { managedId: string }).managedId;

    const edited = await command.service.authorPackage({
      kind: "skill",
      name: "tone",
      content: "Be brief and kind.",
      managedId,
    });
    expect(edited.packageId).toBe(first.packageId);
    expect(edited.existing?.artifactDigest).toBe(first.artifactDigest);
    const update = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: edited.inspectionId },
    });
    expect(update.operation.targets.some((target) => target.action === "update")).toBe(true);
    await command.service.applyChange({
      operationId: update.operation.id,
      approvedDigest: update.operation.planDigest,
    });
    await command.service.reconciler.idle();
    expect(await fs.readFile(skillFile(leafA, ".claude", "tone"), "utf8")).toContain(
      "Be brief and kind.",
    );
    const setups = await command.service.listSetups();
    expect(setups.setups[0]!.exclusions).toContain(`provider:pi|${first.packageId}`);

    const detail = await command.service.getPackage({ packageId: first.packageId });
    expect(detail.previousRevisions[0]?.artifactDigest).toBe(first.artifactDigest);
    const rollback = await command.service.rollbackPackage({
      packageId: first.packageId,
      toRevision: first.revision,
    });
    await command.service.applyChange({
      operationId: rollback.operation.id,
      approvedDigest: rollback.operation.planDigest,
    });
    await command.service.reconciler.idle();
    expect(await fs.readFile(skillFile(leafA, ".claude", "tone"), "utf8")).not.toContain("kind");
    expect((await command.service.getPackage({ packageId: first.packageId })).package.pinned).toBe(
      true,
    );
  });
});

describe("session launch", () => {
  test("policy denial and missing required delivery both refuse launch", async () => {
    const { command } = await fleet();
    const inspection = await command.service.authorPackage({
      kind: "mcp-server",
      name: "tracker",
      mcp: { transport: "http", url: "https://tracker.example.com/mcp" },
    });
    const preview = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, required: true },
    });
    await command.service.applyChange({
      operationId: preview.operation.id,
      approvedDigest: preview.operation.planDigest,
    });
    const denied = { approvals: "ask", capabilityPolicy: { deny: ["network"] } } as never;
    await expect(
      command.service.preflightSession({
        environmentId: "env-1",
        provider: "claude",
        sessionKey: "s1",
        policy: denied,
      }),
    ).rejects.toThrow("require a capability it cannot have");
    await expect(
      command.service.preflightSession({
        environmentId: "env-1",
        provider: "claude",
        sessionKey: "s2",
      }),
    ).rejects.toThrow("not verified");
  });

  test("required files must still match the delivered revision at launch", async () => {
    const { command } = await fleet();
    const inspection = await command.service.authorPackage({
      kind: "skill",
      name: "docs",
      content: "Write docs.",
    });
    const preview = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, required: true },
    });
    await command.service.applyChange({
      operationId: preview.operation.id,
      approvedDigest: preview.operation.planDigest,
    });
    await command.service.reconciler.idle();
    const launch = { environmentId: "env-1", provider: "claude" as const, sessionKey: "s1" };
    const allowed = await command.service.preflightSession(launch);
    expect(allowed?.resolvedPackages).toHaveLength(1);
    await expect(
      command.service.preflightSession({ ...launch, environmentIncarnation: "container-1" }),
    ).rejects.toThrow("cannot have");
    await fs.writeFile(skillFile(command, ".claude", "docs"), "Local changes.");
    await expect(command.service.preflightSession(launch)).rejects.toThrow("not verified");
  });
});

describe("session scope", () => {
  test("a session-only toolkit never writes its components to shared provider homes", async () => {
    const { command, leafA } = await fleet();
    const toolkit = await command.service.setSetup({ setup: { name: "Session tools" } });
    const { inspection } = await addSkill(
      command,
      "session-skill",
      "Scoped instructions.",
      toolkit.id,
    );
    await command.service.assignSetup({
      scope: "session",
      scopeId: "private",
      setupIds: [toolkit.id],
    });
    await command.service.reconciler.idle();
    expect(leafA.applyCalls).toEqual([]);
    expect(await Bun.file(skillFile(command, ".claude", "session-skill")).exists()).toBe(false);
    const result = await command.service.getSessionView({
      sessionKey: "private",
      target: { provider: "claude" },
    });
    expect(result.effective?.resolvedPackages.map(({ id }) => id)).toContain(inspection.packageId);
  });

  test("names supplied by one session do not prove either session loaded a revision", async () => {
    const { command, leafA } = await fleet();
    const { inspection } = await addSkill(command, "notes", "Notes.");
    for (const sessionKey of ["one", "two"]) {
      const result = await command.service.getSessionView({
        sessionKey,
        target: { provider: "claude", nodeId: leafA.id },
        sessionRunning: true,
        ...(sessionKey === "one"
          ? { catalogue: { state: "ready", names: ["notes"], generation: "1" } }
          : {}),
      });
      expect(result.effective?.target.nodeId).toBe(leafA.id);
      expect(
        result.components.find(({ componentId }) => componentId === inspection.components[0]?.id)
          ?.status,
      ).toBe("installed-next-session");
    }
  });
});

describe("portable setups", () => {
  test("export carries no machine ids or host paths and imports back to the same package graph", async () => {
    const { command } = await fleet();
    const toolkit = await command.service.setSetup({
      setup: { name: "Frontend", machineSelectors: ["group:development", `machine:bk_leaf_a`] },
    });
    const inspection = await command.service.authorPackage({
      kind: "skill",
      name: "ui",
      content: "UI rules.",
    });
    const preview = await command.service.previewChange({
      change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, setupId: toolkit.id },
    });
    await command.service.applyChange({
      operationId: preview.operation.id,
      approvedDigest: preview.operation.planDigest,
    });
    const exported = await command.service.exportSetup({ setupIds: [toolkit.id] });
    expect(exported.intent).toContain("frontend:");
    expect(exported.intent).not.toContain("bk_leaf_a");
    expect(exported.intent).not.toContain(command.home);
    const lock = JSON.parse(exported.lock);
    expect(lock.packages[0].artifactDigest).toBe(inspection.artifactDigest);

    const importPreview = await command.service.previewImport({
      intent: exported.intent,
      lock: exported.lock,
    });
    expect(importPreview.valid).toBe(true);
    expect(importPreview.packages[0]?.action).toBe("unchanged");
    const tampered = await command.service.previewImport({
      intent: exported.intent,
      lock: exported.lock.replace(inspection.artifactDigest, `sha256:${"0".repeat(64)}`),
    });
    expect(tampered.packages[0]?.action).toBe("conflict");
    expect(tampered.valid).toBe(false);
    await expect(command.service.importSetup({ previewId: tampered.previewId })).rejects.toThrow(
      "invalid",
    );

    const missingMetadata = await command.service.previewImport({
      intent: exported.intent,
      lock: JSON.stringify({
        ...lock,
        packages: lock.packages.map((entry: object) => ({ ...entry, components: [] })),
      }),
    });
    expect(missingMetadata.valid).toBe(false);
    expect(missingMetadata.issues[0]?.message).toContain("component inventory");

    await command.service.setPackageState({ packageId: inspection.packageId, pinned: true });
    await expect(
      command.service.importSetup({ previewId: importPreview.previewId }),
    ).rejects.toThrow("changed after this preview");
  });
});
