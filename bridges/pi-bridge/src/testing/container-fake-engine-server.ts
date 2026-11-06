#!/usr/bin/env bun
/**
 * `fake-engine-server.ts` as the Docker fixture installs it in a container.
 *
 * The backend starts a container's Pi bridge with the production launch
 * (`start_pi_server`), which sets `PI_AGENT_DIR` and `PI_SESSION_DIR` but no
 * fake-engine variables. The container cells
 * (`e2e/agent-testing/container-fake-engines.spec.ts`) put a bundle of this
 * file where the image's bridge entry is, so that launch runs the real bridge
 * and Pi SDK over the faux model. This only supplies the fake's call log,
 * under `FAKE_PI_ROOT` (default `/tmp/orkestrator-qa-fake-pi`).
 */
import "@orkestrator/protocol/node/bridge-launch-environment";
import { mkdirSync } from "node:fs";

const root = process.env.FAKE_PI_ROOT ?? "/tmp/orkestrator-qa-fake-pi";
mkdirSync(root, { recursive: true, mode: 0o700 });
process.env.FAKE_PI_CALLS ??= `${root}/calls.jsonl`;
await import("./fake-engine-server.js");
