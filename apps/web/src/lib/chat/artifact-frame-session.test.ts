import { describe, expect, test } from "bun:test";
import { ARTIFACT_FRAME_CHANNEL } from "@orkestrator/protocol/artifact-frame-channel";
import { FRAME_CHANNEL_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { ArtifactFrameSession, artifactShellLocation } from "./artifact-frame-session";

const frame = { name: "captured-frame-window" };
const other = { name: "another-window" };
const identity = { artifactId: "art_abcdefgh1", revision: 3, generation: "gen-1" };

function session(now?: () => number) {
  return new ArtifactFrameSession({ ...identity, readinessNonce: "nonce-12345678", now });
}

const ready = {
  channel: ARTIFACT_FRAME_CHANNEL,
  v: 1,
  type: "ready",
  protocolVersion: 1,
  nonce: "nonce-12345678",
};
const size = (height: number, overrides: Record<string, unknown> = {}) => ({
  channel: ARTIFACT_FRAME_CHANNEL,
  v: 1,
  type: "size",
  height,
  ...identity,
  ...overrides,
});
const link = (url: string) => ({
  channel: ARTIFACT_FRAME_CHANNEL,
  v: 1,
  type: "link-request",
  url,
  label: "Docs",
  ...identity,
});

describe("ArtifactFrameSession", () => {
  test("rejects messages that do not come from the captured frame window", () => {
    const channel = session();
    expect(channel.handle({ source: other, data: ready }, frame)).toEqual({
      kind: "rejected",
      reason: "wrong-source",
    });
    expect(channel.handle({ source: null, data: ready }, frame)).toEqual({
      kind: "rejected",
      reason: "wrong-source",
    });
    expect(channel.handle({ source: frame, data: ready }, null)).toEqual({
      kind: "rejected",
      reason: "wrong-source",
    });
    expect(channel.ready).toBe(false);
  });

  test("requires the readiness nonce before accepting identity-bearing messages", () => {
    const channel = session();
    expect(channel.handle({ source: frame, data: size(300) }, frame)).toEqual({
      kind: "rejected",
      reason: "identity-mismatch",
    });
    expect(
      channel.themeMessage({
        appearance: "dark",
        reducedMotion: false,
        viewport: { width: 1, height: 1 },
        tokens: {},
      }),
    ).toBeNull();
    expect(
      channel.handle({ source: frame, data: { ...ready, nonce: "other-nonce-1" } }, frame),
    ).toEqual({
      kind: "rejected",
      reason: "wrong-nonce",
    });
    expect(channel.handle({ source: frame, data: ready }, frame)).toEqual({ kind: "ready" });
    expect(channel.handle({ source: frame, data: ready }, frame)).toEqual({
      kind: "rejected",
      reason: "duplicate-ready",
    });
    expect(channel.handle({ source: frame, data: size(300) }, frame)).toEqual({
      kind: "size",
      height: 300,
    });
  });

  test("rejects a wrong generation, unknown types and oversized messages", () => {
    const channel = session();
    channel.handle({ source: frame, data: ready }, frame);
    expect(
      channel.handle({ source: frame, data: size(300, { generation: "gen-0" }) }, frame),
    ).toEqual({
      kind: "rejected",
      reason: "identity-mismatch",
    });
    expect(channel.handle({ source: frame, data: size(300, { revision: 2 }) }, frame)).toEqual({
      kind: "rejected",
      reason: "identity-mismatch",
    });
    expect(channel.handle({ source: frame, data: { ...size(1), type: "prompt" } }, frame)).toEqual({
      kind: "rejected",
      reason: "unknown-type",
    });
    expect(channel.handle({ source: frame, data: { ...size(1), type: "theme" } }, frame)).toEqual({
      kind: "rejected",
      reason: "unknown-type",
    });
    expect(channel.handle({ source: frame, data: { ...size(1), extra: true } }, frame)).toEqual({
      kind: "rejected",
      reason: "bad-shape",
    });
    const huge = {
      ...link("https://example.com/"),
      label: "x".repeat(FRAME_CHANNEL_POLICY.maxMessageBytes + 10),
    };
    expect(channel.handle({ source: frame, data: huge }, frame)).toEqual({
      kind: "rejected",
      reason: "too-large",
    });
    expect(channel.handle({ source: frame, data: "ready" }, frame)).toEqual({
      kind: "rejected",
      reason: "not-object",
    });
  });

  test("rate limits a flood of messages", () => {
    let now = 1_000;
    const channel = session(() => now);
    channel.handle({ source: frame, data: ready }, frame);
    let limited = 0;
    for (let index = 0; index < FRAME_CHANNEL_POLICY.burst + 10; index++) {
      const outcome = channel.handle(
        { source: frame, data: link(`https://example.com/${index}`) },
        frame,
      );
      if (outcome.kind === "rate-limited") limited++;
    }
    expect(limited).toBeGreaterThan(0);
    // Size updates are coalesced to at most 4 per second.
    now += 10_000;
    expect(channel.handle({ source: frame, data: size(200) }, frame).kind).toBe("size");
    expect(channel.handle({ source: frame, data: size(210) }, frame).kind).toBe("rate-limited");
  });

  test("link requests are normalized http(s) only and never act by themselves", () => {
    const channel = session();
    channel.handle({ source: frame, data: ready }, frame);
    expect(
      channel.handle({ source: frame, data: link("https://Example.com/a?b=1") }, frame),
    ).toEqual({
      kind: "link",
      href: "https://example.com/a?b=1",
      hostname: "example.com",
      label: "Docs",
    });
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pw@example.com/",
      "data:text/html,x",
    ]) {
      expect(channel.handle({ source: frame, data: link(url) }, frame)).toEqual({
        kind: "rejected",
        reason: "bad-shape",
      });
    }
  });

  test("invalidation (reload, navigation, scope change) ends the channel", () => {
    const channel = session();
    channel.handle({ source: frame, data: ready }, frame);
    channel.invalidate();
    expect(channel.ready).toBe(false);
    expect(channel.handle({ source: frame, data: size(10) }, frame)).toEqual({
      kind: "rejected",
      reason: "invalidated",
    });
    expect(channel.handle({ source: frame, data: ready }, frame)).toEqual({
      kind: "rejected",
      reason: "invalidated",
    });
  });

  test("theme messages carry presentation data and the current identity only", () => {
    const channel = session();
    channel.handle({ source: frame, data: ready }, frame);
    expect(
      channel.themeMessage({
        appearance: "light",
        reducedMotion: true,
        viewport: { width: 400.4, height: 300.6 },
        tokens: { "--ork-background": "#fff" },
      }),
    ).toEqual({
      channel: ARTIFACT_FRAME_CHANNEL,
      v: 1,
      type: "theme",
      ...identity,
      appearance: "light",
      reducedMotion: true,
      viewport: { width: 400, height: 301 },
      tokens: { "--ork-background": "#fff" },
    });
  });

  test("with an expected origin, messages from any other origin are refused", () => {
    const shellOrigin = "http://localhost:47123";
    const channel = new ArtifactFrameSession({
      ...identity,
      readinessNonce: "nonce-12345678",
      expectedOrigin: shellOrigin,
    });
    for (const origin of [undefined, "null", "http://127.0.0.1:47123", "http://evil.example"]) {
      expect(channel.handle({ source: frame, data: ready, origin }, frame)).toEqual({
        kind: "rejected",
        reason: "wrong-origin",
      });
    }
    expect(channel.handle({ source: frame, data: ready, origin: shellOrigin }, frame)).toEqual({
      kind: "ready",
    });
  });

  test("the shell's dispose notice invalidates the channel; a malformed one is refused", () => {
    const channel = session();
    channel.handle({ source: frame, data: ready }, frame);
    const disposed = { channel: ARTIFACT_FRAME_CHANNEL, v: 1, type: "shell-disposed" };
    expect(channel.handle({ source: other, data: { ...disposed, reason: "x" } }, frame)).toEqual({
      kind: "rejected",
      reason: "wrong-source",
    });
    expect(channel.handle({ source: frame, data: { ...disposed, reason: "x" } }, frame)).toEqual({
      kind: "rejected",
      reason: "bad-shape",
    });
    expect(channel.ready).toBe(true);
    expect(
      channel.handle({ source: frame, data: { ...disposed, reason: "unexpected-load" } }, frame),
    ).toEqual({ kind: "disposed", reason: "unexpected-load" });
    expect(channel.ready).toBe(false);
    expect(channel.handle({ source: frame, data: size(10) }, frame)).toEqual({
      kind: "rejected",
      reason: "invalidated",
    });
  });

  test("the shell location must share the document's origin and never the application's", () => {
    const content = "http://localhost:47123/a/token";
    expect(
      artifactShellLocation(
        { contentUrl: content, shellUrl: "http://localhost:47123/s/token" },
        "http://127.0.0.1:4100",
      ),
    ).toEqual({ url: "http://localhost:47123/s/token", origin: "http://localhost:47123" });
    for (const shellUrl of [
      undefined,
      "",
      "not a url",
      "http://127.0.0.1:47123/s/token",
      "javascript:alert(1)",
      "http://user:pw@localhost:47123/s/token",
      "http://localhost:47123/s/token#x",
    ]) {
      expect(
        artifactShellLocation(
          { contentUrl: content, shellUrl: shellUrl as string },
          "http://127.0.0.1:4100",
        ),
      ).toBeNull();
    }
    expect(
      artifactShellLocation(
        { contentUrl: content, shellUrl: "http://localhost:47123/s/token" },
        "http://localhost:47123",
      ),
    ).toBeNull();
  });
});
