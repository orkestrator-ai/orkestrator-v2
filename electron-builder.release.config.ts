import type { Configuration } from "electron-builder";
import { readFileSync } from "node:fs";
import {
  HOST_UPDATE_CHANNEL_TAGS,
  hostUpdateChannelOfVersion,
} from "./packages/protocol/src/host-maintenance";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  version: string;
  build: Configuration;
};

const {
  identity: _localIdentity,
  hardenedRuntime: _localHardenedRuntime,
  notarize: _localNotarize,
  ...baseMac
} = packageJson.build.mac ?? {};

/**
 * The updater feed a release writes: `latest`, `beta` or `alpha`, from the
 * version's suffix (`2.23.0`, `2.23.0-beta`, `2.23.0-alpha`).
 */
export function releaseFeedChannel(version: string): "latest" | "beta" | "alpha" {
  const channel = hostUpdateChannelOfVersion(version);
  if (!channel) {
    throw new Error(
      `${version} has a suffix no update channel ships. Use no suffix (Stable), -beta or -alpha (Unstable).`,
    );
  }
  return HOST_UPDATE_CHANNEL_TAGS[channel];
}

/**
 * Only release builds publish: the `publish` target is what makes
 * electron-builder embed `app-update.yml` and emit the `<channel>-*.yml`
 * feeds, and the app only enables its updater when that file exists. Local
 * `package:*` installs therefore never try to update themselves. Releases
 * upload as drafts; the release workflow publishes the draft once every
 * platform has succeeded.
 *
 * The GitHub provider ignores the version's suffix, so `channel` names the
 * feed: a beta writes `beta-mac.yml`. electron-updater reads a stable
 * release's `latest-*.yml` from any channel.
 */
export function releasePublish(version = packageJson.version): Configuration["publish"] {
  return [
    {
      provider: "github",
      owner: "orkestrator-ai",
      repo: "orkestrator-v2",
      releaseType: "draft",
      channel: releaseFeedChannel(version),
    },
  ];
}

const notarizationCredentialSets = [
  ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"],
  ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"],
  ["APPLE_KEYCHAIN_PROFILE"],
] as const;

export function hasNotarizationCredentials(environment: NodeJS.ProcessEnv): boolean {
  return notarizationCredentialSets.some((keys) =>
    keys.every((key) => Boolean(environment[key]?.trim())),
  );
}

/**
 * Distribution builds deliberately opt back into electron-builder's signing
 * identity discovery and Apple notarization. The package.json configuration is
 * kept as the source of truth for every other packaging option.
 */
export function createReleaseConfig(
  environment: NodeJS.ProcessEnv,
  version = packageJson.version,
): Configuration {
  if (!hasNotarizationCredentials(environment)) {
    throw new Error(
      "package:release requires Apple notarization credentials: configure either " +
        "APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, " +
        "APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, or APPLE_KEYCHAIN_PROFILE.",
    );
  }

  return {
    ...packageJson.build,
    forceCodeSigning: true,
    publish: releasePublish(version),
    mac: {
      ...baseMac,
      hardenedRuntime: true,
      notarize: true,
      // The dmg is the website download; electron-updater applies the zip.
      target: ["dmg", "zip"],
    },
  };
}

export default function releaseConfig(): Configuration {
  return createReleaseConfig(process.env);
}
