import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadAgentPlatformSelection,
  saveAgentPlatformSelection,
} from "./agent-platform-selection";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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
    expect(JSON.parse(await readFile(path.join(directory, "agent-platforms.json"), "utf8"))).toEqual({
      version: 1,
      enabled: ["cursor", "grok"],
    });
  });
});
