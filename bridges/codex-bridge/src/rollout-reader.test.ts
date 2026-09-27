import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanRolloutLines,
  type RolloutLine,
  type RolloutScanCursor,
  type RolloutScanLimits,
} from "./rollout-reader.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile(contents: string | Buffer): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-rollout-reader-"));
  tempDirs.push(dir);
  const path = join(dir, "rollout.jsonl");
  await writeFile(path, contents);
  return path;
}

async function scan(
  path: string,
  limits: RolloutScanLimits,
  cursor: RolloutScanCursor = { offset: 0 },
  end?: number,
) {
  const handle = await open(path, "r");
  try {
    const lines: RolloutLine[] = [];
    const size = end ?? (await handle.stat()).size;
    const result = await scanRolloutLines(handle, cursor, size, limits, (batch) =>
      lines.push(...batch),
    );
    return { lines, ...result };
  } finally {
    await handle.close();
  }
}

describe("scanRolloutLines", () => {
  test("splits on newline bytes across chunks, keeping split code points intact", async () => {
    // "é" and "🙂" are multi-byte; a 5-byte chunk splits both mid-sequence.
    const text = '{"a":"é"}\n{"b":"🙂🙂"}\r\n{"c":1}';
    const path = await tempFile(text);

    const { lines, cursor, shortRead } = await scan(path, { maxRecordBytes: 64, chunkBytes: 5 });

    expect(shortRead).toBe(false);
    expect(lines.map((line) => (line.kind === "line" ? line.text : "overlong"))).toEqual([
      '{"a":"é"}',
      '{"b":"🙂🙂"}\r',
    ]);
    // Offsets are file bytes, not UTF-16 code units.
    const firstEnd = Buffer.byteLength('{"a":"é"}\n');
    expect(lines[0]).toMatchObject({ start: 0, end: firstEnd });
    expect(lines[1]).toMatchObject({
      start: firstEnd,
      end: firstEnd + Buffer.byteLength('{"b":"🙂🙂"}\r\n'),
    });
    // The final line has no newline yet: it is left for the next scan.
    expect(cursor).toEqual({ offset: Buffer.byteLength(text) - Buffer.byteLength('{"c":1}') });
  });

  test("resumes an incomplete final line once it is completed", async () => {
    const path = await tempFile('{"a":1}\n{"b":');
    const first = await scan(path, { maxRecordBytes: 64, chunkBytes: 4 });
    expect(first.lines).toHaveLength(1);

    await writeFile(path, '{"a":1}\n{"b":2}\n');
    const second = await scan(path, { maxRecordBytes: 64, chunkBytes: 4 }, first.cursor);
    expect(second.lines).toEqual([{ kind: "line", text: '{"b":2}', start: 8, end: 16 }]);
    expect(second.cursor).toEqual({ offset: 16 });
  });

  test("skips an overlong line as it streams, never carrying more than the cap", async () => {
    const long = "x".repeat(100);
    const path = await tempFile(`{"a":1}\n${long}\n{"b":2}\n`);

    const { lines, cursor } = await scan(path, { maxRecordBytes: 16, chunkBytes: 8 });

    expect(lines).toEqual([
      { kind: "line", text: '{"a":1}', start: 0, end: 8 },
      { kind: "overlong", start: 8, end: 109 },
      { kind: "line", text: '{"b":2}', start: 109, end: 117 },
    ]);
    expect(cursor).toEqual({ offset: 117 });
    for (const line of lines) {
      if (line.kind === "line") expect(Buffer.byteLength(line.text)).toBeLessThanOrEqual(16);
    }
  });

  test("an overlong line spanning scans stays skipped until its newline arrives", async () => {
    const path = await tempFile(`{"a":1}\n${"y".repeat(40)}`);
    const first = await scan(path, { maxRecordBytes: 16, chunkBytes: 8 });
    expect(first.lines).toHaveLength(1);
    expect(first.cursor).toEqual({ offset: 48, overlongFrom: 8 });

    await writeFile(path, `{"a":1}\n${"y".repeat(60)}\n{"b":2}\n`);
    const second = await scan(path, { maxRecordBytes: 16, chunkBytes: 8 }, first.cursor);
    expect(second.lines).toEqual([
      { kind: "overlong", start: 8, end: 69 },
      { kind: "line", text: '{"b":2}', start: 69, end: 77 },
    ]);
    // Only the bytes after the first scan were read again.
    expect(second.bytesRead).toBe(77 - 48);
  });

  test("a line that exceeds the cap within one chunk is reported, not decoded", async () => {
    const path = await tempFile(`${"z".repeat(30)}\n{"b":2}\n`);
    const { lines } = await scan(path, { maxRecordBytes: 10, chunkBytes: 64 });
    expect(lines).toEqual([
      { kind: "overlong", start: 0, end: 31 },
      { kind: "line", text: '{"b":2}', start: 31, end: 39 },
    ]);
  });

  test("reports a short read when the file ends before the requested range", async () => {
    const path = await tempFile('{"a":1}\n');
    const result = await scan(path, { maxRecordBytes: 64, chunkBytes: 4 }, { offset: 0 }, 100);
    expect(result.shortRead).toBe(true);
    expect(result.lines).toHaveLength(1);
  });
});
