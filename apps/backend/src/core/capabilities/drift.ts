/**
 * Local changes ("drift") and adopting installed items
 * (docs/architecture/agent-capabilities-management.md, "Reconciliation" and
 * "Troubleshooting"). A collaborator of `CapabilityService`, given what it
 * needs through `CapabilityDriftContext`.
 *
 * A managed copy someone edited or deleted on a machine is a drift entry. The
 * user keeps it, replaces it, adopts it or merges it:
 *
 * - **Adopt** reads every local change to the package on that machine (all of
 *   its components, through the machine's own executor when it is remote),
 *   lays them over the package's current files and inspects the result like
 *   any source (components, risk, secrets). The user chooses the identity:
 *   the package's **next revision** (a Git or registry package then diverges
 *   from its source, and its upstream updates always need review) or a
 *   **local variant**, a new package of its own that replaces the original in
 *   its setups and takes over the original's copies.
 * - **Merge** is a three-way merge per file (`merge.ts`) of the revision the
 *   copy was installed from (kept in the artifact cache), the local files and
 *   the configured revision. A clean merge, or one whose conflicts the user
 *   resolved, becomes the package's next revision.
 *
 * Both publish through the normal preview, approval and apply; apply checks
 * the machine still has exactly the bytes the preview was made from.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  CAPABILITY_LIMITS,
  type CapabilityComponent,
  type CapabilityDriftEntry,
  type CapabilityPackage,
  type PackageSource,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityChangeResult,
  CapabilityDriftAdoptionMode,
  CapabilityDriftMerge,
  CapabilityDriftMergeFile,
  CapabilityDriftMergeResolution,
  CapabilityInventory,
  CapabilitySourceInspection,
} from "@orkestrator/protocol/capability-resources-api";
import {
  canonicalCapabilityJson,
  capabilityInstallApproval,
} from "@orkestrator/protocol/capability-resources-resolve";
import { capabilityLocation } from "@orkestrator/protocol/capability-resources-support";
import { exportCapabilityNodeItemCommand } from "@orkestrator/protocol/contract/domains/capabilities";

import type { CapabilitiesStorage } from "../storage-capabilities.js";
import type { CapabilityArtifactStore } from "./artifact-store.js";
import {
  hasConflictMarkers,
  mergeTrees,
  type FileMergeOutcome,
  type MergeTreeFile,
} from "./merge.js";
import { locationDirectory, type CapabilityHomes } from "./native-ownership.js";
import type { CapabilityLink } from "./node-transport.js";
import { newCorrelationId, recordActivity, type CapabilityChange } from "./operations.js";
import { sha256 } from "./planning.js";
import {
  CapabilityError,
  readPackageTree,
  treeDigest,
  validatePackageFiles,
  type PackageFile,
} from "./security.js";
import { inspectFiles, type InspectedPackage } from "./source-inspection.js";
import type { CapabilityState, DriftAdoption, SourceInspectionRecord } from "./types.js";

/** Conflicted files larger than this are not sent to the editor. */
const MAX_CONFLICT_TEXT = 256 * 1024;
const MAX_MERGE_FILES = 500;

export interface CapabilityDriftContext {
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  homes(): CapabilityHomes;
  selfId(): Promise<string>;
  link(nodeId: string): CapabilityLink | null;
  now(): string;
  assertAuthority(): void;
  observeNode(nodeId: string): Promise<CapabilityInventory>;
  storeInspection(
    inspected: InspectedPackage,
    requestKey: string | undefined,
    adoption?: DriftAdoption,
  ): Promise<CapabilitySourceInspection>;
  previewChange(change: CapabilityChange, actor?: string): Promise<CapabilityChangeResult>;
  announce(change: { packageIds: string[]; setupIds: string[]; operationIds: string[] }): void;
  reconcileNode(nodeId: string, reason: string): void;
}

/** One component's local change on one machine, in package paths. */
interface LocalComponentChange {
  componentId: string;
  /** The component as the installed revision defines it. */
  component: CapabilityComponent;
  driftIds: string[];
  items: Array<{ locationId: string; componentId: string; digest?: string }>;
  /** The package artifact the machine's copy was installed from. */
  baseDigest: string;
  /** The local files; `null` when the copy was deleted. */
  files: PackageFile[] | null;
}

interface LocalChanges {
  drift: CapabilityDriftEntry;
  pkg: CapabilityPackage;
  changes: LocalComponentChange[];
}

function asText(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CAPABILITY_LIMITS.maxIdChars
  ) {
    throw new CapabilityError("invalid-request", `${name} is required.`);
  }
  return value;
}

function inComponent(filePath: string, component: CapabilityComponent): boolean {
  if (component.kind === "skill")
    return !component.pathOrKey || filePath.startsWith(`${component.pathOrKey}/`);
  return filePath === component.pathOrKey;
}

/** Replaces a component's files in a package tree (`null` removes them). */
function overlay(
  tree: readonly PackageFile[],
  component: CapabilityComponent,
  replacement: readonly PackageFile[] | null,
): PackageFile[] {
  return [...tree.filter((file) => !inComponent(file.path, component)), ...(replacement ?? [])];
}

function componentDefinition(
  state: CapabilityState,
  pkg: CapabilityPackage,
  artifactDigest: string,
  componentId: string,
): CapabilityComponent | undefined {
  if (pkg.artifactDigest === artifactDigest) return state.components[componentId];
  return (
    pkg.previousRevisions
      ?.find((revision) => revision.artifactDigest === artifactDigest)
      ?.components?.find((component) => component.id === componentId) ??
    state.components[componentId]
  );
}

function asTreeMap(files: readonly PackageFile[]): Map<string, MergeTreeFile> {
  return new Map(
    files.map((file) => [file.path, { content: file.content, executable: file.executable }]),
  );
}

function boundedText(content: Buffer | undefined): string | undefined {
  return content === undefined ? undefined : content.toString("utf8");
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "package"
  );
}

export class CapabilityDriftWorkflow {
  constructor(private readonly ctx: CapabilityDriftContext) {}

  // --- Reading installed items ---------------------------------------------

  /**
   * Inspects an installed item on a machine as a package, so it can be
   * adopted. An item on another machine is read through that machine's own
   * executor; no path crosses the link, only the item's opaque id.
   */
  async adoptExternal(args: Record<string, unknown>): Promise<CapabilitySourceInspection> {
    this.ctx.assertAuthority();
    const selfId = await this.ctx.selfId();
    const nodeId = typeof args.nodeId === "string" && args.nodeId ? args.nodeId : selfId;
    const itemId = asText(args.itemId, "itemId");
    const files = await this.readInventoryItem(nodeId, itemId);
    const source: PackageSource = { kind: "local", sourceMachineId: nodeId, sourceId: itemId };
    const location = capabilityLocation(itemId.split("/")[0] ?? "");
    const name = itemId.split("/").slice(1).join("/").replace(/\.md$/, "");
    const rooted =
      location?.layout === "file"
        ? files.map((file) => ({
            ...file,
            path: `${location.kind === "subagent" ? "agents" : location.kind === "prompt" ? "prompts" : "commands"}/${file.path}`,
          }))
        : files;
    const inspected = inspectFiles(source, rooted, { fallbackName: name });
    return this.ctx.storeInspection(
      inspected,
      typeof args.requestKey === "string" ? args.requestKey : undefined,
    );
  }

  async readInventoryItem(nodeId: string, itemId: string): Promise<PackageFile[]> {
    const selfId = await this.ctx.selfId();
    if (nodeId === selfId) return this.exportLocalItem(itemId);
    const link = this.ctx.link(nodeId);
    if (!link?.connected)
      throw new CapabilityError("source-unavailable", "That machine is not connected.");
    const state = await this.ctx.storage.capabilities.loadCapabilityState();
    const answer = (await link.invokeCommand(exportCapabilityNodeItemCommand, {
      controllerId: selfId,
      epoch: state.epoch,
      itemId,
    })) as { files?: unknown };
    return validatePackageFiles(
      (Array.isArray(answer?.files) ? answer.files : []).map((entry: unknown) => {
        const file = entry as { path?: unknown; data?: unknown; executable?: unknown };
        return {
          path: String(file.path ?? ""),
          content: Buffer.from(String(file.data ?? ""), "base64"),
          executable: file.executable === true,
        };
      }),
    );
  }

  /** This machine's files of one inventory item; the item id names a known location. */
  async exportLocalItem(itemId: string): Promise<PackageFile[]> {
    const slash = itemId.indexOf("/");
    const locationId = slash > 0 ? itemId.slice(0, slash) : "";
    const entry = slash > 0 ? itemId.slice(slash + 1) : "";
    const location = capabilityLocation(locationId);
    if (!location || !/^[A-Za-z0-9@][A-Za-z0-9@._+-]*$/.test(entry)) {
      throw new CapabilityError("invalid-request", "Not an inventory item.");
    }
    const directory = locationDirectory(locationId, this.ctx.homes());
    if (location.layout === "directory")
      return readPackageTree(path.join(directory, entry), { within: directory });
    const files = await readPackageTree(directory, { only: [entry] });
    if (files.length !== 1)
      throw new CapabilityError("not-found", "That item is no longer installed.");
    return files;
  }

  // --- Local changes on one machine ------------------------------------------

  /**
   * Every open local change to `drift`'s package on its machine, read back
   * from the machine and checked against the digest the drift recorded.
   */
  private async localChanges(state: CapabilityState, driftId: string): Promise<LocalChanges> {
    const drift = state.drift[driftId];
    const pkg = drift?.packageId ? state.packages[drift.packageId] : undefined;
    if (!drift || drift.state !== "open" || drift.kind === "unmanaged" || !pkg) {
      throw new CapabilityError(
        "unsupported",
        "Only an open local change to a managed package can be adopted or merged.",
      );
    }
    const entries = Object.values(state.drift).filter(
      (entry) =>
        entry.nodeId === drift.nodeId &&
        entry.packageId === pkg.id &&
        entry.state === "open" &&
        entry.kind !== "unmanaged" &&
        entry.componentId !== undefined,
    );
    if (entries.some((entry) => !capabilityLocation(entry.locationId))) {
      throw new CapabilityError(
        "unsupported",
        "Changes to an MCP server or plugin configuration cannot be adopted; keep or replace them.",
      );
    }
    const inventory = await this.ctx.observeNode(drift.nodeId);
    const byComponent = new Map<string, LocalComponentChange>();
    for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
      const componentId = entry.componentId!;
      const receipt = state.receipts[entry.id.slice("drift:".length)];
      const baseDigest = receipt?.packageDigest ?? pkg.artifactDigest;
      const component = componentDefinition(state, pkg, baseDigest, componentId);
      const location = capabilityLocation(entry.locationId)!;
      if (!component) {
        throw new CapabilityError("conflict", `${entry.name} is no longer part of the package.`);
      }
      let files: PackageFile[] | null = null;
      if (entry.kind === "modified") {
        const item = inventory.items.find(
          (candidate) =>
            candidate.locationId === entry.locationId &&
            candidate.componentId === componentId &&
            candidate.packageId === pkg.id &&
            candidate.digest === entry.observedDigest,
        );
        if (!item || !entry.observedDigest) {
          throw new CapabilityError(
            "conflict",
            `${entry.name} changed again. Refresh the machine's inventory before reviewing it.`,
          );
        }
        const read = await this.readInventoryItem(entry.nodeId, item.id);
        if (treeDigest(read) !== entry.observedDigest) {
          throw new CapabilityError("conflict", "The local files changed while they were read.");
        }
        const root = component.pathOrKey;
        files =
          location.layout === "directory"
            ? read.map((file) => ({ ...file, path: root ? `${root}/${file.path}` : file.path }))
            : read.slice(0, 1).map((file) => ({ ...file, path: root }));
      }
      const item = {
        locationId: entry.locationId,
        componentId,
        ...(entry.observedDigest ? { digest: entry.observedDigest } : {}),
      };
      const existing = byComponent.get(componentId);
      if (existing) {
        const same =
          existing.files === null
            ? files === null
            : files !== null && treeDigest(existing.files) === treeDigest(files);
        if (!same) {
          throw new CapabilityError(
            "conflict",
            `The copies of ${entry.name} on this machine differ from each other. Keep or replace one of them first.`,
          );
        }
        existing.driftIds.push(entry.id);
        existing.items.push(item);
        continue;
      }
      byComponent.set(componentId, {
        componentId,
        component,
        driftIds: [entry.id],
        items: [item],
        baseDigest,
        files,
      });
    }
    return { drift, pkg, changes: [...byComponent.values()] };
  }

  /** The setup a new revision of `pkg` is published through. */
  private publishingSetup(state: CapabilityState, pkg: CapabilityPackage, latestOnly: boolean) {
    const setup = Object.values(state.setups).find((entry) =>
      entry.packageSelections.some(
        ({ packageId, version }) => packageId === pkg.id && (!latestOnly || version === "latest"),
      ),
    );
    if (!setup || (latestOnly && (pkg.pinned || pkg.paused))) {
      throw new CapabilityError(
        "conflict",
        latestOnly
          ? "The package must be active and selected at its latest revision before publishing local changes as its next revision."
          : "The package is not in any setup.",
      );
    }
    return setup;
  }

  private adoptionRecord(
    local: LocalChanges,
    mode: CapabilityDriftAdoptionMode,
    merged: boolean,
  ): DriftAdoption {
    return {
      driftId: local.drift.id,
      digest: local.drift.observedDigest ?? "",
      nodeId: local.drift.nodeId,
      driftIds: local.changes.flatMap((change) => change.driftIds),
      items: local.changes.flatMap((change) => change.items),
      mode,
      ...(merged ? { merged: true } : {}),
      fromPackageId: local.pkg.id,
    };
  }

  /** Inspects `tree` as the package's next revision; the changed components must keep their identity. */
  private inspectRevision(local: LocalChanges, tree: PackageFile[]): InspectedPackage {
    if (tree.length === 0) {
      throw new CapabilityError(
        "conflict",
        "Nothing would be left of the package; remove it from its setups instead.",
      );
    }
    const inspected = inspectFiles(local.pkg.source, tree, { fallbackName: local.pkg.displayName });
    for (const change of local.changes) {
      if (change.files && !inspected.components.some(({ id }) => id === change.componentId)) {
        throw new CapabilityError(
          "conflict",
          `The local files change what ${change.component.name} is. Adopt them as a separate package instead.`,
        );
      }
    }
    return inspected;
  }

  /**
   * Prepares adopting the local changes behind `driftId` as `mode`
   * (default: the next revision for an authored package, a local variant
   * for anything with an outside source).
   */
  async prepareAdoption(driftId: string, requestedMode?: unknown): Promise<CapabilityChange> {
    if (
      requestedMode !== undefined &&
      requestedMode !== "revision" &&
      requestedMode !== "variant"
    ) {
      throw new CapabilityError("invalid-request", "Choose a revision or a separate package.");
    }
    const state = await this.ctx.storage.capabilities.loadCapabilityState();
    const local = await this.localChanges(state, driftId);
    const { pkg } = local;
    const mode: CapabilityDriftAdoptionMode =
      requestedMode ?? (pkg.source.kind === "managed" ? "revision" : "variant");
    const setup = this.publishingSetup(state, pkg, mode === "revision");
    let tree = await this.ctx.artifacts.get(pkg.artifactDigest);
    for (const change of local.changes) tree = overlay(tree, change.component, change.files);
    const adoption = this.adoptionRecord(local, mode, false);
    if (mode === "revision") {
      const result = await this.ctx.storeInspection(
        this.inspectRevision(local, tree),
        undefined,
        adoption,
      );
      return {
        kind: "add-to-setup",
        inspectionId: result.inspectionId,
        expectedArtifactDigest: pkg.artifactDigest,
        setupId: setup.id,
      };
    }
    if (tree.length === 0) {
      throw new CapabilityError("conflict", "Nothing would be left of the package.");
    }
    const source: PackageSource = {
      kind: "managed",
      managedId: `${slug(pkg.displayName)}-local-${randomBytes(4).toString("hex")}`,
    };
    const inspected = inspectFiles(source, tree, { fallbackName: pkg.displayName });
    const result = await this.ctx.storeInspection(
      { ...inspected, displayName: `${pkg.displayName} (local)` },
      undefined,
      adoption,
    );
    return { kind: "add-to-setup", inspectionId: result.inspectionId, setupId: setup.id };
  }

  /** What the preview says about publishing local changes. */
  adoptionReasons(state: CapabilityState, inspection: SourceInspectionRecord): string[] {
    const adoption = inspection.adoption;
    if (!adoption) return [];
    const from = adoption.fromPackageId ? state.packages[adoption.fromPackageId] : undefined;
    const reasons =
      adoption.mode === "variant"
        ? [
            `Publish the local files as a separate package that replaces ${from?.displayName ?? "the original"} in its setups.`,
          ]
        : adoption.merged
          ? [
              "Publish the merge of the local changes and the configured revision as the package's new revision.",
            ]
          : ["Adopt the observed local files as the package's new revision."];
    if (adoption.mode !== "variant" && inspection.source.kind !== "managed") {
      reasons.push(
        "The package will diverge from its source: upstream updates will need review, and taking one replaces these changes.",
      );
    }
    return [...reasons, ...capabilityInstallApproval(inspection.components).reasons];
  }

  /** Apply-time check: the machine still has exactly the bytes the preview was made from. */
  async assertAdoptionCurrent(state: CapabilityState, change: CapabilityChange): Promise<void> {
    if (change.kind !== "add-to-setup") return;
    const adoption = state.inspections[change.inspectionId]?.adoption;
    if (!adoption) return;
    const drift = state.drift[adoption.driftId];
    const nodeId = adoption.nodeId ?? drift?.nodeId;
    const packageId = adoption.fromPackageId ?? drift?.packageId;
    const inventory = nodeId ? await this.ctx.observeNode(nodeId) : undefined;
    const items =
      adoption.items ??
      (drift?.componentId
        ? [
            {
              locationId: drift.locationId,
              componentId: drift.componentId,
              digest: adoption.digest,
            },
          ]
        : []);
    const current =
      drift !== undefined &&
      inventory !== undefined &&
      items.every((expected) => {
        const found = inventory.items.find(
          (item) =>
            item.locationId === expected.locationId &&
            item.componentId === expected.componentId &&
            item.packageId === packageId,
        );
        return expected.digest ? found?.digest === expected.digest : found === undefined;
      });
    if (!current) {
      throw new CapabilityError(
        "conflict",
        "The local files no longer match the adoption preview.",
      );
    }
  }

  // --- Keep and replace --------------------------------------------------------

  async resolveDrift(args: Record<string, unknown>, actor?: string) {
    this.ctx.assertAuthority();
    const driftId = asText(args.driftId, "driftId");
    const decision = args.decision;
    if (decision === "adopt") {
      throw new CapabilityError(
        "approval-required",
        "Preview and approve the local revision before adopting it.",
      );
    }
    if (decision !== "keep-local" && decision !== "replace") {
      throw new CapabilityError("invalid-request", "Choose keep or replace.");
    }
    const entry = this.ctx.storage.capabilities.mutateCapabilityState((state) => {
      const drift = state.drift[driftId];
      if (!drift)
        throw new CapabilityError("not-found", "That local change is no longer reported.");
      drift.state = decision === "keep-local" ? "kept-local" : "replaced";
      recordActivity(state, {
        ...(actor ? { actor } : {}),
        action: `drift-${decision}`,
        summary: `${drift.name} on ${drift.nodeId}: ${decision === "keep-local" ? "kept the local version" : "replaced with the configured revision"}.`,
        packageIds: drift.packageId ? [drift.packageId] : [],
        setupIds: [],
        correlationId: newCorrelationId(),
      });
      return { result: structuredClone(drift), changed: true };
    });
    this.ctx.announce({
      packageIds: entry.packageId ? [entry.packageId] : [],
      setupIds: [],
      operationIds: [],
    });
    if (decision === "replace") this.ctx.reconcileNode(entry.nodeId, "drift-replace");
    return entry;
  }

  // --- Merge -------------------------------------------------------------------

  /**
   * Three-way merges the package's local changes on the drift's machine with
   * its configured revision. Without `resolutions` it reports what merged and
   * what conflicts; with them (for the `basis` the conflicts were shown for)
   * it applies the user's resolved files. When nothing is left unresolved the
   * result is inspected like any source and previewed as the package's next
   * revision.
   */
  async merge(args: Record<string, unknown>, actor?: string): Promise<CapabilityDriftMerge> {
    this.ctx.assertAuthority();
    const driftId = asText(args.driftId, "driftId");
    const resolutions = parseResolutions(args.resolutions);
    const state = await this.ctx.storage.capabilities.loadCapabilityState();
    const local = await this.localChanges(state, driftId);
    const { pkg } = local;
    const setup = this.publishingSetup(state, pkg, true);
    const basis = sha256(
      canonicalCapabilityJson({
        configured: pkg.artifactDigest,
        changes: local.changes.map((change) => [
          change.componentId,
          change.baseDigest,
          change.items,
        ]),
      }),
    );
    if (resolutions && args.basis !== basis) {
      throw new CapabilityError(
        "conflict",
        "The local files or the package changed since the merge was shown. Review the merge again.",
      );
    }
    const configured = await this.ctx.artifacts.get(pkg.artifactDigest);
    let tree: PackageFile[] = configured;
    const files: CapabilityDriftMergeFile[] = [];
    const unmergeable: string[] = [];
    let conflicts = 0;
    let baseRevision = pkg.revision;
    const used = new Set<string>();
    for (const change of local.changes) {
      const baseArtifact = await this.ctx.artifacts.get(change.baseDigest).catch(() => null);
      if (!baseArtifact) {
        throw new CapabilityError(
          "conflict",
          `The revision ${change.component.name} was installed from is no longer cached, so it cannot be merged. Keep, adopt or replace it instead.`,
        );
      }
      baseRevision =
        pkg.previousRevisions?.find((revision) => revision.artifactDigest === change.baseDigest)
          ?.revision ?? baseRevision;
      const current = state.components[change.componentId] ?? change.component;
      const base = baseArtifact.filter((file) => inComponent(file.path, change.component));
      const theirs = pkg.componentIds.includes(change.componentId)
        ? configured.filter((file) => inComponent(file.path, current))
        : [];
      const outcomes = mergeTrees(
        asTreeMap(base),
        asTreeMap(change.files ?? []),
        asTreeMap(theirs),
      );
      const merged: Array<{ path: string; content: Buffer; executable: boolean }> = [];
      for (const outcome of outcomes) {
        const resolved = this.resolveOutcome(outcome, resolutions, used);
        if (resolved.file) merged.push({ path: outcome.path, ...resolved.file });
        if (resolved.unmergeable) unmergeable.push(outcome.path);
        if (resolved.open) conflicts += 1;
        if (outcome.outcome !== "unchanged" && files.length < MAX_MERGE_FILES)
          files.push(describeOutcome(outcome, change.componentId, resolved));
      }
      tree = overlay(tree, current, validatePackageFiles(merged));
    }
    if (resolutions) {
      const unknown = resolutions.find((entry) => !used.has(entry.path));
      if (unknown) {
        throw new CapabilityError("invalid-request", `${unknown.path} has no conflict to resolve.`);
      }
    }
    const result: CapabilityDriftMerge = {
      driftId,
      nodeId: local.drift.nodeId,
      packageId: pkg.id,
      displayName: pkg.displayName,
      baseRevision,
      configuredRevision: pkg.revision,
      basis,
      files,
      conflicts,
      unmergeable,
    };
    if (conflicts > 0 || unmergeable.length > 0) return result;
    const inspection = await this.ctx.storeInspection(
      this.inspectRevision(local, tree),
      undefined,
      this.adoptionRecord(local, "revision", true),
    );
    const preview = await this.ctx.previewChange(
      {
        kind: "add-to-setup",
        inspectionId: inspection.inspectionId,
        expectedArtifactDigest: pkg.artifactDigest,
        setupId: setup.id,
      },
      actor,
    );
    return { ...result, operation: preview.operation };
  }

  private resolveOutcome(
    outcome: FileMergeOutcome,
    resolutions: CapabilityDriftMergeResolution[] | null,
    used: Set<string>,
  ): { file?: MergeTreeFile; open?: boolean; unmergeable?: boolean } {
    if (outcome.outcome === "deleted") return {};
    if (outcome.outcome !== "conflict") return { file: outcome.file };
    const tooLarge = [outcome.base, outcome.ours, outcome.theirs].some(
      (content) => content !== undefined && content.length > MAX_CONFLICT_TEXT,
    );
    if (outcome.kind === "binary" || tooLarge) return { unmergeable: true };
    const resolution = resolutions?.find((entry) => entry.path === outcome.path);
    if (!resolution) return { open: true };
    used.add(outcome.path);
    if (resolution.delete) return {};
    const content = resolution.content ?? "";
    if (hasConflictMarkers(content)) {
      throw new CapabilityError(
        "invalid-request",
        `${outcome.path} still has conflict markers; resolve every conflict first.`,
      );
    }
    return { file: { content: Buffer.from(content, "utf8"), executable: outcome.executable } };
  }
}

function parseResolutions(value: unknown): CapabilityDriftMergeResolution[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > MAX_MERGE_FILES) {
    throw new CapabilityError("invalid-request", "resolutions must be a list.");
  }
  return value.map((entry: unknown) => {
    const record = entry as Record<string, unknown> | null;
    const filePath = record?.path;
    if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > 1024) {
      throw new CapabilityError("invalid-request", "Each resolution names a file.");
    }
    if (record?.delete === true) return { path: filePath, delete: true };
    if (typeof record?.content !== "string" || record.content.length > MAX_CONFLICT_TEXT * 4) {
      throw new CapabilityError(
        "invalid-request",
        `The resolution of ${filePath} is not valid text.`,
      );
    }
    return { path: filePath, content: record.content };
  });
}

/** Line of each conflict's `<<<<<<<` marker in the marked-up text (1-based). */
function conflictHunks(outcome: Extract<FileMergeOutcome, { outcome: "conflict" }>) {
  const hunks: Array<{ line: number; base: string; local: string; configured: string }> = [];
  let line = 1;
  for (const chunk of outcome.chunks ?? []) {
    if (chunk.kind === "stable") {
      line += chunk.lines.length;
      continue;
    }
    hunks.push({
      line,
      base: chunk.base.join(""),
      local: chunk.ours.join(""),
      configured: chunk.theirs.join(""),
    });
    line += 4 + chunk.base.length + chunk.ours.length + chunk.theirs.length;
  }
  return hunks;
}

function describeOutcome(
  outcome: FileMergeOutcome,
  componentId: string,
  resolved: { file?: MergeTreeFile; open?: boolean; unmergeable?: boolean },
): CapabilityDriftMergeFile {
  if (outcome.outcome !== "conflict")
    return { path: outcome.path, componentId, outcome: outcome.outcome };
  if (!resolved.open && !resolved.unmergeable) {
    return { path: outcome.path, componentId, outcome: resolved.file ? "merged" : "deleted" };
  }
  if (resolved.unmergeable) {
    const tooLarge = outcome.kind !== "binary";
    return {
      path: outcome.path,
      componentId,
      outcome: "conflict",
      conflict: { kind: tooLarge ? "too-large" : "binary" },
    };
  }
  const base = boundedText(outcome.base);
  const local = boundedText(outcome.ours);
  const configured = boundedText(outcome.theirs);
  return {
    path: outcome.path,
    componentId,
    outcome: "conflict",
    conflict: {
      kind: outcome.kind,
      ...(base !== undefined ? { base } : {}),
      ...(local !== undefined ? { local } : {}),
      ...(configured !== undefined ? { configured } : {}),
      ...(outcome.merged !== undefined ? { merged: outcome.merged } : {}),
      ...(outcome.kind === "text" ? { hunks: conflictHunks(outcome) } : {}),
    },
  };
}
