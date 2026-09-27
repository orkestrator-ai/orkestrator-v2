import type { Context, Hono } from "hono";
import { compress } from "hono/compress";
import {
  bridgeTranscriptDetailRouteBody,
  bridgeTranscriptPageRouteBody,
  bridgeTranscriptRouteBody,
  type BridgeTranscriptSource,
} from "@orkestrator/protocol/bridge-transcript-routes";
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
}

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
  return {
    messages: cached.messages,
    sessionIdentity: sessionId,
    generation: status.engineGeneration,
    contentEpoch: status.contentEpoch,
    revision: status.messageRevision,
    complete: cached.complete,
    freshness: cached.freshness,
    title: status.title,
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
