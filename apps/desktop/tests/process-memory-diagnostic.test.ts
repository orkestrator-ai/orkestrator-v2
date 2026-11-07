import { describe, expect, test } from "bun:test";

import {
  PROCESS_MEMORY_DIAGNOSTIC_ENV,
  PROCESS_MEMORY_MAX_INTERVAL_MS,
  PROCESS_MEMORY_MIN_INTERVAL_MS,
  processMemoryDiagnosticInterval,
  processMemoryLogFields,
  startProcessMemoryDiagnostic,
  summarizeProcessMemory,
  type ProcessMemorySample,
} from "../electron/process-memory-diagnostic";

const metric = (pid: number, type: string, workingSetSize: number, privateBytes?: number) => ({
  pid,
  type,
  memory: { workingSetSize, peakWorkingSetSize: workingSetSize + 1, privateBytes },
});

describe("processMemoryDiagnosticInterval", () => {
  test("is off outside development mode, whatever the environment", () => {
    expect(
      processMemoryDiagnosticInterval(false, { [PROCESS_MEMORY_DIAGNOSTIC_ENV]: "5000" }),
    ).toBe(null);
  });

  test("is off in development mode unless an interval is named", () => {
    expect(processMemoryDiagnosticInterval(true, {})).toBe(null);
    expect(processMemoryDiagnosticInterval(true, { [PROCESS_MEMORY_DIAGNOSTIC_ENV]: "" })).toBe(
      null,
    );
    expect(processMemoryDiagnosticInterval(true, { [PROCESS_MEMORY_DIAGNOSTIC_ENV]: "1e3" })).toBe(
      null,
    );
    expect(processMemoryDiagnosticInterval(true, { [PROCESS_MEMORY_DIAGNOSTIC_ENV]: "-5" })).toBe(
      null,
    );
  });

  test("clamps the interval", () => {
    expect(processMemoryDiagnosticInterval(true, { [PROCESS_MEMORY_DIAGNOSTIC_ENV]: "5000" })).toBe(
      5000,
    );
    expect(processMemoryDiagnosticInterval(true, { [PROCESS_MEMORY_DIAGNOSTIC_ENV]: "1" })).toBe(
      PROCESS_MEMORY_MIN_INTERVAL_MS,
    );
    expect(
      processMemoryDiagnosticInterval(true, { [PROCESS_MEMORY_DIAGNOSTIC_ENV]: "99999999" }),
    ).toBe(PROCESS_MEMORY_MAX_INTERVAL_MS);
  });
});

describe("summarizeProcessMemory", () => {
  test("totals per type and separates realms from window renderers", () => {
    const sample = summarizeProcessMemory(
      [
        metric(1, "Browser", 100),
        metric(2, "GPU", 50),
        metric(3, "Tab", 300),
        metric(4, "Tab", 200, 150),
        metric(5, "Tab", 250),
      ],
      [
        { pid: 4, nodeHash: "aaaa", visible: true },
        { pid: 5, nodeHash: "bbbb", visible: false },
      ],
    );
    expect(sample.processes).toBe(5);
    expect(sample.totalWorkingSetKb).toBe(900);
    expect(sample.byType).toEqual({
      Browser: { count: 1, workingSetKb: 100 },
      GPU: { count: 1, workingSetKb: 50 },
      Tab: { count: 3, workingSetKb: 750 },
    });
    expect(sample.windowRenderers).toEqual({ count: 1, workingSetKb: 300 });
    expect(sample.realms).toEqual([
      { nodeHash: "aaaa", visible: true, workingSetKb: 200, peakWorkingSetKb: 201, privateKb: 150 },
      {
        nodeHash: "bbbb",
        visible: false,
        workingSetKb: 250,
        peakWorkingSetKb: 251,
        privateKb: null,
      },
    ]);
  });

  test("a realm whose process is gone reports zero rather than failing", () => {
    const sample = summarizeProcessMemory([], [{ pid: 9, nodeHash: "cccc", visible: true }]);
    expect(sample.realms[0]).toMatchObject({ workingSetKb: 0, peakWorkingSetKb: null });
  });
});

describe("processMemoryLogFields", () => {
  test("are scalars only, one pair per process type", () => {
    const fields = processMemoryLogFields(
      summarizeProcessMemory(
        [metric(1, "Browser", 100), metric(2, "Tab", 200), metric(3, "Tab", 300)],
        [{ pid: 3, nodeHash: "aaaa", visible: true }],
      ),
    );
    expect(fields).toMatchObject({
      processes: 3,
      totalWorkingSetKb: 600,
      windowRenderers: 1,
      windowRendererKb: 200,
      realms: 1,
      realmKb: 300,
      BrowserCount: 1,
      BrowserKb: 100,
      TabCount: 2,
      TabKb: 500,
    });
    for (const value of Object.values(fields)) expect(typeof value).toBe("number");
  });
});

describe("startProcessMemoryDiagnostic", () => {
  test("does nothing when off", () => {
    let scheduled = 0;
    const stop = startProcessMemoryDiagnostic({
      intervalMs: null,
      metrics: () => [],
      realms: () => [],
      setIntervalImpl: (() => {
        scheduled += 1;
        return 0;
      }) as unknown as typeof setInterval,
    });
    stop();
    expect(scheduled).toBe(0);
  });

  test("samples on each tick, skips a failed read, and stops", () => {
    let tick: (() => void) | null = null;
    let cleared = false;
    const samples: ProcessMemorySample[] = [];
    let fail = false;
    const stop = startProcessMemoryDiagnostic({
      intervalMs: 5000,
      metrics: () => {
        if (fail) throw new Error("gone");
        return [metric(1, "Browser", 10)];
      },
      realms: () => [],
      report: (sample) => samples.push(sample),
      setIntervalImpl: ((callback: () => void, ms: number) => {
        expect(ms).toBe(5000);
        tick = callback;
        return { unref() {} };
      }) as unknown as typeof setInterval,
      clearIntervalImpl: (() => {
        cleared = true;
      }) as unknown as typeof clearInterval,
    });
    tick!();
    fail = true;
    expect(() => tick!()).not.toThrow();
    expect(samples).toHaveLength(1);
    expect(samples[0]!.totalWorkingSetKb).toBe(10);
    stop();
    expect(cleared).toBe(true);
  });
});
