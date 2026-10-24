import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Verified on Grok 1.0.52 stdio: permission answers cannot stop shell commands
// that never ask. Remove the built-in mutation tools before any prompt runs.
// `monitor` is Grok 1.0.67's waiting tool: a read-only turn hands work off and
// ends rather than sitting on it, as Claude's refused `Monitor` does. Read
// live with `scripts/coordinator-probes/grok-web-tools-probe.mjs coordinator`.
export const GROK_READ_ONLY_PROFILE = `---
name: orkestrator-read-only
description: Read-only Orkestrator session
promptMode: extend
disallowedTools:
  - write
  - search_replace
  - run_terminal_cmd
  - Agent
  - monitor
---
`;

export function createReadOnlyProfile(): { path: string; dispose: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "orkestrator-grok-profile-"));
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    const path = join(directory, "read-only.md");
    writeFileSync(path, GROK_READ_ONLY_PROFILE, { mode: 0o600 });
    return { path, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
