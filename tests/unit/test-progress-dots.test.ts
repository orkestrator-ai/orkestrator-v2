import { describe, expect, test } from "bun:test";
import {
  forwardWithDotLines,
  terminateDotRun,
  withProgressDots,
} from "../../scripts/test-progress-dots";

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("withProgressDots", () => {
  test("adds the dots reporter when passing tests are hidden", () => {
    expect(withProgressDots(["--preload", "x.ts", "--only-failures", "--parallel=2"])).toEqual([
      "--preload",
      "x.ts",
      "--only-failures",
      "--parallel=2",
      "--dots",
    ]);
  });

  test("leaves a run that already prints each test alone", () => {
    expect(withProgressDots(["--parallel=2"])).toEqual(["--parallel=2"]);
  });

  test("never overrides a reporter the caller chose", () => {
    for (const reporter of ["--dots", "--reporter=junit", "--reporter"]) {
      expect(withProgressDots(["--only-failures", reporter])).toEqual([
        "--only-failures",
        reporter,
      ]);
    }
  });
});

describe("terminateDotRun", () => {
  test("closes a chunk of progress dots with a newline", () => {
    expect(terminateDotRun(".")).toBe(".\n");
    expect(terminateDotRun("...")).toBe("...\n");
  });

  test("passes failure and summary text through unchanged", () => {
    for (const text of ["\n\nowner.test.ts:\n", "(fail) case [1.00ms]", "a.", ".\n", ""]) {
      expect(terminateDotRun(text)).toBe(text);
    }
  });
});

describe("forwardWithDotLines", () => {
  test("forwards every chunk and keeps a character split across chunks", async () => {
    const encoded = new TextEncoder().encode("fail é\n");
    const split = encoded.indexOf(0xc3) + 1;
    const written: string[] = [];
    await forwardWithDotLines(
      streamOf([
        new TextEncoder().encode("."),
        new TextEncoder().encode("."),
        encoded.subarray(0, split),
        encoded.subarray(split),
      ]),
      (text) => written.push(text),
    );
    expect(written.join("")).toBe(".\n.\nfail é\n");
  });
});
