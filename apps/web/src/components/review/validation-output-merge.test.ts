import { describe, expect, test } from "bun:test";
import type { ReviewValidationOutput } from "@orkestrator/protocol/review-workflow";
import { knownValidationOutput, mergeValidationOutput } from "./validation-output-merge";

const anchor = (seed: string) => seed.padEnd(32, "0");

function output(
  stdout: Partial<NonNullable<ReviewValidationOutput["stdout"]>> | null,
  status: ReviewValidationOutput["status"] = "running",
): ReviewValidationOutput {
  return {
    resultId: "check",
    status,
    stdout: stdout
      ? { contentBase64: "", totalBytes: 0, startOffset: 0, anchor: anchor("a"), ...stdout }
      : null,
    stderr: null,
  };
}

describe("mergeValidationOutput", () => {
  test("appends bytes and keeps only the bounded tail", () => {
    const held = output({ contentBase64: btoa("abcd"), totalBytes: 4 });
    const merged = mergeValidationOutput(
      held,
      output({ contentBase64: btoa("efgh"), totalBytes: 8, startOffset: 4, mode: "append" }),
      6,
    );
    expect(merged.resync).toBe(false);
    expect(atob(merged.output!.stdout!.contentBase64)).toBe("cdefgh");
    expect(merged.output!.stdout).toMatchObject({ totalBytes: 8, startOffset: 2 });
  });

  test("merges a stderr append alongside an authoritative stdout tail", () => {
    const held = {
      ...output({ contentBase64: btoa("old"), totalBytes: 3 }),
      stderr: {
        contentBase64: btoa("err"),
        totalBytes: 3,
        startOffset: 0,
        anchor: anchor("e"),
        mode: "tail" as const,
      },
    };
    const next = {
      ...output({ contentBase64: btoa("new"), totalBytes: 3, anchor: anchor("b") }),
      stderr: {
        contentBase64: btoa("!"),
        totalBytes: 4,
        startOffset: 3,
        anchor: anchor("f"),
        mode: "append" as const,
      },
    };
    const merged = mergeValidationOutput(held, next);
    expect(merged.resync).toBe(false);
    expect(atob(merged.output!.stdout!.contentBase64)).toBe("new");
    expect(atob(merged.output!.stderr!.contentBase64)).toBe("err!");
    expect(merged.output!.stderr).toMatchObject({ totalBytes: 4, startOffset: 0 });
  });

  test("an append this client cannot place is a resync, never a guess", () => {
    const held = output({ contentBase64: btoa("abcd"), totalBytes: 4 });
    const merged = mergeValidationOutput(
      held,
      output({ contentBase64: btoa("zz"), totalBytes: 12, startOffset: 10, mode: "append" }),
    );
    expect(merged).toEqual({ output: null, resync: true });
    expect(
      mergeValidationOutput(null, output({ contentBase64: "", startOffset: 4, mode: "append" }))
        .resync,
    ).toBe(true);
  });

  test("identical answers keep the held object; a status change does not", () => {
    const held = output({ contentBase64: btoa("abcd"), totalBytes: 4 });
    const empty = output({ contentBase64: "", totalBytes: 4, startOffset: 4, mode: "append" });
    expect(mergeValidationOutput(held, empty).output).toBe(held);
    const sameTail = output({ contentBase64: btoa("abcd"), totalBytes: 4 });
    expect(mergeValidationOutput(held, sameTail).output).toBe(held);
    const settled = mergeValidationOutput(held, { ...empty, status: "passed" }).output!;
    expect(settled).not.toBe(held);
    expect(settled.stdout).toBe(held.stdout);
  });

  test("a tail replaces what is held and positions are echoed only with an anchor", () => {
    const held = output({ contentBase64: btoa("abcd"), totalBytes: 4 });
    const rotated = output({ contentBase64: btoa("new"), totalBytes: 3, anchor: anchor("b") });
    expect(mergeValidationOutput(held, rotated).output!.stdout).toBe(rotated.stdout);
    expect(knownValidationOutput(held)).toEqual({ stdout: { totalBytes: 4, anchor: anchor("a") } });
    expect(knownValidationOutput(output({ anchor: undefined }))).toBeUndefined();
    expect(knownValidationOutput(null)).toBeUndefined();
  });
});
