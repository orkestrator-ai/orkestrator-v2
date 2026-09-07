/** Process-wide Cursor SDK persistence and workspace warm-up. */
import {
  Cursor,
  JsonlLocalAgentStore,
  createAgentPlatform,
  getDefaultSdkStateRoot,
  type AgentOptions,
  type CursorAgentPlatform,
  type LocalAgentStore,
} from "@cursor/sdk";
import { cursorSdkStateDirectoryPath, workingDirectory } from "./config.js";

const storeRoot = cursorSdkStateDirectoryPath() ?? getDefaultSdkStateRoot(workingDirectory);

/**
 * One store instance must serve every static Agent API. Mixing stores would
 * make create succeed while list, resume or rewind looked somewhere else.
 */
export const cursorLocalAgentStore: LocalAgentStore = new JsonlLocalAgentStore(storeRoot);

Cursor.configure({ local: { store: cursorLocalAgentStore } });

let platform: Promise<CursorAgentPlatform> | undefined;

async function agentPlatform(): Promise<CursorAgentPlatform> {
  const pending =
    platform ??
    createAgentPlatform({
      localStore: cursorLocalAgentStore,
      workspaceRef: workingDirectory,
      scopedWorkspaceRef: workingDirectory,
    });
  platform = pending;
  try {
    return await pending;
  } catch (error) {
    if (platform === pending) platform = undefined;
    throw error;
  }
}

/**
 * Pay the SDK's workspace scan during attach, before prompt dispatch enters
 * the at-most-once window. The caller retains the returned lease until the
 * attached agent is released.
 */
export async function prewarmCursorWorkspace(
  options: AgentOptions,
): Promise<(() => Promise<void>) | undefined> {
  try {
    return await (await agentPlatform()).prewarmLocalWorkspace(options);
  } catch {
    // Prewarming is only an optimization. Agent.send() can rebuild the same
    // executor and remains the authoritative place to report a real failure.
    return undefined;
  }
}
