/**
 * `HttpBridgeProvider.closeSession` and the shared bridge close contract
 * (`closeBridgeSessionRetaining`): `POST /session/:id/close` is the ordinary,
 * non-destructive close. Only a 2xx that affirms `closed: true` confirms it;
 * 503 pending and anything unaffirmed keep the caller's intent; a bridge
 * that predates the route gets a legacy DELETE only where that DELETE is
 * proven never to delete history (never Claude).
 */
import { describe, expect, test } from "bun:test";
import { tabTeardownFailureKind } from "@orkestrator/protocol/tab-teardown";
import {
  BridgeClosePendingError,
  BridgeCloseUnsupportedError,
  closeBridgeSessionRetaining,
} from "./bridge-session-close.js";
import { codexConnection, cursorConnection, httpProvider } from "./agent-provider-test-support.js";

describe("HTTP bridge provider close", () => {
  test("treats an in-band missing close as success and propagates unconfirmed closes", async () => {
    const missing = httpProvider(() => Response.json({ closed: true, missing: true }));
    await expect(missing.provider.closeSession!("missing-session")).resolves.toBeUndefined();

    const failed = httpProvider(() =>
      Response.json(
        { closed: false, pending: true, error: "Session close did not complete" },
        { status: 503 },
      ),
    );
    await expect(failed.provider.closeSession!("live-session")).rejects.toThrow(
      "Session close did not complete",
    );
  });

  test("never falls back to a destructive DELETE when a Claude bridge predates close", async () => {
    for (const status of [404, 405]) {
      const legacy = httpProvider(() => new Response(null, { status }));
      const failure = await legacy.provider.closeSession!("claude-session").catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(BridgeCloseUnsupportedError);
      expect(String((failure as Error).message)).toContain("predates non-destructive tab close");
      // The renderer recognises this failure and shows the restart notice.
      expect(tabTeardownFailureKind(failure)).toBe("bridge-upgrade-required");
      expect(legacy.requests.map((request) => request.init.method)).toEqual(["POST"]);
    }
  });

  test("falls back to a proven non-destructive legacy DELETE for an older Codex bridge", async () => {
    const { provider, requests } = httpProvider((url, init) => {
      if (url.endsWith("/close")) return new Response("404 Not Found", { status: 404 });
      if (init.method === "DELETE") return Response.json({ status: "deleted" });
      return Response.json({});
    }, codexConnection);
    await provider.closeSession!("codex-session");
    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ["POST", "http://codex.test/session/codex-session/close"],
      ["DELETE", "http://codex.test/session/codex-session"],
    ]);
  });

  test("a 2xx close confirms only when it affirms closed: true", async () => {
    const unaffirmed: Array<() => Response> = [
      () => new Response(null, { status: 200 }),
      () => new Response(null, { status: 204 }),
      () => Response.json({}),
      () => Response.json({ ok: true }),
      () => Response.json({ closed: "true" }),
      () => Response.json({ closed: 1, retained: true }),
      () => Response.json({ closed: false, pending: true }),
      () => new Response("closed", { status: 200 }),
      () => Response.json({ closed: true, padding: "x".repeat(8_192) }),
    ];
    for (const respond of unaffirmed) {
      const calls: string[] = [];
      await expect(
        closeBridgeSessionRetaining("pi", "pi-session", async (method) => {
          calls.push(method);
          return respond();
        }),
      ).rejects.toBeInstanceOf(BridgeClosePendingError);
      // An unaffirmed 2xx is not a missing route, so no legacy DELETE either.
      expect(calls).toEqual(["POST"]);
    }
    await expect(
      closeBridgeSessionRetaining("pi", "pi-session", async () =>
        Response.json({ closed: true, retained: true }),
      ),
    ).resolves.toEqual({ outcome: "closed", via: "close" });
    await expect(
      closeBridgeSessionRetaining("pi", "pi-session", async () =>
        Response.json({ closed: true, missing: true }),
      ),
    ).resolves.toEqual({ outcome: "missing", via: "close" });
  });

  test("a closed Cursor conversation is still listed for deliberate resume", async () => {
    // A stateful bridge fake: close releases the live registration and keeps
    // history; the explicit DELETE would remove it. The listing is derived
    // from that state, not a canned fixture, so a destructive close would fail.
    const live = new Set(["cursor-session"]);
    const history = new Map([["cursor-session", "Cursor work"]]);
    const { provider, requests } = httpProvider((url, init) => {
      const path = new URL(url).pathname;
      if (path === "/session/list") {
        return Response.json({
          sessions: [...history].map(([id, title]) => ({
            id,
            title,
            status: live.has(id) ? "running" : "idle",
          })),
        });
      }
      const match = /^\/session\/([^/]+)(\/close)?$/.exec(path);
      const id = match ? decodeURIComponent(match[1]!) : "";
      if (match?.[2] && init.method === "POST") {
        if (!live.delete(id)) return Response.json({ closed: true, missing: true });
        return Response.json({ closed: true, retained: true });
      }
      if (match && init.method === "DELETE") {
        live.delete(id);
        history.delete(id);
        return Response.json({ deleted: true });
      }
      return new Response(null, { status: 404 });
    }, cursorConnection);

    await provider.closeSession!("cursor-session");
    expect(requests.some((request) => request.init.method === "DELETE")).toBe(false);
    expect(live.has("cursor-session")).toBe(false);
    const listed = await provider.listResumableSessions!();
    expect(listed).toEqual([
      expect.objectContaining({ sessionId: "cursor-session", title: "Cursor work" }),
    ]);
    // A retry after a lost response is answered in band.
    await expect(provider.closeSession!("cursor-session")).resolves.toBeUndefined();
  });
});
