import { expect, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { isRealmBootTimingMessage, logRealmBootTiming } from "../electron/realm-boot-timing-log";

test("writes a realm's boot step with the node from the main process, content-free", () => {
  const logs = captureLogs();
  try {
    const message = {
      type: "bootTiming",
      step: "fan-out-complete",
      durationMs: 2_150,
      sinceStartMs: 4_020,
      requests: 31,
      prompt: "never logged",
    };
    expect(isRealmBootTimingMessage(message)).toBe(true);
    expect(isRealmBootTimingMessage({ type: "selection" })).toBe(false);
    logRealmBootTiming(message, { nodeId: "bk_c", nodeName: "omarchy-hp", sinceOpenMs: 6_900 });
    logRealmBootTiming(
      { type: "bootTiming", step: "unknown" },
      {
        nodeId: "bk_c",
        nodeName: "omarchy-hp",
        sinceOpenMs: 1,
      },
    );
    expect(
      logs.records().map(({ level, area, event, fields }) => ({ level, area, event, fields })),
    ).toEqual([
      {
        level: "info",
        area: "workspaces",
        event: "realm.boot-step",
        fields: {
          nodeId: "bk_c",
          nodeName: "omarchy-hp",
          step: "fan-out-complete",
          durationMs: 2_150,
          sinceStartMs: 4_020,
          sinceOpenMs: 6_900,
          requests: 31,
        },
      },
    ]);
  } finally {
    logs.restore();
  }
});
