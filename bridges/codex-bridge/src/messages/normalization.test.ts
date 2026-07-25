import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_COMMAND_OUTPUT_CHARS } from "../sessions/turn-accumulator.js";
import { itemToParts } from "./normalization.js";

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
    expect(part?.toolOutput).toEndWith("… output truncated");
    expect(part?.toolError).toBe(part?.toolOutput);
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
