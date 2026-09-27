/**
 * Give an in-process test a private ACP state directory.
 *
 * `acp-context.ts` resolves `stateFile` from `ACP_STATE_DIR` at module scope,
 * so a test that needs the real persist/restore path has to set it before any
 * bridge module loads: import this right after `unit-test-env.js` and ahead of
 * every bridge import. Call {@link restoreStateDirEnvironment} once the bridge
 * modules are loaded, so the variable does not outlive the file, and
 * {@link removePrivateStateDir} when the file is done.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previous = process.env.ACP_STATE_DIR;

export const privateStateDir = mkdtempSync(join(tmpdir(), "acp-bridge-private-state-"));
process.env.ACP_STATE_DIR = privateStateDir;

/** Put `ACP_STATE_DIR` back exactly as it was, absence included. */
export function restoreStateDirEnvironment(): void {
  if (previous === undefined) delete process.env.ACP_STATE_DIR;
  else process.env.ACP_STATE_DIR = previous;
}

export function removePrivateStateDir(): void {
  rmSync(privateStateDir, { recursive: true, force: true });
}
