/**
 * Local changes end to end (`drift.ts`): merging with the configured
 * revision, resolving conflicts by hand, adopting every component of a
 * package, and adopting into a Git package (divergence) or as a local
 * variant, over real stores and provider homes on a command node and two
 * leaves.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";

import { MY_SETUP_ID, type PackageSource } from "@orkestrator/protocol/capability-resources";
import type { CapabilitySourceInspection } from "@orkestrator/protocol/capability-resources-api";

import {
  addSkill,
  disposeFleet,
  fleet,
  openDrift,
  previewAndApply,
  skillFile,
  type FleetNode,
} from "./drift-test-support.js";
import { validatePackageFiles } from "./security.js";
import { inspectFiles, type InspectedPackage } from "./source-inspection.js";
import { checkPackageUpdate } from "./update-checker.js";

afterEach(disposeFleet);

const BODY = "Line one.\nLine two.\nLine three.\nLine four.\n";

/** A new revision of an authored skill, applied fleet-wide. */
async function publishRevision(command: FleetNode, managedId: string, body: string) {
  return addSkill(command, "style", body, managedId);
}

async function editFile(file: string, from: string, to: string) {
  const text = await fs.readFile(file, "utf8");
  expect(text).toContain(from);
  await fs.writeFile(file, text.replace(from, to));
}

function managedIdOf(inspection: CapabilitySourceInspection): string {
  return (inspection.source as Extract<PackageSource, { kind: "managed" }>).managedId;
}

describe("merge local changes", () => {
  test("a clean merge is previewed and approved as the package's next revision", async () => {
    const { command, leafA, leafB } = await fleet();
    const first = await addSkill(command, "style", BODY);
    await editFile(skillFile(leafA, ".claude", "style"), "Line one.", "Local one.");
    const [drift] = await openDrift(command, leafA);
    expect(drift?.kind).toBe("modified");

    // The package moves on while leaf A keeps its local edit.
    await publishRevision(command, managedIdOf(first), BODY.replace("Line four.", "New four."));
    expect(await fs.readFile(skillFile(leafB, ".claude", "style"), "utf8")).toContain("New four.");
    expect(await fs.readFile(skillFile(leafA, ".claude", "style"), "utf8")).not.toContain(
      "New four.",
    );

    const merge = await command.service.mergeDrift({ driftId: drift!.id });
    expect(merge.conflicts).toBe(0);
    expect(merge.unmergeable).toEqual([]);
    expect(merge.files).toEqual([expect.objectContaining({ path: "SKILL.md", outcome: "merged" })]);
    expect(merge.operation?.requiresApproval).toBe(true);
    expect(merge.operation?.approvalReasons).toContain(
      "Publish the merge of the local changes and the configured revision as the package's new revision.",
    );
    await command.service.applyChange({
      operationId: merge.operation!.id,
      approvedDigest: merge.operation!.planDigest,
    });
    await command.service.reconciler.idle();
    await command.service.reconciler.reconcileNode(leafA.id, "test");
    await command.service.reconciler.idle();

    for (const node of [leafA, leafB, command]) {
      for (const root of [".claude", ".agents"]) {
        const text = await fs.readFile(skillFile(node, root, "style"), "utf8");
        expect(text).toContain("Local one.");
        expect(text).toContain("New four.");
      }
    }
    expect(
      (await command.service.listDrift({})).drift.filter((entry) => entry.state === "open"),
    ).toEqual([]);
  });

  test("conflicts are returned per file and the resolved text is inspected before approval", async () => {
    const { command, leafA, leafB } = await fleet();
    const first = await addSkill(command, "style", BODY);
    await editFile(skillFile(leafA, ".claude", "style"), "Line two.", "Local two.");
    const [drift] = await openDrift(command, leafA);
    await publishRevision(command, managedIdOf(first), BODY.replace("Line two.", "Upstream two."));

    const merge = await command.service.mergeDrift({ driftId: drift!.id });
    expect(merge.operation).toBeUndefined();
    expect(merge.conflicts).toBe(1);
    const file = merge.files.find((entry) => entry.outcome === "conflict");
    expect(file?.path).toBe("SKILL.md");
    expect(file?.conflict?.kind).toBe("text");
    expect(file?.conflict?.hunks).toEqual([
      expect.objectContaining({
        base: "Line two.\n",
        local: "Local two.\n",
        configured: "Upstream two.\n",
      }),
    ]);
    expect(file?.conflict?.merged).toContain("<<<<<<< local\nLocal two.\n");
    const merged = file!.conflict!.merged!;

    await expect(
      command.service.mergeDrift({
        driftId: drift!.id,
        basis: "sha256:stale",
        resolutions: [{ path: "SKILL.md", content: "x" }],
      }),
    ).rejects.toHaveProperty("code", "conflict");
    await expect(
      command.service.mergeDrift({
        driftId: drift!.id,
        basis: merge.basis,
        resolutions: [{ path: "SKILL.md", content: merged }],
      }),
    ).rejects.toThrow("conflict markers");
    const withSecret = merged.replace(
      /<<<<<<< local\n[\s\S]*>>>>>>> configured\n/,
      "token = ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n",
    );
    await expect(
      command.service.mergeDrift({
        driftId: drift!.id,
        basis: merge.basis,
        resolutions: [{ path: "SKILL.md", content: withSecret }],
      }),
    ).rejects.toHaveProperty("code", "secrets-detected");

    const resolvedText = merged.replace(
      /<<<<<<< local\n[\s\S]*>>>>>>> configured\n/,
      "Local and upstream two.\n",
    );
    const resolved = await command.service.mergeDrift({
      driftId: drift!.id,
      basis: merge.basis,
      resolutions: [{ path: "SKILL.md", content: resolvedText }],
    });
    expect(resolved.conflicts).toBe(0);
    expect(resolved.operation).toBeDefined();
    await command.service.applyChange({
      operationId: resolved.operation!.id,
      approvedDigest: resolved.operation!.planDigest,
    });
    await command.service.reconciler.idle();
    await command.service.reconciler.reconcileNode(leafA.id, "test");
    await command.service.reconciler.idle();
    for (const node of [leafA, leafB]) {
      expect(await fs.readFile(skillFile(node, ".claude", "style"), "utf8")).toContain(
        "Local and upstream two.",
      );
    }
  });

  test("binary files changed on both sides are reported, never merged", async () => {
    const { command, leafA } = await fleet();
    const upload = (logo: number[]) =>
      command.service.authorPackage({
        kind: "upload",
        name: "brand",
        managedId: "brand-assets",
        files: [
          {
            path: "SKILL.md",
            content: "---\nname: brand\ndescription: Brand\n---\nUse the logo.\n",
          },
          { path: "logo.png", content: Buffer.from(logo).toString("base64"), encoding: "base64" },
        ],
      });
    await previewAndApply(command, {
      kind: "add-to-setup",
      inspectionId: (await upload([0, 1, 2])).inspectionId,
      setupId: MY_SETUP_ID,
    });
    await fs.writeFile(
      path.join(leafA.home, ".claude", "skills", "brand", "logo.png"),
      Buffer.from([0, 9, 9]),
    );
    const [drift] = await openDrift(command, leafA);
    await previewAndApply(command, {
      kind: "add-to-setup",
      inspectionId: (await upload([0, 7, 7])).inspectionId,
      setupId: MY_SETUP_ID,
    });
    const merge = await command.service.mergeDrift({ driftId: drift!.id });
    expect(merge.unmergeable).toEqual(["logo.png"]);
    expect(merge.files.find((file) => file.path === "logo.png")?.conflict?.kind).toBe("binary");
    expect(merge.operation).toBeUndefined();
  });
});

describe("adopt local changes", () => {
  test("every component of a multi-component package is adopted as its next revision", async () => {
    const { command, leafA, leafB } = await fleet();
    const inspection = await command.service.authorPackage({
      kind: "upload",
      name: "pair",
      managedId: "pair",
      files: [
        {
          path: "skills/alpha/SKILL.md",
          content: "---\nname: alpha\ndescription: A\n---\nAlpha.\n",
        },
        { path: "skills/beta/SKILL.md", content: "---\nname: beta\ndescription: B\n---\nBeta.\n" },
      ],
    });
    expect(inspection.components).toHaveLength(2);
    await previewAndApply(command, {
      kind: "add-to-setup",
      inspectionId: inspection.inspectionId,
      setupId: MY_SETUP_ID,
    });
    await editFile(skillFile(leafA, ".claude", "alpha"), "Alpha.", "Alpha, edited.");
    await editFile(skillFile(leafA, ".claude", "beta"), "Beta.", "Beta, edited.");
    const drift = await openDrift(command, leafA);
    expect(drift).toHaveLength(2);

    const preview = await previewAndApply(command, {
      kind: "adopt-drift",
      driftId: drift[0]!.id,
      mode: "revision",
    });
    expect(preview.operation.approvalReasons).toContain(
      "Adopt the observed local files as the package's new revision.",
    );
    const detail = await command.service.getPackage({ packageId: inspection.packageId });
    expect(detail.package.provenance).toBe("managed");
    expect(detail.package.componentCount).toBe(2);
    expect(detail.package.diverged).toBeUndefined();
    for (const node of [leafA, leafB]) {
      expect(await fs.readFile(skillFile(node, ".agents", "alpha"), "utf8")).toContain(
        "Alpha, edited.",
      );
      expect(await fs.readFile(skillFile(node, ".agents", "beta"), "utf8")).toContain(
        "Beta, edited.",
      );
    }
    expect(await openDrift(command, leafA)).toEqual([]);
  });

  test("adopting into a Git package makes it diverge; upstream updates then always need review", async () => {
    const { command, leafA, leafB } = await fleet();
    const source = {
      kind: "git",
      repo: "https://example.com/team/skills.git",
      subpath: "",
    } as const satisfies PackageSource;
    const files = (body: string) =>
      validatePackageFiles([
        {
          path: "SKILL.md",
          content: Buffer.from(`---\nname: review\ndescription: Review\n---\n${body}`),
        },
      ]);
    const store = (inspected: InspectedPackage) =>
      (
        command.service as unknown as {
          inspection: {
            store(
              inspected: InspectedPackage,
              requestKey: string | undefined,
            ): Promise<CapabilitySourceInspection>;
          };
        }
      ).inspection.store(inspected, undefined);
    const upstream = "a".repeat(40);
    const inspection = await store(inspectFiles(source, files(BODY), { revision: upstream }));
    await previewAndApply(command, {
      kind: "add-to-setup",
      inspectionId: inspection.inspectionId,
      setupId: MY_SETUP_ID,
    });
    await editFile(skillFile(leafA, ".claude", "review"), "Line one.", "Team one.");
    const [drift] = await openDrift(command, leafA);
    const preview = await previewAndApply(command, {
      kind: "adopt-drift",
      driftId: drift!.id,
      mode: "revision",
    });
    expect(preview.operation.approvalReasons.some((reason) => reason.includes("diverge"))).toBe(
      true,
    );
    const pkg = (await command.service.getPackage({ packageId: inspection.packageId })).package;
    expect(pkg.source).toEqual(source);
    expect(pkg.provenance).toBe("managed");
    expect(pkg.diverged).toMatchObject({
      upstreamRevision: upstream,
      upstreamDigest: inspection.artifactDigest,
      reason: "adopted-local",
    });
    expect(await fs.readFile(skillFile(leafB, ".claude", "review"), "utf8")).toContain("Team one.");

    const state = await command.storage.capabilities.loadCapabilityState();
    const storedPkg = state.packages[inspection.packageId]!;
    const unchanged = await checkPackageUpdate(state, storedPkg, {
      remoteHead: async () => upstream,
      inspect: async () => inspectFiles(source, files(BODY), { revision: upstream }),
      storeArtifact: async () => undefined,
      now: () => new Date().toISOString(),
    });
    expect(unchanged).toBeNull();
    const moved = await checkPackageUpdate(state, storedPkg, {
      remoteHead: async () => "b".repeat(40),
      inspect: async () =>
        inspectFiles(source, files(`${BODY}Line five.\n`), { revision: "b".repeat(40) }),
      storeArtifact: async () => undefined,
      now: () => new Date().toISOString(),
    });
    expect(moved?.proposal.diverged).toBe(true);
    expect(moved?.proposal.requiresApproval).toBe(true);
    expect(moved?.autoApply).toBe(false);
    expect(moved?.proposal.reasons[0]).toContain("taking this update replaces them");
  });

  test("a local variant becomes its own package and takes over the original's copies", async () => {
    const { command, leafA, leafB } = await fleet();
    const original = await addSkill(command, "style", BODY);
    await editFile(skillFile(leafA, ".claude", "style"), "Line three.", "Variant three.");
    const [drift] = await openDrift(command, leafA);
    const preview = await previewAndApply(command, {
      kind: "adopt-drift",
      driftId: drift!.id,
      mode: "variant",
    });
    expect(preview.operation.packageIds).toContain(original.packageId);
    expect(preview.operation.targets.some((target) => target.action === "remove")).toBe(true);
    await command.service.reconciler.reconcileNode(leafA.id, "test");
    await command.service.reconciler.idle();

    const state = await command.storage.capabilities.loadCapabilityState();
    const variant = Object.values(state.packages).find(
      (pkg) => pkg.derivedFrom?.packageId === original.packageId,
    );
    expect(variant?.id).not.toBe(original.packageId);
    expect(variant?.source.kind).toBe("managed");
    expect(variant?.provenance).toBe("managed");
    expect(variant?.displayName).toBe("style (local)");
    const selections = state.setups[MY_SETUP_ID]!.packageSelections.map((entry) => entry.packageId);
    expect(selections).toContain(variant!.id);
    expect(selections).not.toContain(original.packageId);

    for (const node of [leafA, leafB]) {
      for (const root of [".claude", ".agents"]) {
        expect(await fs.readFile(skillFile(node, root, "style"), "utf8")).toContain(
          "Variant three.",
        );
      }
      const inventory = await command.service.getInventory({ nodeId: node.id, refresh: true });
      const owners = inventory.items
        .filter((item) => item.name === "style" && item.ownership === "managed")
        .map((item) => item.packageId);
      expect(owners.length).toBeGreaterThan(0);
      expect(new Set(owners)).toEqual(new Set([variant!.id]));
    }
    const after = await command.storage.capabilities.loadCapabilityState();
    expect(
      Object.values(after.receipts).filter((receipt) => receipt.packageId === original.packageId),
    ).toEqual([]);
    expect(await openDrift(command, leafA)).toEqual([]);
  });

  test("a single deleted component is adopted as the package losing it", async () => {
    const { command, leafA } = await fleet();
    const inspection = await command.service.authorPackage({
      kind: "upload",
      name: "pair",
      managedId: "pair-delete",
      files: [
        {
          path: "skills/alpha/SKILL.md",
          content: "---\nname: alpha\ndescription: A\n---\nAlpha.\n",
        },
        { path: "skills/beta/SKILL.md", content: "---\nname: beta\ndescription: B\n---\nBeta.\n" },
      ],
    });
    await previewAndApply(command, {
      kind: "add-to-setup",
      inspectionId: inspection.inspectionId,
      setupId: MY_SETUP_ID,
    });
    await fs.rm(path.dirname(skillFile(leafA, ".claude", "beta")), { recursive: true });
    const drift = await openDrift(command, leafA);
    expect(drift.map((entry) => entry.kind)).toEqual(["removed"]);
    await previewAndApply(command, { kind: "adopt-drift", driftId: drift[0]!.id });
    const pkg = (await command.service.getPackage({ packageId: inspection.packageId })).package;
    expect(pkg.componentCount).toBe(1);
    await expect(fs.stat(skillFile(leafA, ".agents", "beta"))).rejects.toThrow();
    expect(await openDrift(command, leafA)).toEqual([]);
  });
});
