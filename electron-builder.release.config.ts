import type { Configuration } from "electron-builder";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as {
  build: Configuration;
};

const {
  identity: _localIdentity,
  hardenedRuntime: _localHardenedRuntime,
  notarize: _localNotarize,
  ...baseMac
} = packageJson.build.mac ?? {};

/**
 * Only release builds publish: the `publish` target is what makes
 * electron-builder embed `app-update.yml` and emit `latest-*.yml`, and the app
 * only enables its updater when that file exists. Local `package:*` installs
 * therefore never try to update themselves. Releases upload as drafts; the
 * release workflow publishes the draft once every platform has succeeded.
 */
export const releasePublish: Configuration["publish"] = [
  {
    provider: "github",
    owner: "orkestrator-ai",
    repo: "orkestrator-v2",
    releaseType: "draft",
  },
];

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
export function createReleaseConfig(environment: NodeJS.ProcessEnv): Configuration {
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
    publish: releasePublish,
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
