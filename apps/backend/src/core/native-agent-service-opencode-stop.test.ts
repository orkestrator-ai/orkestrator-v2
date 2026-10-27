import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { openCodeFake, openCodeProvider } from "./agent-provider-test-support.js";
import { NativeAgentService } from "./native-agent-service.js";
import {
  addEnvironment,
  createStorage,
  refusingInvoke,
} from "./native-agent-service-projection-test-support.js";

const identity = {
  environmentId: "env-1",
  agent: "opencode" as const,
  logicalSessionKey: "env-env-1:tab-opencode-stop",
};

describe("OpenCode stop with pending-request cleanup failure", () => {
  for (const failure of ["read", "reject"] as const) {
    for (const outcome of [
      "graceful",
      "force-stop",
      "force-stop error",
      "no force-stop",
    ] as const) {
      test(`${failure} failure still completes the ${outcome} ladder and records a notice`, async () => {
        const root = await mkdtemp(join(tmpdir(), "ork-opencode-stop-"));
        const storage = await createStorage(root);
        await addEnvironment(storage);
        const fake = openCodeFake();
        const provider = openCodeProvider(fake);
        const calls: string[] = [];
        let polls = 0;
        provider.status = async () => {
          calls.push("status");
          polls += 1;
          return outcome === "graceful" && polls >= 2 ? "idle" : "running";
        };
        if (outcome === "force-stop" || outcome === "force-stop error") {
          provider.hardAbort = async () => {
            calls.push("hard-abort");
            if (outcome === "force-stop error") throw new Error("force-stop unavailable");
          };
        }
        let abortError: unknown;
        const abort = provider.abort.bind(provider);
        provider.abort = async (id) => {
          calls.push("abort");
          try {
            return await abort(id);
          } catch (error) {
            abortError = error;
            throw error;
          }
        };
        let now = 0;
        const service = new NativeAgentService(storage, refusingInvoke, {
          provider: async () => provider,
          abortGraceMs: 20,
          now: () => (now += 10),
        });
        try {
          await service.ensureSession(identity);
          fake.setPending(
            [],
            [
              {
                id: "question-stopped",
                sessionID: "owned-session",
                questions: [
                  {
                    header: "Continue?",
                    question: "Continue the turn?",
                    options: [{ label: "Yes", description: "Continue" }],
                  },
                ],
              },
            ],
          );
          if (failure === "read") fake.setPendingReadErrors(new Error("unreachable"), null);
          else
            fake.setQuestionRejectResponse({
              error: { message: "failed" },
              response: { status: 500 },
            });
          calls.length = 0;
          polls = 0;

          const error = await service
            .stopProjectionSession(identity)
            .catch((error: unknown) => error);
          expect(error).toBeInstanceOf(ProviderUnavailableError);
          expect(error).toBe(abortError);

          expect(calls[0]).toBe("abort");
          expect(calls.filter((call) => call === "status").length).toBeGreaterThanOrEqual(2);
          expect(calls.includes("hard-abort")).toBe(
            outcome === "force-stop" || outcome === "force-stop error",
          );
          if (outcome === "force-stop" || outcome === "force-stop error")
            expect(calls.indexOf("hard-abort")).toBeGreaterThan(calls.indexOf("status"));
          // Pending reads may keep the projection in recovery. Once OpenCode
          // is readable again, the next refresh must deliver the stop notice.
          fake.setPendingReadErrors(null, null);
          const projection =
            failure === "read"
              ? await service.getProjection(identity)
              : service.cachedProjectionSnapshot(
                  identity.environmentId,
                  identity.agent,
                  identity.logicalSessionKey,
                );
          const messages =
            projection?.messages.map((message) => (message as { content?: unknown }).content) ?? [];
          expect(messages).toContain(
            outcome === "graceful"
              ? "The turn stopped after a graceful interrupt."
              : outcome === "force-stop" || outcome === "force-stop error"
                ? "The turn did not stop within the grace period and a force-stop was requested."
                : "The turn did not stop within the grace period; this provider has no force-stop action.",
          );
        } finally {
          await service.shutdown();
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});
