/**
 * What an update fetches before the restart, so the new version comes up
 * ready: the target release's pinned provider binaries, and (for machines that
 * run the published container image) the target image.
 *
 * Everything is additive until install. Binaries land in their own versioned
 * directories beside the running set and nothing is pruned; a pulled image is
 * only retagged as the default image right before handing over to the
 * installer, and retagged back if the update ends any way but success.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { CONTAINER_IMAGE_REPOSITORY } from "@orkestrator/protocol/release-channels";
import type {
  ReleaseRequirements,
  ReleaseRequirementsDiffContext,
} from "@orkestrator/protocol/release-requirements";
import type { UpdateJob, UpdateJobDependencies } from "@orkestrator/protocol/updates";
import {
  parseExternalToolchainArtifacts,
  selectPrefetchArtifacts,
} from "@orkestrator/toolchain/external";
import type {
  EnsurePinnedToolchainsOptions,
  PinnedToolchainResult,
} from "@orkestrator/toolchain/manager";
import type { ManifestRead, ResolvedImage } from "../docker-image.js";
import type { UpdateDependencies } from "./update-service.js";

export type UpdateDockerRuntime = {
  resolve(imageRef: string): Promise<ResolvedImage>;
  /** `RepoDigests` of a local image, or null when Docker cannot answer. */
  repoDigests(imageRef: string): Promise<string[] | null>;
  manifest(imageId: string): Promise<ManifestRead>;
  pull(imageRef: string): Promise<void>;
  tag(imageId: string, imageRef: string): Promise<void>;
};

export type UpdateDependencyOptions = {
  dataDir: string;
  platform: string;
  arch: string;
  /** The image environments run (`orkestrator-v2:latest` unless configured). */
  imageRef(): string;
  enabledAgentPlatforms(): Promise<readonly AgentPlatform[]>;
  ensure(options: EnsurePinnedToolchainsOptions): Promise<PinnedToolchainResult>;
  docker: UpdateDockerRuntime;
};

function missingCapabilities(
  have: Record<string, number>,
  required: Record<string, number>,
): string[] {
  return Object.entries(required)
    .filter(([name, version]) => (have[name] ?? 0) < version)
    .map(([name]) => name);
}

export function createUpdateDependencies(options: UpdateDependencyOptions): UpdateDependencies {
  async function inspectLocalImage(): Promise<ReleaseRequirementsDiffContext["localImage"]> {
    const resolved = await options.docker.resolve(options.imageRef());
    // No image (or no Docker at all) means no container work to protect.
    if (resolved.kind === "missing") return null;
    // Docker is installed but not answering: unknown, so compare manifests.
    if (resolved.kind === "unavailable") return undefined;
    const read = await options.docker.manifest(resolved.imageId);
    if (read.kind === "unavailable") return undefined;
    const digests = (await options.docker.repoDigests(options.imageRef())) ?? [];
    return {
      capabilities: read.kind === "manifest" ? { ...read.manifest.capabilities } : {},
      source: digests.some((entry) => entry.startsWith(`${CONTAINER_IMAGE_REPOSITORY}@`))
        ? "published"
        : "local",
    };
  }

  async function pullTargetImage(
    manifest: ReleaseRequirements,
  ): Promise<NonNullable<UpdateJobDependencies["image"]>> {
    const current = await options.docker.resolve(options.imageRef());
    // Becomes the default image, so only the release's own image qualifies,
    // whatever the manifest names.
    const pulledRef = `${CONTAINER_IMAGE_REPOSITORY}:${manifest.version}`;
    if (`${manifest.container.image}:${manifest.container.tag}` !== pulledRef) {
      throw new Error(
        `The release names ${manifest.container.image}:${manifest.container.tag}, not ${pulledRef}`,
      );
    }
    await options.docker.pull(pulledRef);
    const pulled = await options.docker.resolve(pulledRef);
    if (pulled.kind !== "present") throw new Error(`${pulledRef} is not available after pulling`);
    const read = await options.docker.manifest(pulled.imageId);
    if (read.kind !== "manifest") throw new Error(`${pulledRef} has no readable image manifest`);
    // The registry verified the bytes by digest; this checks they are the
    // release we approved and provide what it needs.
    if (read.manifest.appVersion !== manifest.version) {
      throw new Error(`${pulledRef} reports version ${read.manifest.appVersion}`);
    }
    const missing = missingCapabilities(
      read.manifest.capabilities,
      manifest.container.requiredImageCapabilities,
    );
    if (missing.length > 0) {
      throw new Error(`${pulledRef} lacks image capabilities ${missing.join(", ")}`);
    }
    return {
      pulledRef,
      imageId: pulled.imageId,
      previousImageId: current.kind === "present" ? current.imageId : null,
    };
  }

  return {
    inspectLocalImage,
    async prefetch(manifest, _job, report) {
      const result: UpdateJobDependencies = { toolchainBinDir: null, image: null };
      const artifacts = selectPrefetchArtifacts(
        parseExternalToolchainArtifacts(manifest.toolchain.artifacts),
        {
          platform: options.platform,
          architecture: options.arch,
          enabledAgentPlatforms: await options.enabledAgentPlatforms(),
        },
      );
      if (artifacts.length > 0) {
        const activated = await options.ensure({
          dataDir: options.dataDir,
          artifacts,
          // A pre-fetch never deletes anything: the running version keeps its set.
          prune: false,
          onProgress: (progress) =>
            report(
              typeof progress.overallFraction === "number"
                ? Math.round(progress.overallFraction * 100)
                : null,
              progress.message,
            ),
        });
        result.toolchainBinDir = activated.binDir;
      }
      const local = await inspectLocalImage();
      if (
        local?.source === "published" &&
        missingCapabilities(local.capabilities, manifest.container.requiredImageCapabilities)
          .length > 0
      ) {
        report(null, `Pulling ${manifest.container.image}:${manifest.container.tag}`);
        result.image = await pullTargetImage(manifest);
      }
      return result;
    },
    async beforeInstall(_manifest, job: UpdateJob) {
      const image = job.dependencies?.image;
      if (image) await options.docker.tag(image.imageId, options.imageRef());
    },
    async undoBeforeInstall(job: UpdateJob) {
      const previous = job.dependencies?.image?.previousImageId;
      if (previous) await options.docker.tag(previous, options.imageRef());
    },
  };
}
