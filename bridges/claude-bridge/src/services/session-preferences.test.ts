import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeHome,
  claudeSessionPreferencesDir,
  setClaudeHomeForTesting,
} from "./claude-home.js";
import {
  deleteSessionPreferences,
  MAX_DISPATCHED_REQUEST_IDS,
  readSessionPreferences,
  sessionPreferencesUnavailable,
  updateSessionPreferences,
} from "./session-preferences.js";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_SESSION_ID = "123e4567-e89b-42d3-a456-426614174001";

let testHome = "";

function preferencePath(sessionId = SESSION_ID): string {
  return join(
    claudeSessionPreferencesDir(),
    `${sessionId.toLowerCase()}.json`,
  );
}

describe("session preferences", () => {
  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), "claude-preferences-"));
    setClaudeHomeForTesting(testHome);
  });

  afterEach(async () => {
    setClaudeHomeForTesting(null);
    await rm(testHome, { recursive: true, force: true });
  });

  test("resolves the bridge-owned directory beneath the configured Claude home", () => {
    expect(claudeSessionPreferencesDir()).toBe(
      join(testHome, ".claude", "orkestrator", "session-preferences"),
    );
  });

  test("resetting the test override restores the operating-system home", () => {
    setClaudeHomeForTesting(null);
    expect(claudeHome()).toBe(homedir());
    setClaudeHomeForTesting(testHome);
  });

  test("accepts only canonical UUID-shaped ids and normalizes filename case", async () => {
    await updateSessionPreferences(SESSION_ID.toUpperCase(), {
      planMode: true,
    });
    await updateSessionPreferences("../outside", { planMode: false });
    await updateSessionPreferences(`${SESSION_ID}/nested`, {
      planMode: false,
    });

    expect(await readdir(claudeSessionPreferencesDir())).toEqual([
      `${SESSION_ID}.json`,
    ]);
    expect(await readSessionPreferences(SESSION_ID)).toEqual({
      planMode: true,
    });
    expect(await readSessionPreferences("../outside")).toBeUndefined();
  });

  test("returns undefined only for missing files and fails closed for malformed files", async () => {
    expect(await readSessionPreferences(SESSION_ID)).toBeUndefined();

    await mkdir(claudeSessionPreferencesDir(), { recursive: true });
    for (const raw of ["{", "[]", "null", "\"plan\"", "1"]) {
      await writeFile(preferencePath(), raw, "utf-8");
      expect(await readSessionPreferences(SESSION_ID)).toEqual({
        planMode: true,
      });
    }
  });

  test("fails closed when the preference path is unreadable", async () => {
    await mkdir(preferencePath(), { recursive: true });
    const preferences = await readSessionPreferences(SESSION_ID);
    expect(preferences).toEqual({
      planMode: true,
    });
    expect(sessionPreferencesUnavailable(preferences)).toBe(true);
  });

  test("filters, trims, deduplicates, and caps request ids from disk", async () => {
    await mkdir(claudeSessionPreferencesDir(), { recursive: true });
    const validIds = Array.from(
      { length: MAX_DISPATCHED_REQUEST_IDS + 4 },
      (_, index) => `request-${index}`,
    );
    await writeFile(
      preferencePath(),
      JSON.stringify({
        planMode: false,
        dispatchedRequestIds: [
          null,
          "",
          "   ",
          "duplicate",
          " duplicate ",
          "x".repeat(201),
          ...validIds,
        ],
      }),
      "utf-8",
    );

    const result = await readSessionPreferences(SESSION_ID);
    expect(result?.planMode).toBe(false);
    expect(result?.dispatchedRequestIds).toHaveLength(
      MAX_DISPATCHED_REQUEST_IDS,
    );
    expect(result?.dispatchedRequestIds).toEqual(
      validIds.slice(-MAX_DISPATCHED_REQUEST_IDS),
    );
  });

  test("fails closed for an incorrectly typed plan mode", async () => {
    await mkdir(claudeSessionPreferencesDir(), { recursive: true });
    await writeFile(
      preferencePath(),
      JSON.stringify({
        planMode: "yes",
        dispatchedRequestIds: "request-1",
        futurePreference: true,
      }),
      "utf-8",
    );

    const preferences = await readSessionPreferences(SESSION_ID);
    expect(preferences).toEqual({
      planMode: true,
    });
    expect(sessionPreferencesUnavailable(preferences)).toBe(true);
    await expect(
      updateSessionPreferences(SESSION_ID, {
        dispatchedRequestIds: ["request-2"],
      }),
    ).rejects.toThrow("refusing to overwrite the durable prompt journal");
  });

  test("keeps a well-formed client session alias", async () => {
    const alias = `session-client-${"0123456789abcdef".repeat(2)}`;
    await updateSessionPreferences(SESSION_ID, {
      clientSessionBridgeId: alias,
    });

    expect(await readSessionPreferences(SESSION_ID)).toEqual({
      clientSessionBridgeId: alias,
    });
  });

  test("fails closed for a malformed client session alias", async () => {
    await mkdir(claudeSessionPreferencesDir(), { recursive: true });
    const malformedAliases: unknown[] = [
      null,
      42,
      true,
      { id: `session-client-${"a".repeat(32)}` },
      "",
      "session-client-",
      `session-${SESSION_ID}`,
      // One hex digit short, one too long, and the uppercase form: the alias is
      // decoded back into a filename-bound SDK id, so only the canonical shape
      // may be trusted.
      `session-client-${"a".repeat(31)}`,
      `session-client-${"a".repeat(33)}`,
      `session-client-${"A".repeat(32)}`,
    ];

    for (const clientSessionBridgeId of malformedAliases) {
      await writeFile(
        preferencePath(),
        JSON.stringify({
          clientSessionBridgeId,
          planMode: false,
          dispatchedRequestIds: ["request-1"],
        }),
        "utf-8",
      );

      const preferences = await readSessionPreferences(SESSION_ID);
      expect(preferences).toEqual({ planMode: true });
      expect(sessionPreferencesUnavailable(preferences)).toBe(true);
    }

    // Rejecting the alias discards the whole document, so the dispatch journal
    // beside it is unknown and a later write must refuse rather than replace it
    // with one that has forgotten every accepted prompt.
    await expect(
      updateSessionPreferences(SESSION_ID, { planMode: false }),
    ).rejects.toThrow("refusing to overwrite the durable prompt journal");
  });

  test("merges fields and serializes concurrent updates to one session", async () => {
    await Promise.all([
      updateSessionPreferences(SESSION_ID, { planMode: true }),
      updateSessionPreferences(SESSION_ID.toUpperCase(), {
        dispatchedRequestIds: ["request-1"],
      }),
    ]);

    expect(await readSessionPreferences(SESSION_ID)).toEqual({
      planMode: true,
      dispatchedRequestIds: ["request-1"],
    });
    expect(JSON.parse(await readFile(preferencePath(), "utf-8"))).toEqual({
      planMode: true,
      dispatchedRequestIds: ["request-1"],
    });
    expect((await readdir(claudeSessionPreferencesDir())).some(
      (name) => name.endsWith(".tmp") || name.endsWith(".lock"),
    )).toBe(false);
  });

  test("waits for a lock held by another process before merging", async () => {
    await mkdir(claudeSessionPreferencesDir(), { recursive: true });
    const lockPath = `${preferencePath()}.lock`;
    await writeFile(lockPath, "other process", "utf-8");
    let settled = false;
    const update = updateSessionPreferences(SESSION_ID, { planMode: true })
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    await rm(lockPath, { force: true });
    await update;
    expect(await readSessionPreferences(SESSION_ID)).toEqual({
      planMode: true,
    });
  });

  test("does not steal an old lock whose owner process is still alive", async () => {
    await mkdir(claudeSessionPreferencesDir(), { recursive: true });
    const lockPath = `${preferencePath()}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ token: "live-owner", pid: process.pid }),
      "utf-8",
    );
    const staleDate = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleDate, staleDate);

    let settled = false;
    const update = updateSessionPreferences(SESSION_ID, { planMode: true })
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    await rm(lockPath, { force: true });
    await update;
    expect(await readSessionPreferences(SESSION_ID)).toEqual({
      planMode: true,
    });
  });

  test("recovers an abandoned stale-recovery marker and cleans it up", async () => {
    await mkdir(claudeSessionPreferencesDir(), { recursive: true });
    const lockPath = `${preferencePath()}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ token: "dead-owner", pid: 999_999_999 }),
      "utf-8",
    );
    const lockStat = await stat(lockPath);
    const recoveryPath =
      `${lockPath}.recover-${lockStat.dev}-${lockStat.ino}`;
    await writeFile(
      recoveryPath,
      JSON.stringify({ token: "dead-recovery", pid: 999_999_999 }),
      "utf-8",
    );
    const staleDate = new Date(Date.now() - 60_000);
    await Promise.all([
      utimes(lockPath, staleDate, staleDate),
      utimes(recoveryPath, staleDate, staleDate),
    ]);

    await updateSessionPreferences(SESSION_ID, { planMode: true });

    expect(await readSessionPreferences(SESSION_ID)).toEqual({
      planMode: true,
    });
    expect((await readdir(claudeSessionPreferencesDir())).some(
      (name) => name.includes(".recover-") || name.endsWith(".lock"),
    )).toBe(false);
  });

  test("removes temporary files when the atomic rename fails", async () => {
    await mkdir(preferencePath(), { recursive: true });

    await expect(
      updateSessionPreferences(SESSION_ID, { planMode: true }),
    ).rejects.toBeTruthy();

    const entries = await readdir(claudeSessionPreferencesDir());
    expect(entries.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(entries.some((name) => name.endsWith(".lock"))).toBe(false);
  });

  test("does not serialize independent session writes through one queue", async () => {
    await Promise.all([
      updateSessionPreferences(SESSION_ID, { planMode: true }),
      updateSessionPreferences(OTHER_SESSION_ID, { planMode: false }),
    ]);

    expect(await readSessionPreferences(SESSION_ID)).toEqual({
      planMode: true,
    });
    expect(await readSessionPreferences(OTHER_SESSION_ID)).toEqual({
      planMode: false,
    });
  });

  test("recovers after a failed write instead of wedging the session queue", async () => {
    await writeFile(join(testHome, ".claude"), "not a directory", "utf-8");

    await expect(
      updateSessionPreferences(SESSION_ID, { planMode: true }),
    ).rejects.toBeTruthy();

    await rm(join(testHome, ".claude"));
    await updateSessionPreferences(SESSION_ID, { planMode: false });
    expect(await readSessionPreferences(SESSION_ID)).toEqual({
      planMode: false,
    });
  });

  test("serializes deletion after writes and allows idempotent retries", async () => {
    const write = updateSessionPreferences(SESSION_ID, {
      planMode: true,
      dispatchedRequestIds: ["request-1"],
    });
    const deletion = deleteSessionPreferences(SESSION_ID.toUpperCase());
    await Promise.all([write, deletion]);

    expect(await readSessionPreferences(SESSION_ID)).toBeUndefined();
    await expect(deleteSessionPreferences(SESSION_ID)).resolves.toBeUndefined();
  });

  test("recovers after a failed deletion instead of wedging the session queue", async () => {
    await mkdir(preferencePath(), { recursive: true });

    await expect(deleteSessionPreferences(SESSION_ID)).rejects.toBeTruthy();

    await rm(preferencePath(), { recursive: true, force: true });
    await updateSessionPreferences(SESSION_ID, { planMode: true });
    await deleteSessionPreferences(SESSION_ID);
    expect(await readSessionPreferences(SESSION_ID)).toBeUndefined();
  });
});
