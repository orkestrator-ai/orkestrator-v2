import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { Lifetime } from "./lifetime";

let logs: LogCapture;
beforeEach(() => {
  logs = captureLogs();
});
afterEach(() => {
  logs.restore();
});

describe("Lifetime (over an Effect Scope)", () => {
  test("runs finalizers in reverse order of registration, once", () => {
    const events: string[] = [];
    const lifetime = Lifetime.root("test");
    lifetime.onClose("first", () => events.push("first"));
    lifetime.onClose("second", () => events.push("second"));
    lifetime.close();
    lifetime.close();
    expect(events).toEqual(["second", "first"]);
    expect(lifetime.closed).toBe(true);
  });

  test("a child closes with its parent, before the parent's earlier finalizers", () => {
    const events: string[] = [];
    const parent = Lifetime.root("parent");
    parent.onClose("parent", () => events.push("parent"));
    const child = parent.child("child");
    child.onClose("child", () => events.push("child"));
    parent.close();
    expect(events).toEqual(["child", "parent"]);
    expect(child.closed).toBe(true);
  });

  test("closing a child early detaches it, so the parent does not run it again", () => {
    const events: string[] = [];
    const parent = Lifetime.root("parent");
    const child = parent.child("child");
    child.onClose("child", () => events.push("child"));
    child.close();
    parent.close();
    expect(events).toEqual(["child"]);
  });

  test("a finalizer added after close runs at once", () => {
    const lifetime = Lifetime.root("test");
    lifetime.close();
    let ran = false;
    lifetime.onClose("late", () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(() => lifetime.child("late-child")).toThrow(/has ended/);
  });

  test("a throwing finalizer is logged by name and the others still run", () => {
    const events: string[] = [];
    const lifetime = Lifetime.root("node:leaf");
    lifetime.onClose("kept", () => events.push("kept"));
    lifetime.onClose("broken", () => {
      throw new TypeError("contents of a private file");
    });
    expect(() => lifetime.close()).not.toThrow();
    expect(events).toEqual(["kept"]);
    const failures = logs.records().filter((record) => record.event === "finalizer.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.fields).toEqual({
      lifetime: "node:leaf",
      finalizer: "broken",
      error: "TypeError",
    });
    expect(logs.lines.join("\n")).not.toContain("private");
  });
});
