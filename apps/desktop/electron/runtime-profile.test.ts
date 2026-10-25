import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertProfileIsolatedFromProduction,
  assertSafeProfileResetTarget,
  AGENT_TEST_PREVIEW_RETENTION_ENV,
  chromiumSwitchesForRuntime,
  defaultRuntimeProfileRoots,
  isExternalWorktreeDir,
  normalizeRuntimeProfileId,
  parseRuntimeProfile,
  PREVIEW_RETENTION_TIMING,
  previewRetentionTimingForRuntime,
  resolveRuntimeProfile,
} from "./runtime-profile";
import { APP_SLUG } from "./app-constants";
import {
  RUNTIME_APP_SLUG,
  runtimeProfileStatusPath,
} from "@orkestrator/protocol/node/runtime-profile-status";

const roots = {
  developmentRoot: path.join(path.sep, "safe", "orkestrator-v2-dev"),
  productionDataDir: path.join(path.sep, "safe", "orkestrator-v2"),
  homeDir: path.join(path.sep, "safe"),
};

describe("runtime profiles", () => {
  test("shares its data-root slug and status path with the published client", () => {
    // The CLI resolves --profile through the protocol copy; a drifted slug or
    // layout would send it to a different (or production) data root.
    expect(RUNTIME_APP_SLUG).toBe(APP_SLUG);
    const profile = resolveRuntimeProfile({
      repositoryRoot: "/repo/a",
      requestedId: "QA 1",
      roots,
    });
    expect(runtimeProfileStatusPath(roots.developmentRoot, "QA 1").statusPath).toBe(
      path.join(profile.runtimeDir, "status.json"),
    );
  });

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

  test("keeps worktrees in a chosen folder named after the profile", () => {
    const profile = resolveRuntimeProfile({
      repositoryRoot: "/repo/a",
      requestedId: "one",
      roots,
      worktreeRoot: "/trees/dev",
    });
    expect(profile.worktreeDir).toBe(path.join("/trees/dev", "one"));
    expect(isExternalWorktreeDir(profile)).toBe(true);
    expect(parseRuntimeProfile(JSON.parse(JSON.stringify(profile))).worktreeDir).toBe(
      profile.worktreeDir,
    );
    expect(isExternalWorktreeDir(resolveRuntimeProfile({ repositoryRoot: "/repo/a", roots }))).toBe(
      false,
    );
  });

  test("refuses an outside worktree folder that is not the profile's own", () => {
    const profile = resolveRuntimeProfile({ repositoryRoot: "/repo/a", requestedId: "one", roots });
    expect(() => parseRuntimeProfile({ ...profile, worktreeDir: "/trees/shared" })).toThrow(
      "safe profile-owned folder",
    );
    expect(() =>
      resolveRuntimeProfile({
        repositoryRoot: "/repo/a",
        requestedId: "one",
        roots,
        worktreeRoot: roots.productionDataDir,
      }),
    ).toThrow("safe profile-owned folder");
    // A folder holding the profile itself would be deleted with its worktrees.
    expect(() =>
      resolveRuntimeProfile({
        repositoryRoot: "/repo/a",
        requestedId: "profiles",
        roots,
        worktreeRoot: roots.developmentRoot,
      }),
    ).toThrow("safe profile-owned folder");
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

test("rejects a worktree root equal to the profiles directory and round-trips accepted roots", () => {
  expect(() =>
    resolveRuntimeProfile({
      repositoryRoot: "/repo/a",
      requestedId: "qa",
      roots,
      worktreeRoot: path.join(roots.developmentRoot, "profiles"),
    }),
  ).toThrow("strict child");
  for (const worktreeRoot of [
    undefined,
    "/trees/dev",
    path.join(roots.developmentRoot, "profiles", "qa", "nested"),
  ]) {
    const profile = resolveRuntimeProfile({
      repositoryRoot: "/repo/a",
      requestedId: "qa",
      roots,
      worktreeRoot,
    });
    expect(parseRuntimeProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
  }
});

test("only an agent-test profile on macOS swaps the login keychain for a mock", () => {
  // A stale keychain item would otherwise block an unattended launch on an
  // access prompt; development and production keep the user's keychain.
  expect(chromiumSwitchesForRuntime("agent-test", "darwin")).toEqual(["use-mock-keychain"]);
  expect(chromiumSwitchesForRuntime("agent-test", "linux")).toEqual([]);
  expect(chromiumSwitchesForRuntime("development", "darwin")).toEqual([]);
  expect(chromiumSwitchesForRuntime("production", "darwin")).toEqual([]);
});

describe("preview partition retention timing", () => {
  const overridden = { [AGENT_TEST_PREVIEW_RETENTION_ENV]: "1500" };

  test("only an agent-test runtime honours the override", () => {
    expect(previewRetentionTimingForRuntime("agent-test", overridden)).toEqual({
      delayMs: 1_500,
      intervalMs: 1_500,
    });
    // An installed app (or a developer's own profile) never clears site data
    // on a schedule some leftover environment variable chose.
    expect(previewRetentionTimingForRuntime("production", overridden)).toEqual(
      PREVIEW_RETENTION_TIMING,
    );
    expect(previewRetentionTimingForRuntime("development", overridden)).toEqual(
      PREVIEW_RETENTION_TIMING,
    );
    expect(PREVIEW_RETENTION_TIMING).toEqual({ delayMs: 60_000, intervalMs: 30 * 60_000 });
  });

  test("an agent-test runtime keeps the default without a usable value", () => {
    for (const value of [
      undefined,
      "",
      " ",
      "abc",
      "1e3",
      "-5",
      "1.5",
      "99",
      "1800001",
      "9".repeat(20),
    ]) {
      expect(
        previewRetentionTimingForRuntime("agent-test", {
          [AGENT_TEST_PREVIEW_RETENTION_ENV]: value,
        }),
      ).toEqual(PREVIEW_RETENTION_TIMING);
    }
    expect(
      previewRetentionTimingForRuntime("agent-test", {
        [AGENT_TEST_PREVIEW_RETENTION_ENV]: " 100 ",
      }),
    ).toEqual({ delayMs: 100, intervalMs: 100 });
  });

  test("main schedules retention with the flavor-gated timing and never reads the variable itself", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).toContain("previewRetentionTimingForRuntime(runtimeFlavor)");
    expect(main).not.toContain(AGENT_TEST_PREVIEW_RETENTION_ENV);
    expect(main).not.toContain("AGENT_TEST_PREVIEW_RETENTION_ENV");
  });
});
