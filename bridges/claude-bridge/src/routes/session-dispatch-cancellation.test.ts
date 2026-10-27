import { expect, spyOn, test } from "bun:test";
import {
  createSession,
  getSession,
  mockQuery,
  readSessionPreferences,
  track,
  waitFor,
  withTemporaryClaudeHome,
} from "../services/session-manager-test-harness.js";
import * as queryPreparation from "../services/session-manager-prompt-query.js";
import { Hono } from "hono";
import sessionRoutes from "./session.js";

const app = new Hono().route("/session", sessionRoutes);

for (const action of ["stop", "delete"] as const) {
  test(`structured durable claim settles when ${action} interrupts preparation`, async () => {
    await withTemporaryClaudeHome("claude-structured-cancel-", async () => {
      const session = createSession("structured cancellation");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);
      const requestId = "unsent-structured-request";
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = queryPreparation.resolveQueryPlan;
      const prepare = spyOn(queryPreparation, "resolveQueryPlan").mockImplementation(
        async (...args) => {
          const plan = await original(...args);
          entered.resolve();
          await release.promise;
          return plan;
        },
      );
      const queries = mockQuery.mock.calls.length;
      let prompt: Promise<Response> | undefined;
      let deletion: Promise<Response> | undefined;
      try {
        prompt = app.request(`/session/${session.id}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "Review", requestId, outputSchema: { type: "object" } }),
        });
        await entered.promise;
        expect((await readSessionPreferences(sdkSessionId))?.dispatchedRequestIds).toContain(
          requestId,
        );
        if (action === "stop") {
          const stopped = await app.request(`/session/${session.id}/hard-abort`, {
            method: "POST",
          });
          expect(stopped.status).toBe(200);
        } else {
          deletion = app.request(`/session/${session.id}`, { method: "DELETE" });
          await waitFor(() => session.deleting === true);
        }
        release.resolve();
        expect((await prompt).status).toBe(409);
        expect(mockQuery.mock.calls.length).toBe(queries);
        expect(
          (await readSessionPreferences(sdkSessionId))?.dispatchedRequestIds ?? [],
        ).not.toContain(requestId);
        if (deletion) {
          expect((await deletion).status).toBe(200);
          expect(getSession(session.id)).toBeUndefined();
        } else {
          expect(session.dispatchedRequestIds?.has(requestId)).toBe(false);
        }
      } finally {
        release.resolve();
        await prompt;
        await deletion;
        prepare.mockRestore();
      }
    });
  });
}
