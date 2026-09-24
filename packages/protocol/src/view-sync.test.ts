import { describe, expect, test } from "bun:test";
import {
  classifyViewSnapshotResponse,
  isUnknownViewCommandError,
  isViewGeneration,
  isViewSnapshotOutcome,
  parseViewSnapshotRequest,
  readViewRevisionStamp,
  resolveViewSnapshotOutcome,
  toViewSnapshotRequestArgs,
  VIEW_GENERATION_MAX_LENGTH,
} from "./view-sync.js";

interface Body {
  entries: string[];
}

function isBody(value: unknown): value is Body {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Body).entries) &&
    (value as Body).entries.every((entry) => typeof entry === "string")
  );
}

describe("view revision stamps", () => {
  test("generations are bounded printable tokens compared only for equality", () => {
    expect(isViewGeneration("0f3a9c")).toBe(true);
    expect(isViewGeneration("a".repeat(VIEW_GENERATION_MAX_LENGTH))).toBe(true);
    expect(isViewGeneration("a".repeat(VIEW_GENERATION_MAX_LENGTH + 1))).toBe(false);
    expect(isViewGeneration("")).toBe(false);
    expect(isViewGeneration("has space")).toBe(false);
    expect(isViewGeneration(12)).toBe(false);
  });

  test("absent fields mean a legacy peer; a partial or malformed pair is invalid", () => {
    expect(readViewRevisionStamp({}, "event")).toBeNull();
    expect(readViewRevisionStamp({ generation: "g1", revision: 3 }, "event")).toEqual({
      generation: "g1",
      revision: 3,
    });
    expect(readViewRevisionStamp({ generation: "g1" }, "event")).toBe("invalid");
    expect(readViewRevisionStamp({ revision: 3 }, "event")).toBe("invalid");
    expect(readViewRevisionStamp({ generation: "g1", revision: 1.5 }, "event")).toBe("invalid");
    expect(readViewRevisionStamp({ generation: "g1", revision: "3" }, "event")).toBe("invalid");
    expect(readViewRevisionStamp(null, "event")).toBe("invalid");
  });

  test("revision zero is valid for snapshots only", () => {
    expect(readViewRevisionStamp({ generation: "g1", revision: 0 }, "snapshot")).toEqual({
      generation: "g1",
      revision: 0,
    });
    expect(readViewRevisionStamp({ generation: "g1", revision: 0 }, "event")).toBe("invalid");
    expect(readViewRevisionStamp({ generation: "g1", revision: -1 }, "snapshot")).toBe("invalid");
  });
});

describe("conditional snapshot requests", () => {
  test("parses absent, known, and malformed request arguments", () => {
    expect(parseViewSnapshotRequest(undefined)).toEqual({ kind: "absent" });
    expect(parseViewSnapshotRequest({})).toEqual({ kind: "absent" });
    expect(
      parseViewSnapshotRequest(toViewSnapshotRequestArgs({ generation: "g", revision: 0 })),
    ).toEqual({ kind: "known", known: { generation: "g", revision: 0 } });
    expect(parseViewSnapshotRequest({ knownGeneration: "g" })).toEqual({ kind: "invalid" });
    expect(parseViewSnapshotRequest({ knownGeneration: "g", knownRevision: -2 })).toEqual({
      kind: "invalid",
    });
  });

  test("answers unchanged without capturing a body when the client is current", () => {
    let captures = 0;
    const outcome = resolveViewSnapshotOutcome(
      { kind: "known", known: { generation: "g", revision: 7 } },
      { generation: "g", revision: 7 },
      () => {
        captures += 1;
        return { entries: [] };
      },
    );
    expect(outcome).toEqual({ status: "unchanged", generation: "g", revision: 7 });
    expect(captures).toBe(0);
  });

  test("returns a snapshot for an older revision of the same generation", () => {
    expect(
      resolveViewSnapshotOutcome(
        { kind: "known", known: { generation: "g", revision: 3 } },
        { generation: "g", revision: 7 },
        () => ({ entries: ["a"] }),
      ),
    ).toEqual({ status: "snapshot", generation: "g", revision: 7, snapshot: { entries: ["a"] } });
  });

  test("resets for another generation, a client ahead of the owner, or a malformed request", () => {
    const current = { generation: "g2", revision: 1 };
    const body = () => ({ entries: ["b"] });
    expect(
      resolveViewSnapshotOutcome(
        { kind: "known", known: { generation: "g1", revision: 1 } },
        current,
        body,
      ),
    ).toMatchObject({ status: "reset", reason: "generation", revision: 1 });
    expect(
      resolveViewSnapshotOutcome(
        { kind: "known", known: { generation: "g2", revision: 9 } },
        current,
        body,
      ),
    ).toMatchObject({ status: "reset", reason: "ahead" });
    expect(resolveViewSnapshotOutcome({ kind: "invalid" }, current, body)).toMatchObject({
      status: "reset",
      reason: "invalid-request",
    });
  });

  test("validates every outcome variant including its body", () => {
    expect(
      isViewSnapshotOutcome({ status: "unchanged", generation: "g", revision: 1 }, isBody),
    ).toBe(true);
    expect(isViewSnapshotOutcome({ status: "deleted", generation: "g", revision: 4 }, isBody)).toBe(
      true,
    );
    expect(
      isViewSnapshotOutcome(
        { status: "snapshot", generation: "g", revision: 2, snapshot: { entries: ["x"] } },
        isBody,
      ),
    ).toBe(true);
    expect(
      isViewSnapshotOutcome(
        { status: "snapshot", generation: "g", revision: 2, snapshot: { entries: [1] } },
        isBody,
      ),
    ).toBe(false);
    expect(
      isViewSnapshotOutcome(
        { status: "reset", generation: "g", revision: 2, snapshot: { entries: [] } },
        isBody,
      ),
    ).toBe(false);
    expect(
      isViewSnapshotOutcome(
        {
          status: "reset",
          generation: "g",
          revision: 2,
          snapshot: { entries: [] },
          reason: "generation",
        },
        isBody,
      ),
    ).toBe(true);
    expect(isViewSnapshotOutcome({ status: "unchanged", generation: "g" }, isBody)).toBe(false);
    expect(
      isViewSnapshotOutcome(
        { status: "unchanged", generation: "g", revision: 1, snapshot: { entries: [] } },
        isBody,
      ),
    ).toBe(false);
    expect(isViewSnapshotOutcome({ status: "other", generation: "g", revision: 1 }, isBody)).toBe(
      false,
    );
  });
});

describe("capability fallback", () => {
  test("classifies outcome, stamped, legacy, and invalid responses", () => {
    expect(
      classifyViewSnapshotResponse({ status: "unchanged", generation: "g", revision: 1 }, isBody),
    ).toEqual({
      kind: "outcome",
      outcome: { status: "unchanged", generation: "g", revision: 1 },
    });
    expect(
      classifyViewSnapshotResponse({ entries: ["a"], generation: "g", revision: 0 }, isBody),
    ).toEqual({
      kind: "stamped",
      stamp: { generation: "g", revision: 0 },
      snapshot: { entries: ["a"], generation: "g", revision: 0 },
    });
    expect(classifyViewSnapshotResponse({ entries: [] }, isBody)).toEqual({
      kind: "legacy",
      snapshot: { entries: [] },
    });
    expect(classifyViewSnapshotResponse({ entries: [], generation: "g" }, isBody)).toEqual({
      kind: "invalid",
    });
    expect(classifyViewSnapshotResponse({ status: "snapshot" }, isBody)).toEqual({
      kind: "invalid",
    });
    expect(classifyViewSnapshotResponse("nonsense", isBody)).toEqual({ kind: "invalid" });
  });

  test("only the backend's unknown-command answer selects the unsupported capability", () => {
    expect(
      isUnknownViewCommandError(
        new Error("Unknown backend command: get_pr_monitor_state"),
        "get_pr_monitor_state",
      ),
    ).toBe(true);
    expect(
      isUnknownViewCommandError(
        new Error("Unknown backend command: other"),
        "get_pr_monitor_state",
      ),
    ).toBe(false);
    expect(isUnknownViewCommandError(new Error("401 Unauthorized"), "get_pr_monitor_state")).toBe(
      false,
    );
    expect(isUnknownViewCommandError(undefined, "get_pr_monitor_state")).toBe(false);
  });
});
