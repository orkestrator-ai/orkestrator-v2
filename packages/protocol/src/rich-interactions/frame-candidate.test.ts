import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_FRAME_CHANNEL,
  ArtifactFrameRateLimiter,
  isArtifactResultCandidateValue,
  parseArtifactFrameMessage,
} from "../artifact-frame-channel.js";

const identity = { artifactId: "art_explorer01", revision: 5, generation: "gen-1" };
const candidate = (extra: Record<string, unknown> = {}) => ({
  channel: ARTIFACT_FRAME_CHANNEL,
  v: 1,
  type: "result-candidate",
  protocolVersion: 2,
  candidateId: "c-1",
  value: { workers: 4, memoryPerWorkerMiB: 2048 },
  ...identity,
  ...extra,
});

describe("artifact frame result candidates (feature 12)", () => {
  test("a candidate with the exact identity is accepted as proposed values only", () => {
    const parsed = parseArtifactFrameMessage(candidate(), identity);
    expect(parsed).toMatchObject({
      ok: true,
      message: { type: "result-candidate", candidateId: "c-1" },
    });
  });

  test("before the readiness handshake, or for another revision or generation, it is refused", () => {
    expect(parseArtifactFrameMessage(candidate(), null)).toEqual({
      ok: false,
      reason: "identity-mismatch",
    });
    expect(parseArtifactFrameMessage(candidate({ revision: 4 }), identity)).toEqual({
      ok: false,
      reason: "identity-mismatch",
    });
    expect(parseArtifactFrameMessage(candidate({ generation: "gen-0" }), identity)).toEqual({
      ok: false,
      reason: "identity-mismatch",
    });
  });

  test("the candidate protocol version, keys and id are exact", () => {
    expect(parseArtifactFrameMessage(candidate({ protocolVersion: 1 }), identity)).toEqual({
      ok: false,
      reason: "bad-shape",
    });
    expect(parseArtifactFrameMessage(candidate({ submit: true }), identity)).toEqual({
      ok: false,
      reason: "bad-shape",
    });
    expect(parseArtifactFrameMessage(candidate({ candidateId: "bad id!" }), identity)).toEqual({
      ok: false,
      reason: "bad-shape",
    });
  });

  test("values are bounded plain JSON objects", () => {
    expect(isArtifactResultCandidateValue({ a: 1, b: [1, 2], c: { d: "x" } })).toBe(true);
    expect(isArtifactResultCandidateValue([1])).toBe(false);
    expect(isArtifactResultCandidateValue({ a: Number.NaN })).toBe(false);
    expect(isArtifactResultCandidateValue({ a: "x".repeat(7_000) })).toBe(false);
    expect(parseArtifactFrameMessage(candidate({ value: "4 workers" }), identity)).toEqual({
      ok: false,
      reason: "bad-shape",
    });
  });

  test("candidates share the frame rate limit", () => {
    let now = 0;
    const limiter = new ArtifactFrameRateLimiter(() => now);
    let admitted = 0;
    for (let i = 0; i < 100; i += 1) if (limiter.admit("result-candidate")) admitted += 1;
    expect(admitted).toBeLessThan(100);
    now += 10_000;
    expect(limiter.admit("result-candidate")).toBe(true);
  });
});
