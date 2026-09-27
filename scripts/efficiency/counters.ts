import { readFileSync } from "node:fs";

/**
 * Deterministic operation counters for the efficiency harness.
 *
 * Every counter here counts *work* — serialization visits, syscall bytes —
 * and never keeps the values it saw. Nothing is retained beyond integers, so
 * a counter cannot leak fixture content into a report even by accident.
 */

/** Mutable tally shared by every counting object of one measurement. */
export interface VisitTally {
  messages: number;
  parts: number;
}

export function newTally(): VisitTally {
  return { messages: 0, parts: 0 };
}

/**
 * Makes `JSON.stringify(value)` count one visit per serialization.
 *
 * The hook is a non-enumerable `toJSON`, so it never appears in a spread copy
 * or in the encoded output: the encoding is byte-identical to the uncounted
 * value. This is the method the review's original probes used (see
 * docs/improvements/efficiency/validation.md). A copy made by the code under
 * test (`{ ...message }`) is not counted, which undercounts rather than
 * overcounts — the numbers are lower bounds on repeated work.
 */
export function countSerializations<T extends object>(
  value: T,
  tally: VisitTally,
  kind: keyof VisitTally,
): T {
  Object.defineProperty(value, "toJSON", {
    configurable: true,
    enumerable: false,
    value(this: Record<string, unknown>) {
      tally[kind] += 1;
      return { ...this };
    },
  });
  return value;
}

/** Counts message visits and, when `parts` is set, part visits too. */
export function countingMessages<T extends { parts?: unknown[] }>(
  messages: T[],
  tally: VisitTally,
  options: { parts?: boolean } = {},
): T[] {
  for (const message of messages) {
    countSerializations(message, tally, "messages");
    if (options.parts) {
      for (const part of message.parts ?? []) {
        if (part && typeof part === "object") countSerializations(part, tally, "parts");
      }
    }
  }
  return messages;
}

/**
 * Temporarily wraps the global `JSON.stringify` to count calls whose value
 * matches `predicate`, as `native-agent-projection-encoding.test.ts` does.
 * Always restores the original, including when `run` throws.
 */
export async function countStringifyCalls<T>(
  predicate: (value: unknown) => boolean,
  run: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  const original = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (predicate(value)) calls += 1;
    return (original as (...args: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify;
  try {
    const result = await run();
    return { result, calls };
  } finally {
    JSON.stringify = original;
  }
}

/** Process-wide syscall byte counters from Linux `/proc/self/io`. */
export interface IoSample {
  /** Bytes passed through read()-family syscalls (page cache included). */
  readBytes: number;
  /** Bytes passed through write()-family syscalls. */
  writeBytes: number;
}

function readProcIo(): IoSample | undefined {
  try {
    const text = readFileSync("/proc/self/io", "utf8");
    const field = (name: string) => Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(text)?.[1]);
    const readBytes = field("rchar");
    const writeBytes = field("wchar");
    return Number.isFinite(readBytes) && Number.isFinite(writeBytes)
      ? { readBytes, writeBytes }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Measures syscall bytes around an awaited operation.
 *
 * Reading `/proc/self/io` itself costs a read, so the overhead of one sample
 * is calibrated and subtracted. Only meaningful while nothing else in the
 * process does I/O, which holds for the harness's sequential workloads.
 * Returns `undefined` where `/proc/self/io` does not exist (non-Linux).
 */
export async function measureIo<T>(
  run: () => Promise<T>,
): Promise<{ result: T; io: IoSample | undefined }> {
  const calibrationStart = readProcIo();
  const before = readProcIo();
  const result = await run();
  const after = readProcIo();
  if (!calibrationStart || !before || !after) return { result, io: undefined };
  const overhead = before.readBytes - calibrationStart.readBytes;
  return {
    result,
    io: {
      readBytes: Math.max(0, after.readBytes - before.readBytes - overhead),
      writeBytes: Math.max(0, after.writeBytes - before.writeBytes),
    },
  };
}

export function ioAvailable(): boolean {
  return readProcIo() !== undefined;
}

/** UTF-8 bytes of the JSON encoding. */
export function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json);
}

/** Gzip size at a fixed level, as a compressed-transport indicator. */
export function gzipBytes(value: unknown): number {
  return Bun.gzipSync(Buffer.from(JSON.stringify(value) ?? ""), { level: 6 }).length;
}
