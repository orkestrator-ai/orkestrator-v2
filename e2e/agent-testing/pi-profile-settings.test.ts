import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  editProfilePiFiles,
  keepRecentTokensForShortSessions,
  profilePiAgentDirectory,
} from "./pi-profile-settings";

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

test("a dangling settings link is refused without creating its target or removing the link", () => {
  const dataDir = profile();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-profile-outside-"));
  roots.push(outside);
  const settings = settingsOf(dataDir);
  mkdirSync(path.dirname(settings), { recursive: true });
  // The target's directory exists but the target does not, so existsSync on
  // the link answers false although a write through it would succeed.
  const target = path.join(outside, "settings.json");
  symlinkSync(target, settings);

  expect(() => keepRecentTokensForShortSessions(dataDir)).toThrow("is a link");
  expect(existsSync(target)).toBe(false);
  expect(lstatSync(settings).isSymbolicLink()).toBe(true);
  expect(readlinkSync(settings)).toBe(target);
});

test("a dangling Pi directory link is refused before anything is created through it", () => {
  const dataDir = profile();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-profile-outside-"));
  roots.push(outside);
  const home = path.join(dataDir, "agent-credentials", "home");
  mkdirSync(home, { recursive: true });
  const target = path.join(outside, "pi");
  symlinkSync(target, path.join(home, ".pi"));

  expect(() => profilePiAgentDirectory(dataDir)).toThrow("escapes the profile");
  expect(existsSync(target)).toBe(false);
});

test("every file an edit names is checked before any is written", () => {
  const dataDir = profile();
  const outside = mkdtempSync(path.join(tmpdir(), "pi-profile-outside-"));
  roots.push(outside);
  const settings = settingsOf(dataDir);
  const models = path.join(path.dirname(settings), "models.json");
  mkdirSync(path.dirname(settings), { recursive: true });
  symlinkSync(path.join(outside, "models.json"), models);

  expect(() =>
    editProfilePiFiles(dataDir, {
      "settings.json": (current) => ({ ...current, defaultModel: "m" }),
      "models.json": (current) => ({ ...current, providers: {} }),
    }),
  ).toThrow("models.json is a link");
  expect(existsSync(settings)).toBe(false);
  expect(existsSync(path.join(outside, "models.json"))).toBe(false);
  expect(() => editProfilePiFiles(dataDir, { "../settings.json": (current) => current })).toThrow(
    "Not a Pi file name",
  );
});

test("an edit of several files is restored exactly", () => {
  const dataDir = profile();
  const settings = settingsOf(dataDir);
  const models = path.join(path.dirname(settings), "models.json");
  mkdirSync(path.dirname(settings), { recursive: true });
  writeFileSync(models, '{"providers":{"kept":{}}}\n');

  const restore = editProfilePiFiles(dataDir, {
    "models.json": (current) => ({
      ...current,
      providers: { ...(current.providers as object), fake: { baseUrl: "http://127.0.0.1:1" } },
    }),
    "settings.json": (current) => ({ ...current, defaultProvider: "fake" }),
  });
  expect(JSON.parse(readFileSync(models, "utf8"))).toEqual({
    providers: { kept: {}, fake: { baseUrl: "http://127.0.0.1:1" } },
  });
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ defaultProvider: "fake" });
  restore();
  expect(readFileSync(models, "utf8")).toBe('{"providers":{"kept":{}}}\n');
  expect(existsSync(settings)).toBe(false);
});
