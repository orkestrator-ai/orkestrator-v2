/**
 * Exporting and importing setups for `CapabilityService`
 * (docs/architecture/agent-capabilities-management.md, "Sharing setups"). The
 * manifest and lockfile formats, and the pure planning over the store, are
 * `import-export.ts`; signatures are `manifest-signing.ts`. This module runs
 * them against the store, the artifact cache and the package sources.
 */
import { randomBytes } from "node:crypto";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { MY_SETUP_ID } from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityExport,
  CapabilityImportPreview,
  CapabilitySetupList,
} from "@orkestrator/protocol/capability-resources-api";
import {
  canonicalCapabilityJson,
  capabilityInstallApproval,
} from "@orkestrator/protocol/capability-resources-resolve";

import { assertCapabilitySourceAllowed } from "./admin-policy.js";
import {
  addImportedPackages,
  exportSetups,
  importedSelections,
  isRevisionKept,
  parseManifests,
  planImport,
  readProjectManifests,
  setupSlug,
  writeProjectManifests,
} from "./import-export.js";
import type { CapabilityLibraryReads } from "./library-reads.js";
import {
  isTrustedManifestSigner,
  manifestSignatureIssues,
  verifyCapabilityLockSignature,
  type ManifestSigningKeys,
} from "./manifest-signing.js";
import { newCorrelationId, recordActivity } from "./operations.js";
import { sha256 } from "./planning.js";
import { inspectRegistrySource } from "./registry.js";
import { CapabilityError } from "./security.js";
import { asText, stringList } from "./service-args.js";
import type { CapabilityServiceContext } from "./service-context.js";
import { inspectFiles, inspectGitSource, type InspectedPackage } from "./source-inspection.js";
import type { CapabilityState } from "./types.js";

type ParsedLock = NonNullable<ReturnType<typeof parseManifests>["lock"]>;
type ParsedIntent = NonNullable<ReturnType<typeof parseManifests>["intent"]>;

export class CapabilityImportCommands {
  constructor(
    private readonly ctx: CapabilityServiceContext,
    private readonly reads: CapabilityLibraryReads,
  ) {}

  async exportSetup(args: Record<string, unknown>): Promise<CapabilityExport> {
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const setupIds = stringList(args.setupIds, 64);
    let signingKey: ReturnType<ManifestSigningKeys["installationKey"]> = null;
    if (args.sign === true) {
      signingKey = this.ctx.deps.signing?.installationKey(true) ?? null;
      if (!signingKey)
        throw new CapabilityError("unsupported", "This backend has no manifest signing key.");
    }
    const exported = exportSetups(
      state,
      setupIds.length > 0 ? setupIds : [MY_SETUP_ID],
      signingKey ? { signingKey } : {},
    );
    let written = false;
    if (args.write === true) {
      this.ctx.assertAuthority();
      const projectId = asText(args.projectId, "projectId");
      const project = await this.ctx.deps.storage.getProject?.(projectId);
      if (!project?.localPath)
        throw new CapabilityError(
          "not-found",
          "The project has no local checkout on this machine.",
        );
      await writeProjectManifests(project.localPath, exported);
      written = true;
    }
    return {
      intentFile: "orkestrator.capabilities.yaml",
      intent: exported.intentText,
      lockFile: "orkestrator.capabilities.lock.json",
      lock: exported.lockText,
      ...(written ? { written } : {}),
      formatVersion: exported.formatVersion,
      ...(exported.signed ? { signed: exported.signed } : {}),
    };
  }

  async previewImport(args: Record<string, unknown>): Promise<CapabilityImportPreview> {
    this.ctx.assertAuthority();
    let intentText: string;
    let lockText: string;
    const projectId = typeof args.projectId === "string" ? args.projectId : undefined;
    if (typeof args.intent === "string" && typeof args.lock === "string") {
      intentText = args.intent;
      lockText = args.lock;
    } else if (projectId) {
      const project = await this.ctx.deps.storage.getProject?.(projectId);
      if (!project?.localPath)
        throw new CapabilityError(
          "not-found",
          "The project has no local checkout on this machine.",
        );
      ({ intent: intentText, lock: lockText } = await readProjectManifests(project.localPath));
    } else {
      throw new CapabilityError(
        "invalid-request",
        "Provide the manifest and lockfile, or a project.",
      );
    }
    const parsed = parseManifests(intentText, lockText);
    const previewId = `imp_${randomBytes(8).toString("hex")}`;
    if (!parsed.intent || !parsed.lock) {
      return {
        previewId,
        issues: parsed.issues,
        setups: [],
        packages: [],
        approvalReasons: [],
        valid: false,
      };
    }
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const plan = planImport(state, parsed.intent, parsed.lock);
    const approvalReasons: string[] = [];
    // An invalid signature, or (by policy) an unsigned or untrusted one, blocks before any fetch.
    const requireSignedManifests = state.settings.requireSignedManifests === true;
    const signature = verifyCapabilityLockSignature(
      parsed.lock,
      parsed.signedPayload,
      parsed.intent,
      this.ctx.deps.signing,
    );
    const issues = [
      ...parsed.issues,
      ...manifestSignatureIssues(signature, requireSignedManifests),
    ];
    if (issues.length === 0 && plan.packages.every((entry) => entry.action !== "conflict")) {
      for (const entry of parsed.lock.packages) {
        try {
          const inspected = await this.inspectLockedArtifact(entry);
          approvalReasons.push(...capabilityInstallApproval(inspected.components).reasons);
          await this.ctx.artifacts.put(inspected.files);
        } catch (error) {
          if (!(error instanceof CapabilityError)) throw error;
          issues.push({ path: "packages", message: error.message });
        }
      }
    }
    const valid =
      issues.length === 0 && plan.packages.every((entry) => entry.action !== "conflict");
    if (valid) {
      this.ctx.deps.storage.capabilities.mutateCapabilityState((current) => {
        current.imports[previewId] = {
          id: previewId,
          digest: importBasis(state, parsed.lock!, projectId),
          verified: true,
          intent: parsed.intent,
          lock: parsed.lock,
          signatureStatus: signature.status,
          ...(projectId ? { projectId } : {}),
          createdAt: this.ctx.now(),
        };
        return { result: undefined, changed: true };
      });
    }
    return {
      previewId,
      issues,
      ...plan,
      approvalReasons: [...new Set(approvalReasons)],
      signature,
      requireSignedManifests,
      valid,
    };
  }

  private async inspectLockedArtifact(
    entry: ParsedLock["packages"][number],
    cachedOnly = false,
  ): Promise<InspectedPackage> {
    let inspected: InspectedPackage;
    if (entry.source.kind === "provider-marketplace") {
      throw new CapabilityError(
        "unsupported",
        "Marketplace plugin imports require verified immutable content.",
      );
    }
    if (await this.ctx.artifacts.has(entry.artifactDigest)) {
      inspected = inspectFiles(entry.source, await this.ctx.artifacts.get(entry.artifactDigest), {
        revision: entry.revision,
      });
    } else if (!cachedOnly && entry.source.kind === "git") {
      assertCapabilitySourceAllowed(
        await this.ctx.deps.storage.capabilities.loadCapabilityState(),
        entry.id,
      );
      inspected = await inspectGitSource(
        { ...entry.source, channel: entry.revision },
        {
          workRoot: this.ctx.deps.dataDir,
          ...(this.ctx.deps.gitRun ? { run: this.ctx.deps.gitRun } : {}),
        },
      );
      // The immutable fetch ref is distinct from the package's update channel.
      inspected.source = entry.source;
    } else if (!cachedOnly && entry.source.kind === "registry") {
      // The locked registry version, from a registry configured under the same id.
      inspected = await inspectRegistrySource(
        entry.source,
        this.ctx.registries.context(await this.ctx.deps.storage.capabilities.loadCapabilityState()),
        entry.revision,
      );
    } else {
      throw new CapabilityError(
        "source-unavailable",
        "A locked artifact is unavailable on this machine.",
      );
    }
    if (inspected.secretsFound.length > 0) {
      throw new CapabilityError("secrets-detected", "A locked artifact contains a credential.");
    }
    if (
      inspected.artifactDigest !== entry.artifactDigest ||
      inspected.revision !== entry.revision
    ) {
      throw new CapabilityError(
        "unsafe-content",
        "A locked artifact does not match the approved revision and digest.",
      );
    }
    const componentInventory = (components: typeof entry.components) =>
      components.map(({ id, kind, pathOrKey }) => JSON.stringify([id, kind, pathOrKey])).sort();
    if (
      canonicalCapabilityJson(componentInventory(inspected.components)) !==
      canonicalCapabilityJson(componentInventory(entry.components))
    ) {
      throw new CapabilityError(
        "unsafe-content",
        "The lockfile component inventory differs from the inspected artifact.",
      );
    }
    return inspected;
  }

  async importSetup(args: Record<string, unknown>, actor?: string): Promise<CapabilitySetupList> {
    this.ctx.assertAuthority();
    const previewId = asText(args.previewId, "previewId");
    await this.completeImport(previewId, actor);
    void this.ctx.reconciler.reconcileAll("import");
    return this.reads.listSetups();
  }

  /**
   * Fetches every locked package not already in the library at its exact
   * revision, checks the digest against the lockfile, then creates or
   * updates the setups. A digest mismatch fails the whole import; nothing is
   * half-created.
   */
  async completeImport(previewId: string, actor?: string): Promise<void> {
    const commit = await this.prepareImport(previewId, actor);
    this.ctx.deps.storage.capabilities.mutateCapabilityState((current) => {
      this.ctx.assertAuthority();
      commit(current);
      return { result: undefined, changed: true };
    });
  }

  async prepareImport(
    previewId: string,
    actor?: string,
  ): Promise<(state: CapabilityState) => void> {
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const record = state.imports[previewId];
    if (!record?.verified)
      throw new CapabilityError(
        "conflict",
        "The import preview expired or is invalid; preview it again.",
      );
    const intent = record.intent as ParsedIntent;
    const lock = record.lock as ParsedLock;
    const trusted = () =>
      record.signatureStatus === "trusted" &&
      !!lock.signature &&
      isTrustedManifestSigner(lock.signature, this.ctx.deps.signing);
    if (state.settings.requireSignedManifests === true && !trusted()) {
      throw new CapabilityError(
        "approval-required",
        "This installation now requires manifests signed by a trusted key; preview the import again.",
      );
    }
    const fetched: InspectedPackage[] = [];
    for (const entry of lock.packages) {
      if (!isRevisionKept(state, entry)) {
        fetched.push(await this.inspectLockedArtifact(entry, true));
      }
    }
    return (current) => {
      if (
        current.imports[previewId]?.digest !== record.digest ||
        importBasis(current, lock, record.projectId) !== record.digest ||
        planImport(current, intent, lock).packages.some((entry) => entry.action === "conflict")
      ) {
        throw new CapabilityError(
          "conflict",
          "The library changed after this preview; review the import again.",
        );
      }
      if (current.settings.requireSignedManifests === true && !trusted()) {
        throw new CapabilityError(
          "approval-required",
          "This installation now requires manifests signed by a trusted key; preview the import again.",
        );
      }
      for (const entry of lock.packages) assertCapabilitySourceAllowed(current, entry.id);
      const now = this.ctx.now();
      // A package locked at several revisions keeps each one, so every setup's pin resolves.
      addImportedPackages(current, fetched, record.projectId ? "project" : "managed", now);
      const bySlug = record.projectId
        ? new Map(
            Object.keys(intent.setups).map((slug) => [
              slug,
              `project-toolkit-${sha256(`${record.projectId}\0${slug}`).slice(-32)}`,
            ]),
          )
        : new Map(
            Object.values(current.setups)
              .filter((setup) => !setup.id.startsWith("project-toolkit-"))
              .map((setup) => [setupSlug(setup), setup.id]),
          );
      for (const [slug, setupIntent] of Object.entries(intent.setups)) {
        const id =
          bySlug.get(slug) ?? (slug === MY_SETUP_ID ? MY_SETUP_ID : `toolkit-${slug}`.slice(0, 64));
        const existing = current.setups[id];
        const selections = importedSelections(setupIntent, lock.setups[slug], lock);
        current.setups[id] = {
          id,
          name:
            existing?.name ??
            slug.replace(/-/g, " ").replace(/^./, (letter) => letter.toUpperCase()),
          ...(setupIntent.description ? { description: setupIntent.description } : {}),
          ...(existing?.builtIn ? { builtIn: true } : {}),
          revision: (existing?.revision ?? 0) + 1,
          packageSelections: selections,
          providerSelectors: (setupIntent.providers ?? []).map(
            (provider: AgentPlatform) => `provider:${provider}`,
          ),
          machineSelectors: (setupIntent.machines ?? []).map((machine: string) =>
            machine === "*" ? "*" : `group:${machine}`,
          ),
          ...(record.projectId ? { targetSelectors: [`project:${record.projectId}`] } : {}),
          exclusions: setupIntent.exclusions ?? [],
          parentSetupIds: (setupIntent.parents ?? [])
            .map((parent: string) => bySlug.get(parent) ?? `toolkit-${parent}`)
            .filter((parent: string) => parent !== id),
          updatePolicy: setupIntent.updatePolicy ?? "approve",
          updatedAt: now,
          ...(actor ? { updatedBy: actor } : {}),
        };
        if (record.projectId) {
          const assignmentId = `project:${record.projectId}`;
          const assignment = current.assignments[assignmentId];
          current.assignments[assignmentId] = {
            id: assignmentId,
            scope: "project",
            scopeId: record.projectId,
            setupIds: [...new Set([...(assignment?.setupIds ?? []), id])].slice(0, 16),
            revision: (assignment?.revision ?? 0) + 1,
            updatedAt: now,
          };
        }
      }
      delete current.imports[previewId];
      recordActivity(current, {
        ...(actor ? { actor } : {}),
        action: "import",
        summary: `Imported ${Object.keys(intent.setups).length} setup(s) and ${fetched.length} package(s).`,
        packageIds: fetched.map((entry) => entry.packageId),
        setupIds: [],
        correlationId: newCorrelationId(),
      });
    };
  }
}

/** What an import preview was made against: the locked packages, the setups, the project's assignment. */
function importBasis(state: CapabilityState, lock: ParsedLock, projectId?: string) {
  return sha256(
    canonicalCapabilityJson({
      packages: lock.packages.map((entry) => state.packages[entry.id] ?? null),
      setups: state.setups,
      assignment: projectId ? (state.assignments[`project:${projectId}`] ?? null) : null,
    }),
  );
}
