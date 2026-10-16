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

  test("recognizes OpenCode's raw envelope from a backend older than 2.19.17", () => {
    expect(
      classifyTranscriptEntry({
        info: { id: "m1", role: "assistant", time: { created: 1 } },
        parts: [{ id: "p1", type: "text", text: "Hi" }],
      }),
    ).toBe("opencode-envelope");
    // A message with no parts yet, or none at all, is still an envelope.
    expect(classifyTranscriptEntry({ info: { id: "m1" } })).toBe("opencode-envelope");
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
  test("reads the id where each shape keeps it", () => {
    expect(transcriptEntryId({ id: "flat" })).toBe("flat");
    expect(transcriptEntryId({ info: { id: "envelope" } })).toBe("envelope");
    expect(transcriptEntryId({ id: "", info: { id: 1 } })).toBeUndefined();
    expect(transcriptEntryId({})).toBeUndefined();
  });
});

describe("describeTranscriptSkew", () => {
  test("tells the user which side to update for a legacy shape", () => {
    expect(describeTranscriptSkew("opencode-envelope", 1)).toBe(
      "1 OpenCode message not shown. The backend runs an Orkestrator version older than 2.19.17, which sends it in a format this app no longer reads. Update Orkestrator on the computer running the backend to see it.",
    );
    expect(describeTranscriptSkew("opencode-envelope", 3)).toBe(
      "3 OpenCode messages not shown. The backend runs an Orkestrator version older than 2.19.17, which sends them in a format this app no longer reads. Update Orkestrator on the computer running the backend to see them.",
    );
  });

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
