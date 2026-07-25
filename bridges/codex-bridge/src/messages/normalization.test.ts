import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_COMMAND_OUTPUT_CHARS } from "../sessions/turn-accumulator.js";
import { capCommandOutput, itemToParts } from "./normalization.js";

describe("reasoning normalization", () => {
  test("drops empty and whitespace-only thinking parts", async () => {
    for (const text of ["", " \n\t"]) {
      expect(await itemToParts({
        id: "reasoning",
        type: "reasoning",
        text,
      }, "/tmp")).toEqual([]);
    }
  });

  test("preserves non-empty thinking content byte-for-byte", async () => {
    const content = "  Inspecting the workspace.\n";
    expect(await itemToParts({
      id: "reasoning",
      type: "reasoning",
      text: content,
    }, "/tmp")).toEqual([{ type: "thinking", content }]);
  });
});

describe("command normalization bounds", () => {
  test("caps oversized authoritative command output for both output and error", async () => {
    const oversized = "x".repeat(DEFAULT_MAX_COMMAND_OUTPUT_CHARS + 10);
    const [part] = await itemToParts({
      id: "command",
      type: "command_execution",
      command: "generate",
      aggregated_output: oversized,
      status: "failed",
    }, "/tmp");

    expect(part?.toolOutput?.length).toBeLessThan(oversized.length);
    // The cap is a memory bound, so the truncated result must fit *inside* it —
    // appending the notice must not push it back over.
    expect(part?.toolOutput?.length).toBeLessThanOrEqual(
      DEFAULT_MAX_COMMAND_OUTPUT_CHARS,
    );
    expect(part?.toolOutput).toEndWith("… output truncated");
    expect(part?.toolError).toBe(part?.toolOutput);
  });

  test("passes output of exactly the cap through untouched", async () => {
    // Boundary for the `<=`: one character either way is silently invisible in
    // the oversized and ordinary cases above.
    const exact = "y".repeat(DEFAULT_MAX_COMMAND_OUTPUT_CHARS);
    expect(capCommandOutput(exact)).toBe(exact);
    expect(capCommandOutput(exact).length).toBe(DEFAULT_MAX_COMMAND_OUTPUT_CHARS);

    const [part] = await itemToParts({
      id: "exact",
      type: "command_execution",
      command: "generate",
      aggregated_output: exact,
      status: "completed",
    }, "/tmp");
    expect(part?.toolOutput).toBe(exact);

    expect(capCommandOutput("z".repeat(DEFAULT_MAX_COMMAND_OUTPUT_CHARS + 1))).not.toBe(
      exact,
    );
  });

  test("never slices from the end when the cap is tighter than the notice", () => {
    // `maxChars - notice.length` goes negative here; an unguarded slice would
    // return the *tail* of the output and grow the result instead of capping it.
    expect(capCommandOutput("abcdefghij", 3)).toBe("\n… output truncated");
    expect(capCommandOutput("abcdefghij", 0)).toBe("\n… output truncated");
  });

  test("keeps ordinary output byte-for-byte and supplies a default failure", async () => {
    expect((await itemToParts({
      id: "ok",
      type: "command_execution",
      command: "echo ok",
      aggregated_output: "ok\n",
      status: "completed",
    }, "/tmp"))[0]?.toolOutput).toBe("ok\n");

    expect((await itemToParts({
      id: "failed",
      type: "command_execution",
      command: "false",
      aggregated_output: "",
      status: "failed",
    }, "/tmp"))[0]?.toolError).toBe("Command failed");
  });
});
