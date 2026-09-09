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
import { createCursorSandboxBootstrap } from "./sandbox-bootstrap.js";

const storeRoot = cursorSdkStateDirectoryPath() ?? getDefaultSdkStateRoot(workingDirectory);

let platform: Promise<CursorAgentPlatform> | undefined;
let initializeSandbox = createCursorSandboxBootstrap();

/**
 * One store instance must serve every static Agent API. Mixing stores would
 * make create succeed while list, resume or rewind looked somewhere else.
 *
 * The binding is reassignable for one reason: this module is a process-wide
 * singleton evaluated exactly once, so a test that wants the real SDK writing
 * under its own temporary root cannot get there by setting an environment
 * variable — an earlier suite in the same process may already have evaluated
 * this file, and its store would be the one every later import received.
 */
export let cursorLocalAgentStore: LocalAgentStore = new JsonlLocalAgentStore(storeRoot);

Cursor.configure({ local: { store: cursorLocalAgentStore } });

/**
 * Point the whole runtime at another store, returning the one it replaced.
 *
 * The memoized platform is dropped with it: it captured the previous store at
 * construction, and leaving it in place is exactly the split-brain the comment
 * above warns about.
 */
export function useCursorLocalAgentStoreForTests(store: LocalAgentStore): LocalAgentStore {
  const previous = cursorLocalAgentStore;
  cursorLocalAgentStore = store;
  Cursor.configure({ local: { store } });
  platform = undefined;
  initializeSandbox = createCursorSandboxBootstrap();
  return previous;
}

/**
 * Agent.create reserves a queued first run, but only the returned SDK handle
 * knows to consume it. Agent.resume loses that handle and tries to create a
 * second run, which the store rejects as "already has active run".
 *
 * Only this exact unused reservation is replaceable. A queued follow-up, a
 * starting run or a conversation checkpoint may represent dispatched work.
 * Read failures propagate; they are not evidence that a session is unused.
 */
export async function hasUnusedInitialRun(agentId: string): Promise<boolean> {
  const agent = await cursorLocalAgentStore.agents.get({ agentId });
  if (!agent || agent.status !== "idle" || !agent.activeRunId || agent.latestCheckpoint) {
    return false;
  }
  const run = await cursorLocalAgentStore.runs.get({ agentId, runId: agent.activeRunId });
  return Boolean(
    run &&
    run.turnNumber === 1 &&
    run.status === "queued" &&
    run.requestId == null &&
    run.startedAt == null &&
    run.endedAt == null &&
    run.startCheckpointRef == null &&
    run.latestCheckpointRef == null,
  );
}

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
  sandboxBoundary: "none" | "provider" | "container",
): Promise<(() => Promise<void>) | undefined> {
  try {
    const runtime = await agentPlatform();
    // Containers use their outer boundary and never need the nested sandbox.
    // All host sessions share this barrier, including concurrent warm-ups.
    await initializeSandbox(runtime, options, sandboxBoundary);
    return await runtime.prewarmLocalWorkspace(options);
  } catch {
    // Prewarming is only an optimization. Agent.send() can rebuild the same
    // executor and remains the authoritative place to report a real failure.
    return undefined;
  }
}
