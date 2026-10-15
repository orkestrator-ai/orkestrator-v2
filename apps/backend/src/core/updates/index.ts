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
import type { StorageService } from "../storage.js";
import { createUpdateFeed, resolveFeedBaseUrl, UpdateFeedError } from "./update-feed.js";
import { UpdateService, type UpdateDependencies } from "./update-service.js";

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
  storage: Pick<StorageService, "getUpdateChannel" | "setUpdateChannel" | "storageSchemaVersion">;
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
  return new UpdateService({
    dataDir: options.dataDir,
    currentVersion: options.currentVersion,
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
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
    dependencies: options.dependencies,
  });
}
