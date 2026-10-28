import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";

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

async function stallReader(child: Child, port: number) {
  // Megabytes arrive; scan each chunk (with the previous chunk's tail, in case
  // the marker straddles two) instead of keeping them.
  let tail = "";
  let marker: string | null = null;
  child.stdout.on("data", (chunk: Buffer) => {
    const text = tail + chunk.toString();
    marker ??= MARKER.exec(text)?.[0] ?? null;
    tail = text.slice(-1_024);
  });
  expect(await probe(port)).toBe("answered");
  child.stdout.pause();
  await Bun.sleep(STALL_MS);
  const duringStall = await probe(port);
  child.stdout.resume();
  return { duringStall, marker: () => marker };
}

describe("console output with a stalled stdout reader", () => {
  test("Bun's own console blocks the process (control)", async () => {
    const { child, port } = await startChild("plain");
    try {
      const { duringStall } = await stallReader(child, port);
      expect(duringStall).toBe("timed-out");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);

  test("the bounded console keeps serving and reports the dropped lines", async () => {
    const { child, port } = await startChild("bounded");
    try {
      const { duringStall, marker } = await stallReader(child, port);
      expect(duringStall).toBe("answered");
      // Bun's pause() lets bursts through, so the marker may already be in.
      const deadline = Date.now() + 10_000;
      while (!marker() && Date.now() < deadline) await Bun.sleep(50);
      expect(marker()).toMatch(MARKER);
      expect(await probe(port)).toBe("answered");
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
