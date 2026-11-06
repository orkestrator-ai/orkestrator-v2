#!/usr/bin/env bun
/**
 * `fake-engine-server.ts` as the Docker fixture installs it in a container.
 *
 * The backend starts a container's Cursor bridge with the production launch
 * (`start_cursor_server`): its own port, token, state directory and log, and
 * no fake-engine variables. The container cells
 * (`e2e/agent-testing/container-fake-engines.spec.ts`) put a bundle of this
 * file where the image's bridge entry is, so that launch runs the real bridge
 * over the fake SDK. This only supplies the fake's own files, under
 * `FAKE_CURSOR_ROOT` (default `/tmp/orkestrator-qa-fake-cursor`).
 */
import { mkdirSync } from "node:fs";

const root = process.env.FAKE_CURSOR_ROOT ?? "/tmp/orkestrator-qa-fake-cursor";
mkdirSync(root, { recursive: true, mode: 0o700 });
process.env.FAKE_CURSOR_STORE ??= `${root}/store.json`;
process.env.FAKE_CURSOR_LOG ??= `${root}/sdk.log`;
await import("./fake-engine-server.js");
