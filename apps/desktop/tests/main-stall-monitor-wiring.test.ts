import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { EventLoopStallMonitorOptions } from "@orkestrator/protocol/event-loop-stall-monitor";

test("main entrypoint supplies host counters and routes suspension and stall reports", () => {
  const source = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("startEventLoopStallMonitor({");
  expect(start).toBeGreaterThan(0);
  const end = source.indexOf("\n});", start);
  expect(end).toBeGreaterThan(start);
  // Execute the actual composition call in isolation: importing all of main
  // would create windows and host services. Removing any option must fail here.
  let captured: EventLoopStallMonitorOptions | undefined;
  const stalls: unknown[] = [];
  const suspensions: unknown[] = [];
  const reportSuspension = (value: unknown) => suspensions.push(value);
  const compose = new Function(
    "startEventLoopStallMonitor",
    "readHostCpuTimes",
    "reportMainThreadStall",
    "reportMainThreadSuspension",
    "nativeDialogs",
    "process",
    source.slice(start, end + 4),
  );
  compose(
    (options: EventLoopStallMonitorOptions) => {
      captured = options;
    },
    () => [123_000, 456_000],
    (value: unknown) => stalls.push(value),
    reportSuspension,
    { describeStall: () => ({}) },
    { cpuUsage: () => ({ user: 123, system: 456 }) },
  );
  expect(captured!.hostCpuTimes!()).toEqual([123_000, 456_000]);
  expect(captured!.cpuUsage!()).toBe(579);
  expect(captured!.reportSuspension).toBe(reportSuspension);
  const suspension = {
    suspendedMs: 10_000,
    lagMs: 10_000,
    endedAt: "",
    intervalMs: 500,
    suppressed: 0,
  };
  captured!.reportSuspension!(suspension);
  const stall = {
    lagMs: 10_000,
    endedAt: "",
    intervalMs: 500,
    folded: "",
    level: "error" as const,
  };
  captured!.report!(stall);
  expect(suspensions).toEqual([suspension]);
  expect(stalls).toEqual([stall]);
});
