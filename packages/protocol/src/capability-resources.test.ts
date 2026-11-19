import { describe, expect, test } from "bun:test";

import {
  canonicalGitRepo,
  capabilityComponentId,
  capabilityPackageId,
  isCapabilitySelector,
  isPackageSource,
  isSafeCapabilityRelativePath,
  maxCapabilityRisk,
  parseCapabilityComponentId,
  statusFromEvidence,
  summarizeCapabilityTargets,
} from "./capability-resources.js";

describe("package identity", () => {
  test("one repository has one canonical address however it is written", () => {
    const forms = [
      "https://github.com/Org/Agent-Tools",
      "https://github.com/org/agent-tools.git",
      "https://github.com/org/agent-tools/",
      "git@github.com:Org/Agent-Tools.git",
      "ssh://git@github.com/org/agent-tools",
    ];
    expect(new Set(forms.map(canonicalGitRepo))).toEqual(new Set(["github.com/org/agent-tools"]));
  });

  test("explicit nondefault ports remain distinct Git origins", () => {
    expect(canonicalGitRepo("https://git.example.invalid:8443/team/tools.git")).toBe(
      "git.example.invalid:8443/team/tools",
    );
    expect(canonicalGitRepo("https://git.example.invalid:9443/team/tools.git")).toBe(
      "git.example.invalid:9443/team/tools",
    );
    expect(canonicalGitRepo("https://github.com:443/Org/Tools.git")).toBe("github.com/org/tools");
  });

  test("identity is source and subpath, never the display name or channel", () => {
    const a = capabilityPackageId({
      kind: "git",
      repo: "https://github.com/a/b",
      subpath: "skills/review",
      channel: "main",
    });
    const b = capabilityPackageId({
      kind: "git",
      repo: "git@github.com:a/b.git",
      subpath: "./skills/review/",
      channel: "v2",
    });
    expect(a).toBe(b);
    expect(a).toBe("git:github.com/a/b//skills/review");
  });

  test("two marketplaces publishing the same short name are two packages", () => {
    const official = capabilityPackageId({
      kind: "provider-marketplace",
      provider: "claude",
      qualifiedId: "review@official",
    });
    const team = capabilityPackageId({
      kind: "provider-marketplace",
      provider: "claude",
      qualifiedId: "review@team",
    });
    expect(official).not.toBe(team);
    expect(capabilityComponentId(official, "native-plugin", "review")).not.toBe(
      capabilityComponentId(team, "native-plugin", "review"),
    );
  });

  test("component ids round-trip, including package ids with # and :", () => {
    const pkg = "registry:my-source:@team/x";
    const id = capabilityComponentId(pkg, "mcp-server", "docs");
    expect(parseCapabilityComponentId(id)).toEqual({
      packageId: pkg,
      kind: "mcp-server",
      key: "docs",
    });
    expect(parseCapabilityComponentId("nonsense")).toBeNull();
  });

  test("sources are validated", () => {
    expect(isPackageSource({ kind: "git", repo: "https://x/y", subpath: "" })).toBe(true);
    expect(isPackageSource({ kind: "git", repo: "https://x/y", subpath: "../escape" })).toBe(false);
    expect(
      isPackageSource({ kind: "provider-marketplace", provider: "nobody", qualifiedId: "a@b" }),
    ).toBe(false);
    expect(
      isPackageSource({ kind: "local", sourceMachineId: "bk_1", sourceId: "claude-user-skills/x" }),
    ).toBe(true);
  });
});

describe("paths and selectors", () => {
  test("only safe relative paths are accepted", () => {
    expect(isSafeCapabilityRelativePath("skills/review/SKILL.md")).toBe(true);
    for (const bad of ["/etc/passwd", "../x", "a/../b", "a//b", "C:/x", "a\\b", "", "a/./b"]) {
      expect(isSafeCapabilityRelativePath(bad)).toBe(false);
    }
  });

  test("selectors name known kinds", () => {
    expect(isCapabilitySelector("*")).toBe(true);
    expect(isCapabilitySelector("provider:pi")).toBe(true);
    expect(isCapabilitySelector("provider:nope")).toBe(false);
    expect(isCapabilitySelector("group:development")).toBe(true);
    expect(isCapabilitySelector("path:/etc")).toBe(false);
  });
});

describe("statuses", () => {
  test("a file copy is never ready without runtime evidence", () => {
    expect(
      statusFromEvidence({ level: "present", runtimeInventory: false, sessionRunning: false }),
    ).toBe("installed-next-session");
    expect(
      statusFromEvidence({ level: "enabled", runtimeInventory: true, sessionRunning: true }),
    ).toBe("queued-until-idle");
    expect(
      statusFromEvidence({ level: "advertised", runtimeInventory: true, sessionRunning: false }),
    ).toBe("ready");
    expect(
      statusFromEvidence({ level: "requested", runtimeInventory: true, sessionRunning: false }),
    ).toBe("pending");
  });

  test("risk and summaries", () => {
    expect(maxCapabilityRisk(["instructions", "network", "executable"])).toBe("executable");
    expect(maxCapabilityRisk([])).toBe("instructions");
    expect(
      summarizeCapabilityTargets([{ status: "ready" }, { status: "offline" }, { status: "ready" }]),
    ).toEqual({
      total: 3,
      byStatus: { ready: 2, offline: 1 },
    });
  });
});
