import { expect, test } from "bun:test";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { recoveredDispatchAcceptance } from "./provider-dispatch-recovery.js";

test.each(["absent", "lost", "unknown"] as const)(
  "a result naming another request does not override %s",
  async (status) => {
    const provider = {
      dispatchStatus: async () => status,
      structured: async () => ({ ok: true, requestId: "other", value: {} }),
    } as unknown as BuildPipelineProvider;
    expect(await recoveredDispatchAcceptance(provider, "session", "request")).toBe(status);
  },
);

test("failed result and journal reads leave a recovered dispatch unknown", async () => {
  const provider = {
    dispatchStatus: async () => {
      throw new Error("unreachable");
    },
    structured: async () => {
      throw new Error("unreachable");
    },
  } as unknown as BuildPipelineProvider;
  expect(await recoveredDispatchAcceptance(provider, "session", "request")).toBe("unknown");
});

test("a missing tool result never falls back to another transport", async () => {
  const provider = {
    dispatchStatus: async () => "lost",
    structured: async () => ({ ok: true, requestId: "request", value: {} }),
  } as unknown as BuildPipelineProvider;
  expect(await recoveredDispatchAcceptance(provider, "session", "request", () => null)).toBe(
    "lost",
  );
});
