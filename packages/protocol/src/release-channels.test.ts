import { describe, expect, test } from "bun:test";
import {
  channelIncludes,
  compareReleaseVersions,
  containerTagsForVersion,
  newestIncludedRelease,
  npmDistTagForChannel,
  parseReleaseChannelIndex,
  parseSemver,
  releaseAssetUrl,
  releaseChannelOfVersion,
  resolveChannelUpdate,
  unstableBaseVersion,
  unstableVersion,
  type ReleaseChannelEntry,
  type ReleaseChannelIndex,
} from "./release-channels.js";

const SHA = "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567";
const DIGEST = "a".repeat(64);

function entry(version: string): ReleaseChannelEntry {
  return {
    version,
    tag: `v${version}`,
    publishedAt: "2026-10-15T03:00:00Z",
    requirementsSha256: DIGEST,
  };
}

function index(channels: Partial<ReleaseChannelIndex["channels"]>): ReleaseChannelIndex {
  return {
    schema: "orkestrator-release-channels",
    schemaVersion: 1,
    repository: "orkestrator-ai/orkestrator-v2",
    generatedAt: "2026-10-15T03:00:00Z",
    channels: { stable: null, beta: null, unstable: null, ...channels },
  };
}

describe("semver", () => {
  test.each(["2.21.0", "2.21.0-beta.1", "0.0.0", "1.2.3-alpha.0.x+build.5"])("parses %s", (v) =>
    expect(parseSemver(v)).not.toBeNull(),
  );

  test.each(["v2.21.0", "2.21", "02.1.0", "2.21.0-beta.01", "2.21.0-", "2.21.0-a..b", ""])(
    "rejects %s",
    (v) => expect(parseSemver(v)).toBeNull(),
  );

  test("orders by semver precedence, including channel prereleases", () => {
    const ordered = [
      "2.20.1",
      "2.21.0-beta.1",
      "2.21.0-beta.2",
      "2.21.0-beta.10",
      "2.21.0-unstable.20261014.9.gaaaaaaa",
      "2.21.0-unstable.20261015.10.g0000000",
      "2.21.0-unstable.20261015.11.g0000000",
      "2.21.0",
      "2.21.1-unstable.20261016.12.gbbbbbbb",
      "2.22.0",
    ];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      expect(compareReleaseVersions(ordered[i]!, ordered[i + 1]!)).toBe(-1);
      expect(compareReleaseVersions(ordered[i + 1]!, ordered[i]!)).toBe(1);
    }
    expect(compareReleaseVersions("2.21.0", "2.21.0")).toBe(0);
  });

  test("orders numeric identifiers beyond double precision", () => {
    expect(compareReleaseVersions("1.0.0-9007199254740993", "1.0.0-9007199254740992")).toBe(1);
  });

  test("throws instead of guessing on invalid input", () => {
    expect(() => compareReleaseVersions("2.21", "2.21.0")).toThrow("Not a semver");
  });
});

describe("channels", () => {
  test.each([
    ["2.21.0", "stable"],
    ["2.21.0-beta.3", "beta"],
    ["2.21.0-unstable.20261015.412.g3f2a9c1", "unstable"],
    ["2.21.0-unstable.20240229.1.g3f2a9c1d4e5f60718293a4b5c6d7e8f901234567", "unstable"],
  ] as const)("%s is on %s", (version, channel) =>
    expect(releaseChannelOfVersion(version)).toBe(channel),
  );

  test.each([
    "2.21.0-alpha.1",
    "2.21.0-rc.1",
    "2.21.0-beta",
    "2.21.0-beta.1.2",
    "2.21.0+build",
    "2.21.0-unstable.20261015.3f2a9c1",
    "2.21.0-unstable.20261015.0.g3f2a9c1",
    "2.21.0-unstable.20261315.1.g3f2a9c1",
    "2.21.0-unstable.20230229.1.g3f2a9c1",
    "2.21.0-unstable.20261015.1.gXYZ1234",
  ])("%s is not a channel version", (version) =>
    expect(releaseChannelOfVersion(version)).toBeNull(),
  );

  test("subscriptions nest", () => {
    expect(channelIncludes("stable", "stable")).toBe(true);
    expect(channelIncludes("stable", "beta")).toBe(false);
    expect(channelIncludes("beta", "stable")).toBe(true);
    expect(channelIncludes("beta", "unstable")).toBe(false);
    expect(channelIncludes("unstable", "beta")).toBe(true);
    expect(channelIncludes("unstable", "stable")).toBe(true);
  });

  test("npm dist-tags", () => {
    expect(npmDistTagForChannel("stable")).toBe("latest");
    expect(npmDistTagForChannel("beta")).toBe("beta");
    expect(npmDistTagForChannel("unstable")).toBe("unstable");
  });
});

describe("unstable versions", () => {
  test("bases on the next patch of a stable main, or main's own core for a prerelease", () => {
    expect(unstableBaseVersion("2.20.1")).toBe("2.20.2");
    expect(unstableBaseVersion("2.22.0-beta.3")).toBe("2.22.0");
  });

  test("builds a sortable, valid version even for an all-digit SHA", () => {
    const version = unstableVersion({
      mainVersion: "2.20.1",
      date: new Date("2026-10-15T23:59:00Z"),
      runNumber: 412,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(version).toBe("2.20.2-unstable.20261015.412.g0123456");
    expect(releaseChannelOfVersion(version)).toBe("unstable");
    const later = unstableVersion({
      mainVersion: "2.20.1",
      date: new Date("2026-10-15T23:59:30Z"),
      runNumber: 413,
      commitSha: "0000000000000000000000000000000000000000",
    });
    expect(compareReleaseVersions(later, version)).toBe(1);
    // Unstable of a beta's core sorts after that beta, before its stable.
    const fromBeta = unstableVersion({
      mainVersion: "2.22.0-beta.3",
      date: new Date("2026-10-16T00:00:00Z"),
      runNumber: 414,
      commitSha: SHA,
    });
    expect(compareReleaseVersions(fromBeta, "2.22.0-beta.3")).toBe(1);
    expect(compareReleaseVersions(fromBeta, "2.22.0")).toBe(-1);
  });

  test("refuses bad inputs", () => {
    const base = { mainVersion: "2.20.1", date: new Date("2026-10-15T00:00:00Z"), commitSha: SHA };
    expect(() => unstableVersion({ ...base, runNumber: 0 })).toThrow("runNumber");
    expect(() => unstableVersion({ ...base, runNumber: 1, commitSha: "xyz" })).toThrow("commitSha");
    expect(() => unstableVersion({ ...base, runNumber: 1, mainVersion: "main" })).toThrow("semver");
  });
});

describe("container tags", () => {
  test("only a stable version moves latest and the floating major/minor tags", () => {
    expect(containerTagsForVersion("2.21.0", SHA)).toEqual([
      "2.21.0",
      "2.21",
      "2",
      "latest",
      "stable",
      `sha-${SHA}`,
    ]);
    expect(containerTagsForVersion("2.22.0-beta.3", SHA)).toEqual([
      "2.22.0-beta.3",
      "beta",
      `sha-${SHA}`,
    ]);
    const unstable = "2.22.0-unstable.20261015.412.g3f2a9c1";
    expect(containerTagsForVersion(unstable, SHA)).toEqual([unstable, "unstable", `sha-${SHA}`]);
  });

  test("refuses non-channel versions and short SHAs", () => {
    expect(() => containerTagsForVersion("2.21.0-rc.1", SHA)).toThrow("not a release channel");
    expect(() => containerTagsForVersion("2.21.0", "3f2a9c1")).toThrow("full commit");
  });
});

describe("channel index", () => {
  test("parses a valid index and fills missing channels with null", () => {
    const parsed = parseReleaseChannelIndex({
      ...index({ stable: entry("2.21.0") }),
      channels: { stable: entry("2.21.0") },
    });
    expect(parsed.channels).toEqual({ stable: entry("2.21.0"), beta: null, unstable: null });
  });

  test.each([
    [{ schema: "other" }, "wrong schema"],
    [{ schemaVersion: 2 }, "Unsupported"],
    [{ repository: "x" }, "repository"],
    [{ channels: { stable: entry("2.21.0-beta.1") } }, "not a stable version"],
    [{ channels: { beta: { ...entry("2.21.0-beta.1"), tag: "v2.21.0" } } }, "tag"],
    [{ channels: { stable: { ...entry("2.21.0"), requirementsSha256: "AB" } } }, "SHA-256"],
    [{ channels: { stable: { ...entry("2.21.0"), publishedAt: "soon" } } }, "timestamp"],
  ])("rejects %j", (override, message) => {
    expect(() => parseReleaseChannelIndex({ ...index({}), ...override })).toThrow(message);
  });
});

describe("resolving an update", () => {
  const feed = index({
    stable: entry("2.21.0"),
    beta: entry("2.22.0-beta.2"),
    unstable: entry("2.22.0-unstable.20261015.412.g3f2a9c1"),
  });

  test("each subscription takes the newest release it includes", () => {
    expect(newestIncludedRelease(feed, "stable")?.entry.version).toBe("2.21.0");
    expect(newestIncludedRelease(feed, "beta")?.entry.version).toBe("2.22.0-beta.2");
    expect(newestIncludedRelease(feed, "unstable")?.entry.version).toBe(
      "2.22.0-unstable.20261015.412.g3f2a9c1",
    );
  });

  test("beta subscribers get a stable that is newer than every beta", () => {
    const newerStable = index({ stable: entry("2.23.0"), beta: entry("2.22.0-beta.2") });
    expect(
      resolveChannelUpdate({
        index: newerStable,
        subscribed: "beta",
        currentVersion: "2.22.0-beta.2",
      }),
    ).toEqual({ kind: "update", channel: "stable", entry: entry("2.23.0") });
  });

  test("offers a newer release and reports up to date otherwise", () => {
    expect(
      resolveChannelUpdate({ index: feed, subscribed: "stable", currentVersion: "2.20.1" }),
    ).toMatchObject({ kind: "update", channel: "stable" });
    expect(
      resolveChannelUpdate({ index: feed, subscribed: "stable", currentVersion: "2.21.0" }),
    ).toEqual({ kind: "up-to-date" });
  });

  test("never downgrades after moving to a narrower channel", () => {
    expect(
      resolveChannelUpdate({ index: feed, subscribed: "stable", currentVersion: "2.22.0-beta.2" }),
    ).toEqual({
      kind: "waiting-for-channel",
      newest: { channel: "stable", entry: entry("2.21.0") },
    });
    expect(
      resolveChannelUpdate({
        index: feed,
        subscribed: "beta",
        currentVersion: "2.22.0-unstable.20261015.412.g3f2a9c1",
      }),
    ).toMatchObject({ kind: "waiting-for-channel" });
  });

  test("a narrower channel that has caught up is offered normally", () => {
    const caughtUp = index({ stable: entry("2.22.0") });
    expect(
      resolveChannelUpdate({
        index: caughtUp,
        subscribed: "stable",
        currentVersion: "2.22.0-beta.2",
      }),
    ).toMatchObject({ kind: "update", entry: entry("2.22.0") });
  });

  test("an empty index is up to date, never an error", () => {
    expect(
      resolveChannelUpdate({ index: index({}), subscribed: "unstable", currentVersion: "2.21.0" }),
    ).toEqual({ kind: "up-to-date" });
  });
});

test("release asset URLs encode the tag and asset", () => {
  expect(releaseAssetUrl("v2.21.0", "release-requirements.json")).toBe(
    "https://github.com/orkestrator-ai/orkestrator-v2/releases/download/v2.21.0/release-requirements.json",
  );
  expect(releaseAssetUrl("v1", "a b", "http://127.0.0.1:9/feed/")).toBe(
    "http://127.0.0.1:9/feed/v1/a%20b",
  );
});
