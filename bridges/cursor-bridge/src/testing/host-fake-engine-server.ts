#!/usr/bin/env bun
/**
 * `fake-engine-server.ts` as an agent-test profile's host launch runs it.
 *
 * A local environment's Cursor bridge is started by the backend's production
 * launch (`start_cursor_server`): `bun <bridges/cursor-bridge>/dist/index.js`
 * with its own port, token and state directory, and no fake-engine variables.
 * The inactive-path steer spec (`e2e/agent-testing/browser-gateway.spec.ts`,
 * todo 0005 task 7) puts a bundle of this file where that entry is for the
 * length of its Cursor case, so the launch runs the real bridge over the fake
 * SDK. This only supplies the fake's own files, under the environment's own
 * `CURSOR_BRIDGE_STATE_DIR` (inside the profile's data directory), so two
 * environments, or two profiles, never share a store.
 */
import "@orkestrator/protocol/node/bridge-launch-environment";
import { mkdirSync } from "node:fs";
import path from "node:path";

const stateDir = process.env.CURSOR_BRIDGE_STATE_DIR;
if (!stateDir) throw new Error("CURSOR_BRIDGE_STATE_DIR is required");
const root = path.join(stateDir, "qa-fake-cursor");
mkdirSync(root, { recursive: true, mode: 0o700 });
process.env.FAKE_CURSOR_STORE ??= path.join(root, "store.json");
process.env.FAKE_CURSOR_LOG ??= path.join(root, "sdk.log");
await import("./fake-engine-server.js");
