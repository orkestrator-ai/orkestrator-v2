import { expect, test } from "bun:test";
import { cleanUpUntrackedChild, type UntrackedChildCleanupSystem } from "./untracked-child.js";

function kernel(results: number[]) {
  const signals: number[] = [];
  const waits: Array<[number, boolean]> = [];
  const system: UntrackedChildCleanupSystem = {
    wait(pid, noHang) {
      waits.push([pid, noHang]);
      return results.shift()!;
    },
    kill(pid) {
      signals.push(pid);
    },
  };
  return { system, signals, waits };
}

test("a reaped PID reassigned to another parent's process receives no signal", () => {
  const { system, signals, waits } = kernel([-1]); // ECHILD despite the reused PID existing.
  cleanUpUntrackedChild(100, system);
  expect(signals).toEqual([]);
  expect(waits).toEqual([[100, true]]);
});

test("cleanup reaps a zombie without signalling its released PID", () => {
  const { system, signals, waits } = kernel([100, -1]);
  cleanUpUntrackedChild(100, system);
  // The PID is now reused. A second cleanup must leave it alone.
  cleanUpUntrackedChild(100, system);
  expect(signals).toEqual([]);
  expect(waits).toEqual([
    [100, true],
    [100, true],
  ]);
});

test("a still-owned running child is checked, killed and synchronously reaped", () => {
  const { system, signals, waits } = kernel([0, 100]);
  cleanUpUntrackedChild(100, system);
  expect(signals).toEqual([100]);
  expect(waits).toEqual([
    [100, true],
    [100, false],
  ]);
});

test("invalid PIDs never reach the kernel", () => {
  const { system, signals, waits } = kernel([]);
  for (const pid of [0, 1, -1, process.pid, 1.5, NaN]) cleanUpUntrackedChild(pid, system);
  expect(signals).toEqual([]);
  expect(waits).toEqual([]);
});
