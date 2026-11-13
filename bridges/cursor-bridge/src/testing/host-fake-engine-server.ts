#!/usr/bin/env bun
/**
 * `fake-engine-server.ts` as an agent-test profile's host launch runs it.
 *
 * A local environment's Cursor bridge is started by the backend's production
 * launch (`start_cursor_server`): `bun <bridges/cursor-bridge>/dist/index.js`
 * with its own port, token and state directory, and no fake-engine variables.
 * The inactive-path steer spec (`e2e/agent-testing/steer-inactive-live.spec.ts`,
 * todo 0005 task 7) puts a bundle of this file where that entry is for the
 * length of its Cursor case, so the launch runs the real bridge over the fake
 * SDK. This only supplies the fake's own files, under the environment's own
 * `CURSOR_BRIDGE_STATE_DIR` (inside the profile's data directory), so two
 * environments, or two profiles, never share a store.
 *
 * The entry is shared by every profile started from the checkout, so the
 * bundle serves the fake only to the profile that owns the swap
 * (`host-fake-entry-lock.ts`); any other launch runs the real entry kept
 * beside it.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  hostFakeEntryServes,
  readHostFakeEntryLock,
  REAL_ENTRY_NAME,
} from "./host-fake-entry-lock.js";

const distDirectory = path.dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.CURSOR_BRIDGE_STATE_DIR;

if (!hostFakeEntryServes(readHostFakeEntryLock(distDirectory), stateDir)) {
  await import(pathToFileURL(path.join(distDirectory, REAL_ENTRY_NAME)).href);
} else {
  await import("@orkestrator/protocol/node/bridge-launch-environment");
  const { mkdirSync } = await import("node:fs");
  const root = path.join(stateDir!, "qa-fake-cursor");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  process.env.FAKE_CURSOR_STORE ??= path.join(root, "store.json");
  process.env.FAKE_CURSOR_LOG ??= path.join(root, "sdk.log");
  await import("./fake-engine-server.js");
}
