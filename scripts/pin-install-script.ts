#!/usr/bin/env bun
/**
 * Pin the site's `install.sh` to a published Stable release.
 *
 *   mise run release:pin-installer            # the version in package.json
 *   mise run release:pin-installer -- 2.37.0
 *
 * Run it after `mise run release:publish` of a Stable release and merge the
 * change through a pull request; the hosted site follows `main`. The script
 * refuses a version npm does not have, because a pin to one breaks every
 * install. See docs/development/releasing.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hostUpdateChannelOfVersion } from "../packages/protocol/src/host-maintenance.js";

const root = path.resolve(import.meta.dir, "..");
const INSTALL_SCRIPT = path.join(root, "apps/web-public/public/install.sh");
const REGISTRY = "https://registry.npmjs.org";
const PIN = /^PINNED_RELEASE="([^"]*)"$/m;

/** The release an `install.sh` runs. */
export function pinnedRelease(script: string): string {
  const pinned = PIN.exec(script)?.[1];
  if (!pinned) throw new Error("install.sh has no PINNED_RELEASE line");
  return pinned;
}

/** The script pinned to `version`; refuses a prerelease or a step backwards. */
export function stampRelease(script: string, version: string): string {
  if (hostUpdateChannelOfVersion(version) !== "stable") {
    throw new Error(`${version} is not a Stable release; install.sh only pins Stable releases`);
  }
  const current = pinnedRelease(script);
  if (Bun.semver.order(version, current) < 0) {
    throw new Error(`${version} is older than the current pin ${current}`);
  }
  return script.replace(PIN, `PINNED_RELEASE="${version}"`);
}

/** Refuses a version the registry does not have; `bunx` would fail on it for every user. */
export async function assertPublished(
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${REGISTRY}/orkestrator/${version}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `orkestrator@${version} is not on npm (HTTP ${response.status}); publish the release first`,
    );
  }
}

if (import.meta.main) {
  try {
    const { version: repositoryVersion } = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { version: string };
    const version = (process.argv[2] ?? repositoryVersion).replace(/^v/, "");
    const stamped = stampRelease(readFileSync(INSTALL_SCRIPT, "utf8"), version);
    await assertPublished(version);
    writeFileSync(INSTALL_SCRIPT, stamped);
    console.log(
      `install.sh now runs orkestrator@${version}. Commit it and merge through a pull request.`,
    );
  } catch (error) {
    console.error(`pin-install-script: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
