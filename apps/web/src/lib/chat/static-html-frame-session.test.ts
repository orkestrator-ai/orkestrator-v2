import { describe, expect, test } from "bun:test";
import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import {
  STATIC_HTML_FRAME_CHANNEL,
  STATIC_HTML_MAX_TEXT_CHUNKS,
} from "@orkestrator/protocol/static-html-presentation";
import { StaticHtmlFrameSession } from "./static-html-frame-session";

const NONCE = "n".repeat(32);
const GENERATION = "g".repeat(32);
const THEME = { appearance: "light" as const, reducedMotion: false, tokens: {} };
const FRAME = { name: "frame window" };

function setup() {
  let now = 1_000_000;
  const session = new StaticHtmlFrameSession({
    nonce: NONCE,
    generation: GENERATION,
    now: () => now,
  });
  const send = (message: Record<string, unknown>, source: unknown = FRAME) =>
    session.handle(
      { source, data: { channel: STATIC_HTML_FRAME_CHANNEL, v: 1, ...message } },
      FRAME,
    );
  return {
    session,
    send,
    advance: (ms: number) => {
      now += ms;
    },
    ready: () => send({ type: "ready", nonce: NONCE }),
    rendered: () => {
      send({ type: "ready", nonce: NONCE });
      session.renderMessage("<p>x</p>", THEME, "light");
      return send({
        type: "rendered",
        generation: GENERATION,
        height: 300,
        elementCount: 4,
        themed: true,
      });
    },
  };
}

describe("StaticHtmlFrameSession", () => {
  test("hands out the document once, only after this mount's own ready", () => {
    const { session, ready } = setup();
    expect(session.renderMessage("<p>x</p>", THEME, "light")).toBeNull();
    expect(ready()).toEqual({ kind: "ready" });
    expect(session.renderMessage("<p>x</p>", THEME, "light")).toMatchObject({
      type: "render",
      generation: GENERATION,
      html: "<p>x</p>",
    });
    expect(session.renderMessage("<p>x</p>", THEME, "light")).toBeNull();
  });

  test("ignores another window even with a valid nonce and generation", () => {
    const { send, session } = setup();
    expect(send({ type: "ready", nonce: NONCE }, { name: "other frame" })).toEqual({
      kind: "rejected",
      reason: "wrong-source",
    });
    expect(session.renderMessage("<p>x</p>", THEME, "light")).toBeNull();
  });

  test("ignores the wrong nonce, version and generation", () => {
    const { send, session, rendered } = setup();
    expect(send({ type: "ready", nonce: "x".repeat(32) })).toEqual({
      kind: "rejected",
      reason: "wrong-nonce",
    });
    expect(session.renderMessage("<p>x</p>", THEME, "light")).toBeNull();
    rendered();
    expect(send({ type: "size", generation: "x".repeat(32), height: 500 })).toEqual({
      kind: "rejected",
      reason: "generation-mismatch",
    });
    expect(send({ type: "size", generation: GENERATION, height: 500, v: 2 })).toEqual({
      kind: "rejected",
      reason: "wrong-version",
    });
  });

  test("nothing it accepts can ask for a privileged action", () => {
    const { send, rendered } = setup();
    rendered();
    for (const type of ["invoke", "backend", "tool", "shortcut", "publish", "clipboard"])
      expect(send({ type, generation: GENERATION })).toEqual({
        kind: "rejected",
        reason: "unknown-type",
      });
  });

  test("a rendered report before any render was sent is refused", () => {
    const { send, ready } = setup();
    ready();
    expect(
      send({ type: "rendered", generation: GENERATION, height: 10, elementCount: 1, themed: true }),
    ).toEqual({ kind: "rejected", reason: "not-rendering" });
  });

  test("a reload is invalidation: a second load or ready never gets the document again", () => {
    for (const reload of ["load", "ready"] as const) {
      const { session, send, rendered } = setup();
      session.noteLoad();
      rendered();
      const outcome =
        reload === "load" ? session.noteLoad() : send({ type: "ready", nonce: NONCE });
      expect(outcome).toEqual({ kind: "reloaded" });
      expect(session.invalidated).toBe(true);
      expect(session.renderMessage("<p>x</p>", THEME, "light")).toBeNull();
      expect(session.themeMessage(THEME)).toBeNull();
      expect(send({ type: "ready", nonce: NONCE })).toEqual({
        kind: "rejected",
        reason: "invalidated",
      });
    }
  });

  test("the first load is not a reload, in either order with ready", () => {
    const { session, ready } = setup();
    expect(session.noteLoad()).toBeNull();
    expect(ready()).toEqual({ kind: "ready" });
    const late = setup();
    expect(late.ready()).toEqual({ kind: "ready" });
    expect(late.session.noteLoad()).toBeNull();
  });

  test("malformed sizes are rejected and do not count", () => {
    const { send, rendered } = setup();
    rendered();
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY, -5, 200_000])
      expect(send({ type: "size", generation: GENERATION, height })).toEqual({
        kind: "rejected",
        reason: "bad-shape",
      });
  });

  test("persistent oscillation stops the mount; ordinary resizing does not", () => {
    const stable = setup();
    stable.rendered();
    for (let index = 0; index < STATIC_PRESENTATION_POLICY.maxSizeChangesPerWindow * 3; index++) {
      stable.advance(STATIC_PRESENTATION_POLICY.sizeChangeWindowMs / 4);
      expect(stable.send({ type: "size", generation: GENERATION, height: 400 + index }).kind).toBe(
        "size",
      );
    }
    const unstable = setup();
    unstable.rendered();
    let last = "";
    for (let index = 0; index <= STATIC_PRESENTATION_POLICY.maxSizeChangesPerWindow; index++) {
      unstable.advance(100);
      last = unstable.send({
        type: "size",
        generation: GENERATION,
        height: index % 2 ? 400 : 500,
      }).kind;
    }
    expect(last).toBe("unstable");
    expect(unstable.session.invalidated).toBe(true);
  });

  test("repeating one height is not instability", () => {
    const { send, rendered, advance } = setup();
    rendered();
    for (let index = 0; index < 100; index++) {
      advance(100);
      expect(send({ type: "size", generation: GENERATION, height: 700 }).kind).toBe("size");
    }
  });

  test("a message flood is refused, then stops the mount", () => {
    const { send, rendered, session } = setup();
    rendered();
    let refused = 0;
    let last = "";
    for (let index = 0; index < 400 && !session.invalidated; index++) {
      const outcome = send({ type: "escape", generation: GENERATION });
      last = outcome.kind;
      if (outcome.kind === "rejected" && outcome.reason === "rate-limited") refused++;
    }
    expect(refused).toBeGreaterThan(0);
    expect(last).toBe("unstable");
  });

  test("a link's display form is derived here, not taken from the frame", () => {
    const { send, rendered } = setup();
    rendered();
    expect(
      send({
        type: "link-request",
        generation: GENERATION,
        url: "HTTPS://Example.com/a b",
        label: "Report",
      }),
    ).toEqual({
      kind: "link",
      href: "https://example.com/a%20b",
      hostname: "example.com",
      label: "Report",
    });
    expect(
      send({ type: "link-request", generation: GENERATION, url: "javascript:x", label: "" }),
    ).toEqual({ kind: "rejected", reason: "bad-shape" });
  });

  describe("document text", () => {
    const chunk = (index: number, count: number, text = `part ${index} `) => ({
      type: "text",
      generation: GENERATION,
      index,
      count,
      text,
    });

    test("is reassembled, and handed over only once it is whole", () => {
      const { send, rendered } = setup();
      rendered();
      expect(send(chunk(0, 3))).toEqual({ kind: "text-partial" });
      expect(send(chunk(1, 3))).toEqual({ kind: "text-partial" });
      expect(send(chunk(2, 3))).toEqual({ kind: "text", text: "part 0 part 1 part 2 " });
    });

    test("is refused before the document has rendered", () => {
      const { send, ready } = setup();
      ready();
      expect(send(chunk(0, 1))).toEqual({ kind: "rejected", reason: "not-rendering" });
    });

    test("is reported once per mount", () => {
      const { send, rendered } = setup();
      rendered();
      expect(send(chunk(0, 1, "first")).kind).toBe("text");
      expect(send(chunk(0, 1, "second"))).toEqual({ kind: "rejected", reason: "bad-shape" });
    });

    test("with a chunk missing is abandoned rather than indexed in part", () => {
      const { send, rendered } = setup();
      rendered();
      send(chunk(0, 3));
      expect(send(chunk(2, 3))).toEqual({ kind: "rejected", reason: "bad-shape" });
      expect(send(chunk(1, 3))).toEqual({ kind: "rejected", reason: "bad-shape" });
    });

    test("of a full report is not refused by the channel's rate limit", () => {
      const { send, rendered } = setup();
      rendered();
      const kinds = Array.from(
        { length: STATIC_HTML_MAX_TEXT_CHUNKS },
        (_, index) => send(chunk(index, STATIC_HTML_MAX_TEXT_CHUNKS)).kind,
      );
      expect(kinds.at(-1)).toBe("text");
      expect(kinds.filter((kind) => kind === "text-partial")).toHaveLength(
        STATIC_HTML_MAX_TEXT_CHUNKS - 1,
      );
    });
  });

  test("a frame error ends the mount", () => {
    const { send, rendered, session } = setup();
    rendered();
    expect(send({ type: "error", generation: GENERATION, code: "render-failed" })).toEqual({
      kind: "error",
      code: "render-failed",
    });
    expect(session.invalidated).toBe(true);
  });
});
