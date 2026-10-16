import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REMOTE_RELAUNCH_FILE,
  REMOTE_RELAUNCH_MAX_ATTEMPTS,
  REMOTE_RELAUNCH_WINDOW_MS,
  claimRemoteRelaunchAttempt,
  readRemoteRelaunchMarker,
  writeRemoteRelaunchMarker,
} from "../electron/remote-relaunch";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-remote-relaunch-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("a fresh marker is read back and allows a bounded number of relaunches", async () => {
  const now = () => Date.parse("2026-10-16T12:00:00.000Z");
  await writeRemoteRelaunchMarker(dataDir, { jobId: "job-1", version: "2.22.0" }, now);
  let marker = readRemoteRelaunchMarker(dataDir, now);
  expect(marker).toMatchObject({ jobId: "job-1", version: "2.22.0", attempts: 0 });
  for (let attempt = 0; attempt < REMOTE_RELAUNCH_MAX_ATTEMPTS; attempt += 1) {
    expect(claimRemoteRelaunchAttempt(dataDir, marker!)).toBe(true);
    marker = readRemoteRelaunchMarker(dataDir, now);
  }
  expect(claimRemoteRelaunchAttempt(dataDir, marker!)).toBe(false);
});

test("an expired marker is removed and ignored", async () => {
  const written = Date.parse("2026-10-16T12:00:00.000Z");
  await writeRemoteRelaunchMarker(dataDir, { jobId: "job-1", version: "2.22.0" }, () => written);
  expect(
    readRemoteRelaunchMarker(dataDir, () => written + REMOTE_RELAUNCH_WINDOW_MS + 1),
  ).toBeNull();
  expect(existsSync(path.join(dataDir, REMOTE_RELAUNCH_FILE))).toBe(false);
});

test("no marker means an ordinary launch", () => {
  expect(readRemoteRelaunchMarker(dataDir)).toBeNull();
});
