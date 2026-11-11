import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { keepRecentTokensForShortSessions, profilePiAgentDirectory } from "./pi-profile-settings";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function profile(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pi-profile-settings-"));
  roots.push(root);
  return path.join(root, "data");
}

const settingsOf = (dataDir: string) =>
  path.join(dataDir, "agent-credentials", "home", ".pi", "agent", "settings.json");

test("keepRecentTokens is set beside the other settings and restored exactly", () => {
  const dataDir = profile();
  const settings = settingsOf(dataDir);
  mkdirSync(path.dirname(settings), { recursive: true });
  const original = `${JSON.stringify({ defaultModel: "m", compaction: { reserveTokens: 9 } })}\n`;
  writeFileSync(settings, original);

  const restore = keepRecentTokensForShortSessions(dataDir);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
    defaultModel: "m",
    compaction: { reserveTokens: 9, keepRecentTokens: 1 },
  });
  restore();
  expect(readFileSync(settings, "utf8")).toBe(original);
});

test("a profile with no Pi settings gets a file that the restore removes", () => {
  const dataDir = profile();
  const restore = keepRecentTokensForShortSessions(dataDir);
  expect(JSON.parse(readFileSync(settingsOf(dataDir), "utf8"))).toEqual({
    compaction: { keepRecentTokens: 1 },
  });
  restore();
  expect(existsSync(settingsOf(dataDir))).toBe(false);
});

test("a Pi directory or settings file that leads out of the profile is refused", () => {
  const dataDir = profile();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-profile-outside-"));
  roots.push(outside);
  const home = path.join(dataDir, "agent-credentials", "home");
  mkdirSync(home, { recursive: true });
  symlinkSync(outside, path.join(home, ".pi"));
  expect(() => profilePiAgentDirectory(dataDir)).toThrow("escapes the profile");
  // Refused before anything was created through the link.
  expect(existsSync(path.join(outside, "agent"))).toBe(false);

  const other = profile();
  const settings = settingsOf(other);
  mkdirSync(path.dirname(settings), { recursive: true });
  const target = path.join(outside, "settings.json");
  writeFileSync(target, "{}\n");
  symlinkSync(target, settings);
  expect(() => keepRecentTokensForShortSessions(other)).toThrow("is a link");
  expect(readFileSync(target, "utf8")).toBe("{}\n");
});
