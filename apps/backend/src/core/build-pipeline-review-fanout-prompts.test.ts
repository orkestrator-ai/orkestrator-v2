import { describe, expect, spyOn, test, mock } from "bun:test";
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

// Exercise one host directly: constructing another host would start a new pass
// and could hide a rejected promise retained by the first one.
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
      const host = fanout["reviewHost"](pipeline, "main");
      const reviewer = pipeline.reviewFanout!.reviewers[0]!;
      await expect(host.reviewerPrompt!(0, 4, reviewer)).rejects.toThrow(
        "transient prompt read failure",
      );
      const recovered = await host.reviewerPrompt!(1, 4, reviewer);
      expect(recovered).toContain("Review carefully");
      await host.reviewerPrompt!(2, 4, reviewer);
      expect(instruction).toHaveBeenCalledTimes(2);
      expect(context).toHaveBeenCalledTimes(failingRead === "reviewContext" ? 2 : 1);
    });
  },
);
