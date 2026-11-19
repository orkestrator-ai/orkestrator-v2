/**
 * Inspecting a source and authoring a package for `CapabilityService`
 * (docs/architecture/agent-capabilities-management.md, "Adding a package").
 * An inspection caches the package's bytes and records what it holds; adding
 * it to a setup is a separate previewed change (`change-commands.ts`).
 * Adopting an installed item is `drift.ts`, which stores its result here.
 */
import { createHash, randomBytes } from "node:crypto";

import {
  capabilityPackageId,
  isPackageSource,
  type PackageSource,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilitySourceInspection } from "@orkestrator/protocol/capability-resources-api";
import {
  capabilityInstallApproval,
  compatibleProviders,
} from "@orkestrator/protocol/capability-resources-resolve";
import { baselineCapabilitySupport } from "@orkestrator/protocol/capability-resources-support";

import { assertCapabilitySourceAllowed } from "./admin-policy.js";
import { authoredFiles, parseAuthoredInput } from "./authoring.js";
import { inspectRegistrySource } from "./registry.js";
import { CapabilityError, treeDigest, type PackageFile } from "./security.js";
import { asRecord, requestKeyOf } from "./service-args.js";
import type { CapabilityServiceContext } from "./service-context.js";
import {
  inspectFiles,
  inspectGitSource,
  newInspectionId,
  type InspectedPackage,
} from "./source-inspection.js";
import type { DriftAdoption, SourceInspectionRecord } from "./types.js";

/** How long an inspection can wait to be added to a setup. */
export const INSPECTION_TTL_MS = 60 * 60_000;

export class CapabilityInspectionCommands {
  constructor(private readonly ctx: CapabilityServiceContext) {}

  /** Caches an inspected package's bytes and records the inspection for a later preview. */
  async store(
    inspected: InspectedPackage,
    requestKey: string | undefined,
    adoption?: DriftAdoption,
  ): Promise<CapabilitySourceInspection> {
    if (inspected.secretsFound.length > 0) {
      throw new CapabilityError(
        "secrets-detected",
        `Remove the detected credential (${inspected.secretsFound.join(", ")}) before inspecting this package.`,
      );
    }
    await this.ctx.artifacts.put(inspected.files);
    const id = newInspectionId();
    const now = this.ctx.now();
    const record: SourceInspectionRecord = {
      id,
      ...(requestKey ? { requestKey } : {}),
      ...(adoption ? { adoption } : {}),
      source: inspected.source,
      packageId: inspected.packageId,
      displayName: inspected.displayName,
      ...(inspected.description ? { description: inspected.description } : {}),
      revision: inspected.revision,
      artifactDigest: inspected.artifactDigest,
      ...(inspected.publisher ? { publisher: inspected.publisher } : {}),
      components: inspected.components,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + INSPECTION_TTL_MS).toISOString(),
    };
    const existing = this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
      state.inspections[id] = record;
      const artifact = (state.artifacts[inspected.artifactDigest] ??= {
        digest: inspected.artifactDigest,
        bytes: inspected.files.reduce((total, file) => total + file.bytes, 0),
        files: inspected.files.map((file) => ({
          path: file.path,
          bytes: file.bytes,
          executable: file.executable,
          sha256: file.sha256,
        })),
        refs: [],
        createdAt: now,
      });
      artifact.refs = [...new Set([...artifact.refs, `inspection:${id}`])].slice(-64);
      const pkg = state.packages[inspected.packageId];
      return {
        result: pkg ? { revision: pkg.revision, artifactDigest: pkg.artifactDigest } : undefined,
        changed: true,
      };
    });
    const matrices = baselineCapabilitySupport();
    const compatible = compatibleProviders(inspected.components, matrices);
    const unsupported: CapabilitySourceInspection["unsupported"] = [];
    for (const matrix of matrices) {
      for (const component of inspected.components) {
        if (
          component.providerHints.length > 0 &&
          !component.providerHints.includes(matrix.provider)
        )
          continue;
        const support = matrix.kinds[component.kind].install;
        if (support.level === "unsupported") {
          unsupported.push({
            provider: matrix.provider,
            componentId: component.id,
            reason: support.reason ?? "Not supported.",
          });
        }
      }
    }
    const warnings = [...inspected.warnings];
    for (const component of inspected.components) {
      if (component.requirements.os?.length)
        warnings.push(`${component.name} runs only on ${component.requirements.os.join(", ")}.`);
      if (component.requirements.binaries?.length) {
        warnings.push(
          `${component.name} needs ${component.requirements.binaries.join(", ")} installed on each machine.`,
        );
      }
      if (component.requirements.envRefs?.length) {
        warnings.push(
          `${component.name} needs ${component.requirements.envRefs.join(", ")} set on each machine; credentials are never copied.`,
        );
      }
    }
    return {
      inspectionId: id,
      expiresAt: record.expiresAt,
      source: inspected.source,
      packageId: inspected.packageId,
      displayName: inspected.displayName,
      ...(inspected.description ? { description: inspected.description } : {}),
      revision: inspected.revision,
      artifactDigest: inspected.artifactDigest,
      risk: inspected.risk,
      ...(inspected.publisher ? { publisher: inspected.publisher } : {}),
      components: inspected.components,
      files: inspected.files
        .slice(0, 500)
        .map((file) => ({ path: file.path, bytes: file.bytes, executable: file.executable })),
      totalBytes: inspected.files.reduce((total, file) => total + file.bytes, 0),
      compatibleProviders: compatible,
      unsupported,
      approvalReasons: capabilityInstallApproval(inspected.components).reasons,
      warnings: [...new Set(warnings)],
      secretsFound: inspected.secretsFound,
      ...(existing ? { existing } : {}),
    };
  }

  async inspectSource(args: Record<string, unknown>): Promise<CapabilitySourceInspection> {
    this.ctx.assertAuthority();
    const requestKey = requestKeyOf(args.requestKey);
    if (args.localItem !== undefined) {
      const item = asRecord(args.localItem, "localItem");
      return this.ctx.drift.adoptExternal({
        nodeId: item.nodeId,
        itemId: item.itemId,
        requestKey,
      });
    }
    const source = args.source;
    if (!isPackageSource(source))
      throw new CapabilityError("invalid-request", "Not a valid package source.");
    switch (source.kind) {
      case "git":
        assertCapabilitySourceAllowed(
          await this.ctx.deps.storage.capabilities.loadCapabilityState(),
          capabilityPackageId(source),
        );
        return this.store(
          await inspectGitSource(source, {
            workRoot: this.ctx.deps.dataDir,
            ...(this.ctx.deps.gitRun ? { run: this.ctx.deps.gitRun } : {}),
          }),
          requestKey,
        );
      case "provider-marketplace": {
        if (source.provider !== "claude") {
          throw new CapabilityError(
            "unsupported",
            `${source.provider} plugins are installed through ${source.provider} itself; Orkestrator can list them but not install them.`,
          );
        }
        if (
          !/^[@A-Za-z0-9][@A-Za-z0-9._/-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(source.qualifiedId)
        ) {
          throw new CapabilityError(
            "invalid-request",
            "A marketplace plugin is named name@marketplace.",
          );
        }
        const manifest = Buffer.from(
          `${JSON.stringify({ marketplace: source.qualifiedId }, null, 2)}\n`,
        );
        const files: PackageFile[] = [
          {
            path: "marketplace-plugin.json",
            bytes: manifest.length,
            executable: false,
            sha256: "",
            content: manifest,
          },
        ];
        const inspected = inspectMarketplacePlugin(source, files);
        return this.store(inspected, requestKey);
      }
      case "registry":
        return this.store(
          await inspectRegistrySource(
            source,
            this.ctx.registries.context(
              await this.ctx.deps.storage.capabilities.loadCapabilityState(),
            ),
          ),
          requestKey,
        );
      case "local":
      case "managed":
        throw new CapabilityError(
          "invalid-request",
          "Choose an installed item or author the package instead.",
        );
    }
  }

  async authorPackage(args: Record<string, unknown>): Promise<CapabilitySourceInspection> {
    this.ctx.assertAuthority();
    const input = parseAuthoredInput(args);
    const managedId =
      typeof args.managedId === "string" && /^[a-z0-9-]{1,80}$/.test(args.managedId)
        ? args.managedId
        : `${input.name}-${randomBytes(4).toString("hex")}`;
    const source: PackageSource = { kind: "managed", managedId };
    const files = authoredFiles(input);
    const inspected = inspectFiles(source, files, { fallbackName: input.name });
    return this.store(
      {
        ...inspected,
        displayName: input.name,
        ...(input.description ? { description: input.description } : {}),
      },
      undefined,
    );
  }
}

/** A Claude marketplace plugin: its contents resolve inside Claude at install time. */
function inspectMarketplacePlugin(
  source: Extract<PackageSource, { kind: "provider-marketplace" }>,
  files: PackageFile[],
): InspectedPackage {
  const withHashes = files.map((file) => ({
    ...file,
    sha256: createHash("sha256").update(file.content).digest("hex"),
  }));
  const packageId = capabilityPackageId(source);
  const name =
    source.qualifiedId.slice(0, source.qualifiedId.lastIndexOf("@")) || source.qualifiedId;
  const artifactDigest = treeDigest(withHashes);
  return {
    source,
    packageId,
    displayName: name,
    description: `Claude plugin from the ${source.qualifiedId.slice(source.qualifiedId.lastIndexOf("@") + 1)} marketplace.`,
    revision: "marketplace",
    artifactDigest,
    components: [
      {
        id: `${packageId}#native-plugin:claude:${name}`,
        packageId,
        kind: "native-plugin",
        pathOrKey: source.qualifiedId,
        name,
        dependencies: [],
        providerHints: ["claude"],
        requirements: {},
        // Unknown until Claude resolves it: treat it as able to run programs.
        risk: "executable",
      },
    ],
    files: withHashes,
    risk: "executable",
    warnings: [
      "Claude resolves this plugin's contents from its marketplace at install time, so Orkestrator cannot show its hooks or commands beforehand.",
    ],
    secretsFound: [],
  };
}
