import { describe, expect, test } from "bun:test";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import {
  PROCESS_OUTPUT_LINE_LIMIT,
  createBoundedLineSplitter,
  forEachBoundedLine,
} from "./bounded-line-splitter";

function split(chunks: Array<Buffer | string>, limit?: number): string[] {
  const lines: string[] = [];
  const splitter = createBoundedLineSplitter((line) => lines.push(line), limit);
  for (const chunk of chunks) splitter.push(chunk);
  splitter.flush();
  return lines;
}

async function readlineLines(chunks: Array<Buffer | string>): Promise<string[]> {
  const input = new PassThrough();
  const lines: string[] = [];
  const closed = new Promise<void>((resolve) =>
    createInterface({ input })
      .on("line", (line) => lines.push(line))
      .once("close", () => resolve()),
  );
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await closed;
  return lines;
}

describe("bounded line splitter", () => {
  test("ends lines where readline does", async () => {
    const chunks = [
      "plain\nwindows\r\nold mac\rnext\n",
      "split cr\r",
      "\nempty\n\nlast without end",
    ];
    expect(split(chunks)).toEqual(await readlineLines(chunks));
    expect(split(chunks)).toEqual([
      "plain",
      "windows",
      "old mac",
      "next",
      "split cr",
      "empty",
      "",
      "last without end",
    ]);
  });

  test("U+2028 and U+2029 stay inside a line, as in Electron's (Node's) readline", () => {
    // Bun's readline ends a line at them and Node's does not; the desktop runs on Node.
    const line = `sep${String.fromCharCode(0x2028)}and${String.fromCharCode(0x2029)}para`;
    expect(split([`${line}\n`])).toEqual([line]);
  });

  test("reassembles a line and a UTF-8 character split across chunks", async () => {
    const euro = Buffer.from("€");
    const chunks = [Buffer.from("partial-"), euro.subarray(0, 1), euro.subarray(1), "-line\n"];
    expect(split(chunks)).toEqual(["partial-€-line"]);
    expect(split(chunks)).toEqual(await readlineLines(chunks));
  });

  test("a lone carriage return at a chunk end still ends the line", () => {
    expect(split(["progress 1\r", "progress 2\r", "done\n"])).toEqual([
      "progress 1",
      "progress 2",
      "done",
    ]);
  });

  test("passes a line over the limit on in pieces, then keeps the rest", () => {
    const lines: string[] = [];
    const splitter = createBoundedLineSplitter((line) => lines.push(line), 16);
    splitter.push("x".repeat(36));
    expect(lines).toEqual(["x".repeat(16), "x".repeat(16)]);
    splitter.push("tail");
    expect(lines).toHaveLength(2);
    splitter.push(" end\nnext");
    expect(lines).toEqual(["x".repeat(16), "x".repeat(16), "xxxxtail end"]);
    splitter.flush();
    expect(lines.at(-1)).toBe("next");
    splitter.flush();
    expect(lines).toHaveLength(4);
  });

  test("never cuts between the halves of a surrogate pair", () => {
    const lines = split([`${"x".repeat(15)}😀${"y".repeat(4)}\n`], 16);
    expect(lines).toEqual(["x".repeat(15), `😀${"y".repeat(4)}`]);
  });

  test("cuts a complete line over the limit that arrived in one chunk", () => {
    expect(split([`${"z".repeat(40)}\nshort\n`], 16)).toEqual([
      "z".repeat(16),
      "z".repeat(16),
      "z".repeat(8),
      "short",
    ]);
  });

  test("passes on no piece over the limit however long a newline-free stream runs", () => {
    let longest = 0;
    let total = 0;
    const splitter = createBoundedLineSplitter((line) => {
      longest = Math.max(longest, line.length);
      total += line.length;
    });
    // Larger than the limit, as a Bun pipe read can be.
    const chunk = "y".repeat(200 * 1024);
    for (let index = 0; index < 16; index += 1) splitter.push(chunk);
    splitter.flush();
    expect(total).toBe(chunk.length * 16);
    expect(longest).toBe(PROCESS_OUTPUT_LINE_LIMIT);
  });

  test("reads a stream to its end", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    forEachBoundedLine(input, (line) => lines.push(line));
    const ended = new Promise((resolve) => input.once("end", resolve));
    input.write("one\ntw");
    input.end("o");
    input.resume();
    await ended;
    expect(lines).toEqual(["one", "two"]);
  });
});
