/**
 * Runtime proof (`runtime-proof.ts`) and running-work holds
 * (`running-work.ts`) through a real `CapabilityService` on one machine.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  parseCapabilitySessionEvidence,
  type CapabilitySessionEvidenceRead,
} from "@orkestrator/protocol/capability-evidence";
import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";

import { StorageService } from "../storage/service.js";
import { testCapabilityHomes } from "./native-ownership.js";
import type { ProviderCli } from "./provider-adapters/provider-cli.js";
import { busyProvidersFrom } from "./running-work.js";
import { CapabilityService } from "./service.js";

const NODE = "bk_self";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function machine(options: {
  busy?: () => AgentPlatform[];
  evidence?: () => CapabilitySessionEvidenceRead;
  grok?: ProviderCli;
}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capabilities-runtime-proof-"));
  const home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  const storage = new StorageService(path.join(dir, "data"));
  await storage.init();
  const service = new CapabilityService({
    storage: { capabilities: storage.capabilities },
    dataDir: path.join(dir, "data"),
    selfId: async () => NODE,
    selfName: async () => NODE,
    machines: async () => [],
    link: () => null,
    isAuthority: () => true,
    emit: () => undefined,
    homes: () => testCapabilityHomes(home),
    inventory: {
      providers: async () => AGENT_PLATFORMS.map((provider) => ({ provider, available: true })),
    },
    ...(options.busy ? { busyProviders: async () => options.busy!() } : {}),
    ...(options.evidence ? { sessionEvidence: async () => options.evidence!() } : {}),
    ...(options.grok ? { providerCli: () => options.grok! } : {}),
  });
  await service.init();
  cleanups.push(async () => {
    service.dispose();
    storage.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { service, storage, home, dataDir: path.join(dir, "data") };
}

async function addSkill(service: CapabilityService, name: string) {
  const inspection = await service.authorPackage({
    kind: "skill",
    name,
    description: `${name} skill`,
    content: "Do the thing.\n",
  });
  const preview = await service.previewChange({
    change: { kind: "add-to-setup", inspectionId: inspection.inspectionId, setupId: MY_SETUP_ID },
  });
  await service.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await service.reconciler.idle();
  return { inspection, operationId: preview.operation.id };
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

describe("busy providers", () => {
  test("only working local environments count, with the providers of their sessions", () => {
    expect(
      busyProvidersFrom(
        [
          { id: "a", environmentType: "local", agentActivityState: "working" },
          { id: "b", environmentType: "local", agentActivityState: "idle" },
          { id: "c", environmentType: "containerized", agentActivityState: "working" },
        ],
        [
          { environmentId: "a", agent: "codex" },
          { environmentId: "b", agent: "pi" },
          { environmentId: "c", agent: "grok" },
        ],
      ),
    ).toEqual(["codex"]);
  });

  test("waiting turns and stale unattended sources continue to hold their provider", () => {
    expect(
      busyProvidersFrom(
        [
          {
            id: "waiting",
            agentActivityState: "waiting",
            agentActivitySources: { "native-agent": { state: "waiting" } },
          },
          {
            id: "stale",
            agentActivityState: "working",
            agentActivitySources: { "claude-tmux": { state: "working", stale: true } },
          },
        ],
        [{ environmentId: "waiting", agent: "codex" }],
      ),
    ).toEqual(["claude", "codex"]);
  });

  test("terminal Claude work holds Claude; working without a known session holds everyone", () => {
    expect(
      busyProvidersFrom(
        [
          {
            id: "a",
            agentActivityState: "working",
            agentActivitySources: { "claude-tmux": { state: "working" } },
          },
        ],
        [],
      ),
    ).toEqual(["claude"]);
    expect(
      busyProvidersFrom(
        [
          { id: "a", agentActivityState: "working" },
          { id: "b", agentActivityState: "idle" },
        ],
        [],
      ),
    ).toEqual([...AGENT_PLATFORMS]);
  });
});

describe("running work holds shared writes", () => {
  test("a write Claude would read waits while Claude works and lands once it is idle", async () => {
    let busy: AgentPlatform[] = ["claude"];
    const { service, storage, home } = await machine({ busy: () => busy });
    const { operationId } = await addSkill(service, "held-skill");
    const claudeCopy = path.join(home, ".claude", "skills", "held-skill", "SKILL.md");
    const sharedCopy = path.join(home, ".agents", "skills", "held-skill", "SKILL.md");
    expect(await exists(claudeCopy)).toBe(false);
    // Locations no busy provider reads are not held.
    expect(await exists(sharedCopy)).toBe(true);
    let state = await storage.capabilities.loadCapabilityState();
    const held = state.operations[operationId]!.targets.filter(
      (target) => target.status === "queued-until-idle",
    );
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((target) => target.locationId === "claude-user-skills")).toBe(true);
    expect(state.machines[NODE]?.appliedManifestDigest).toBeUndefined();

    busy = [];
    await service.reconciler.reconcileNode(NODE, "test");
    await service.reconciler.idle();
    expect(await exists(claudeCopy)).toBe(true);
    state = await storage.capabilities.loadCapabilityState();
    expect(
      state.operations[operationId]!.targets.some(
        (target) => target.status === "queued-until-idle",
      ),
    ).toBe(false);
  });

  test("a removal waits too, so running work does not lose a skill mid-task", async () => {
    let busy: AgentPlatform[] = [];
    const { service, home } = await machine({ busy: () => busy });
    const { inspection } = await addSkill(service, "kept-skill");
    const claudeCopy = path.join(home, ".claude", "skills", "kept-skill", "SKILL.md");
    expect(await exists(claudeCopy)).toBe(true);
    busy = [...AGENT_PLATFORMS];
    const preview = await service.previewChange({
      change: { kind: "remove-from-setup", packageId: inspection.packageId, setupId: MY_SETUP_ID },
    });
    await service.applyChange({
      operationId: preview.operation.id,
      approvedDigest: preview.operation.planDigest,
    });
    await service.reconciler.idle();
    expect(await exists(claudeCopy)).toBe(true);
    const operation = await service.getOperation({ operationId: preview.operation.id });
    expect(operation.targets).toContainEqual(
      expect.objectContaining({
        action: "remove",
        locationId: "claude-user-skills",
        status: "queued-until-idle",
      }),
    );
    busy = [];
    await service.reconciler.reconcileNode(NODE, "test");
    await service.reconciler.idle();
    expect(await exists(claudeCopy)).toBe(false);
  });
});

describe("runtime proof", () => {
  async function withPrivateLaunch(
    evidence: () => CapabilitySessionEvidenceRead,
    provider: "claude" | "pi" = "claude",
  ) {
    const node = await machine({ evidence });
    const { inspection } = await addSkill(node.service, "review");
    const state = await node.storage.capabilities.loadCapabilityState();
    const pkg = state.packages[inspection.packageId]!;
    const componentId = pkg.componentIds[0]!;
    node.storage.capabilities.mutateCapabilityState((current) => {
      current.launches["sess-1"] = {
        sessionKey: "sess-1",
        target: { nodeId: NODE, provider, environmentId: "env-1", sessionId: "sess-1" },
        manifestDigest: "sha256:m",
        permissionPolicyDigest: "sha256:p",
        packages: [{ id: pkg.id, artifactDigest: pkg.artifactDigest }],
        privatePlugin: {
          digest: "0123456789abcdef0123",
          treeDigest: "sha256:t",
          items: [
            {
              packageId: pkg.id,
              componentId,
              packageDigest: pkg.artifactDigest,
              kind: "skill",
              name: "review",
              pathOrKey: state.components[componentId]!.pathOrKey,
            },
          ],
        },
        launchedAt: "2026-11-19T10:00:00.000Z",
      };
      return { result: undefined, changed: true };
    });
    const stagingRoot = path.join(node.dataDir, "capability-session-plugins");
    await fs.mkdir(stagingRoot, { recursive: true });
    const verify = () =>
      node.service.verify({
        consent: true,
        target: { nodeId: NODE, provider, environmentId: "env-1", sessionId: "sess-1" },
        componentIds: [componentId],
      });
    return { ...node, stagingRoot: await fs.realpath(stagingRoot), componentId, verify };
  }

  const loaded = (usedSkills: string[] = []): CapabilitySessionEvidenceRead => ({
    state: "evidence",
    generation: 3,
    loadedAt: "2026-11-19T10:01:00.000Z",
    plugins: [
      {
        name: "orkestrator-session",
        path: "/data/capability-session-plugins/0123456789abcdef0123",
      },
    ],
    skills: ["orkestrator-session:review"],
    usedSkills,
  });

  test("a private plugin the session reported loading is load-confirmed and recorded", async () => {
    const node = await withPrivateLaunch(() => loaded());
    const result = await node.verify();
    expect(result.checks).toEqual([
      expect.objectContaining({ componentId: node.componentId, level: "load-confirmed" }),
    ]);
    const state = await node.storage.capabilities.loadCapabilityState();
    const observation = Object.values(state.observations).find(
      (entry) => entry.componentId === node.componentId,
    );
    expect(observation).toMatchObject({
      level: "load-confirmed",
      source: "bridge-inventory",
      generation: "claude:3:2026-11-19T10:01:00.000Z",
    });
  });

  test("a private skill the agent invoked is observed in use", async () => {
    const node = await withPrivateLaunch(() => loaded(["orkestrator-session:review"]));
    const result = await node.verify();
    expect(result.checks[0]).toMatchObject({ level: "observed-in-use", status: "ready" });
  });

  test("a load that did not include the session's plugin directory is never confirmed", async () => {
    const node = await withPrivateLaunch(() => ({
      ...(loaded() as Extract<CapabilitySessionEvidenceRead, { state: "evidence" }>),
      plugins: [{ name: "orkestrator-session", path: "/elsewhere/ffffffffffffffffffff" }],
    }));
    const result = await node.verify();
    expect(result.checks[0]).toMatchObject({ level: "present", status: "failed" });
  });

  test("without a report the private copy stays present, not runtime-verified", async () => {
    const node = await withPrivateLaunch(() => ({ state: "unsupported" }));
    const result = await node.verify();
    expect(result.checks[0]).toMatchObject({
      level: "present",
      status: "installed-next-session",
    });
    const state = await node.storage.capabilities.loadCapabilityState();
    expect(Object.keys(state.observations)).toHaveLength(0);
    expect(result.checks[0]?.detail).toContain("does not report which skills it loaded");
  });

  /** A Pi session's report: each loaded skill with the `SKILL.md` it came from. */
  const piLoaded = (skillPath: string, incomplete = false): CapabilitySessionEvidenceRead =>
    parseCapabilitySessionEvidence({
      state: "evidence",
      generation: 2,
      loadedAt: "2026-11-26T10:01:00.000Z",
      plugins: [],
      skills: ["review"],
      loadedSkills: [{ name: "review", path: skillPath }],
      loadedSkillsIncomplete: incomplete,
      usedSkills: [],
    });

  test("a Pi skill loaded from the session's own directory is load-confirmed", async () => {
    let loadedPath = "";
    const node = await withPrivateLaunch(() => piLoaded(loadedPath), "pi");
    loadedPath = path.join(node.stagingRoot, "0123456789abcdef0123/skills/review/SKILL.md");
    const result = await node.verify();
    expect(result.checks).toEqual([
      expect.objectContaining({
        componentId: node.componentId,
        level: "load-confirmed",
        status: "ready",
      }),
    ]);
    expect(result.checks[0]?.detail).toContain("own skill directory");
    const state = await node.storage.capabilities.loadCapabilityState();
    expect(
      Object.values(state.observations).find((entry) => entry.componentId === node.componentId),
    ).toMatchObject({ level: "load-confirmed", generation: "pi:2:2026-11-26T10:01:00.000Z" });
  });

  test("a Pi skill outside the staging root is never confirmed even with an identical suffix", async () => {
    const node = await withPrivateLaunch(
      () => piLoaded("/home/user/.pi/agent/0123456789abcdef0123/skills/review/SKILL.md"),
      "pi",
    );
    const result = await node.verify();
    expect(result.checks[0]).toMatchObject({ level: "present", status: "failed" });
    expect(result.checks[0]?.detail).toContain("shared skill of the same name");
  });

  test("an incomplete Pi report leaves an omitted private skill unconfirmed", async () => {
    const node = await withPrivateLaunch(
      () => piLoaded("/home/user/.pi/agent/skills/review/SKILL.md", true),
      "pi",
    );
    const result = await node.verify();
    expect(result.checks[0]).toMatchObject({ level: "present", status: "installed-next-session" });
    expect(result.checks[0]?.detail).toContain("available evidence");
  });

  test("a Pi bridge without the route reports that loading cannot be confirmed", async () => {
    const node = await withPrivateLaunch(() => ({ state: "unsupported" }), "pi");
    const result = await node.verify();
    expect(result.checks[0]).toMatchObject({ level: "present", status: "installed-next-session" });
    expect(result.checks[0]?.detail).toContain("does not report which skills it loaded");
  });

  test("Grok's own discovery listing of the installed path is advertised; a name alone is not", async () => {
    let listed: Array<{ name: string; path: string }> = [];
    const grok: ProviderCli = async () => ({
      stdout: JSON.stringify({
        grokVersion: "1.0.88",
        skills: listed.map((entry) => ({
          name: entry.name,
          source: { type: "user", path: entry.path },
        })),
      }),
      exitCode: 0,
    });
    const node = await machine({ grok });
    const { inspection } = await addSkill(node.service, "grok-skill");
    const state = await node.storage.capabilities.loadCapabilityState();
    const componentId = state.packages[inspection.packageId]!.componentIds[0]!;
    const verify = () =>
      node.service.verify({
        consent: true,
        target: { nodeId: NODE, provider: "grok" },
        componentIds: [componentId],
      });
    listed = [{ name: "grok-skill", path: path.join(node.home, "elsewhere", "SKILL.md") }];
    const unlisted = await verify();
    expect(unlisted.checks.every((check) => check.level !== "advertised")).toBe(true);

    listed = [
      {
        name: "grok-skill",
        path: path.join(node.home, ".agents", "skills", "grok-skill", "SKILL.md"),
      },
    ];
    const result = await verify();
    expect(result.checks.some((check) => check.level === "advertised")).toBe(true);
  });
});
