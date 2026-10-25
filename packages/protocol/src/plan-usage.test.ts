import { describe, expect, test } from "bun:test";
import {
  CLAUDE_PLAN_WINDOW_LABELS,
  claudeModelWeeklyWindow,
  claudePlanWindowFromKind,
  claudePlanWindowFromLabel,
  stalePlanUsageSnapshot,
} from "./plan-usage.js";

describe("Claude window identities", () => {
  test.each([
    [" Five Hour ", "five_hour"],
    ["SESSION", "five_hour"],
    ["Weekly", "seven_day"],
    ["weekly all", "seven_day"],
    ["Weekly (OAuth Apps)", "seven_day_oauth_apps"],
    ["Weekly apps limit", "seven_day_oauth_apps"],
    ["Weekly (Opus)", "seven_day_opus"],
    ["Weekly SONNET limit", "seven_day_sonnet"],
  ])("resolves legacy/canonical label %s", (label, id) => {
    expect(claudePlanWindowFromLabel(label)).toEqual({ id, ...CLAUDE_PLAN_WINDOW_LABELS[id]! });
  });

  test("resolves punctuation and multiword models to the same slug", () => {
    const identity = claudeModelWeeklyWindow("  Fable Pro 2.1 ")!;
    expect(identity).toEqual({
      id: "seven_day_fable_pro_2_1",
      label: "Weekly Fable Pro 2.1 limit",
      windowMinutes: 10_080,
    });
    expect(claudePlanWindowFromLabel("Weekly (Fable-Pro 2.1)")?.id).toBe(identity.id);
    expect(claudePlanWindowFromLabel("Weekly Fable Pro 2.1 limit")?.id).toBe(identity.id);
  });

  test("gives the canonical apps label precedence over a model match", () => {
    expect(claudePlanWindowFromLabel("weekly apps limit")?.id).toBe("seven_day_oauth_apps");
    expect(claudePlanWindowFromLabel("Weekly (OAuth Apps)")?.id).toBe("seven_day_oauth_apps");
    expect(claudePlanWindowFromLabel("Weekly OAuth-Apps limit")).toEqual({
      id: "seven_day_oauth_apps",
      ...CLAUDE_PLAN_WINDOW_LABELS.seven_day_oauth_apps!,
    });
    expect(claudePlanWindowFromLabel("Weekly (Opus!)")).toEqual({
      id: "seven_day_opus",
      ...CLAUDE_PLAN_WINDOW_LABELS.seven_day_opus!,
    });
  });

  test.each(["", "   ", "--?!", "🪶"])("rejects empty model slug %s", (name) => {
    expect(claudeModelWeeklyWindow(name)).toBeUndefined();
    expect(claudePlanWindowFromLabel(`Weekly (${name})`)).toBeUndefined();
  });

  test("leaves unrecognized labels to the caller's slug fallback", () => {
    expect(claudePlanWindowFromLabel("Opus")).toBeUndefined();
    expect(claudePlanWindowFromLabel("New quota")).toBeUndefined();
  });

  test("classifies named windows by kind rather than unrelated scope labels", () => {
    expect(claudePlanWindowFromKind("session", "Opus")?.id).toBe("five_hour");
    expect(claudePlanWindowFromKind("weekly_all", "Opus")?.id).toBe("seven_day");
    expect(claudePlanWindowFromKind("weekly_scoped", " Opus ")?.id).toBe("seven_day_opus");
    expect(claudePlanWindowFromKind("weekly_scoped")).toBeUndefined();
    expect(claudePlanWindowFromKind("weekly_scoped", " ")).toBeUndefined();
    expect(claudePlanWindowFromKind("unknown", "Opus")).toBeUndefined();
  });
});

describe("stalePlanUsageSnapshot", () => {
  test("keeps the reading's time and empties windows that have reset since", () => {
    const now = Date.parse("2026-10-18T12:00:00.000Z");
    const stale = stalePlanUsageSnapshot(
      {
        platform: "claude",
        status: "ok",
        plan: "max",
        windows: [
          { window: "five_hour", usedPercent: 80, resetsAt: "2026-10-18T11:00:00.000Z" },
          { window: "seven_day", usedPercent: 40, resetsAt: "2026-10-20T00:00:00.000Z" },
        ],
        fetchedAt: "2026-10-18T09:00:00.000Z",
      },
      now,
      "Rate limited.",
    );
    expect(stale).toEqual({
      platform: "claude",
      status: "ok",
      plan: "max",
      windows: [
        { window: "five_hour", usedPercent: 0 },
        { window: "seven_day", usedPercent: 40, resetsAt: "2026-10-20T00:00:00.000Z" },
      ],
      message: "Rate limited.",
      stale: true,
      fetchedAt: "2026-10-18T09:00:00.000Z",
    });
  });
});
