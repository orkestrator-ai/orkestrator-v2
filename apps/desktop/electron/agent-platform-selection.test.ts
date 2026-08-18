import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyAgentTestPlatformSelection,
  loadAgentPlatformSelection,
  saveAgentPlatformSelection,
} from "./agent-platform-selection";
import { pinnedArtifactsForPlatforms } from "./toolchain-manifest";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "orkestrator-platforms-"));
  directories.push(directory);
  return directory;
}

describe("first-run agent platform selection", () => {
  test("prompts a fresh installation before toolchain download", async () => {
    expect(await loadAgentPlatformSelection(await temporaryDirectory())).toEqual({
      enabled: [],
      needsFirstRunChoice: true,
    });
  });

  test("keeps the legacy three platforms for an existing installation", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "config.json"), JSON.stringify({ global: {} }));
    expect(await loadAgentPlatformSelection(directory)).toEqual({
      enabled: ["claude", "codex", "opencode"],
      needsFirstRunChoice: false,
    });
  });

  test("persists a bounded, normalized sidecar for backend adoption", async () => {
    const directory = await temporaryDirectory();
    await saveAgentPlatformSelection(directory, ["grok", "cursor", "grok"]);
    expect(await loadAgentPlatformSelection(directory)).toEqual({
      enabled: ["cursor", "grok"],
      needsFirstRunChoice: false,
    });
    expect(
      JSON.parse(await readFile(path.join(directory, "agent-platforms.json"), "utf8")),
    ).toEqual({
      version: 1,
      enabled: ["cursor", "grok"],
    });
  });
});

describe("agent-test platform selection", () => {
  test("enables the launcher's selection in a fresh isolated profile", async () => {
    const directory = await temporaryDirectory();
    await applyAgentTestPlatformSelection(directory, ["cursor", "grok"]);
    // Provisioning the toolchain is only half of launchability: the backend
    // derives the app's enabled platforms from this profile's own state, so a
    // selection that never lands here downloads Cursor and Grok and then offers
    // neither.
    expect(await loadAgentPlatformSelection(directory)).toEqual({
      enabled: ["cursor", "grok"],
      needsFirstRunChoice: false,
    });
  });

  test("reconciles a profile whose config.json already shadows the sidecar", async () => {
    const directory = await temporaryDirectory();
    // An existing config.json wins over the sidecar, so a profile that has saved
    // settings once would otherwise silently keep the legacy three.
    await writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({
        global: { defaultAgent: "claude", theme: "dark" },
        repositories: { "/repo": { branchPrefix: "qa" } },
      }),
    );

    await applyAgentTestPlatformSelection(directory, ["cursor", "grok"]);

    const config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")) as {
      global: Record<string, unknown>;
      repositories: unknown;
    };
    expect(config.global.enabledAgentPlatforms).toEqual(["cursor", "grok"]);
    // A default pointing at a platform this run did not provision would fail at
    // session creation rather than at the picker.
    expect(config.global.defaultAgent).toBe("cursor");
    expect(config.global.theme).toBe("dark");
    expect(config.repositories).toEqual({ "/repo": { branchPrefix: "qa" } });
    expect(await loadAgentPlatformSelection(directory)).toEqual({
      enabled: ["cursor", "grok"],
      needsFirstRunChoice: false,
    });
  });

  test("keeps a default agent the selection still contains", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({
        global: { defaultAgent: "codex" },
      }),
    );

    await applyAgentTestPlatformSelection(directory, ["codex", "cursor"]);

    const config = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")) as {
      global: Record<string, unknown>;
    };
    expect(config.global.defaultAgent).toBe("codex");
    expect(config.global.enabledAgentPlatforms).toEqual(["codex", "cursor"]);
  });

  test("writes nothing for an empty selection", async () => {
    const directory = await temporaryDirectory();
    await applyAgentTestPlatformSelection(directory, []);
    // saveAgentPlatformSelection rejects an empty list, and a profile with no
    // selection is a caller bug rather than a reason to fail Electron startup.
    await expect(readFile(path.join(directory, "agent-platforms.json"))).rejects.toThrow();
  });
});

describe("pinned artifacts for a platform selection", () => {
  test("downloads only what the selection enables", () => {
    expect(
      pinnedArtifactsForPlatforms(["cursor", "grok"], "darwin", "arm64").map((a) => a.name),
    ).toEqual(["cursor", "grok"]);
    expect(pinnedArtifactsForPlatforms(["claude"], "linux", "x64").map((a) => a.name)).toEqual([
      "claude",
    ]);
  });

  test("selects nothing when no platform is enabled", () => {
    // What an agent-test profile used to do, which is why Cursor and Grok were
    // unlaunchable in exactly the profiles meant to test them.
    expect(pinnedArtifactsForPlatforms([], "darwin", "arm64")).toEqual([]);
  });
});
