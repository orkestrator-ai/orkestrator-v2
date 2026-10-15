import { describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { parseReleaseChannelIndex } from "../../../packages/protocol/src/release-channels";
import {
  buildReleaseChannelIndex,
  computeReleaseChannelIndex,
  publishReleaseChannelIndex,
  pruneUnstableReleases,
  runChannelIndex,
  selectChannelReleases,
  unstableReleasesToPrune,
  type ChannelIndexRuntime,
  type PublishedRelease,
} from "../../../scripts/release-channel-index";
import { buildReleaseRequirements } from "../../../scripts/release-requirements";
import {
  serializeReleaseRequirements,
  sha256Hex,
} from "../../../packages/protocol/src/release-requirements";
import { MACOS_PERMISSION_CATALOGUE } from "../../../packages/protocol/src/macos-permissions";

const COMMIT = "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567";
const EXTEND_INFO = Object.fromEntries(
  Object.values(MACOS_PERMISSION_CATALOGUE)
    .flatMap((entry) => (entry.infoPlistKey ? [entry.infoPlistKey] : []))
    .map((key) => [key, `Usage for ${key}`]),
);

function release(tagName: string, overrides: Partial<PublishedRelease> = {}): PublishedRelease {
  return {
    tagName,
    isDraft: false,
    isPrerelease: tagName.includes("-"),
    publishedAt: "2026-10-10T00:00:00Z",
    assets: ["latest-mac.yml", "release-requirements.json"],
    ...overrides,
  };
}

function manifestBytes(version: string): Uint8Array {
  const manifest = buildReleaseRequirements({
    version,
    commit: COMMIT,
    config: {
      compatibility: { minClientVersion: "2.0.0", minBackendVersion: "2.0.0" },
      egressHosts: [],
    },
    extendInfo: EXTEND_INFO,
    storageMigrations: [{ version: 3, name: "record-shape-upgrade" }],
    toolVersions: {},
    artifacts: [],
    requiredImageCapabilities: {},
    imageCapabilities: {},
    containerDefaultDomains: [],
  });
  return new TextEncoder().encode(serializeReleaseRequirements(manifest));
}

describe("selecting channel releases", () => {
  test("takes the newest published release of each channel", () => {
    const selected = selectChannelReleases([
      release("v2.20.0"),
      release("v2.21.0"),
      release("v2.21.1", { isDraft: true }),
      release("v2.22.0-beta.1"),
      release("v2.22.0-beta.10"),
      release("v2.22.0-beta.2"),
      release("v2.22.0-unstable.20261014.9.gaaaaaaa"),
      release("v2.22.0-unstable.20261015.10.gbbbbbbb"),
      release("v2.23.0-rc.1"),
      release("update-channels", { isPrerelease: true }),
    ]);
    expect(selected.stable?.tagName).toBe("v2.21.0");
    expect(selected.beta?.tagName).toBe("v2.22.0-beta.10");
    expect(selected.unstable?.tagName).toBe("v2.22.0-unstable.20261015.10.gbbbbbbb");
  });

  test("ignores unpublished releases, missing manifests and contradictory prerelease flags", () => {
    const selected = selectChannelReleases([
      release("v2.21.0", { publishedAt: null }),
      release("v2.21.1", { assets: ["latest-mac.yml"] }),
      release("v2.21.2", { isPrerelease: true }),
      release("v2.22.0-beta.1", { isPrerelease: false }),
    ]);
    expect(selected).toEqual({ stable: null, beta: null, unstable: null });
  });
});

describe("building the index", () => {
  test("is deterministic: generatedAt is the newest publication, not the clock", () => {
    const releases = [
      release("v2.21.0", { publishedAt: "2026-10-01T00:00:00Z" }),
      release("v2.22.0-beta.1", { publishedAt: "2026-10-12T08:00:00Z" }),
    ];
    const digests = new Map([
      ["v2.21.0", "a".repeat(64)],
      ["v2.22.0-beta.1", "b".repeat(64)],
    ]);
    const index = buildReleaseChannelIndex({ releases, requirementsSha256: digests });
    expect(index).toEqual(buildReleaseChannelIndex({ releases, requirementsSha256: digests }));
    expect(index.generatedAt).toBe("2026-10-12T08:00:00Z");
    expect(index.channels).toEqual({
      stable: {
        version: "2.21.0",
        tag: "v2.21.0",
        publishedAt: "2026-10-01T00:00:00Z",
        requirementsSha256: "a".repeat(64),
      },
      beta: {
        version: "2.22.0-beta.1",
        tag: "v2.22.0-beta.1",
        publishedAt: "2026-10-12T08:00:00Z",
        requirementsSha256: "b".repeat(64),
      },
      unstable: null,
    });
    expect(parseReleaseChannelIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);
  });

  test("refuses a selected release without a verified digest", () => {
    expect(() =>
      buildReleaseChannelIndex({ releases: [release("v2.21.0")], requirementsSha256: new Map() }),
    ).toThrow("no verified requirements digest");
  });
});

function runtimeFor(
  releases: Array<PublishedRelease>,
  options: {
    manifests?: Record<string, Uint8Array>;
    signatures?: Record<string, string>;
    keys?: string[];
    indexRelease?: unknown;
  } = {},
) {
  const run = mock((_command: string[]) => {});
  const runtime: ChannelIndexRuntime = {
    capture: (command) => {
      if (command.includes("--jq")) return COMMIT;
      if (command[1] === "api") {
        return JSON.stringify([
          releases.map((entry) => ({
            tag_name: entry.tagName,
            draft: entry.isDraft,
            prerelease: entry.isPrerelease,
            published_at: entry.publishedAt,
            assets: entry.assets.map((name) => ({ name })),
          })),
        ]);
      }
      if (command[1] === "release" && command[2] === "view") {
        if (options.indexRelease === undefined) throw new Error("release not found");
        return JSON.stringify(options.indexRelease);
      }
      throw new Error(`unexpected ${command.join(" ")}`);
    },
    captureBytes: (command) => {
      const tag = command[3]!;
      const asset = command[7]!;
      if (asset === "release-requirements.json")
        return options.manifests?.[tag] ?? manifestBytes(tag.slice(1));
      if (asset === "release-requirements.json.sig") {
        return new TextEncoder().encode(options.signatures?.[tag] ?? "");
      }
      throw new Error(`unexpected download ${asset}`);
    },
    run,
    signingKeys: options.keys ?? [],
  };
  return { runtime, run };
}

describe("publishing", () => {
  test("refuses when the update-channels release is missing or could become latest", async () => {
    const { runtime, run } = runtimeFor([release("v2.21.0")]);
    await expect(publishReleaseChannelIndex(runtime)).rejects.toThrow(
      "gh release create update-channels",
    );
    const notPrerelease = runtimeFor([release("v2.21.0")], {
      indexRelease: { isPrerelease: false, isDraft: false },
    });
    await expect(publishReleaseChannelIndex(notPrerelease.runtime)).rejects.toThrow(
      "published prerelease",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test("uploads an index whose digests are of the verified manifests", async () => {
    const { runtime, run } = runtimeFor([release("v2.21.0"), release("v2.22.0-beta.1")], {
      indexRelease: { isPrerelease: true, isDraft: false },
    });
    const text = await publishReleaseChannelIndex(runtime);
    const index = parseReleaseChannelIndex(JSON.parse(text));
    expect(index.channels.stable?.requirementsSha256).toBe(
      await sha256Hex(manifestBytes("2.21.0")),
    );
    expect(index.channels.beta?.version).toBe("2.22.0-beta.1");
    expect(run).toHaveBeenCalledTimes(3);
    const upload = run.mock.calls[1]![0];
    expect(upload.slice(0, 6)).toEqual([
      "gh",
      "release",
      "upload",
      "update-channels",
      "--repo",
      "orkestrator-ai/orkestrator-v2",
    ]);
    expect(upload[6]).toBe("--clobber");
    expect(upload[7]?.endsWith("/channels.json")).toBe(true);
  });

  test("refuses a manifest that belongs to another version", async () => {
    const { runtime } = runtimeFor([release("v2.21.0")], {
      indexRelease: { isPrerelease: true, isDraft: false },
      manifests: { "v2.21.0": manifestBytes("2.20.0") },
    });
    await expect(publishReleaseChannelIndex(runtime)).rejects.toThrow("is for 2.20.0");
  });

  test("requires a valid signature once signing keys are embedded", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const key = Buffer.from(
      publicKey.export({ format: "der", type: "spki" }).subarray(-32),
    ).toString("base64");
    const bytes = manifestBytes("2.21.0");
    const unsigned = runtimeFor([release("v2.21.0")], {
      indexRelease: { isPrerelease: true, isDraft: false },
      keys: [key],
    });
    expect((await computeReleaseChannelIndex(unsigned.runtime)).channels.stable).toBeNull();
    const signedRelease = release("v2.21.0", {
      assets: ["release-requirements.json", "release-requirements.json.sig"],
    });
    const forged = runtimeFor([signedRelease], {
      indexRelease: { isPrerelease: true, isDraft: false },
      keys: [key],
      signatures: { "v2.21.0": sign(null, manifestBytes("2.20.9"), privateKey).toString("base64") },
    });
    await expect(publishReleaseChannelIndex(forged.runtime)).rejects.toThrow("does not verify");
    const valid = runtimeFor([signedRelease], {
      indexRelease: { isPrerelease: true, isDraft: false },
      keys: [key],
      signatures: { "v2.21.0": sign(null, bytes, privateKey).toString("base64") },
    });
    await expect(publishReleaseChannelIndex(valid.runtime)).resolves.toContain("2.21.0");
  });
});

describe("pruning unstable releases", () => {
  const unstable = (day: number, run: number) =>
    release(`v2.22.0-unstable.202610${String(day).padStart(2, "0")}.${run}.g${"a".repeat(7)}`);

  test("keeps the newest N by version and never the indexed one", () => {
    const releases = [
      unstable(10, 1),
      unstable(11, 2),
      unstable(12, 3),
      unstable(13, 4),
      release("v2.21.0"),
    ];
    expect(unstableReleasesToPrune(releases, 2).map((entry) => entry.tagName)).toEqual([
      unstable(11, 2).tagName,
      unstable(10, 1).tagName,
    ]);
    // A draft newer than every published one is kept off the index, so the
    // published one it would otherwise push out survives.
    const withDraft = [unstable(14, 5), ...releases].map((entry, index) =>
      index === 0 ? { ...entry, isDraft: true } : entry,
    );
    expect(unstableReleasesToPrune(withDraft, 1).map((entry) => entry.tagName)).not.toContain(
      unstable(13, 4).tagName,
    );
  });

  test("deletes each pruned release with its tag", () => {
    const { runtime, run } = runtimeFor([unstable(10, 1), unstable(11, 2)]);
    expect(pruneUnstableReleases(runtime, 1)).toEqual([unstable(10, 1).tagName]);
    expect(run.mock.calls[0]![0]).toEqual([
      "gh",
      "release",
      "delete",
      unstable(10, 1).tagName,
      "--repo",
      "orkestrator-ai/orkestrator-v2",
      "--cleanup-tag",
      "--yes",
    ]);
    expect(() => pruneUnstableReleases(runtime, 0)).toThrow("positive integer");
  });
});

test("refuses unknown commands", async () => {
  const { runtime } = runtimeFor([]);
  await expect(runChannelIndex(["publish", "--now"], runtime)).rejects.toThrow("usage:");
});

test("signed unstable publication tolerates legacy unsigned stable and beta", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const key = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString(
    "base64",
  );
  const version = "2.22.0-unstable.20261015.1.gaaaaaaa";
  const signed = release(`v${version}`, {
    assets: ["release-requirements.json", "release-requirements.json.sig"],
  });
  const { runtime } = runtimeFor([release("v2.21.0"), release("v2.22.0-beta.1"), signed], {
    keys: [key],
    signatures: {
      [signed.tagName]: sign(null, manifestBytes(version), privateKey).toString("base64"),
    },
  });
  const index = await computeReleaseChannelIndex(runtime);
  expect(index.channels.stable).toBeNull();
  expect(index.channels.beta).toBeNull();
  expect(index.channels.unstable?.version).toBe(version);
});

test("repository lock excludes a stale publisher and retry recomputes after the newer release", async () => {
  const releases = [release("v2.21.0")];
  const first = runtimeFor(releases, { indexRelease: { isPrerelease: true, isDraft: false } });
  const second = runtimeFor(releases, { indexRelease: { isPrerelease: true, isDraft: false } });
  let locked = false;
  let competing: Promise<string> | undefined;
  const instrument = (runtime: ChannelIndexRuntime, startCompetitor: boolean) => {
    const run = runtime.run;
    runtime.run = (command) => {
      if (command.includes("POST")) {
        if (locked) throw new Error("422 reference already exists");
        locked = true;
      } else if (command.includes("DELETE")) locked = false;
      else if (command[2] === "upload" && startCompetitor) {
        releases.push(release("v2.22.0"));
        competing = publishReleaseChannelIndex(second.runtime);
        // Observe rejection immediately, before the first upload releases the lock.
        void competing.catch(() => undefined);
      }
      run(command);
    };
  };
  instrument(first.runtime, true);
  instrument(second.runtime, false);
  await publishReleaseChannelIndex(first.runtime);
  await expect(competing!).rejects.toThrow("Could not acquire");
  expect(second.run).not.toHaveBeenCalled();
  const latest = JSON.parse(await publishReleaseChannelIndex(second.runtime));
  expect(latest.channels.stable.version).toBe("2.22.0");
  expect(locked).toBe(false);
});
