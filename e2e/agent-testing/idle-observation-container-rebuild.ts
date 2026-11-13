/**
 * The `rebuild` case of `idle-observation-live.spec.ts` (todo 0008 task 7):
 * an OpenCode 2.x conversation in a container environment survives a
 * preserving rebuild, because the rebuild carries `opencode2.db` to the new
 * runtime's persistent mount.
 *
 * Kept apart from the spec, which is already long; the spec hands it the
 * closures it needs. Evidence, all content-free:
 *
 * - before: a turn settles, and the database on the persistent mount
 *   (`OPENCODE2_DB_PATH`) exists, is not empty and names the session;
 * - the rebuild (`recreate_environment` with `intent: "preserve"`, bound to
 *   the reviewed runtime) produces a new container whose setup settles;
 * - after: the same file exists in the new runtime and still names the
 *   session; a follow-up turn on the same tab settles on the same session,
 *   with the earlier reply and its prompt still in the transcript once each
 *   (a lost database would make OpenCode start a new conversation, with a new
 *   session id and none of the earlier rows), and a fresh page shows both.
 *
 * The container's fake model lives in `/tmp`, which a rebuild does not keep,
 * so it is stopped before the rebuild and installed again in the new runtime.
 */
import { spawnSync } from "node:child_process";
import { isEnvironmentReadyForAgents } from "@orkestrator/protocol/environment-readiness";

/** The container path of OpenCode 2.x's database (`container-state-layout.ts`). */
export const CONTAINER_OPENCODE2_DB =
  "/home/node/.local/share/opencode/orkestrator-db/opencode2.db";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface RebuildMessage {
  id: string;
  role: string;
  content?: unknown;
}

export interface RebuildProjection {
  sessionId?: string;
  turn: { phase: string };
  messages: RebuildMessage[];
}

export interface RebuildEnvironment {
  containerId?: string | null;
  status?: string | null;
  setupPhase?: string | null;
  setupScriptsComplete?: boolean | null;
  setupOverride?: boolean | null;
}

export interface DatabaseEvidence {
  /** The main file's size in bytes, or -1 when it is absent. */
  bytes: number;
  /** Lines of the main file and its WAL that name the session id. */
  sessionMentions: number;
}

export interface RebuildCaseRecord {
  status: string;
  notes: string[];
  timings: Record<string, number | null>;
}

export interface RebuildCaseContext {
  environmentId: string;
  /** The runtime the case starts on. */
  containerId: string;
  invoke(): Invoke;
  projection(): Promise<RebuildProjection | null>;
  sendFromBackend(prompt: string): Promise<void>;
  /** Wait, from backend reads only, until a new assistant row holds `word` and the turn is idle. */
  waitForReply(previous: ReadonlySet<string>, word: string): Promise<void>;
  /** Stop the current runtime's fake model before the rebuild. */
  stopFake(): Promise<void>;
  /** Serve the fake model in the new runtime. */
  installFake(containerId: string): Promise<void>;
  /** Open a fresh page on the environment and wait until it shows `words`. */
  reopenAndShow(words: readonly string[]): Promise<void>;
  inspectDatabase?(containerId: string, sessionId: string): DatabaseEvidence;
  replyPrompt(word: string): string;
  nonce(): string;
  progress(step: string): void;
  sleep(ms: number): Promise<unknown>;
  rebuildTimeoutMs?: number;
}

/** Plain text of a projection row, the way the spec reads it. */
function textOf(message: RebuildMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

/** Parse `<bytes> <mentions>` from the inspection script. */
export function parseDatabaseEvidence(output: string): DatabaseEvidence {
  const match = /^(-?\d+)\s+(\d+)\s*$/.exec(output.trim());
  if (!match) throw new Error("the database inspection printed no evidence");
  return { bytes: Number(match[1]), sessionMentions: Number(match[2]) };
}

/** Only an id that cannot change the inspection script reaches it. */
export function assertInspectableSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error("the session id is not one the database inspection accepts");
  }
}

/**
 * Size of `opencode2.db` in a container and how many of its (and its WAL's)
 * lines name `sessionId`. Run as root, because the server, not `node`, may
 * own the file; it reads only, and prints two numbers.
 */
export function inspectContainerDatabase(containerId: string, sessionId: string): DatabaseEvidence {
  assertInspectableSessionId(sessionId);
  const script = [
    `f=${CONTAINER_OPENCODE2_DB}`,
    `if [ -f "$f" ]; then s=$(stat -c %s "$f"); else s=-1; fi`,
    `n=$(cat "$f" "$f-wal" 2>/dev/null | grep -a -c -F -- "$ORKESTRATOR_QA_SESSION" || true)`,
    `echo "$s \${n:-0}"`,
  ].join("\n");
  const result = spawnSync(
    "docker",
    [
      "exec",
      "--user",
      "root",
      "-e",
      `ORKESTRATOR_QA_SESSION=${sessionId}`,
      containerId,
      "sh",
      "-c",
      script,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) throw new Error("the database inspection failed");
  return parseDatabaseEvidence(result.stdout);
}

/** The rebuild has produced a new runtime and the environment may run agents again. */
export function rebuildSettled(
  environment: RebuildEnvironment | null,
  previousContainerId: string,
): boolean {
  return Boolean(
    environment?.containerId &&
    environment.containerId !== previousContainerId &&
    isEnvironmentReadyForAgents(environment),
  );
}

/**
 * A client-side request timeout is not the rebuild failing: the operation is
 * the backend's, and the case follows it through the environment record.
 */
export function rebuildRequestFailure(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|socket hang up|ECONNRESET/i.test(message)) return null;
  return message.slice(0, 300);
}

/** Run the case; returns the new runtime's container id. */
export async function runContainerRebuildCase(
  context: RebuildCaseContext,
  record: RebuildCaseRecord,
): Promise<string> {
  const inspect = context.inspectDatabase ?? inspectContainerDatabase;
  const kept = `IDLEQA-KEPT-${context.nonce()}`;
  const keptPrompt = context.replyPrompt(kept);
  const first = new Set(((await context.projection())?.messages ?? []).map((m) => m.id));
  await context.sendFromBackend(keptPrompt);
  await context.waitForReply(first, kept);
  const before = await context.projection();
  const sessionId = before?.sessionId;
  if (!sessionId) throw new Error("the session has no id before the rebuild");

  const evidenceBefore = inspect(context.containerId, sessionId);
  record.timings.databaseBytesBefore = evidenceBefore.bytes;
  record.timings.databaseSessionMentionsBefore = evidenceBefore.sessionMentions;
  if (evidenceBefore.bytes <= 0) {
    throw new Error("opencode2.db is missing or empty on the persistent mount before the rebuild");
  }
  if (evidenceBefore.sessionMentions === 0) {
    throw new Error("opencode2.db does not name the session before the rebuild");
  }

  await context.stopFake();
  context.progress("rebuilding, keeping files");
  const startedAt = Date.now();
  let requestError: string | null = null;
  let requestSettled = false;
  const request = context
    .invoke()("recreate_environment", {
      environmentId: context.environmentId,
      intent: "preserve",
      expectedContainerId: context.containerId,
    })
    .then(
      () => {
        requestSettled = true;
      },
      (error: unknown) => {
        requestSettled = true;
        requestError = rebuildRequestFailure(error);
      },
    );
  const deadline = startedAt + (context.rebuildTimeoutMs ?? 15 * 60_000);
  let environment: RebuildEnvironment | null = null;
  for (;;) {
    if (requestError) throw new Error(`the preserving rebuild was refused: ${requestError}`);
    environment = await context
      .invoke()<RebuildEnvironment | null>("get_environment", {
        environmentId: context.environmentId,
      })
      .catch(() => null);
    if (requestSettled && rebuildSettled(environment, context.containerId)) break;
    if (Date.now() > deadline) {
      throw new Error(
        `the rebuild did not settle: status ${environment?.status ?? "unknown"}, ` +
          `setup ${environment?.setupPhase ?? "unknown"}, ` +
          `new runtime ${environment?.containerId && environment.containerId !== context.containerId}`,
      );
    }
    await context.sleep(2_000);
  }
  await request;
  record.timings.rebuildMs = Date.now() - startedAt;
  const containerId = environment!.containerId!;
  context.progress("rebuilt onto a new runtime");

  await context.installFake(containerId);
  const evidenceAfter = inspect(containerId, sessionId);
  record.timings.databaseBytesAfter = evidenceAfter.bytes;
  record.timings.databaseSessionMentionsAfter = evidenceAfter.sessionMentions;
  if (evidenceAfter.bytes <= 0) {
    throw new Error("opencode2.db is missing or empty in the new runtime");
  }
  if (evidenceAfter.sessionMentions === 0) {
    throw new Error("opencode2.db in the new runtime does not name the session");
  }

  const follow = `IDLEQA-AFTER-REBUILD-${context.nonce()}`;
  const ids = new Set((before?.messages ?? []).map((m) => m.id));
  const followAt = Date.now();
  await context.sendFromBackend(context.replyPrompt(follow));
  await context.waitForReply(ids, follow);
  record.timings.followUpTurnMs = Date.now() - followAt;
  const after = await context.projection();
  if (after?.sessionId !== sessionId) {
    throw new Error("the follow-up turn ran on a different session after the rebuild");
  }
  const messages = after?.messages ?? [];
  const keptReplies = messages.filter(
    (message) => message.role === "assistant" && textOf(message).includes(kept),
  ).length;
  const keptPrompts = messages.filter(
    (message) => message.role === "user" && textOf(message) === keptPrompt,
  ).length;
  if (keptReplies < 1) throw new Error("the reply from before the rebuild is gone");
  if (keptPrompts !== 1) {
    throw new Error(`the prompt from before the rebuild appears ${keptPrompts} times, not once`);
  }
  record.notes.push(
    "same session before and after the rebuild; earlier prompt once, earlier reply kept",
  );
  await context.reopenAndShow([kept, follow]);
  return containerId;
}
