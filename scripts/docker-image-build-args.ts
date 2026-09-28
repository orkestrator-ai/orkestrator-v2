#!/usr/bin/env bun
/**
 * Prints the `--build-arg` pairs every image build passes: the source revision
 * and the capability list probed from the repository's contract scripts. The
 * image build regenerates the list from the installed files and fails if the
 * two disagree, so the image label can be trusted as a summary.
 *
 *   docker build $(bun scripts/docker-image-build-args.ts) -f docker/Dockerfile .
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

export function dockerImageBuildArgs(repositoryRoot: string): string[] {
  const probe = spawnSync(
    "bun",
    [
      path.join(repositoryRoot, "docker", "image-manifest.ts"),
      "capabilities",
      "--repo",
      repositoryRoot,
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    throw new Error(`Capability probe failed: ${probe.stderr.trim()}`);
  }
  const revision = spawnSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  return [
    "--build-arg",
    `ORKESTRATOR_IMAGE_CAPABILITIES=${probe.stdout.trim()}`,
    "--build-arg",
    `ORKESTRATOR_SOURCE_REVISION=${revision.status === 0 ? revision.stdout.trim() : "unknown"}`,
  ];
}

if (import.meta.main) {
  process.stdout.write(`${dockerImageBuildArgs(path.resolve(import.meta.dir, "..")).join(" ")}\n`);
}
