/**
 * Registries, signed manifests and mixed-revision exports through the
 * service, over real storage: two separate installations (each its own
 * SQLite store and provider home) and an in-memory registry served by an
 * injected fetch. No network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";
import { revisionDigest } from "@orkestrator/protocol/capability-resources-resolve";

import { StorageService } from "../storage.js";
import type { ManifestSigningKeys } from "./manifest-signing.js";
import { testCapabilityHomes } from "./native-ownership.js";
import {
  fakeRegistryFetch,
  registryIndex,
  registryKey,
  sha256Of,
  skillTarball,
} from "./registry-test-support.js";
import { CapabilityService } from "./service.js";

const INDEX = "https://registry.example.com/index.json";
const tarballUrl = (version: string) => `https://cdn.example.com/review-${version}.tgz`;
const source = { kind: "registry" as const, registryId: "team", qualifiedId: "team/review" };
const PACKAGE_ID = "registry:team/team/review";

interface Installation {
  dir: string;
  storage: StorageService;
  service: CapabilityService;
  keys: { own: ReturnType<typeof registryKey> | null; trusted: ReturnType<typeof registryKey>[] };
}

const installations: Installation[] = [];

afterEach(async () => {
  for (const node of installations.splice(0)) {
    node.service.dispose();
    node.storage.close?.();
    await fs.rm(node.dir, { recursive: true, force: true });
  }
});

/** The registry's published versions (newest first) and the routes serving them. */
function publish(versions: string[], routes = new Map<string, Buffer | string>()) {
  for (const version of versions) {
    routes.set(tarballUrl(version), skillTarball("review", `Review, version ${version}.`));
  }
  routes.set(
    INDEX,
    JSON.stringify(
      registryIndex({
        "team/review": {
          displayName: "Review",
          latest: versions[0],
          versions: versions.map((version) => ({
            version,
            tarball: {
              url: tarballUrl(version),
              sha256: sha256Of(routes.get(tarballUrl(version)) as Buffer),
              subpath: "package",
            },
          })),
        },
      }),
    ),
  );
  return routes;
}

async function install(name: string, routes: Map<string, Buffer | string>): Promise<Installation> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `capability-registry-${name}-`));
  const home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  const storage = new StorageService(path.join(dir, "data"));
  await storage.init();
  const keys: Installation["keys"] = { own: null, trusted: [] };
  const signing: ManifestSigningKeys = {
    installationKey: (create) => {
      if (!keys.own && create) keys.own = registryKey();
      return keys.own;
    },
    trusted: () =>
      keys.trusted.map((key) => ({ keyId: key.keyId, publicKey: key.publicKey, label: "Peer" })),
  };
  const service = new CapabilityService({
    storage: { capabilities: storage.capabilities },
    dataDir: path.join(dir, "data"),
    selfId: async () => `bk_${name}`,
    selfName: async () => name,
    machines: async () => [],
    link: () => null,
    isAuthority: () => true,
    emit: () => undefined,
    homes: () => testCapabilityHomes(home),
    inventory: {
      providers: async () => AGENT_PLATFORMS.map((provider) => ({ provider, available: true })),
    },
    signing,
    registryFetch: fakeRegistryFetch(routes),
  });
  await service.init();
  const node = { dir, storage, service, keys };
  installations.push(node);
  return node;
}

async function addToSetup(node: Installation, inspectionId: string, setupId: string) {
  const preview = await node.service.previewChange({
    change: { kind: "add-to-setup", inspectionId, setupId },
  });
  await node.service.applyChange({
    operationId: preview.operation.id,
    approvedDigest: preview.operation.planDigest,
  });
  await node.service.reconciler.idle();
}

async function configureRegistry(node: Installation) {
  return node.service.registries.set({
    registry: { id: "team", label: "Team registry", indexUrl: INDEX },
  });
}

describe("package registries", () => {
  test("a registry package is added, identified by registry and updated from the index", async () => {
    const routes = publish(["1.0.0"]);
    const node = await install("command", routes);
    await expect(node.service.inspectSource({ source })).rejects.toThrow(
      "No package registry named team",
    );
    const list = await configureRegistry(node);
    expect(list.registries[0]).toMatchObject({ id: "team", packageCount: 1 });
    expect(list.registries[0]?.lastError).toBeUndefined();

    const inspection = await node.service.inspectSource({ source });
    expect(inspection.packageId).toBe(PACKAGE_ID);
    expect(inspection.revision).toBe("1.0.0");
    await addToSetup(node, inspection.inspectionId, MY_SETUP_ID);
    expect((await node.service.listPackages({})).packages[0]?.id).toBe(PACKAGE_ID);

    // Nothing new: no proposal.
    expect((await node.service.refreshUpdates({})).updates).toEqual([]);
    // A new version in the index becomes a proposal; approval rules are unchanged.
    publish(["1.1.0", "1.0.0"], routes);
    const updates = (await node.service.refreshUpdates({})).updates;
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      packageId: PACKAGE_ID,
      fromRevision: "1.0.0",
      toRevision: "1.1.0",
      state: "pending",
      requiresApproval: true,
    });
    const cancelled = await node.service.previewUpdate({ updateId: updates[0]!.id });
    await node.service.cancelOperation({ operationId: cancelled.operation.id });
    const preview = await node.service.previewUpdate({ updateId: updates[0]!.id });
    expect(preview.operation.id).not.toBe(cancelled.operation.id);
    expect(preview.operation.state).toBe("awaiting-approval");
    await node.service.approveUpdate({
      updateId: updates[0]!.id,
      approvedDigest: preview.operation.planDigest,
    });
    const state = await node.storage.capabilities.loadCapabilityState();
    expect(state.packages[PACKAGE_ID]?.revision).toBe("1.1.0");
    expect(state.packages[PACKAGE_ID]?.previousRevisions?.[0]?.revision).toBe("1.0.0");
  });

  test("an active historical pin survives more than five newer revisions", async () => {
    const routes = publish(["1.0.0"]);
    const node = await install("long-history", routes);
    await configureRegistry(node);
    const original = await node.service.inspectSource({ source });
    await addToSetup(node, original.inspectionId, MY_SETUP_ID);
    const pinned = await node.service.setSetup({
      setup: {
        name: "Pinned",
        packageSelections: [{ packageId: PACKAGE_ID, version: original.artifactDigest }],
      },
    });
    for (let n = 1; n <= 6; n += 1) {
      const revision = `1.${n}.0`;
      publish([revision], routes);
      const update = (await node.service.refreshUpdates({})).updates.find(
        (candidate) => candidate.toRevision === revision,
      )!;
      const preview = await node.service.previewUpdate({ updateId: update.id });
      await node.service.approveUpdate({
        updateId: update.id,
        approvedDigest: preview.operation.planDigest,
      });
    }
    const state = await node.storage.capabilities.loadCapabilityState();
    expect(revisionDigest(state.packages[PACKAGE_ID]!, original.artifactDigest)).toBe(
      original.artifactDigest,
    );
    await expect(node.service.exportSetup({ setupIds: [pinned.id] })).resolves.toBeTruthy();
  });

  test("forbiddenSources forbids a registry: no inspection and no update discovery", async () => {
    const routes = publish(["1.0.0"]);
    const node = await install("command", routes);
    await configureRegistry(node);
    const inspection = await node.service.inspectSource({ source });
    await addToSetup(node, inspection.inspectionId, MY_SETUP_ID);
    const before = await node.service.getEffectiveResources({
      target: { nodeId: "bk_command", provider: "claude" },
    });
    expect(before.resolvedPackages.some((entry) => entry.id === PACKAGE_ID)).toBe(true);
    node.storage.capabilities.mutateCapabilityState((state) => {
      state.settings.forbiddenSources = ["registry:team/"];
      return { result: undefined, changed: true };
    });
    await expect(node.service.inspectSource({ source })).rejects.toThrow("forbids");
    publish(["2.0.0", "1.0.0"], routes);
    expect((await node.service.refreshUpdates({})).updates).toEqual([]);
    // And the resolver blocks the package that is already there.
    const effective = await node.service.getEffectiveResources({
      target: { nodeId: "bk_command", provider: "claude" },
    });
    expect(effective.resolvedPackages.some((entry) => entry.id === PACKAGE_ID)).toBe(false);
    expect(effective.blocked.map((entry) => entry.reason).join("\n")).toContain("polic");
  });

  test("a registry can be removed and a bad index is reported, not thrown", async () => {
    const node = await install("command", new Map([[INDEX, "{not json"]]));
    const list = await configureRegistry(node);
    expect(list.registries[0]?.lastError).toBe("The registry index is not valid JSON.");
    expect((await node.service.registries.set({ remove: "team" })).registries).toEqual([]);
    await expect(
      node.service.registries.set({ registry: { id: "x", indexUrl: "http://insecure/i.json" } }),
    ).rejects.toThrow("https://");
  });
});

/** Two toolkits on one installation pinned to two revisions of the registry package. */
async function mixedRevisions(node: Installation, routes: Map<string, Buffer | string>) {
  await configureRegistry(node);
  const stable = await node.service.setSetup({ setup: { name: "Stable" } });
  const edge = await node.service.setSetup({ setup: { name: "Edge" } });
  const first = await node.service.inspectSource({ source });
  await addToSetup(node, first.inspectionId, stable.id);
  publish(["1.1.0", "1.0.0"], routes);
  const [update] = (await node.service.refreshUpdates({})).updates;
  const preview = await node.service.previewUpdate({ updateId: update!.id });
  await node.service.approveUpdate({
    updateId: update!.id,
    approvedDigest: preview.operation.planDigest,
  });
  let state = await node.storage.capabilities.loadCapabilityState();
  await node.service.setSetup({
    setup: {
      id: stable.id,
      name: "Stable",
      packageSelections: [{ packageId: PACKAGE_ID, version: "1.0.0" }],
    },
    expectedRevision: state.setups[stable.id]!.revision,
  });
  await node.service.setSetup({
    setup: {
      id: edge.id,
      name: "Edge",
      packageSelections: [{ packageId: PACKAGE_ID, version: "latest" }],
    },
    expectedRevision: state.setups[edge.id]!.revision,
  });
  state = await node.storage.capabilities.loadCapabilityState();
  return { stable: stable.id, edge: edge.id, state };
}

/** Each setup's (package, digest) pins, by setup name. */
function pinnedGraph(
  state: Awaited<ReturnType<StorageService["capabilities"]["loadCapabilityState"]>>,
) {
  return Object.fromEntries(
    Object.values(state.setups)
      .filter((setup) => setup.packageSelections.length > 0)
      .map((setup) => [
        setup.name,
        setup.packageSelections.map((selection) => [
          selection.packageId,
          revisionDigest(state.packages[selection.packageId]!, selection.version),
        ]),
      ]),
  );
}

describe("mixed-revision exports (lockfile format 2)", () => {
  test("two setups pinned to two revisions export together and import to the same pinned graph", async () => {
    const routes = publish(["1.0.0"]);
    const exporter = await install("exporter", routes);
    const { stable, edge, state } = await mixedRevisions(exporter, routes);
    const exported = await exporter.service.exportSetup({ setupIds: [stable, edge] });
    expect(exported.formatVersion).toBe(2);
    const lock = JSON.parse(exported.lock);
    expect(lock.formatVersion).toBe(2);
    expect(lock.packages.map((entry: { revision: string }) => entry.revision)).toEqual([
      "1.1.0",
      "1.0.0",
    ]);
    expect(exported.intent).not.toContain(exporter.dir);

    // Each setup alone still fits format 1, which older installations read.
    const single = await exporter.service.exportSetup({ setupIds: [stable] });
    expect(single.formatVersion).toBe(1);
    expect(JSON.parse(single.lock).setups.stable.packageIds).toEqual([PACKAGE_ID]);

    const importer = await install("importer", routes);
    await configureRegistry(importer);
    const preview = await importer.service.previewImport({
      intent: exported.intent,
      lock: exported.lock,
    });
    expect(preview.issues).toEqual([]);
    expect(preview.valid).toBe(true);
    expect(preview.packages.map((entry) => [entry.revision, entry.action])).toEqual([
      ["1.1.0", "add"],
      ["1.0.0", "add"],
    ]);
    await importer.service.importSetup({ previewId: preview.previewId });
    const imported = await importer.storage.capabilities.loadCapabilityState();
    expect(pinnedGraph(imported)).toEqual(pinnedGraph(state));
    expect(imported.packages[PACKAGE_ID]?.revision).toBe("1.1.0");
    expect(
      imported.packages[PACKAGE_ID]?.previousRevisions?.map((entry) => entry.revision),
    ).toEqual(["1.0.0"]);

    // Importing again changes nothing: both revisions are already kept.
    const again = await importer.service.previewImport({
      intent: exported.intent,
      lock: exported.lock,
    });
    expect(again.packages.every((entry) => entry.action === "unchanged")).toBe(true);
    expect(again.valid).toBe(true);
  });

  test("a format 1 lockfile still imports", async () => {
    const routes = publish(["1.0.0"]);
    const exporter = await install("exporter", routes);
    await configureRegistry(exporter);
    const inspection = await exporter.service.inspectSource({ source });
    await addToSetup(exporter, inspection.inspectionId, MY_SETUP_ID);
    const exported = await exporter.service.exportSetup({ setupIds: [MY_SETUP_ID] });
    expect(JSON.parse(exported.lock).formatVersion).toBe(1);
    const importer = await install("importer", routes);
    await configureRegistry(importer);
    const preview = await importer.service.previewImport({
      intent: exported.intent,
      lock: exported.lock,
    });
    expect(preview.valid).toBe(true);
    expect(preview.signature?.status).toBe("unsigned");
    await importer.service.importSetup({ previewId: preview.previewId });
    const imported = await importer.storage.capabilities.loadCapabilityState();
    expect(imported.packages[PACKAGE_ID]?.artifactDigest).toBe(inspection.artifactDigest);
  });
});

describe("signed team manifests", () => {
  async function signedExport() {
    const routes = publish(["1.0.0"]);
    const exporter = await install("exporter", routes);
    await configureRegistry(exporter);
    const inspection = await exporter.service.inspectSource({ source });
    await addToSetup(exporter, inspection.inspectionId, MY_SETUP_ID);
    const exported = await exporter.service.exportSetup({ setupIds: [MY_SETUP_ID], sign: true });
    const importer = await install("importer", routes);
    await configureRegistry(importer);
    return { exporter, importer, exported };
  }

  test("signer, trust and policy are shown and enforced on import preview", async () => {
    const { exporter, importer, exported } = await signedExport();
    expect(exported.formatVersion).toBe(2);
    expect(exported.signed?.keyId).toBe(exporter.keys.own!.keyId);
    expect(exported.lock).not.toContain(exporter.keys.own!.privateKey);

    // The exporter trusts its own key.
    const own = await exporter.service.previewImport({
      intent: exported.intent,
      lock: exported.lock,
    });
    expect(own.signature).toMatchObject({ status: "trusted", own: true });

    // Another installation: valid but untrusted; allowed until the policy requires signatures.
    const untrusted = await importer.service.previewImport({
      intent: exported.intent,
      lock: exported.lock,
    });
    expect(untrusted.signature?.status).toBe("untrusted");
    expect(untrusted.signature?.publicKey).toBe(exporter.keys.own!.publicKey);
    expect(untrusted.valid).toBe(true);

    const policy = await importer.service.registries.setManifestPolicy({
      requireSignedManifests: true,
    });
    expect(policy.requireSignedManifests).toBe(true);
    const blocked = await importer.service.previewImport({
      intent: exported.intent,
      lock: exported.lock,
    });
    expect(blocked.valid).toBe(false);
    expect(blocked.requireSignedManifests).toBe(true);
    expect(blocked.issues[0]?.message).toContain("is not trusted");
    // A preview made before the policy changed cannot be applied after it.
    await expect(importer.service.importSetup({ previewId: untrusted.previewId })).rejects.toThrow(
      "requires manifests signed by a trusted key",
    );

    importer.keys.trusted.push(exporter.keys.own!);
    const trusted = await importer.service.previewImport({
      intent: exported.intent,
      lock: exported.lock,
    });
    expect(trusted.signature).toMatchObject({ status: "trusted", label: "Peer" });
    expect(trusted.valid).toBe(true);
    await importer.service.importSetup({ previewId: trusted.previewId });

    // Unsigned manifests are blocked by the policy too.
    const unsigned = await exporter.service.exportSetup({ setupIds: [MY_SETUP_ID] });
    const refused = await importer.service.previewImport({
      intent: unsigned.intent,
      lock: unsigned.lock,
    });
    expect(refused.signature?.status).toBe("unsigned");
    expect(refused.valid).toBe(false);
  });

  test("an edited signed manifest is invalid and blocks the import", async () => {
    const { importer, exported } = await signedExport();
    const editedIntent = exported.intent.replace("updatePolicy: approve", "updatePolicy: pinned");
    expect(editedIntent).not.toBe(exported.intent);
    const preview = await importer.service.previewImport({
      intent: editedIntent,
      lock: exported.lock,
    });
    expect(preview.signature?.status).toBe("invalid");
    expect(preview.valid).toBe(false);
    expect(preview.issues[0]?.message).toContain("The signature is invalid");
  });
});
