#!/usr/bin/env bun
/**
 * Reports whether the Dockerfile's pinned base image digest is still the one
 * its tag points to. The pin makes builds reproducible; this is the refresh
 * half, so a security update to the base is noticed rather than frozen out.
 *
 *   mise run docker:check-base
 *
 * Exits 0 when current, 1 when the tag has moved (refresh both FROM lines to
 * the printed digest and rebuild), 2 when it could not be checked.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export function pinnedBase(dockerfile: string): { image: string; digest: string } | null {
  const pins = [...dockerfile.matchAll(/^FROM\s+(\S+?)@(sha256:[0-9a-f]{64})/gm)].map((match) => ({
    image: match[1]!,
    digest: match[2]!,
  }));
  if (pins.length === 0) return null;
  const first = pins[0]!;
  // Every stage must pin the same base; version-drift tests enforce it too.
  if (pins.some((pin) => pin.image !== first.image || pin.digest !== first.digest)) return null;
  return first;
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const pin = pinnedBase(readFileSync(path.join(root, "docker", "Dockerfile"), "utf8"));
  if (!pin) {
    console.error("docker/Dockerfile has no consistent pinned base image");
    process.exit(2);
  }
  const inspect = spawnSync(
    "docker",
    ["buildx", "imagetools", "inspect", pin.image, "--format", "{{json .Manifest.Digest}}"],
    { encoding: "utf8", timeout: 60_000 },
  );
  const current = inspect.status === 0 ? (JSON.parse(inspect.stdout.trim()) as string) : null;
  if (!current) {
    console.error(`Could not resolve ${pin.image}: ${inspect.stderr.trim().slice(0, 300)}`);
    process.exit(2);
  }
  if (current === pin.digest) {
    console.log(`${pin.image} is pinned to its current digest ${current}`);
    process.exit(0);
  }
  console.log(`${pin.image} moved: pinned ${pin.digest}, now ${current}`);
  console.log("Update both FROM lines in docker/Dockerfile, rebuild and run the image smoke test.");
  process.exit(1);
}
