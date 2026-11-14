import { describe, expect, spyOn, test, mock } from "bun:test";
import { configureLogger } from "@orkestrator/protocol/logger";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import {
  advanceUntil,
  fourReviewers,
  startInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";

/**
 * The reviewer prompt's shared package prefix is built once per supervisor
 * pass, not once per reviewer, and every reviewer still gets the same prefix.
 */
describe("build pipeline reviewer prompts", () => {
  test("one pass reads the review instruction and project notes once for its whole panel", async () => {
    await withPipeline(async ({ service, storage, read, provider }) => {
      const started = await service.start(startInput(fourReviewers()));
      await advanceUntil(service, read, started.id, "reviewing");
      const notes = spyOn(storage.kanban, "getProjectNotes");
      const passes: Array<{ dispatched: number; notes: number }> = [];
      try {
        for (let pass = 0; pass < 6; pass += 1) {
          const sentBefore = provider.sent.length;
          notes.mockClear();
          await service.advanceNow(started.id);
          const dispatched = provider.sent
            .slice(sentBefore)
            .filter((entry) => /review-\d/.test(entry.sessionId)).length;
          passes.push({
            dispatched,
            notes: notes.mock.calls.length,
          });
        }
      } finally {
        notes.mockRestore();
      }
      const dispatching = passes.filter((pass) => pass.dispatched > 0);
      // Several reviewers went out together, which is the case this covers.
      expect(Math.max(...dispatching.map((pass) => pass.dispatched))).toBeGreaterThan(1);
      // A pass reads the notes for its own reasons too (as the passes that
      // dispatch nothing show); the whole panel adds one read, not one each.
      const otherReads = Math.max(
        0,
        ...passes.filter((pass) => pass.dispatched === 0).map((pass) => pass.notes),
      );
      for (const pass of dispatching) expect(pass.notes).toBeLessThanOrEqual(otherReads + 1);

      const prompts = provider.sent
        .filter((entry) => /review-\d/.test(entry.sessionId))
        .map((entry) => entry.prompt);
      expect(prompts.length).toBe(4);
      const prefix = prompts[0]!.slice(0, prompts[0]!.indexOf("## Review package"));
      expect(prefix.length).toBeGreaterThan(0);
      for (const prompt of prompts) expect(prompt.startsWith(prefix)).toBe(true);
    });
  });
});

/**
 * The live count (to-do 7566 (retired); `test:agent:auto-pipeline --reviewers
 * 4`, docs/development/agent-testing.md) reads the `review.prompt-reads` debug
 * line, so the line has to report what the pass did: every prompt it built,
 * and one read of each input for the whole panel.
 */
test("a dispatching pass logs its prompt count and one read of each input", async () => {
  const logs = captureLogs();
  configureLogger({ areaLevels: { "build-pipeline": "debug" } });
  try {
    await withPipeline(async ({ service, read, provider }) => {
      const started = await service.start(startInput(fourReviewers()));
      await advanceUntil(service, read, started.id, "reviewing");
      const dispatched: number[] = [];
      for (let pass = 0; pass < 6; pass += 1) {
        const sentBefore = provider.sent.length;
        await service.advanceNow(started.id);
        dispatched.push(
          provider.sent.slice(sentBefore).filter((entry) => /review-\d/.test(entry.sessionId))
            .length,
        );
      }
      const lines = logs
        .records()
        .filter(
          (record) => record.area === "build-pipeline" && record.event === "review.prompt-reads",
        )
        .map((record) => record.fields);
      // One line per pass that built prompts, none for the passes that did not.
      expect(lines.length).toBe(dispatched.filter((count) => count > 0).length);
      expect(lines.reduce((sum, fields) => sum + Number(fields?.prompts), 0)).toBe(4);
      expect(Math.max(...lines.map((fields) => Number(fields?.prompts)))).toBeGreaterThan(1);
      for (const fields of lines) {
        expect(fields).toEqual({
          prompts: expect.any(Number),
          instructionReads: 1,
          notesReads: 1,
        });
      }
    });
  } finally {
    logs.restore();
  }
});

// Exercise one host directly: constructing another host would start a new pass
// and could hide a rejected promise retained by the first one. The pass's
// counts are checked too: a rejected request is not a prompt built.
test.each(["reviewInstruction", "reviewContext"] as const)(
  "a rejected %s build is evicted within the same pass",
  async (failingRead) => {
    await withPipeline(async ({ service, read }) => {
      const started = await service.start(startInput(fourReviewers()));
      await advanceUntil(service, read, started.id, "reviewing");
      const pipeline = await read(started.id);
      const { BuildPipelineReviewFanout } = await import("./build-pipeline-review-fanout.js");
      const instruction = mock(async () => "Review carefully");
      const context = mock(async () => ({}));
      const failure = new Error("transient prompt read failure");
      if (failingRead === "reviewInstruction") instruction.mockRejectedValueOnce(failure);
      else context.mockRejectedValueOnce(failure);
      const fanout = new BuildPipelineReviewFanout({
        reviewInstruction: instruction,
        reviewContext: context,
      } as unknown as ConstructorParameters<typeof BuildPipelineReviewFanout>[0]);
      const reads = { prompts: 0, instructionReads: 0, notesReads: 0 };
      const host = fanout["reviewHost"](pipeline, "main", reads);
      const reviewer = pipeline.reviewFanout!.reviewers[0]!;
      await expect(host.reviewerPrompt!(0, 4, reviewer)).rejects.toThrow(
        "transient prompt read failure",
      );
      // The rejected request built no prompt, though its reads happened.
      expect(reads).toEqual({
        prompts: 0,
        instructionReads: 1,
        notesReads: failingRead === "reviewContext" ? 1 : 0,
      });
      const recovered = await host.reviewerPrompt!(1, 4, reviewer);
      expect(recovered).toContain("Review carefully");
      await host.reviewerPrompt!(2, 4, reviewer);
      expect(instruction).toHaveBeenCalledTimes(2);
      expect(context).toHaveBeenCalledTimes(failingRead === "reviewContext" ? 2 : 1);
      // The debug line counts the two prompts built, and every read, failed or not.
      expect(reads).toEqual({
        prompts: 2,
        instructionReads: 2,
        notesReads: failingRead === "reviewContext" ? 2 : 1,
      });
    });
  },
);
