import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  PINNED_TOOLCHAIN_VERSIONS,
  agentToolchainsForPlatform,
} from "@orkestrator/toolchain/manifest";
import {
  OPENCODE2_DB_PATH,
  OPENCODE2_LEGACY_DB_PATH,
  OPENCODE_DB_DIRECTORY,
  OPENCODE_DB_PATH,
  PROVIDER_PRESERVATION,
  PROVIDER_STATE_LAYOUT,
  PROVIDER_STATE_TRACED_VERSIONS,
  persistentStateExports,
} from "../src/core/container-state-layout";

const repoRoot = join(import.meta.dir, "..", "..", "..");

function cursorSdkPin(): string {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "bridges", "cursor-bridge", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  return pkg.dependencies?.["@cursor/sdk"] ?? "";
}

describe("provider state layout re-trace", () => {
  // A failure here means an agent was upgraded without re-tracing the paths
  // its state lives at. Follow "Re-trace preserved provider state" in
  // docs/development/upgrade-agents.md, then record the new version.
  test("was traced against every pinned provider version", () => {
    expect(Object.keys(PROVIDER_STATE_TRACED_VERSIONS).sort()).toEqual([...AGENT_PLATFORMS].sort());
    // Each platform's one pinned CLI (OpenCode's is the toolchain's `opencode2`).
    const platformPins: Record<string, string> = {};
    for (const platform of AGENT_PLATFORMS) {
      const tools = agentToolchainsForPlatform(platform);
      if (tools.length === 0) continue;
      expect(tools).toHaveLength(1);
      platformPins[platform] = PINNED_TOOLCHAIN_VERSIONS[tools[0]!];
    }
    expect(platformPins.opencode).toBe(PINNED_TOOLCHAIN_VERSIONS.opencode2);
    expect<Record<string, string>>(PROVIDER_STATE_TRACED_VERSIONS).toEqual({
      ...platformPins,
      cursor: cursorSdkPin(),
    });
  });

  test("OpenCode 2.x never opens 1.x's database, with or without the persistent mount", () => {
    const exports = persistentStateExports("opencode2");
    expect(exports).toContain(`export OPENCODE_DB=${OPENCODE2_DB_PATH}`);
    expect(exports).toContain(`export OPENCODE_DB=${OPENCODE2_LEGACY_DB_PATH}`);
    expect(exports).not.toContain(OPENCODE_DB_PATH);
    expect(OPENCODE2_DB_PATH.startsWith(`${OPENCODE_DB_DIRECTORY}/`)).toBe(true);
    // No mount of its own: storage sets initialized before 2.x stay valid.
    expect(
      PROVIDER_STATE_LAYOUT.filter((entry) => OPENCODE2_DB_PATH.startsWith(entry.containerPath)),
    ).toHaveLength(1);
  });

  test("every provider has preserved state and a preservation claim", () => {
    for (const provider of AGENT_PLATFORMS) {
      expect(PROVIDER_STATE_LAYOUT.some((entry) => entry.provider === provider)).toBe(true);
      const claim = PROVIDER_PRESERVATION[provider];
      // A partial claim must say what is lost; a full one must not hedge.
      expect(claim.limitations === null).toBe(claim.level === "full");
    }
  });

  test("each path is mounted once, from its own sub-directory", () => {
    const subdirs = PROVIDER_STATE_LAYOUT.map((entry) => entry.subdir);
    const paths = PROVIDER_STATE_LAYOUT.map((entry) => entry.containerPath);
    expect(new Set(subdirs).size).toBe(subdirs.length);
    expect(new Set(paths).size).toBe(paths.length);
    for (const entry of PROVIDER_STATE_LAYOUT) {
      expect(entry.subdir.startsWith(`${entry.provider}/`)).toBe(true);
    }
  });
});
