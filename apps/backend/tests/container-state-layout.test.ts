import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  PINNED_TOOLCHAIN_VERSIONS,
  agentPlatformForToolchain,
} from "@orkestrator/toolchain/manifest";
import {
  PROVIDER_PRESERVATION,
  PROVIDER_STATE_LAYOUT,
  PROVIDER_STATE_TRACED_VERSIONS,
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
    // Only each platform's own binary. `opencode2` is pinned beside 1.x before
    // any provider runs it; its state is traced when the 2.x provider lands
    // (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 3).
    const platformPins: Record<string, string> = Object.fromEntries(
      Object.entries(PINNED_TOOLCHAIN_VERSIONS).filter(
        ([name]) => agentPlatformForToolchain(name) === name,
      ),
    );
    expect<Record<string, string>>(PROVIDER_STATE_TRACED_VERSIONS).toEqual({
      ...platformPins,
      cursor: cursorSdkPin(),
    });
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
