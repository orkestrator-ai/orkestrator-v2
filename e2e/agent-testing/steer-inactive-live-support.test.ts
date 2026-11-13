import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  fakeCursorStorePath,
  fakeCursorTurns,
  readyPrompt,
  REAL_ENTRY_SUFFIX,
  selectedSteerPlatforms,
  steerPrompt,
  steersCarrying,
  swapBridgeEntry,
} from "./steer-inactive-live-support";
import { steerStep } from "./steer-inactive-fake-claude";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "steer-inactive-support-"));
  directories.push(directory);
  return directory;
}

test("the swap puts the bundle in place and restore brings the real entry back", () => {
  const entry = path.join(scratch(), "index.js");
  writeFileSync(entry, "real bridge");
  const restore = swapBridgeEntry(entry, "fake bridge");
  expect(readFileSync(entry, "utf8")).toBe("fake bridge");
  expect(readFileSync(`${entry}${REAL_ENTRY_SUFFIX}`, "utf8")).toBe("real bridge");
  restore();
  expect(readFileSync(entry, "utf8")).toBe("real bridge");
  expect(existsSync(`${entry}${REAL_ENTRY_SUFFIX}`)).toBe(false);
  // A second restore has nothing left to do.
  restore();
  expect(readFileSync(entry, "utf8")).toBe("real bridge");
});

test("a backup left by an interrupted run is kept as the real entry", () => {
  const entry = path.join(scratch(), "index.js");
  writeFileSync(`${entry}${REAL_ENTRY_SUFFIX}`, "real bridge");
  writeFileSync(entry, "stale fake bridge");
  const restore = swapBridgeEntry(entry, "fake bridge");
  expect(readFileSync(`${entry}${REAL_ENTRY_SUFFIX}`, "utf8")).toBe("real bridge");
  restore();
  expect(readFileSync(entry, "utf8")).toBe("real bridge");
});

test("a missing entry is refused before anything is written", () => {
  const entry = path.join(scratch(), "index.js");
  expect(() => swapBridgeEntry(entry, "fake bridge")).toThrow("bridge entry not found");
  expect(existsSync(entry)).toBe(false);
});

test("Codex keeps its own opt-in; Claude and Cursor run scripted or, when named, real", () => {
  expect([...selectedSteerPlatforms({})]).toEqual([]);
  expect([...selectedSteerPlatforms({ ORKESTRATOR_AGENT_TEST_REVIEW: "1" })]).toEqual([
    ["codex", "real"],
  ]);
  expect([...selectedSteerPlatforms({ ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS: "1" })]).toEqual([
    ["claude", "scripted"],
    ["cursor", "scripted"],
  ]);
  expect([
    ...selectedSteerPlatforms({
      ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS: "1",
      ORKESTRATOR_AGENT_TEST_STEER_PLATFORMS: "cursor",
      ORKESTRATOR_AGENT_TEST_STEER_REAL_PLATFORMS: "claude",
    }),
  ]).toEqual([
    ["cursor", "scripted"],
    ["claude", "real"],
  ]);
  expect(() =>
    selectedSteerPlatforms({
      ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS: "1",
      ORKESTRATOR_AGENT_TEST_STEER_PLATFORMS: "codex",
    }),
  ).toThrow("not codex");
  expect(() =>
    selectedSteerPlatforms({
      ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS: "1",
      ORKESTRATOR_AGENT_TEST_STEER_REAL_PLATFORMS: "cursor",
    }),
  ).toThrow("both a real and a scripted model");
});

test("the fake vendor store is read per environment, and steers are counted by marker", () => {
  const dataDir = scratch();
  expect(fakeCursorTurns(dataDir, "env-1")).toEqual([]);
  const file = fakeCursorStorePath(dataDir, "env-1");
  expect(file.startsWith(path.join(dataDir, "cursor-bridge-state"))).toBe(true);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      agents: {
        a: {
          turns: [{ runId: "r1", prompt: "HOLD", status: "running", steers: [steerPrompt("m-1")] }],
        },
      },
    }),
  );
  const turns = fakeCursorTurns(dataDir, "env-1");
  expect(turns).toHaveLength(1);
  expect(steersCarrying(turns, "m-1")).toBe(1);
  expect(steersCarrying(turns, "m-2")).toBe(0);
  expect(fakeCursorTurns(dataDir, "env-2")).toEqual([]);
});

test("the spec's prompts are the ones the scripted models act on", () => {
  expect(readyPrompt("cursor", "scripted")).toContain("HOLD");
  // A real model is asked only for what it can do.
  expect(readyPrompt("cursor", "real")).not.toContain("HOLD");
  expect(readyPrompt("claude", "scripted")).not.toContain("HOLD");
  const tools = [{ name: "Bash" }];
  expect(
    steerStep({ tools, messages: [{ role: "user", content: readyPrompt("claude", "scripted") }] }),
  ).toMatchObject({
    kind: "shell",
    command: expect.stringContaining(".qa-queued-ready"),
  });
  expect(
    steerStep({
      tools,
      messages: [
        { role: "user", content: readyPrompt("claude", "scripted") },
        { role: "user", content: steerPrompt("queued-steer-42") },
      ],
    }),
  ).toMatchObject({ kind: "shell", command: expect.stringContaining("'queued-steer-42' >>") });
});
