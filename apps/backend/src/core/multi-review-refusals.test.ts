import { expect, test } from "bun:test";
import { multiReviewDeleteRefusal, multiReviewStartRefusal } from "./multi-review-refusals.js";
import { Provider, waitUntil, withService } from "./multi-review-service-test-support.js";

const FAILED_DELETE =
  "This Multi Review failed. Retry the failed stage or abandon (cancel) the review before deleting it";
const FAILED_START =
  "The existing Multi Review failed. Retry its failed stage or abandon (cancel) it before starting another";

test("a failed review's refusals name the phase and the way out, never 'running'", () => {
  expect(multiReviewDeleteRefusal("failed")).toBe(FAILED_DELETE);
  expect(multiReviewStartRefusal(["failed"])).toBe(FAILED_START);
  expect(multiReviewStartRefusal(["failed", "failed"])).toBe(FAILED_START);
  for (const message of [FAILED_DELETE, FAILED_START]) expect(message).not.toContain("running");
});

test("an active review that has not failed keeps the existing refusals", () => {
  expect(multiReviewDeleteRefusal("reviewing")).toBe(
    "Cancel or finish the running Multi Review before deleting it",
  );
  const finish = "Finish, cancel, or delete the existing Multi Review before starting another";
  expect(multiReviewStartRefusal(["preparing"])).toBe(finish);
  // A running review beside a failed one is not described as failed.
  expect(multiReviewStartRefusal(["failed", "reviewing"])).toBe(finish);
  // The record could not be read back: say nothing it cannot prove.
  expect(multiReviewStartRefusal([])).toBe(finish);
});

test("MultiReviewService refuses to delete or replace a failed review with the failed wording", async () => {
  const environmentId = "env-failed-refusals";
  await withService(
    environmentId,
    new Provider(false),
    async ({ service, storage, start, snapshot }) => {
      const started = await start();
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "failed";
      });

      await expect(service.close(started.id)).rejects.toThrow(FAILED_DELETE);
      await expect(
        service.start({
          environmentId,
          projectId: "project-1",
          targetBranch: "main",
          reviewers: [{ agent: "claude", model: "opus" }],
          fixModel: { agent: "claude", model: "fix-model" },
        }),
      ).rejects.toThrow(FAILED_START);
      expect(await storage.getMultiReviewWorkflow(started.id)).not.toBeNull();

      // Abandoning it (cancel) is the way out the message names.
      await service.cancel(started.id);
      await waitUntil(async () => {
        await service.advanceNow(started.id);
        return (await snapshot(started.id))?.phase === "cancelled";
      });
      await service.close(started.id);
      expect(await storage.getMultiReviewWorkflow(started.id)).toBeNull();
    },
    {
      packageFlow: true,
      environmentType: "containerized",
      serviceOptions: {
        // Fails the preparation step before any turn, which leaves the
        // workflow in `failed`.
        assertAgentToolsReachable: async () => {
          throw new Error("the container can't reach the agent tools server");
        },
      },
    },
  );
});
