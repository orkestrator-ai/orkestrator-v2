import type { Context, Hono } from "hono";
import { compress } from "hono/compress";
import {
  bridgeTranscriptDetailRouteBody,
  bridgeTranscriptPageRouteBody,
  bridgeTranscriptRouteBody,
  type BridgeTranscriptSource,
} from "@orkestrator/protocol/bridge-transcript-routes";
import {
  getSessionMessages,
  hydratePersistedSessionMessages,
  peekSession,
} from "../services/session-manager.js";
import { readTranscriptVersion } from "../services/transcript-revision.js";
import type { NormalizedMessage } from "../types/index.js";

/**
 * What every transcript route of one resident session reads right now.
 *
 * The token is built from the session's transcript revision and epoch rather
 * than a hash of the history, so an unchanged poll touches no message. That is
 * only sound because every mutation of `messages` marks the revision
 * (`services/transcript-revision.ts`). Messages, loaded state and version are
 * read together here, so a summary, a detail locator and a page cursor always
 * describe the same array.
 *
 * `peekSession` only: a transcript read never materializes a persisted session
 * or probes the catalogue. `getSessionMessages` refreshes the idle clock, as a
 * user-driven tab read should.
 */
export function claudeTranscriptSource(
  id: string,
  generation: string,
): { source: BridgeTranscriptSource<NormalizedMessage>; needsHydration: boolean } | undefined {
  const sessionData = peekSession(id);
  if (!sessionData) return undefined;
  const needsHydration = sessionData.persistedMessagesLoaded === false;
  // A prompt claims the transcript (`persistedMessagesLoaded = true`) before
  // its own pre-turn read has installed the history; while that read is in
  // flight `messages` is still the preview and must not read as a complete,
  // current (and possibly empty) conversation.
  const loaded = !needsHydration && sessionData.persistedHydration === undefined;
  const messages = getSessionMessages(id);
  const version = readTranscriptVersion(sessionData);
  return {
    needsHydration,
    source: {
      messages,
      sessionIdentity: id,
      generation,
      // The prefix keeps the long-standing preview/hydrated distinction
      // visible to readers; the epoch separates successive histories of each.
      // A cursor minted in the preview therefore expires once hydration
      // installs the full history, rather than naming a position in it.
      contentEpoch: `${loaded ? "hydrated" : "preview"}:${version.epoch}`,
      revision: version.revision,
      complete: loaded,
      freshness: loaded ? "current" : "cached",
      title: sessionData.title,
    },
  };
}

/**
 * Gzip for the detail and page reads, registered by the composition root
 * beside the transcript's own. Exact details carry the tool output and images
 * summaries leave out and pages carry history: both are as compressible as the
 * transcript. `Vary` keeps a shared cache from serving gzip to a plain client.
 */
export function compressTranscriptReads(app: Hono): void {
  for (const path of ["/session/:id/transcript/detail", "/session/:id/transcript/page"]) {
    app.use(path, async (c, next) => {
      await next();
      c.res.headers.append("Vary", "Accept-Encoding");
    });
    app.use(path, compress({ encoding: "gzip" }));
  }
}

function query(c: Context) {
  return (name: string) => c.req.query(name);
}

/**
 * `GET /:id/transcript`, `/:id/transcript/detail` and `/:id/transcript/page`.
 *
 * The summary route keeps its 404 for an unknown session (unchanged v1
 * contract). Detail and page are newer: an older bridge answers them 404, so
 * they answer an unknown session in band (`missing` / `expired`) instead.
 * Neither of them hydrates: they serve exactly what the summary route serves,
 * preview or hydrated, and it is the summary route that starts hydration.
 */
export function registerSessionTranscriptRoutes(app: Hono, generation: string): void {
  // Transcript-first display route. Persisted hydration continues in the
  // background; callers keep the preview visible and poll its conditional
  // token. The response is serialized before hydration is started, so the
  // token always describes exactly the content it was sent with.
  app.get("/:id/transcript", (c) => {
    const id = c.req.param("id");
    const read = claudeTranscriptSource(id, generation);
    if (!read) return c.json({ error: "Session not found" }, 404);
    const response = c.json(bridgeTranscriptRouteBody(read.source, query(c)));
    if (read.needsHydration) {
      void hydratePersistedSessionMessages(id).catch((error) => {
        console.warn(
          "[session] Background transcript hydration failed:",
          error instanceof Error ? error.message : "unknown error",
        );
      });
    }
    return response;
  });

  app.get("/:id/transcript/detail", (c) =>
    c.json(
      bridgeTranscriptDetailRouteBody(
        claudeTranscriptSource(c.req.param("id"), generation)?.source,
        query(c),
      ),
    ),
  );

  app.get("/:id/transcript/page", (c) =>
    c.json(
      bridgeTranscriptPageRouteBody(
        claudeTranscriptSource(c.req.param("id"), generation)?.source,
        query(c),
      ),
    ),
  );
}
