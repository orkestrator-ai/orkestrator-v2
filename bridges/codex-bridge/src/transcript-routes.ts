import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { compress } from "hono/compress";
import {
  bridgeTranscriptDetailRouteBody,
  bridgeTranscriptPageRouteBody,
  bridgeTranscriptRouteBody,
  type BridgeTranscriptSource,
} from "@orkestrator/protocol/node/bridge-transcript-routes";
import {
  CHANGE_EVIDENCE_ACK_ROUTE,
  CHANGE_EVIDENCE_BODY_ROUTE,
  CHANGE_EVIDENCE_ROUTE,
  changeEvidenceAckRouteBody,
  changeEvidenceBodyRouteBody,
  changeEvidenceReadBody,
} from "@orkestrator/protocol/node/change-tracking/evidence-routes";
import type { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import type { NormalizedMessage } from "./messages/types.js";

/** The runtime reads the transcript routes use; neither touches liveness or attaches. */
export interface CodexTranscriptRuntime {
  getStatus(
    sessionId: string,
    touch?: boolean,
  ): {
    title?: string;
    engineGeneration: number;
    messageRevision: number;
    contentEpoch: number;
  } | null;
  getCachedMessages(sessionId: string): {
    messages: NormalizedMessage[];
    freshness: "cached" | "current";
    complete: boolean;
  } | null;
  /** Rows recently changed, newest first, for the summary's `revisedMessages`. */
  getRevisedRowsOverflowVersion?(sessionId: string): number;
  getRevisedMessageIds?(sessionId: string): readonly string[];
}

/**
 * Scopes the transcript generation to this bridge process.
 *
 * The engine generation alone is not enough: a supervisor numbers its
 * app-server children from 1 in every process, and a restored session starts
 * its revision and content epoch again at 0 (`ThreadRegistry.restoreSession`).
 * After a bridge restart all three can repeat values a reader still holds a
 * token or page cursor for, and that token would then answer `unchanged` for
 * different content. The other bridges draw a random generation per process;
 * this keeps the engine generation readable after the process part.
 */
const TRANSCRIPT_PROCESS = randomUUID();

/**
 * What every transcript route of one session reads right now.
 *
 * The bridge-owned display tail — the attached thread's rendered messages, or
 * the detached session's retained local tail as a cached preview — never an
 * attach or a rollout read. All three routes build from this, so a detail
 * locator or page cursor is resolved against the array it was minted from; a
 * cursor from a detached preview expires when hydration moves the epoch.
 * Synchronous: nothing here can wait on the app-server stdout loop.
 */
export function codexTranscriptSource(
  runtime: CodexTranscriptRuntime,
  sessionId: string,
): BridgeTranscriptSource<NormalizedMessage> | undefined {
  // Display polls are not user activity: they must not keep an idle thread
  // attached, so status is read without touching liveness.
  const status = runtime.getStatus(sessionId, false);
  const cached = runtime.getCachedMessages(sessionId);
  if (!status || !cached) return undefined;
  const revisedMessageIds = runtime.getRevisedMessageIds?.(sessionId);
  return {
    messages: cached.messages,
    sessionIdentity: sessionId,
    generation: `${TRANSCRIPT_PROCESS}:${status.engineGeneration}`,
    contentEpoch: status.contentEpoch,
    revision: status.messageRevision,
    complete: cached.complete,
    freshness: cached.freshness,
    title: status.title,
    revisedRowsOverflowVersion: runtime.getRevisedRowsOverflowVersion?.(sessionId),
    ...(revisedMessageIds?.length ? { revisedMessageIds } : {}),
  };
}

function query(c: Context) {
  return (name: string) => c.req.query(name);
}

/**
 * `GET /session/:id/transcript` (v1, or v2 summaries for `version=2`), plus
 * `/transcript/detail` and `/transcript/page`.
 *
 * The summary route keeps its 404 for an unknown session. Detail and page are
 * newer, and an older bridge answers them 404, so they answer an unknown
 * session in band (`missing` / `expired`) instead. Detail and page bodies are
 * gzip-compressed on request like the transcript; the caller registers the
 * transcript's own compression before this.
 */
export function registerCodexTranscriptRoutes(app: Hono, runtime: CodexTranscriptRuntime): void {
  for (const path of ["/session/:id/transcript/detail", "/session/:id/transcript/page"]) {
    app.use(path, async (c, next) => {
      await next();
      c.res.headers.append("Vary", "Accept-Encoding");
    });
    app.use(path, compress({ encoding: "gzip" }));
  }

  app.get("/session/:id/transcript", (c) => {
    const source = codexTranscriptSource(runtime, c.req.param("id"));
    if (!source) return c.json({ error: "Session not found" }, 404);
    return c.json(bridgeTranscriptRouteBody(source, query(c)));
  });

  app.get("/session/:id/transcript/detail", (c) =>
    c.json(
      bridgeTranscriptDetailRouteBody(codexTranscriptSource(runtime, c.req.param("id")), query(c)),
    ),
  );

  app.get("/session/:id/transcript/page", (c) =>
    c.json(
      bridgeTranscriptPageRouteBody(codexTranscriptSource(runtime, c.req.param("id")), query(c)),
    ),
  );
}

/**
 * `GET /change-evidence`, `GET /change-evidence/body` and
 * `POST /change-evidence/ack`: the backend's pull over this process's
 * change-evidence spool (`change-evidence.ts`). Registered beside the
 * transcript routes, behind the same bridge authentication. Bodies are shared
 * with every bridge (`evidence-routes.ts`); an unknown body id is answered in
 * band, never 404, because a 404 here means "this bridge predates the route".
 */
export function registerCodexChangeEvidenceRoutes(app: Hono, spool: ChangeEvidenceSpool): void {
  app.get(CHANGE_EVIDENCE_ROUTE, (c) => c.json(changeEvidenceReadBody(spool, query(c))));
  app.get(CHANGE_EVIDENCE_BODY_ROUTE, (c) => c.json(changeEvidenceBodyRouteBody(spool, query(c))));
  app.post(CHANGE_EVIDENCE_ACK_ROUTE, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const result = changeEvidenceAckRouteBody(spool, body);
    return result.ok ? c.json(result) : c.json(result, 400);
  });
}
