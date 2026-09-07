import { describe, expect, test } from "bun:test";
import {
  MAX_RUNTIME_NOTICES,
  MAX_RUNTIME_NOTICE_OCCURRENCES,
  RuntimeHealthRecorder,
  emptyRuntimeHealth,
} from "./runtime-health.js";
import { MAX_NATIVE_AGENT_DRIFT_KINDS } from "./native-agent.js";

describe("drift recording", () => {
  test("a clean recorder reports no drift at all, not a zero", () => {
    expect(new RuntimeHealthRecorder().drift()).toBeUndefined();
    expect(new RuntimeHealthRecorder().snapshot()).toEqual({ notices: [] });
  });

  test("counts every unknown event and keeps the kind names", () => {
    const recorder = new RuntimeHealthRecorder();
    recorder.recordUnknown("summary-started");
    recorder.recordUnknown("summary-started");
    recorder.recordUnknown("record-screen");
    expect(recorder.drift()).toEqual({
      unknownEvents: 3,
      unknownKinds: ["summary-started", "record-screen"],
    });
  });

  test("a repeated kind moves to the newest end of the retained window", () => {
    // Otherwise a kind that arrives constantly is evicted by one-off names
    // while the one-offs are the entries retained.
    const recorder = new RuntimeHealthRecorder();
    recorder.recordUnknown("first");
    recorder.recordUnknown("second");
    recorder.recordUnknown("first");
    expect(recorder.drift()?.unknownKinds).toEqual(["second", "first"]);
  });

  test("the kind list is bounded and drops oldest first", () => {
    const recorder = new RuntimeHealthRecorder();
    for (let index = 0; index < MAX_NATIVE_AGENT_DRIFT_KINDS + 5; index += 1) {
      recorder.recordUnknown(`kind-${index}`);
    }
    const drift = recorder.drift()!;
    expect(drift.unknownEvents).toBe(MAX_NATIVE_AGENT_DRIFT_KINDS + 5);
    expect(drift.unknownKinds).toHaveLength(MAX_NATIVE_AGENT_DRIFT_KINDS);
    expect(drift.unknownKinds[0]).toBe("kind-5");
    expect(drift.unknownKinds.at(-1)).toBe(`kind-${MAX_NATIVE_AGENT_DRIFT_KINDS + 4}`);
  });

  test("a long kind name is truncated rather than retained whole", () => {
    const recorder = new RuntimeHealthRecorder();
    recorder.recordUnknown("x".repeat(500));
    expect(recorder.drift()?.unknownKinds[0]).toHaveLength(128);
  });

  test("an empty kind still counts but names nothing", () => {
    const recorder = new RuntimeHealthRecorder();
    recorder.recordUnknown("");
    expect(recorder.drift()).toEqual({ unknownEvents: 1, unknownKinds: [] });
  });
});

describe("notice recording", () => {
  test("defaults an omitted severity and source to warning/bridge", () => {
    const recorder = new RuntimeHealthRecorder();
    recorder.recordNotice({ message: "Something odd" });
    expect(recorder.listNotices()[0]).toMatchObject({
      message: "Something odd",
      severity: "warning",
      source: "bridge",
      count: 1,
    });
  });

  test("deduplicates on method and message, counting repeats", () => {
    const recorder = new RuntimeHealthRecorder();
    recorder.recordNotice({ message: "Model rerouted", method: "model/rerouted" });
    recorder.recordNotice({ message: "Model rerouted", method: "model/rerouted" });
    recorder.recordNotice({ message: "Model rerouted", method: "other" });
    const notices = recorder.listNotices();
    expect(notices).toHaveLength(2);
    expect(notices.find((notice) => notice.method === "model/rerouted")?.count).toBe(2);
  });

  test("occurrences are bounded to the most recent few", () => {
    const recorder = new RuntimeHealthRecorder();
    for (let index = 0; index < MAX_RUNTIME_NOTICE_OCCURRENCES + 3; index += 1) {
      recorder.recordNotice({ message: "repeat", detail: `detail-${index}` });
    }
    const notice = recorder.listNotices()[0]!;
    expect(notice.count).toBe(MAX_RUNTIME_NOTICE_OCCURRENCES + 3);
    expect(notice.occurrences).toHaveLength(MAX_RUNTIME_NOTICE_OCCURRENCES);
    expect(notice.occurrences?.[0]?.detail).toBe("detail-3");
  });

  test("the notice map is bounded and drops oldest first", () => {
    const recorder = new RuntimeHealthRecorder();
    for (let index = 0; index < MAX_RUNTIME_NOTICES + 4; index += 1) {
      recorder.recordNotice({ message: `notice-${index}` });
    }
    const notices = recorder.listNotices();
    expect(notices).toHaveLength(MAX_RUNTIME_NOTICES);
    expect(notices[0]?.message).toBe("notice-4");
  });

  test("message and detail are truncated to their bounds", () => {
    const recorder = new RuntimeHealthRecorder();
    recorder.recordNotice({ message: "m".repeat(4_000), detail: "d".repeat(4_000) });
    const notice = recorder.listNotices()[0]!;
    expect(notice.message).toHaveLength(1_000);
    expect(notice.occurrences?.[0]?.detail).toHaveLength(1_000);
  });

  test("an empty message records nothing", () => {
    const recorder = new RuntimeHealthRecorder();
    recorder.recordNotice({ message: "" });
    expect(recorder.listNotices()).toEqual([]);
  });
});

describe("advisories", () => {
  test("only error notices reach the transcript", () => {
    const recorder = new RuntimeHealthRecorder();
    recorder.recordNotice({ message: "inventory", severity: "info" });
    recorder.recordNotice({ message: "deprecated", severity: "warning", source: "provider" });
    recorder.recordNotice({ message: "broken", severity: "error", source: "provider" });
    expect(recorder.advisories()).toEqual([{ message: "broken", severity: "error" }]);
  });

  test("advisories are bounded to the most recent few", () => {
    const recorder = new RuntimeHealthRecorder();
    for (let index = 0; index < 9; index += 1) {
      recorder.recordNotice({ message: `advisory-${index}`, severity: "error" });
    }
    const advisories = recorder.advisories();
    expect(advisories).toHaveLength(5);
    expect(advisories[0]?.message).toBe("advisory-4");
  });
});

describe("the unknown-session answer", () => {
  test("is in band and empty, never a 404 body", () => {
    // The backend reads a 404 on a shared route as "this bridge is older than
    // the route" and fails the environment.
    expect(emptyRuntimeHealth()).toEqual({ summary: {}, notices: [] });
  });
});

describe("reset", () => {
  test("clears both drift and notices", () => {
    const recorder = new RuntimeHealthRecorder();
    recorder.recordUnknown("kind");
    recorder.recordNotice({ message: "notice" });
    recorder.reset();
    expect(recorder.snapshot()).toEqual({ notices: [] });
  });
});
