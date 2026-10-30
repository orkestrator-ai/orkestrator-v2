import { describe, expect, test } from "bun:test";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

describe("NativeAgentService transient reviewer inspection", () => {
  test("does not persist or enroll a reviewer in activity reconciliation", async () => {
    const stub = createProviderStub("opencode", {
      status: async () => "running",
      activity: async () => "working",
      interactiveSnapshot: async () => ({ status: "running", messages: [] }),
    });
    await withService(
      { prefix: "orkestrator-reviewer-inspection-", provider: async () => stub.provider },
      async ({ service, storage }) => {
        const identity = {
          environmentId: "env-1",
          agent: "opencode" as const,
          logicalSessionKey: "multi-review:workflow-1:reviewer:reviewer-1",
        };
        const projection = await service.inspectSession({
          ...identity,
          providerSessionId: "reviewer-session",
          origin: "automated-review",
        });
        expect(projection?.sessionId).toBe("reviewer-session");
        expect(projection?.turn.phase).toBe("running");
        expect(await storage.listNativeAgentSessions()).toEqual([]);
        stub.status.mockClear();
        stub.activity!.mockClear();
        stub.interactiveSnapshot!.mockClear();
        await service.reconcileAgentActivity();
        expect(stub.status).not.toHaveBeenCalled();
        expect(stub.activity).not.toHaveBeenCalled();
        expect(stub.interactiveSnapshot).not.toHaveBeenCalled();
        expect(await storage.listNativeAgentSessions()).toEqual([]);
        expect(stub.createSession).not.toHaveBeenCalled();
      },
    );
  });
});
