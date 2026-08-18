import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  assertProfileIsolatedFromProduction,
  assertSafeProfileResetTarget,
  defaultRuntimeProfileRoots,
  normalizeRuntimeProfileId,
  parseRuntimeProfile,
  resolveRuntimeProfile,
} from "./runtime-profile";

const roots = {
  developmentRoot: path.join(path.sep, "safe", "orkestrator-v2-dev"),
  productionDataDir: path.join(path.sep, "safe", "orkestrator-v2"),
  homeDir: path.join(path.sep, "safe"),
};

describe("runtime profiles", () => {
  test("normalizes caller names conservatively", () => {
    expect(normalizeRuntimeProfileId(" Agent 123 / QA ")).toBe("agent-123-qa");
    expect(() => normalizeRuntimeProfileId("...///")).toThrow();
  });

  test("derives distinct mutable state and Docker identities per profile and workspace", () => {
    const first = resolveRuntimeProfile({ repositoryRoot: "/repo/a", requestedId: "one", roots });
    const second = resolveRuntimeProfile({ repositoryRoot: "/repo/a", requestedId: "two", roots });
    const otherWorkspace = resolveRuntimeProfile({
      repositoryRoot: "/repo/b",
      requestedId: "one",
      roots,
    });

    expect(first.dataDir).not.toBe(second.dataDir);
    expect(first.worktreeDir).not.toBe(second.worktreeDir);
    expect(first.dockerOwner).not.toBe(second.dockerOwner);
    expect(first.dockerImage).toBe(second.dockerImage);
    expect(first.dockerImage).not.toBe(otherWorkspace.dockerImage);
    expect(first.dataDir.startsWith(first.profileRoot)).toBe(true);
  });

  test("refuses production nesting and unsafe reset targets", () => {
    expect(() =>
      assertProfileIsolatedFromProduction(
        path.join(roots.productionDataDir, "agent"),
        roots.productionDataDir,
      ),
    ).toThrow("production data directory");

    const profile = resolveRuntimeProfile({ repositoryRoot: "/repo/a", requestedId: "one", roots });
    expect(() => assertSafeProfileResetTarget({ profile, roots, sentinel: null })).toThrow(
      "sentinel",
    );
    expect(() =>
      assertSafeProfileResetTarget({
        profile,
        roots,
        sentinel: { version: 1, profile: "two" },
      }),
    ).toThrow("sentinel");
    expect(() =>
      assertSafeProfileResetTarget({
        profile,
        roots,
        sentinel: { version: 1, profile: "one" },
      }),
    ).not.toThrow();
  });

  test("validates a stored platform selection at the file boundary", () => {
    const safe = resolveRuntimeProfile({
      repositoryRoot: "/repo/a",
      requestedId: "safe",
      roots,
      agentPlatforms: ["grok", "cursor", "grok"],
    });
    expect(safe.agentPlatforms).toEqual(["grok", "cursor"]);
    expect(parseRuntimeProfile({ ...safe }).agentPlatforms).toEqual(["grok", "cursor"]);
    // The selection decides which executables get provisioned, so a profile file
    // must not be able to name something that is not an agent platform.
    expect(() => parseRuntimeProfile({ ...safe, agentPlatforms: ["cursor", "sh"] })).toThrow(
      "agentPlatforms is invalid",
    );
    expect(() => parseRuntimeProfile({ ...safe, agentPlatforms: "cursor" as never })).toThrow(
      "agentPlatforms is invalid",
    );
  });

  test("reads a profile written before platform selection existed", () => {
    const safe = resolveRuntimeProfile({ repositoryRoot: "/repo/a", requestedId: "safe", roots });
    const { agentPlatforms: _omitted, ...legacy } = safe;
    // Such a profile provisioned nothing, which is what an empty selection means.
    // Failing the parse instead would make dev:stop and dev:reset fall back to a
    // profile rebuilt from arguments rather than the one on disk.
    expect(parseRuntimeProfile(legacy).agentPlatforms).toEqual([]);
  });

  test("refuses a loaded development profile rooted in production state", () => {
    const roots = defaultRuntimeProfileRoots();
    const safe = resolveRuntimeProfile({ repositoryRoot: "/repo/a", requestedId: "safe" });
    const profileRoot = path.join(roots.productionDataDir, "injected-profile");
    expect(() =>
      parseRuntimeProfile({
        ...safe,
        profileRoot,
        dataDir: path.join(profileRoot, "data"),
        runtimeDir: path.join(profileRoot, "runtime"),
        worktreeDir: path.join(profileRoot, "worktrees"),
        logDir: path.join(profileRoot, "logs"),
        fixtureDir: path.join(profileRoot, "fixtures"),
      }),
    ).toThrow("production data directory");
  });
});
