/**
 * Preload for this package's suite: keep tests off the developer's own Pi
 * directory.
 *
 * Session creation reads Pi's saved default model from `settings.json` in
 * Pi's agent directory, which is `~/.pi/agent` unless `PI_CODING_AGENT_DIR`
 * names another. Without this, a test that creates a session would read the
 * real file, and its outcome could depend on what the developer last chose
 * with `/model`. Tests that need settings write their own into a directory
 * they create.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDirectory = mkdtempSync(join(tmpdir(), "pi-bridge-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDirectory;
delete process.env.PI_AGENT_DIR;
delete process.env.PI_BRIDGE_DEFAULT_MODEL;
// A preload's `afterAll` runs once after every file in this worker; Bun test
// workers do not reliably emit `exit`.
afterAll(() => rmSync(agentDirectory, { recursive: true, force: true }));
