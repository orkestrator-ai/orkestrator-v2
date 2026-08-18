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
    mac: {
      ...baseMac,
      hardenedRuntime: true,
      notarize: true,
      target: ["dmg"],
    },
  };
}

export default function releaseConfig(): Configuration {
  return createReleaseConfig(process.env);
}
