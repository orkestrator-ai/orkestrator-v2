import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type ModelReasoningEffort } from "@openai/codex-sdk";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Codex SDK reasoning effort forwarding", () => {
  test.each(["max", "ultra"] as const)("forwards %s to the spawned CLI", async (effort) => {
    const root = mkdtempSync(join(tmpdir(), "orkestrator-codex-sdk-effort-"));
    tempDirs.push(root);
    const executablePath = join(root, "fake-codex");
    const capturePath = join(root, "args.txt");
    writeFileSync(
      executablePath,
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$@\" > \"$CAPTURE_PATH\"",
        "cat >/dev/null",
        "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread-test\"}'",
      ].join("\n"),
    );
    chmodSync(executablePath, 0o755);

    const codex = new Codex({
      codexPathOverride: executablePath,
      env: {
        CAPTURE_PATH: capturePath,
        PATH: process.env.PATH ?? "",
      },
    });
    const thread = codex.startThread({
      modelReasoningEffort: effort as ModelReasoningEffort,
    });
    const streamed = await thread.runStreamed("test prompt");
    for await (const _event of streamed.events) {
      // Drain the process so the SDK waits for the fake CLI to exit.
    }

    const args = readFileSync(capturePath, "utf8").trim().split("\n");
    expect(args).toContain("--config");
    expect(args).toContain(`model_reasoning_effort="${effort}"`);
  });
});
