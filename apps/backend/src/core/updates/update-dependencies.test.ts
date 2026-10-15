import { describe, expect, mock, test } from "bun:test";
import { PINNED_TOOLCHAIN_ARTIFACTS } from "@orkestrator/toolchain/manifest";
import type { EnsurePinnedToolchainsOptions } from "@orkestrator/toolchain/manager";
import type { UpdateJob } from "@orkestrator/protocol/updates";
import type { ManifestRead, ResolvedImage } from "../docker-image.js";
import { createUpdateDependencies, type UpdateDockerRuntime } from "./update-dependencies.js";
import { manifestFor } from "./update-test-support.js";

const ARTIFACTS = JSON.parse(JSON.stringify(PINNED_TOOLCHAIN_ARTIFACTS)) as unknown[];

function imageManifest(appVersion: string, capabilities: Record<string, number>): ManifestRead {
  return { kind: "manifest", manifest: { appVersion, capabilities } } as unknown as ManifestRead;
}

function docker(
  images: Record<
    string,
    { id: string; manifest: ManifestRead; digests?: string[] } | "unavailable"
  >,
) {
  const pulled: string[] = [];
  const tagged: Array<[string, string]> = [];
  const runtime: UpdateDockerRuntime = {
    async resolve(ref): Promise<ResolvedImage> {
      const image = images[ref];
      if (image === "unavailable") return { kind: "unavailable", imageRef: ref };
      if (!image) return { kind: "missing", imageRef: ref };
      return {
        kind: "present",
        imageRef: ref,
        imageId: image.id,
        registryDigest: null,
        architecture: "arm64",
      };
    },
    async repoDigests(ref) {
      const image = images[ref];
      return image && image !== "unavailable" ? (image.digests ?? []) : null;
    },
    async manifest(imageId) {
      const image = Object.values(images).find(
        (entry) => entry !== "unavailable" && entry.id === imageId,
      );
      return image && image !== "unavailable" ? image.manifest : { kind: "unavailable" };
    },
    pull: mock(async (ref: string) => {
      pulled.push(ref);
    }),
    tag: mock(async (id: string, ref: string) => {
      tagged.push([id, ref]);
    }),
  };
  return { runtime, pulled, tagged };
}

function setup(options: { docker: ReturnType<typeof docker>; enabled?: string[] }) {
  const ensure = mock(async (input: EnsurePinnedToolchainsOptions) => {
    input.onProgress?.({
      phase: "downloading",
      completedTools: 0,
      totalTools: 1,
      overallFraction: 0.5,
      message: "Downloading claude",
    });
    return {
      rootDir: "/data/toolchains",
      binDir: "/data/toolchains/bin/target",
      executables: {} as never,
    };
  });
  const dependencies = createUpdateDependencies({
    dataDir: "/data",
    platform: "darwin",
    arch: "arm64",
    imageRef: () => "orkestrator-v2:latest",
    enabledAgentPlatforms: async () => (options.enabled ?? ["claude"]) as never,
    ensure,
    docker: options.docker.runtime,
  });
  return { dependencies, ensure };
}

const target = (
  version = "2.22.0",
  required: Record<string, number> = { "workspace-prepare": 1 },
) =>
  manifestFor(version, {
    toolchain: { versions: {}, artifacts: structuredClone(ARTIFACTS) as never },
    container: {
      image: "ghcr.io/orkestrator-ai/orkestrator-v2",
      tag: version,
      requiredImageCapabilities: required,
      imageCapabilities: required,
    },
  });

describe("prefetching provider binaries", () => {
  test("fetches this machine's selection of the target's pins without pruning", async () => {
    const { dependencies, ensure } = setup({ docker: docker({}) });
    const progress: Array<[number | null, string | null]> = [];
    const result = await dependencies.prefetch!(target(), {} as UpdateJob, (percent, message) =>
      progress.push([percent, message]),
    );
    expect(result).toEqual({ toolchainBinDir: "/data/toolchains/bin/target", image: null });
    const call = ensure.mock.calls[0]![0];
    expect(call.prune).toBe(false);
    expect(call.dataDir).toBe("/data");
    expect(
      call
        .artifacts!.map(
          (artifact) => `${artifact.name}/${artifact.platform}/${artifact.architecture}`,
        )
        .sort(),
    ).toEqual(["claude/darwin/arm64", "gh/darwin/arm64"]);
    expect(progress).toEqual([[50, "Downloading claude"]]);
  });

  test("refuses a target whose pins are malformed before downloading anything", async () => {
    const { dependencies, ensure } = setup({ docker: docker({}) });
    const broken = target();
    (broken.toolchain.artifacts[0] as Record<string, unknown>).name = "../../etc";
    await expect(dependencies.prefetch!(broken, {} as UpdateJob, () => undefined)).rejects.toThrow(
      "tool name",
    );
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("the container image", () => {
  test("no image or no Docker means no container work; a quiet daemon is unknown", async () => {
    expect(await setup({ docker: docker({}) }).dependencies.inspectLocalImage!()).toBeNull();
    expect(
      await setup({ docker: docker({ "orkestrator-v2:latest": "unavailable" }) }).dependencies
        .inspectLocalImage!(),
    ).toBeUndefined();
  });

  test("tells a published image from a local build", async () => {
    const published = docker({
      "orkestrator-v2:latest": {
        id: "sha256:old",
        manifest: imageManifest("2.21.0", { "workspace-prepare": 1 }),
        digests: ["ghcr.io/orkestrator-ai/orkestrator-v2@sha256:abc"],
      },
    });
    expect(await setup({ docker: published }).dependencies.inspectLocalImage!()).toEqual({
      capabilities: { "workspace-prepare": 1 },
      source: "published",
    });
    const local = docker({
      "orkestrator-v2:latest": { id: "sha256:old", manifest: { kind: "legacy" } },
    });
    expect(await setup({ docker: local }).dependencies.inspectLocalImage!()).toEqual({
      capabilities: {},
      source: "local",
    });
  });

  test("pulls and verifies the target image when the published one lacks a capability", async () => {
    const images = docker({
      "orkestrator-v2:latest": {
        id: "sha256:old",
        manifest: imageManifest("2.21.0", { "workspace-prepare": 1 }),
        digests: ["ghcr.io/orkestrator-ai/orkestrator-v2@sha256:abc"],
      },
      "ghcr.io/orkestrator-ai/orkestrator-v2:2.22.0": {
        id: "sha256:new",
        manifest: imageManifest("2.22.0", { "workspace-prepare": 1, "network-policy": 3 }),
      },
    });
    const { dependencies } = setup({ docker: images });
    const result = await dependencies.prefetch!(
      target("2.22.0", { "workspace-prepare": 1, "network-policy": 3 }),
      {} as UpdateJob,
      () => undefined,
    );
    expect(images.pulled).toEqual(["ghcr.io/orkestrator-ai/orkestrator-v2:2.22.0"]);
    expect(result.image).toEqual({
      pulledRef: "ghcr.io/orkestrator-ai/orkestrator-v2:2.22.0",
      imageId: "sha256:new",
      previousImageId: "sha256:old",
    });
    // Nothing is retagged until install, and a rollback retags the old image.
    expect(images.tagged).toEqual([]);
    const job = { dependencies: result } as UpdateJob;
    await dependencies.beforeInstall!(target(), job);
    await dependencies.afterRollback!(job);
    expect(images.tagged).toEqual([
      ["sha256:new", "orkestrator-v2:latest"],
      ["sha256:old", "orkestrator-v2:latest"],
    ]);
  });

  test("refuses a pulled image that is not the approved release", async () => {
    const images = docker({
      "orkestrator-v2:latest": {
        id: "sha256:old",
        manifest: imageManifest("2.21.0", {}),
        digests: ["ghcr.io/orkestrator-ai/orkestrator-v2@sha256:abc"],
      },
      "ghcr.io/orkestrator-ai/orkestrator-v2:2.22.0": {
        id: "sha256:new",
        manifest: imageManifest("2.23.0", { "workspace-prepare": 1 }),
      },
    });
    await expect(
      setup({ docker: images }).dependencies.prefetch!(target(), {} as UpdateJob, () => undefined),
    ).rejects.toThrow("reports version 2.23.0");
  });

  test("never touches a locally built image", async () => {
    const images = docker({
      "orkestrator-v2:latest": { id: "sha256:old", manifest: imageManifest("2.21.0", {}) },
    });
    const result = await setup({ docker: images }).dependencies.prefetch!(
      target(),
      {} as UpdateJob,
      () => undefined,
    );
    expect(result.image).toBeNull();
    expect(images.pulled).toEqual([]);
  });
});
