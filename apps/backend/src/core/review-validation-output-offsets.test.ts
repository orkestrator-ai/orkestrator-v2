import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  newReviewValidationRun,
  REVIEW_VALIDATION_OUTPUT_MAX_BYTES,
  type ReviewValidationOutput,
} from "@orkestrator/protocol/review-workflow";
import { readReviewValidationOutput } from "./review-validation-service.js";
import type { CommandContext } from "./commands-context.js";

test("validation output reader appends by offset and resets on truncation or rotation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "validation-output-offsets-"));
  const run = newReviewValidationRun("review-validation-offsets", {
    headRef: "a".repeat(40),
    commands: [
      {
        id: "check",
        command: "bun run check",
        cwd: ".",
        dependsOn: [],
        resources: [],
        weight: 1,
        timeoutMs: 1_000,
      },
    ],
    limitations: [],
  });
  const directory = path.join(root, ".orkestrator", "review-artifacts", run.id);
  const relativeArtifact = `.orkestrator/review-artifacts/${run.id}/validation-01.stdout.txt`;
  const artifact = path.join(root, relativeArtifact);
  Object.assign(run.results[0]!, { status: "running", stdoutPath: relativeArtifact });
  const context = {
    storage: {
      getEnvironment: async () => ({
        id: "env",
        status: "running",
        environmentType: "local",
        worktreePath: root,
      }),
    },
    appRoot: root,
    resourceRoot: root,
    toolchainBinDir: path.dirname(process.execPath),
  } as unknown as CommandContext;
  const read = (known?: unknown) =>
    readReviewValidationOutput("env", run.id, "check", context, known);
  const text = (base64: string) => Buffer.from(base64, "base64").toString();
  const heldAt = (output: ReviewValidationOutput) => ({
    stdout: { totalBytes: output.stdout!.totalBytes, anchor: output.stdout!.anchor },
  });

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "state.json"), JSON.stringify({ run }));
    await writeFile(artifact, "line one\n");

    const first = await read();
    expect(first.stdout).toMatchObject({ mode: "tail", totalBytes: 9, startOffset: 0 });
    expect(first.stdout!.anchor).toMatch(/^[0-9a-f]{32}$/);

    // Growth: only the new bytes cross the wire.
    await writeFile(artifact, "line one\nline two\n");
    const grown = await read(heldAt(first));
    expect(grown.stdout).toMatchObject({ mode: "append", startOffset: 9, totalBytes: 18 });
    expect(text(grown.stdout!.contentBase64)).toBe("line two\n");

    // Nothing new: an empty append.
    const idle = await read(heldAt(grown));
    expect(idle.stdout).toMatchObject({ mode: "append", startOffset: 18, totalBytes: 18 });
    expect(idle.stdout!.contentBase64).toBe("");

    // Truncation: an authoritative tail.
    await writeFile(artifact, "new\n");
    const truncated = await read(heldAt(grown));
    expect(truncated.stdout).toMatchObject({ mode: "tail", startOffset: 0, totalBytes: 4 });
    expect(text(truncated.stdout!.contentBase64)).toBe("new\n");

    // Rotation to a larger file with different content: the anchor no longer
    // matches the held tail, so the answer is an authoritative tail again.
    await writeFile(artifact, "rotated log with other content\n");
    const rotated = await read(heldAt(grown));
    expect(rotated.stdout).toMatchObject({ mode: "tail", startOffset: 0 });
    expect(text(rotated.stdout!.contentBase64)).toBe("rotated log with other content\n");

    // A gap larger than the bound answers a bounded tail, not an append.
    const small = await read();
    await writeFile(
      artifact,
      Buffer.concat([
        Buffer.from("rotated log with other content\n"),
        Buffer.alloc(REVIEW_VALIDATION_OUTPUT_MAX_BYTES + 1, "y"),
      ]),
    );
    const large = await read(heldAt(small));
    expect(large.stdout).toMatchObject({ mode: "tail" });
    expect(Buffer.from(large.stdout!.contentBase64, "base64").byteLength).toBe(
      REVIEW_VALIDATION_OUTPUT_MAX_BYTES,
    );

    // A malformed position is ignored (older or confused client): full tail.
    const ignored = await read({ stdout: { totalBytes: -1, anchor: "nope" } });
    expect(ignored.stdout).toMatchObject({ mode: "tail" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
