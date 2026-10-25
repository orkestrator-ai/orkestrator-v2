import { describe, expect, test } from "bun:test";
import { hydrationFreshnessNotice, remoteFreshnessNotice } from "./view-freshness";

describe("hydrationFreshnessNotice", () => {
  test("says nothing while current, idle or hydrating", () => {
    // A quiet safety check never leaves `current`, and a reconnect's
    // `hydrating` is not a failure: neither may flicker an indicator.
    for (const status of ["current", "idle", "hydrating"] as const) {
      expect(hydrationFreshnessNotice(status, "change counts")).toBeNull();
      expect(hydrationFreshnessNotice(status, "change counts", { polled: true })).toBeNull();
    }
  });

  test("describes stale, degraded and unsupported mirrors", () => {
    expect(hydrationFreshnessNotice("stale", "change counts")?.kind).toBe("stale");
    expect(hydrationFreshnessNotice("degraded", "change counts")?.kind).toBe("degraded");
    expect(hydrationFreshnessNotice("unsupported", "change counts")?.kind).toBe("unsupported");
    expect(hydrationFreshnessNotice("stale", "change counts")?.detail).toContain(
      "last state received",
    );
  });

  test("a polled view only reports delayed announcements, never the polling fallback", () => {
    expect(hydrationFreshnessNotice("unsupported", "the file lists", { polled: true })).toBeNull();
    const notice = hydrationFreshnessNotice("degraded", "the file lists", { polled: true });
    expect(notice?.kind).toBe("degraded");
    expect(notice?.detail).toContain("periodic re-read");
  });
});

describe("remoteFreshnessNotice", () => {
  test("says nothing for local worktrees, older backends and current or immutable bases", () => {
    expect(remoteFreshnessNotice(undefined, "origin/main")).toBeNull();
    expect(remoteFreshnessNotice({ state: "current" }, "origin/main")).toBeNull();
    expect(remoteFreshnessNotice({ state: "not-required" }, "origin/main")).toBeNull();
  });

  test("a stale base is exact against the clone's refs, never unusable", () => {
    const notice = remoteFreshnessNotice(
      { state: "stale", lastSuccessAt: "2026-10-25T09:30:00.000Z", failure: "network" },
      "origin/main",
    );
    expect(notice?.kind).toBe("remote-stale");
    expect(notice?.detail).toContain("origin/main");
    expect(notice?.detail).toContain("exact");
    expect(notice?.detail).toContain("could not be reached");
    expect(notice?.detail).not.toMatch(/unusable|invalid|wrong/i);
  });

  test("a stale base without a known fetch time does not invent one", () => {
    const notice = remoteFreshnessNotice({ state: "stale" }, "origin/main");
    expect(notice?.detail).toContain("as this clone holds it");
  });

  test("an unfetched base is reported as not fetched yet", () => {
    expect(remoteFreshnessNotice({ state: "unknown" }, "origin/main")?.kind).toBe("remote-unknown");
  });
});
