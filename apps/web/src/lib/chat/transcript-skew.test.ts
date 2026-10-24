import { describe, expect, test } from "bun:test";
import {
  classifyTranscriptEntry,
  describeTranscriptSkew,
  transcriptEntryId,
  transcriptSkewNoticeMessage,
} from "./transcript-skew";

describe("classifyTranscriptEntry", () => {
  test("reads the display row every current backend sends", () => {
    expect(classifyTranscriptEntry({ id: "m1", role: "assistant", content: "Hi" })).toBe("display");
    expect(classifyTranscriptEntry({ role: "user" })).toBe("display");
    expect(classifyTranscriptEntry({ content: "" })).toBe("display");
    expect(classifyTranscriptEntry({ parts: [] })).toBe("display");
  });

  test("keeps a display row that carries an `info` field of its own", () => {
    expect(classifyTranscriptEntry({ role: "assistant", content: "Hi", info: { id: "x" } })).toBe(
      "display",
    );
    expect(classifyTranscriptEntry({ id: "m1", info: "not-a-record", content: "Hi" })).toBe(
      "display",
    );
  });

  test("calls any other shape unrecognized", () => {
    expect(classifyTranscriptEntry({ kind: "display-row-v3", row: { text: "Hi" } })).toBe(
      "unrecognized",
    );
    expect(classifyTranscriptEntry({ id: "m1", role: 1, content: null, parts: {} })).toBe(
      "unrecognized",
    );
    expect(classifyTranscriptEntry({})).toBe("unrecognized");
  });
});

describe("transcriptEntryId", () => {
  test("reads the entry's own id", () => {
    expect(transcriptEntryId({ id: "flat" })).toBe("flat");
    expect(transcriptEntryId({ info: { id: "nested" } })).toBeUndefined();
    expect(transcriptEntryId({ id: "" })).toBeUndefined();
    expect(transcriptEntryId({})).toBeUndefined();
  });
});

describe("describeTranscriptSkew", () => {
  test("does not guess which side is older for an unrecognized shape", () => {
    expect(describeTranscriptSkew("unrecognized", 1)).toBe(
      "1 transcript entry not shown: it is in a format this app does not recognize. If this app and its backend run different Orkestrator versions, update the older one.",
    );
    expect(describeTranscriptSkew("unrecognized", 2)).toStartWith(
      "2 transcript entries not shown: they are",
    );
  });
});

describe("transcriptSkewNoticeMessage", () => {
  test("is a system row whose text part repeats its content", () => {
    const notice = transcriptSkewNoticeMessage({
      kind: "unrecognized",
      count: 2,
      anchor: "m4",
      createdAt: "2026-10-16T00:00:00.000Z",
    });
    expect(notice).toEqual({
      id: "transcript-skew:unrecognized:m4",
      role: "system",
      content: describeTranscriptSkew("unrecognized", 2),
      parts: [{ type: "text", content: describeTranscriptSkew("unrecognized", 2) }],
      createdAt: "2026-10-16T00:00:00.000Z",
    });
  });
});
