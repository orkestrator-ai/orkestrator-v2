/**
 * Mail injected as a new turn first gives the backend the chance to
 * fast-forward a coordinator's checkout (`beforeMailInject`,
 * `coordinator-mail-upstream.ts`), so the turn reads current code. The hook
 * never stands between the mail and its delivery.
 */
import { describe, expect, mock, test } from "bun:test";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const identity = {
  environmentId: "env-1",
  agent: "cursor" as const,
  logicalSessionKey: "env-env-1:mail-upstream",
};

describe("native agent mail inject upstream hook", () => {
  test("runs before the mail turn is sent", async () => {
    const order: string[] = [];
    const stub = createProviderStub("cursor", {
      send: async () => {
        order.push("send");
      },
    });
    const beforeMailInject = mock(async (environmentId: string) => {
      order.push(`before:${environmentId}`);
    });
    await withService(
      {
        prefix: "orkestrator-mail-upstream-order-",
        provider: async () => stub.provider,
        beforeMailInject,
      },
      async ({ service }) => {
        await service.ensureSession(identity);
        expect(
          await service.dispatchMailInject({
            ...identity,
            prompt: "worker report",
            requestId: "mail-upstream-1",
          }),
        ).toMatchObject({ outcome: "accepted" });
        expect(order).toEqual(["before:env-1", "send"]);
      },
    );
  });

  test("a failing hook does not hold the mail", async () => {
    const stub = createProviderStub("cursor");
    await withService(
      {
        prefix: "orkestrator-mail-upstream-failing-",
        provider: async () => stub.provider,
        beforeMailInject: async () => {
          throw new Error("fetch failed");
        },
      },
      async ({ service }) => {
        await service.ensureSession(identity);
        expect(
          await service.dispatchMailInject({
            ...identity,
            prompt: "worker report",
            requestId: "mail-upstream-2",
          }),
        ).toMatchObject({ outcome: "accepted" });
        expect(stub.send).toHaveBeenCalledTimes(1);
      },
    );
  });
});
