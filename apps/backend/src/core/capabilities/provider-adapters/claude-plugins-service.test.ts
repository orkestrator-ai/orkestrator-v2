/**
 * A Claude plugin package through the whole service: preview, approval,
 * planning (the plugin carries its parts for Claude), the executor, the
 * inventory, a lost answer settled by observation, and removal.
 */
import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";

import { StorageService } from "../../storage/service.js";
import { testCapabilityHomes } from "../native-ownership.js";
import { CapabilityService } from "../service.js";
import { ClaudePluginAdapter } from "./claude-plugins.js";
import { FakeClaudeCli } from "./fake-claude-cli.test-support.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function makeService() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-plugin-service-"));
  const homes = testCapabilityHomes(path.join(dir, "home"));
  const storage = new StorageService(path.join(dir, "data"));
  await storage.init();
  const claude = new FakeClaudeCli(homes.claudeConfigDir);
  const adapter = new ClaudePluginAdapter({ homes: () => homes, cli: claude.cli });
  const service = new CapabilityService({
    storage: { capabilities: storage.capabilities },
    dataDir: path.join(dir, "data"),
    selfId: async () => "bk_self",
    selfName: async () => "self",
    machines: async () => [],
    link: () => null,
    isAuthority: () => true,
    emit: () => undefined,
    homes: () => homes,
    inventory: {
      providers: async () => AGENT_PLATFORMS.map((provider) => ({ provider, available: true })),
      managedPlugins: () => adapter.observe(),
    },
    claudePlugins: adapter,
  });
  await service.init();
  cleanups.push(async () => {
    service.dispose();
    storage.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { service, claude, homes };
}

const pluginFiles = [
  {
    path: "demo/.claude-plugin/plugin.json",
    content: JSON.stringify({ name: "demo", version: "1.0.0", description: "Demo plugin" }),
  },
  {
    path: "demo/skills/greet/SKILL.md",
    content: "---\nname: greet\ndescription: Greets\n---\nSay hello.\n",
  },
  {
    path: "demo/hooks/hooks.json",
    content: JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "./guard.sh" }] }] },
    }),
  },
];

test("a Claude plugin installs from its reviewed bytes, carries its skill and hook, and removes cleanly", async () => {
  const { service, claude, homes } = await makeService();
  const inspection = await service.authorPackage({
    kind: "upload",
    name: "demo",
    files: pluginFiles,
  });
  const plugin = inspection.components.find((component) => component.kind === "native-plugin")!;
  expect(plugin.pathOrKey).toBe(".claude-plugin/plugin.json");

  const preview = await service.previewChange({
    change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, setupId: MY_SETUP_ID },
  });
  // The plugin's hook runs a program: the change needs approval.
  expect(preview.operation.requiresApproval).toBe(true);
  const pluginTarget = preview.operation.targets.find(
    (target) => target.locationId === "plugin:claude",
  );
  expect(pluginTarget?.action).toBe("install");
  // The skill reaches Claude inside the plugin, so it is not copied to Claude's skill directory.
  expect(
    preview.operation.targets.some((target) => target.locationId === "claude-user-skills"),
  ).toBe(false);
  expect(
    preview.operation.targets.some(
      (target) => target.locationId === "agents-shared-skills" && target.action === "install",
    ),
  ).toBe(true);
  // The hook is never a standalone install, and is not reported unsupported for Claude.
  expect(
    preview.operation.targets.some(
      (target) => target.target.provider === "claude" && target.status === "unsupported",
    ),
  ).toBe(false);

  await service.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await service.reconciler.idle();

  expect(claude.installed.has("demo@orkestrator-managed")).toBe(true);
  await expect(fs.stat(path.join(homes.claudeConfigDir, "skills", "greet"))).rejects.toThrow();
  const detail = await service.getPackage({ packageId: inspection.packageId });
  const claudeCell = detail.availability.find(
    (cell) => cell.target.provider === "claude" && cell.componentId === plugin.id,
  );
  expect(claudeCell?.status).toBe("installed-next-session");

  const inventory = await service.observeSelf();
  expect(inventory.items).toContainEqual(
    expect.objectContaining({
      kind: "native-plugin",
      ownership: "managed",
      locationId: "plugin:claude",
      componentId: plugin.id,
      qualifiedId: "demo@orkestrator-managed",
    }),
  );

  // Re-reconciling the same state writes nothing.
  const installs = claude.count("install");
  await service.reconciler.reconcileAll("test");
  await service.reconciler.idle();
  expect(claude.count("install")).toBe(installs);

  const removal = await service.previewChange({
    change: { kind: "remove-from-setup", packageId: inspection.packageId, setupId: MY_SETUP_ID },
  });
  expect(
    removal.operation.targets.some(
      (target) => target.locationId === "plugin:claude" && target.action === "remove",
    ),
  ).toBe(true);
  await service.applyChange({
    operationId: removal.operation.id,
    approvedDigest: removal.operation.planDigest,
  });
  await service.reconciler.idle();
  expect(claude.installed.has("demo@orkestrator-managed")).toBe(false);
  expect(claude.marketplaces.has("orkestrator-managed")).toBe(false);
});

test("a marketplace-named Claude plugin is not installed: its bytes were never reviewed", async () => {
  const { service, claude } = await makeService();
  const inspection = await service.inspectSource({
    source: { kind: "provider-marketplace", provider: "claude", qualifiedId: "review@official" },
  });
  const preview = await service.previewChange({
    change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, setupId: MY_SETUP_ID },
  });
  const target = preview.operation.targets.find((entry) => entry.target.provider === "claude");
  expect(target?.status).toBe("unsupported");
  expect(target?.reason).toContain("mutable source");
  expect(claude.calls).toEqual([]);
});

test("a deployed bundle cannot keep a hook enabled under a new denial", async () => {
  const { service, claude } = await makeService();
  const inspection = await service.authorPackage({
    kind: "upload",
    name: "demo",
    files: pluginFiles,
  });
  const preview = await service.previewChange({
    change: {
      kind: "add-to-setup",
      inspectionId: inspection.inspectionId,
      setupId: MY_SETUP_ID,
      required: true,
    },
  });
  await service.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await service.reconciler.idle();
  expect(claude.installed.has("demo@orkestrator-managed")).toBe(true);
  await expect(
    service.preflightSession({
      environmentId: "env-1",
      provider: "claude",
      sessionKey: "permitted",
    }),
  ).resolves.toBeTruthy();
  await service.adminPolicy.set({ forbiddenComponents: ["kind:hook"], expectedRevision: 0 });
  await service.reconciler.reconcileAll("policy-test");
  await service.reconciler.idle();
  expect(claude.installed.has("demo@orkestrator-managed")).toBe(false);
  expect(claude.count("install")).toBe(1);
});
