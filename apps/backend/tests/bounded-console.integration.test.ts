import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import type { BoundedConsoleStats } from "../src/bounded-console.js";

/**
 * The 2026-10-28 freeze, reproduced with a real stdout socket: the desktop
 * reads the backend's stdout, and when that reader stops, Bun's own console
 * parks the whole process on the next write. With the bounded console the
 * process keeps answering and reports the dropped lines once the reader
 * drains again.
 */

const CHILD = path.join(import.meta.dir, "fixtures", "stalled-stdout-child.ts");
/** Long enough for a few megabytes of logs to fill any socket buffer. */
const STALL_MS = 2_500;
const PROBE_TIMEOUT_MS = 1_500;

type Child = ChildProcessByStdio<null, Readable, Readable>;

async function startChild(mode: "bounded" | "plain"): Promise<{ child: Child; port: number }> {
  const child = spawn(process.execPath, [CHILD, mode], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise<number>((resolve, reject) => {
    let text = "";
    child.stderr.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = /PORT (\d+)/.exec(text);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`child exited early (${code})`)));
  });
  return { child, port };
}

async function probe(port: number): Promise<"answered" | "timed-out"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.text();
    return "answered";
  } catch {
    return "timed-out";
  }
}

const MARKER =
  /\[Backend\] Dropped \d+ log line\(s\) \(\d+ bytes\) from \S+ to \S+: the log reader was not draining output/;

async function readStats(port: number): Promise<BoundedConsoleStats> {
  const response = await fetch(`http://127.0.0.1:${port}/stats`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return (await response.json()) as BoundedConsoleStats;
}

async function stallReader(child: Child, port: number, mode: "plain" | "bounded") {
  // Megabytes arrive; scan each chunk (with the previous chunk's tail, in case
  // the marker straddles two) instead of keeping them.
  let tail = "";
  let marker: string | null = null;
  let recovered = false;
  child.stdout.on("data", (chunk: Buffer) => {
    const text = tail + chunk.toString();
    marker ??= MARKER.exec(text)?.[0] ?? null;
    recovered ||= text.includes("RECOVERED normal output after draining\n");
    tail = text.slice(-1_024);
  });
  expect(await probe(port)).toBe("answered");
  child.stdout.pause();
  await Bun.sleep(STALL_MS);
  if (mode === "bounded") {
    // Socket capacity and timer throughput vary by host. Keep the reader
    // paused until backpressure has actually caused a drop, not just for an
    // assumed number of timer ticks.
    let stalled = await readStats(port);
    const deadline = Date.now() + 10_000;
    while (stalled.stdout.droppedLines === 0 && Date.now() < deadline) {
      await Bun.sleep(50);
      stalled = await readStats(port);
    }
    expect(stalled.stdout.droppedLines).toBeGreaterThan(0);
  }
  const duringStall = await probe(port);
  child.stdout.resume();
  return { duringStall, marker: () => marker, recovered: () => recovered };
}

describe("console output with a stalled stdout reader", () => {
  test("Bun's own console blocks the process (control)", async () => {
    const { child, port } = await startChild("plain");
    try {
      const { duringStall } = await stallReader(child, port, "plain");
      expect(duringStall).toBe("timed-out");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  test("the bounded console keeps serving and reports the dropped lines", async () => {
    const { child, port } = await startChild("bounded");
    try {
      const { duringStall, marker, recovered } = await stallReader(child, port, "bounded");
      expect(duringStall).toBe("answered");
      // Bun's pause() lets bursts through, so the marker may already be in.
      const deadline = Date.now() + 10_000;
      while (!marker() && Date.now() < deadline) await Bun.sleep(50);
      expect(marker()).toMatch(MARKER);
      await fetch(`http://127.0.0.1:${port}/stop-logging`);
      let drained = await readStats(port);
      const drainDeadline = Date.now() + 10_000;
      while (drained.stdout.pendingBytes > 0 && Date.now() < drainDeadline) {
        await Bun.sleep(50);
        drained = await readStats(port);
      }
      expect(drained.stdout.pendingBytes).toBe(0);
      expect(drained.stdout.unreportedDroppedLines).toBe(0);
      await fetch(`http://127.0.0.1:${port}/resumed`);
      const recoveryDeadline = Date.now() + 10_000;
      while (!recovered() && Date.now() < recoveryDeadline) await Bun.sleep(50);
      expect(recovered()).toBe(true);
      expect((await readStats(port)).stdout).toMatchObject({
        pendingBytes: 0,
        writtenLines: drained.stdout.writtenLines + 1,
        droppedLines: drained.stdout.droppedLines,
        failedLines: 0,
      });
      expect(await probe(port)).toBe("answered");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
