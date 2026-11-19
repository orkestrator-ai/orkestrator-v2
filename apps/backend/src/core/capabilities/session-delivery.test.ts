/**
 * Session-private delivery (8314 task 2): a selection made for one session is
 * staged into an Orkestrator-owned plugin passed on that session's turns
 * only, never into a provider home other sessions or providers read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CapabilityComponent } from "@orkestrator/protocol/capability-resources";
import type { NodeRoute } from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";

import {
  settle,
  stopTestNodeNetworks,
  TestNodeNetwork,
} from "../nodes/node-network-test-support.js";
import {
  addCapabilityNode,
  addSkill as addNetworkSkill,
  disposeCapabilityNodes,
  type CapabilityNode,
} from "./capability-network-test-support.js";
import { disposeFleet, fleet, skillFile, type FleetNode } from "./drift-test-support.js";
import { applyChangeToState, parseCapabilityChange } from "./operations.js";
import { sha256 } from "./planning.js";
import { canonicalCapabilityJson } from "@orkestrator/protocol/capability-resources-resolve";
import { sha256Hex, treeDigest, type PackageFile } from "./security.js";
import {
  parseSessionPrivateItems,
  pruneSessionPlugins,
  sessionPluginDigest,
  sessionPluginForTurn,
  sessionPluginsRoot,
  sessionPrivateDeliverable,
  stageSessionPlugin,
  withoutPrivateItems,
  type SessionPrivateItem,
} from "./session-delivery.js";

const temporary: string[] = [];

afterEach(async () => {
  await stopTestNodeNetworks();
  await disposeCapabilityNodes();
  await disposeFleet();
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function pkgFile(relative: string, text: string): PackageFile {
  const content = Buffer.from(text);
  return {
    path: relative,
    bytes: content.length,
    executable: false,
    sha256: sha256Hex(content),
    content,
  };
}

function fakeArtifacts(files: Record<string, PackageFile[]>) {
  return { get: async (digest: string) => files[digest] ?? [] };
}

function component(overrides: Partial<CapabilityComponent>): CapabilityComponent {
  return {
    id: "pkg#skill:review",
    packageId: "pkg",
    kind: "skill",
    name: "review",
    pathOrKey: "review",
    dependencies: [],
    providerHints: [],
    requirements: {},
    risk: "instructions",
    ...overrides,
  } as CapabilityComponent;
}

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-plugins-"));
  temporary.push(dir);
  return path.join(dir, "capability-session-plugins");
}

const ITEMS: SessionPrivateItem[] = [
  {
    packageId: "pkg",
    packageDigest: "sha256:a",
    componentId: "pkg#skill:review",
    kind: "skill",
    name: "review",
    pathOrKey: "review",
  },
  {
    packageId: "pkg",
    packageDigest: "sha256:a",
    componentId: "pkg#command:ship",
    kind: "command",
    name: "ship",
    pathOrKey: "commands/ship.md",
  },
  {
    packageId: "pkg",
    packageDigest: "sha256:a",
    componentId: "pkg#subagent:critic",
    kind: "subagent",
    name: "critic",
    pathOrKey: "agents/critic.md",
  },
];

const ARTIFACT = {
  "sha256:a": [
    pkgFile("review/SKILL.md", "---\nname: review\n---\nReview it."),
    pkgFile("review/notes/checklist.md", "Checklist."),
    pkgFile("commands/ship.md", "Ship it."),
    pkgFile("agents/critic.md", "Be critical."),
  ],
};

describe("which components a session can receive alone", () => {
  const state = { components: {} as Record<string, CapabilityComponent> };
  test("Claude on a host, for kinds a plugin carries", () => {
    const host = { provider: "claude" as const };
    expect(sessionPrivateDeliverable(state, host, component({}))).toBe(true);
    for (const kind of ["command", "prompt", "subagent"] as const) {
      expect(sessionPrivateDeliverable(state, host, component({ kind }))).toBe(true);
    }
    for (const kind of ["hook", "mcp-server", "native-plugin"] as const) {
      expect(sessionPrivateDeliverable(state, host, component({ kind }))).toBe(false);
    }
  });

  test("never another provider, a container, or a component meant for another provider", () => {
    expect(sessionPrivateDeliverable(state, { provider: "codex" }, component({}))).toBe(false);
    expect(
      sessionPrivateDeliverable(
        state,
        { provider: "claude", environmentIncarnation: "container-1" },
        component({}),
      ),
    ).toBe(false);
    expect(
      sessionPrivateDeliverable(
        state,
        { provider: "claude" },
        component({ providerHints: ["pi"] }),
      ),
    ).toBe(false);
  });

  test("a part a native plugin carries is delivered by the plugin, never alone", () => {
    const withPlugin = {
      components: {
        "pkg#native-plugin:x": component({ id: "pkg#native-plugin:x", kind: "native-plugin" }),
      },
    };
    expect(
      sessionPrivateDeliverable(
        withPlugin,
        { provider: "claude" },
        component({ dependencies: ["pkg#native-plugin:x"] }),
      ),
    ).toBe(false);
  });
});

describe("staging a session plugin", () => {
  test("writes a Claude plugin with the selected bytes and reads it back", async () => {
    const root = await tempRoot();
    const staged = await stageSessionPlugin({
      root,
      items: ITEMS,
      artifacts: fakeArtifacts(ARTIFACT),
    });
    expect(path.dirname(staged.directory)).toBe(root);
    const manifest = JSON.parse(
      await fs.readFile(path.join(staged.directory, ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("orkestrator-session");
    expect(
      await fs.readFile(path.join(staged.directory, "skills", "review", "SKILL.md"), "utf8"),
    ).toContain("Review it.");
    expect(
      await fs.readFile(
        path.join(staged.directory, "skills", "review", "notes", "checklist.md"),
        "utf8",
      ),
    ).toBe("Checklist.");
    expect(await fs.readFile(path.join(staged.directory, "commands", "ship.md"), "utf8")).toBe(
      "Ship it.",
    );
    expect(await fs.readFile(path.join(staged.directory, "agents", "critic.md"), "utf8")).toBe(
      "Be critical.",
    );
    expect(staged.record.items).toHaveLength(3);

    // The same selection is the same directory, reused.
    const again = await stageSessionPlugin({
      root,
      items: [...ITEMS].reverse(),
      artifacts: fakeArtifacts(ARTIFACT),
    });
    expect(again.directory).toBe(staged.directory);
    expect(again.record.treeDigest).toBe(staged.record.treeDigest);
  });

  test("a changed copy on disk is replaced with the recorded bytes", async () => {
    const root = await tempRoot();
    const staged = await stageSessionPlugin({
      root,
      items: ITEMS,
      artifacts: fakeArtifacts(ARTIFACT),
    });
    await fs.writeFile(path.join(staged.directory, "commands", "ship.md"), "Tampered.");
    await stageSessionPlugin({ root, items: ITEMS, artifacts: fakeArtifacts(ARTIFACT) });
    expect(await fs.readFile(path.join(staged.directory, "commands", "ship.md"), "utf8")).toBe(
      "Ship it.",
    );
  });

  test("two components with one install name are refused, not merged", async () => {
    const root = await tempRoot();
    await expect(
      stageSessionPlugin({
        root,
        items: [ITEMS[1]!, { ...ITEMS[1]!, componentId: "other#command:ship", packageId: "other" }],
        artifacts: fakeArtifacts(ARTIFACT),
      }),
    ).rejects.toThrow("both called ship");
  });

  test("a component missing from its artifact fails the delivery", async () => {
    const root = await tempRoot();
    await expect(
      stageSessionPlugin({ root, items: ITEMS, artifacts: fakeArtifacts({}) }),
    ).rejects.toThrow("not in the revision");
  });

  test("a turn re-stages a pruned plugin, and refuses bytes that moved", async () => {
    const root = await tempRoot();
    const staged = await stageSessionPlugin({
      root,
      items: ITEMS,
      artifacts: fakeArtifacts(ARTIFACT),
    });
    await fs.rm(staged.directory, { recursive: true });
    const byId = new Map(ITEMS.map((item) => [item.componentId, item]));
    const directory = await sessionPluginForTurn({
      root,
      record: staged.record,
      state: { packages: {}, components: {} },
      artifacts: fakeArtifacts(ARTIFACT),
      resolveItem: (entry) => byId.get(entry.componentId),
    });
    expect(directory).toBe(staged.directory);
    expect(await Bun.file(path.join(directory, "commands", "ship.md")).exists()).toBe(true);

    await fs.rm(staged.directory, { recursive: true });
    await expect(
      sessionPluginForTurn({
        root,
        record: staged.record,
        state: { packages: {}, components: {} },
        artifacts: fakeArtifacts({
          "sha256:a": ARTIFACT["sha256:a"].map((entry) =>
            entry.path === "commands/ship.md" ? pkgFile(entry.path, "Changed.") : entry,
          ),
        }),
        resolveItem: (entry) => byId.get(entry.componentId),
      }),
    ).rejects.toThrow("no longer match");
  });

  test("pruning keeps referenced and recent plugins", async () => {
    const root = await tempRoot();
    const kept = await stageSessionPlugin({
      root,
      items: ITEMS.slice(0, 1),
      artifacts: fakeArtifacts(ARTIFACT),
    });
    const stale = await stageSessionPlugin({
      root,
      items: ITEMS.slice(1, 2),
      artifacts: fakeArtifacts(ARTIFACT),
    });
    const recent = await stageSessionPlugin({
      root,
      items: ITEMS.slice(2),
      artifacts: fakeArtifacts(ARTIFACT),
    });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stale.directory, old, old);
    await fs.utimes(kept.directory, old, old);
    const removed = await pruneSessionPlugins(root, new Set([kept.record.digest]));
    expect(removed).toBe(1);
    expect(
      await Bun.file(path.join(kept.directory, ".claude-plugin", "plugin.json")).exists(),
    ).toBe(true);
    expect(await fs.stat(stale.directory).catch(() => null)).toBeNull();
    expect((await fs.stat(recent.directory)).isDirectory()).toBe(true);
  });
});

describe("reporting undelivered components", () => {
  const effective = {
    target: { nodeId: "n", provider: "claude" as const },
    setupRevisions: [],
    resolvedPackages: [
      { id: "pkg", artifactDigest: "sha256:a", components: ITEMS.map((i) => i.componentId) },
    ],
    permissionPolicyDigest: "p",
    manifestDigest: "m",
    unsupported: [],
    blocked: [],
    launchBlockers: [],
    warnings: [],
    resolvedAt: "2026-11-19T00:00:00.000Z",
  };

  test("optional ones are dropped with a warning; required ones block", () => {
    const optional = withoutPrivateItems(effective, ITEMS.slice(0, 1), "Gone.", new Set());
    expect(optional.resolvedPackages[0]?.components).not.toContain(ITEMS[0]!.componentId);
    expect(optional.unsupported).toEqual([{ componentId: ITEMS[0]!.componentId, reason: "Gone." }]);
    expect(optional.launchBlockers).toEqual([]);
    expect(optional.manifestDigest).not.toBe("m");
    const required = withoutPrivateItems(effective, ITEMS.slice(0, 1), "Gone.", new Set(["pkg"]));
    expect(required.launchBlockers[0]?.componentId).toBe(ITEMS[0]!.componentId);
  });

  test("an answer's items are bounded and typed", () => {
    expect(parseSessionPrivateItems("x")).toEqual([]);
    expect(parseSessionPrivateItems([{ ...ITEMS[0], kind: "hook" }])).toEqual([]);
    expect(parseSessionPrivateItems([ITEMS[0], { packageId: 1 }])).toEqual([ITEMS[0]!]);
    expect(parseSessionPrivateItems(Array.from({ length: 900 }, () => ITEMS[0]))).toHaveLength(500);
  });
});

test("exclusion lists preserve empty selections and reject invalid input", () => {
  const change = { kind: "add-to-setup", inspectionId: "inspection" };
  expect(
    parseCapabilityChange({ ...change, excludedMachines: [], excludedProviders: [] }),
  ).toMatchObject({ excludedMachines: [], excludedProviders: [] });
  expect(() =>
    parseCapabilityChange({
      ...change,
      excludedMachines: Array.from({ length: 65 }, () => "machine"),
    }),
  ).toThrow("too many entries");
  expect(() => parseCapabilityChange({ ...change, excludedProviders: ["claude", 1] })).toThrow(
    "invalid",
  );
});

test("session plugin digests sort keys independent of locale", () => {
  const items = ["é", "a", "Z"].map((componentId) => ({ ...ITEMS[0]!, componentId }));
  const expected = sha256(
    canonicalCapabilityJson({
      format: 1,
      items: ["Z", "a", "é"].map((id) => [items[0]!.packageId, id, items[0]!.packageDigest]),
    }),
  )
    .replace(/^sha256:/, "")
    .slice(0, 40);
  expect(sessionPluginDigest(items)).toBe(expected);
});

async function sessionToolkit(command: FleetNode, required: boolean) {
  const toolkit = await command.service.setSetup({ setup: { name: "Session tools" } });
  const inspection = await command.service.authorPackage({
    kind: "skill",
    name: "private-skill",
    description: "private-skill skill",
    content: "Only for this session.",
  });
  const preview = await command.service.previewChange({
    change: {
      kind: "add-to-setup",
      inspectionId: inspection.inspectionId,
      setupId: toolkit.id,
      ...(required ? { required: true } : {}),
    },
  });
  await command.service.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await command.service.reconciler.idle();
  await command.service.assignSetup({ scope: "session", scopeId: "s1", setupIds: [toolkit.id] });
  await command.service.reconciler.idle();
  return { toolkit, inspection };
}

describe("session launch on a host", () => {
  test("an optional machine-wide component without a copy is pending in the chip", async () => {
    const { command } = await fleet();
    const inspection = await command.service.authorPackage({
      kind: "skill",
      name: "optional-global",
      content: "Instructions.",
    });
    await command.service.reconciler.idle();
    command.storage.capabilities.mutateCapabilityState((state) => {
      const draft = state.inspections[inspection.inspectionId]!;
      applyChangeToState(state, {
        kind: "add-to-setup",
        setupId: "my-setup",
        inspectionId: draft.id,
      });
      return { changed: true, result: undefined };
    });
    const view = await command.service.getSessionView({
      sessionKey: "s1",
      target: { provider: "claude" },
    });
    expect(
      view.components.find((entry) => entry.componentId === inspection.components[0]?.id)?.status,
    ).toBe("pending");
    const launch = await command.service.preflightSession({
      environmentId: "env-1",
      sessionKey: "s1",
      provider: "claude",
    });
    expect(launch?.resolvedPackages).toEqual([]);
    expect(launch?.warnings.join(" ")).toContain("not verified");
  });

  test("the session chip does not promise private delivery for an old shared copy", async () => {
    const { command } = await fleet();
    const { inspection } = await sessionToolkit(command, true);
    const componentId = inspection.components[0]!.id;
    command.storage.capabilities.mutateCapabilityState((state) => {
      const nodeId = command.id;
      const key = `${nodeId}|claude-user-skills|${componentId}`;
      state.receipts[key] = {
        id: key,
        nodeId,
        locationId: "claude-user-skills",
        componentId,
        packageId: inspection.packageId,
        packageDigest: "sha256:old",
        digest: "sha256:old",
        providers: ["claude"],
        alsoVisibleTo: [],
        references: ["setup:my-setup"],
        status: "installed-next-session",
        verification: "present",
        operationId: "old",
        appliedAt: "2026-11-19T00:00:00.000Z",
      };
      return { changed: true, result: undefined };
    });
    const view = await command.service.getSessionView({
      sessionKey: "s1",
      target: { provider: "claude" },
    });
    expect(view.components.find((row) => row.componentId === componentId)?.status).toBe(
      "unsupported",
    );
    expect(view.effective?.launchBlockers.some((row) => row.componentId === componentId)).toBe(
      true,
    );
  });

  test("a required private skill cannot pass a read-only launch", async () => {
    const { command } = await fleet();
    await sessionToolkit(command, true);
    await expect(
      command.service.preflightSession({
        environmentId: "env-1",
        provider: "claude",
        sessionKey: "s1",
        readOnly: true,
      }),
    ).rejects.toThrow("cannot have");
    expect(await command.service.sessionPlugins("s1")).toEqual([]);
  });

  test("active private metadata survives launch diagnostics retention", async () => {
    const { command } = await fleet();
    await sessionToolkit(command, true);
    await command.service.preflightSession({
      environmentId: "env-1",
      provider: "claude",
      sessionKey: "s1",
    });
    const before = await command.service.sessionPlugins("s1");
    command.storage.capabilities.mutateCapabilityState((state) => {
      const launch = state.launches.s1!;
      const { privatePlugin: _, ...diagnostic } = launch;
      for (let index = 0; index < 2001; index++) {
        const sessionKey = `unrelated-${index}`;
        state.launches[sessionKey] = {
          ...diagnostic,
          sessionKey,
          launchedAt: "2099-01-01T00:00:00.000Z",
        };
      }
      return { result: undefined, changed: true };
    });
    expect(await command.service.sessionPlugins("s1")).toEqual(before);
  });

  test("a required session-only skill reaches that Claude session alone", async () => {
    const { command } = await fleet();
    const { inspection } = await sessionToolkit(command, true);
    const effective = await command.service.preflightSession({
      environmentId: "env-1",
      provider: "claude",
      sessionKey: "s1",
    });
    expect(effective?.launchBlockers).toEqual([]);
    expect(effective?.resolvedPackages.map((entry) => entry.id)).toEqual([inspection.packageId]);
    // Nothing reached a shared provider home.
    expect(await Bun.file(skillFile(command, ".claude", "private-skill")).exists()).toBe(false);
    expect(await Bun.file(skillFile(command, ".agents", "private-skill")).exists()).toBe(false);

    const record = (await command.storage.capabilities.loadCapabilityState()).launches.s1;
    expect(record?.privatePlugin?.items.map((item) => item.packageId)).toEqual([
      inspection.packageId,
    ]);
    const [directory] = await command.service.sessionPlugins("s1");
    expect(path.dirname(directory!)).toBe(sessionPluginsRoot(path.join(command.dir, "data")));
    expect(
      await fs.readFile(path.join(directory!, "skills", "private-skill", "SKILL.md"), "utf8"),
    ).toContain("Only for this session.");
    // Another session, with no assignment, receives nothing.
    expect(await command.service.sessionPlugins("s2")).toEqual([]);

    // The chip reports it as this session's own copy, not a shared install.
    const view = await command.service.getSessionView({
      sessionKey: "s1",
      target: { provider: "claude" },
    });
    const entry = view.components.find((item) => item.componentId === inspection.components[0]?.id);
    expect(entry?.status).toBe("installed-next-session");
    expect(entry?.reason).toContain("this session only");
    expect(entry?.liveSemantics).toBe("new-session-required");
  });

  test("the plugin is frozen at launch: a later setup change does not reach the running session", async () => {
    const { command } = await fleet();
    const { toolkit } = await sessionToolkit(command, false);
    await command.service.preflightSession({
      environmentId: "env-1",
      provider: "claude",
      sessionKey: "s1",
    });
    const [before] = await command.service.sessionPlugins("s1");
    const digestBefore = treeDigest(
      await (async () => {
        const text = await fs.readFile(path.join(before!, "skills", "private-skill", "SKILL.md"));
        return [{ path: "SKILL.md", executable: false, sha256: sha256Hex(text) }];
      })(),
    );
    await command.service.assignSetup({ scope: "session", scopeId: "s1", setupIds: [] });
    expect(toolkit.id).toBeTruthy();
    const [after] = await command.service.sessionPlugins("s1");
    expect(after).toBe(before);
    const text = await fs.readFile(path.join(after!, "skills", "private-skill", "SKILL.md"));
    expect(treeDigest([{ path: "SKILL.md", executable: false, sha256: sha256Hex(text) }])).toBe(
      digestBefore,
    );
  });

  test("other providers and containers still report the selection undeliverable", async () => {
    const { command } = await fleet();
    await sessionToolkit(command, true);
    await expect(
      command.service.preflightSession({
        environmentId: "env-1",
        provider: "codex",
        sessionKey: "s1",
      }),
    ).rejects.toThrow("cannot have");
    await expect(
      command.service.preflightSession({
        environmentId: "env-1",
        provider: "claude",
        sessionKey: "s1",
        environmentIncarnation: "container-1",
      }),
    ).rejects.toThrow("cannot have");
    expect((await command.storage.capabilities.loadCapabilityState()).launches.s1).toBeUndefined();
  });

  test("an optional session-only skill whose bytes are gone is dropped, never reported delivered", async () => {
    const { command } = await fleet();
    const { inspection } = await sessionToolkit(command, false);
    await fs.rm(path.join(command.dir, "data", "capability-artifacts"), {
      recursive: true,
      force: true,
    });
    const effective = await command.service.preflightSession({
      environmentId: "env-1",
      provider: "claude",
      sessionKey: "s1",
    });
    expect(effective?.resolvedPackages).toEqual([]);
    expect(effective?.unsupported.map((entry) => entry.componentId)).toContain(
      inspection.components[0]?.id,
    );
    expect(
      (await command.storage.capabilities.loadCapabilityState()).launches.s1?.privatePlugin,
    ).toBeUndefined();
  });

  test("a required session-only skill whose bytes are gone stops the launch", async () => {
    const { command } = await fleet();
    await sessionToolkit(command, true);
    await fs.rm(path.join(command.dir, "data", "capability-artifacts"), {
      recursive: true,
      force: true,
    });
    await expect(
      command.service.preflightSession({
        environmentId: "env-1",
        provider: "claude",
        sessionKey: "s1",
      }),
    ).rejects.toThrow("cannot have");
  });
});

function route(node: CapabilityNode): NodeRoute {
  return { id: "primary" as RouteId, kind: "https", enabled: true, origin: node.node.origin };
}

describe("session launch on a leaf", () => {
  test("the command node sends the bytes with its answer and the leaf stages the plugin itself", async () => {
    const network = new TestNodeNetwork();
    const desktop = await addCapabilityNode(network, "desktop", { forceRegistration: true });
    const gram = await addCapabilityNode(network, "gram", { launchAnswerTimeoutMs: 5_000 });
    await desktop.node.service.addNode({ routes: [route(gram)], token: gram.node.token });
    await settle(40);
    const toolkit = await desktop.cap.setSetup({ setup: { name: "Leaf session tools" } });
    const { inspection } = await addNetworkSkill(desktop, "leaf-private", "Leaf only.", {
      required: true,
      setupId: toolkit.id,
    });
    await desktop.cap.assignSetup({ scope: "session", scopeId: "s1", setupIds: [toolkit.id] });
    await desktop.cap.reconciler.idle();

    const effective = await gram.cap.preflightSession({
      environmentId: "env-1",
      provider: "claude",
      sessionKey: "s1",
    });
    expect(effective?.launchBlockers).toEqual([]);
    expect(effective?.resolvedPackages.map((entry) => entry.id)).toEqual([inspection.packageId]);
    const [directory] = await gram.cap.sessionPlugins("s1");
    expect(
      await fs.readFile(path.join(directory!, "skills", "leaf-private", "SKILL.md"), "utf8"),
    ).toContain("Leaf only.");
    await fs.rm(directory!, { recursive: true });
    expect(await gram.cap.sessionPlugins("s1")).toEqual([directory!]);
    expect(
      await fs.readFile(path.join(directory!, "skills", "leaf-private", "SKILL.md"), "utf8"),
    ).toContain("Leaf only.");

    // Recorded on the leaf, and never written to its shared provider homes.
    expect(
      (await gram.storage.capabilities.loadCapabilityState()).launches.s1?.privatePlugin?.items,
    ).toHaveLength(1);
    expect(
      await Bun.file(
        path.join(gram.home, ".claude", "skills", "leaf-private", "SKILL.md"),
      ).exists(),
    ).toBe(false);
  });
});
