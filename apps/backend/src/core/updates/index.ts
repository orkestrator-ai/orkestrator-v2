/**
 * Builds the backend's update service from its runtime: the release feed (or
 * the qualification override), this build's own requirements manifest, and
 * the policy that decides whether checks run automatically.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  parseReleaseRequirementsBytes,
  RELEASE_REQUIREMENTS_ASSET,
  type ReleaseRequirements,
} from "@orkestrator/protocol/release-requirements";
import { RELEASE_SIGNING_PUBLIC_KEYS } from "@orkestrator/protocol/release-signing-keys";
import { DISABLE_AUTO_UPDATE_ENV } from "@orkestrator/protocol/updates";
import { ensurePinnedToolchains } from "@orkestrator/toolchain/manager";
import { loadAgentPlatformSelection } from "@orkestrator/toolchain/platform-selection";
import { DOCKER_IMAGE } from "../constants.js";
import { readImageManifest, resolveDockerImage } from "../docker-image.js";
import { runCommand } from "../shell.js";
import type { StorageService } from "../storage.js";
import { createUpdateDependencies, type UpdateDockerRuntime } from "./update-dependencies.js";
import { createUpdateFeed, resolveFeedBaseUrl, UpdateFeedError } from "./update-feed.js";
import { UpdateService, type UpdateDependencies } from "./update-service.js";

/** Docker as the dependency step uses it: inspect, pull by tag, retag. */
export function dockerUpdateRuntime(
  storage: Pick<StorageService, "getDataDir">,
): UpdateDockerRuntime {
  return {
    resolve: resolveDockerImage,
    async repoDigests(imageRef) {
      try {
        const { stdout } = await runCommand(
          "docker",
          ["image", "inspect", "--format", "{{json .RepoDigests}}", imageRef],
          { timeoutMs: 15_000 },
        );
        const digests = JSON.parse(stdout.trim()) as unknown;
        return Array.isArray(digests)
          ? digests.filter((entry): entry is string => typeof entry === "string")
          : [];
      } catch {
        return null;
      }
    },
    manifest: (imageId) => readImageManifest(imageId, { storage: storage as StorageService }),
    async pull(imageRef) {
      await runCommand("docker", ["pull", imageRef], { timeoutMs: 30 * 60_000 });
    },
    async tag(imageId, imageRef) {
      await runCommand("docker", ["tag", imageId, imageRef], { timeoutMs: 60_000 });
    },
  };
}

export { UpdateService } from "./update-service.js";

/**
 * The manifest this build ships: `resources/release-requirements.json` in the
 * desktop app and the npm package. A dev checkout has none, which the diff
 * treats as "no baseline".
 */
export function readOwnRequirements(resourceRoot: string): ReleaseRequirements | null {
  const file = path.join(resourceRoot, RELEASE_REQUIREMENTS_ASSET);
  if (!existsSync(file)) return null;
  try {
    return parseReleaseRequirementsBytes(readFileSync(file));
  } catch (error) {
    console.warn(
      `[Updates] Ignored this build's requirements manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export function createBackendUpdateService(options: {
  dataDir: string;
  resourceRoot: string;
  currentVersion: string;
  runtimeFlavor: "production" | "development" | "agent-test";
  storage: Pick<
    StorageService,
    "getUpdateChannel" | "setUpdateChannel" | "storageSchemaVersion" | "getDataDir"
  >;
  /** The image environments run; `orkestrator-v2:latest` unless configured. */
  dockerImage?: string;
  emit(event: string, payload: unknown): void;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  dependencies?: UpdateDependencies;
}): UpdateService {
  const env = options.env ?? process.env;
  let baseUrl: string | undefined;
  let disabledReason: string | null = null;
  try {
    baseUrl = resolveFeedBaseUrl(env);
  } catch (error) {
    disabledReason = error instanceof UpdateFeedError ? error.message : String(error);
  }
  if (env[DISABLE_AUTO_UPDATE_ENV] === "1") {
    disabledReason = `Updates are turned off on this machine (${DISABLE_AUTO_UPDATE_ENV}=1).`;
  } else if (options.runtimeFlavor === "agent-test") {
    disabledReason = "Updates are off in agent-test profiles.";
  }
  let ownRequirements: ReleaseRequirements | null | undefined;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const dependencies =
    options.dependencies ??
    createUpdateDependencies({
      dataDir: options.dataDir,
      platform,
      arch,
      imageRef: () => options.dockerImage ?? DOCKER_IMAGE,
      enabledAgentPlatforms: async () =>
        (await loadAgentPlatformSelection(options.dataDir)).enabled,
      ensure: ensurePinnedToolchains,
      docker: dockerUpdateRuntime(options.storage),
    });
  return new UpdateService({
    dataDir: options.dataDir,
    currentVersion: options.currentVersion,
    platform,
    arch,
    feed: createUpdateFeed({ baseUrl, signingKeys: RELEASE_SIGNING_PUBLIC_KEYS }),
    emit: options.emit,
    readOwnRequirements: () => {
      if (ownRequirements === undefined)
        ownRequirements = readOwnRequirements(options.resourceRoot);
      return ownRequirements;
    },
    readChannel: () => options.storage.getUpdateChannel(),
    writeChannel: (channel) => options.storage.setUpdateChannel(channel),
    storageSchemaVersion: () => {
      try {
        return options.storage.storageSchemaVersion();
      } catch {
        return null;
      }
    },
    // Never under the test runner: a scheduled check would reach GitHub.
    automaticChecks:
      disabledReason === null && options.runtimeFlavor === "production" && env.NODE_ENV !== "test",
    disabledReason,
    dependencies,
  });
}
