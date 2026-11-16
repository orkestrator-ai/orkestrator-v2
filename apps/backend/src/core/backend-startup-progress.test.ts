import { expect, test } from "bun:test";
import {
  BACKEND_STARTUP_LINE_TYPE,
  BACKEND_STARTUP_PHASES,
  backendStartupLine,
  createBackendStartupProgress,
  parseBackendStartupLine,
} from "./backend-startup-progress.js";

test("each phase is one content-free JSON line that parses back", () => {
  for (const phase of BACKEND_STARTUP_PHASES) {
    const line = backendStartupLine(phase);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: BACKEND_STARTUP_LINE_TYPE, phase });
    expect(parseBackendStartupLine(line.trimEnd())).toBe(phase);
  }
});

test("other stdout lines are not startup phases", () => {
  for (const line of [
    "",
    "[backend] starting",
    '{"type":"orkestrator-backend-ready","url":"http://127.0.0.1:1"}',
    `{"type":"${BACKEND_STARTUP_LINE_TYPE}","phase":"from-a-newer-backend"}`,
    `{"type":"${BACKEND_STARTUP_LINE_TYPE}"`,
    "null",
  ]) {
    expect(parseBackendStartupLine(line)).toBeNull();
  }
});

test("reports each phase once, in the order reached", () => {
  const written: string[] = [];
  const progress = createBackendStartupProgress((text) => written.push(text));
  progress("process");
  progress("storage");
  progress("process");
  expect(written.map((line) => parseBackendStartupLine(line.trimEnd()))).toEqual([
    "process",
    "storage",
  ]);
});
