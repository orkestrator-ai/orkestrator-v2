/**
 * Cursor SDK run access shared by the session lifecycle and the close path.
 *
 * Kept apart from `agent-session.ts` so finishing a restored close can cancel
 * a surviving run without importing the session lifecycle that waits on it.
 */
import { Agent, type Run } from "@cursor/sdk";
import { CATALOG_TIMEOUT_MS, MAX_RESUME_ENTRIES, workingDirectory } from "./config.js";

export class SessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConflictError";
  }
}

let cursorAgent = Agent;

/** The SDK entry point, replaceable by tests through {@link useCursorAgentForTests}. */
export function cursorAgentApi(): typeof Agent {
  return cursorAgent;
}

export function useCursorAgentForTests(agent: typeof Agent): () => void {
  const previous = cursorAgent;
  cursorAgent = agent;
  return () => {
    cursorAgent = previous;
  };
}

export async function listAllRuns(agentId: string): Promise<Run[]> {
  const runs: Run[] = [];
  let cursor: string | undefined;
  do {
    const page = await withTimeout(
      cursorAgent.listRuns(agentId, {
        runtime: "local",
        cwd: workingDirectory,
        limit: MAX_RESUME_ENTRIES,
        ...(cursor ? { cursor } : {}),
      }),
      CATALOG_TIMEOUT_MS,
    );
    runs.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && runs.length < 2_000);
  return runs;
}

/**
 * Cancel any run of `agentId` still executing after the session that owned it
 * was closed by a previous bridge process. Never rejects.
 *
 * `unknown` means the store could not be read — not evidence of a live run.
 * `running` means one was found and did not acknowledge cancellation.
 */
export async function cancelSurvivingRuns(
  agentId: string,
  cancelTimeoutMs: number,
): Promise<"none" | "cancelled" | "running" | "unknown"> {
  let runs: Run[];
  try {
    runs = await listAllRuns(agentId);
  } catch {
    return "unknown";
  }
  const running = runs.filter((run) => run.status === "running");
  if (running.length === 0) return "none";
  const stopped = await Promise.all(
    running.map((run) =>
      withTimeout(
        Promise.resolve().then(() => run.cancel()),
        cancelTimeoutMs,
      ).then(
        () => true,
        () => false,
      ),
    ),
  );
  return stopped.every(Boolean) ? "cancelled" : "running";
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cursor history read timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
