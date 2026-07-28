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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeSessionPreferencesDir,
  setClaudeHomeForTesting,
} from "./claude-home.js";
import {
  deleteSessionPreferences,
  MAX_DISPATCHED_REQUEST_IDS,
  readSessionPreferences,
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

  test("returns undefined for missing, malformed, array, and scalar files", async () => {
    expect(await readSessionPreferences(SESSION_ID)).toBeUndefined();

    await mkdir(claudeSessionPreferencesDir(), { recursive: true });
    for (const raw of ["{", "[]", "null", "\"plan\"", "1"]) {
      await writeFile(preferencePath(), raw, "utf-8");
      expect(await readSessionPreferences(SESSION_ID)).toBeUndefined();
    }
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

  test("ignores unknown and incorrectly typed fields", async () => {
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

    expect(await readSessionPreferences(SESSION_ID)).toEqual({});
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
