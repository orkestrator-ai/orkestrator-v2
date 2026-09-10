import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { openCodeFake, openCodeProvider } from "./agent-provider-test-support.js";
import { ProviderUnavailableError } from "./native-agent-provider.js";
import { resolveNativeAgentExecutionPolicy } from "./native-agent-execution-policy.js";

const environment = { environmentType: "local" as const, networkAccessMode: "full" as const };
const policy = resolveNativeAgentExecutionPolicy(environment, "looped-review");
const reviewOptions = {
  requestId: "review-request",
  mode: "plan" as const,
  readOnly: true,
  reviewShellPolicy: policy,
};

type Rule = { permission: string; pattern: string; action: string };

// These cases use whole-tool rules. OpenCode appends session rules to the
// agent's rules and evaluates the last match, including the '*' fallback.
function actionFor(update: Record<string, unknown>, tool: string) {
  return (update.permission as Rule[]).findLast(
    (rule) => rule.permission === "*" || rule.permission === tool,
  )?.action;
}

describe("OpenCode reviewer shell permissions", () => {
  test("makes shell available without enabling editing or dropping environment policy", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.send("review-session", "Inspect the packaged Git diff", reviewOptions);
      expect(fake.updateCalls).toHaveLength(1);
      const update = fake.updateCalls[0]!;
      expect(update).toMatchObject({ sessionID: "review-session", directory: "/workspace" });
      for (const tool of ["bash", "shell", "read", "grep"]) {
        expect(actionFor(update, tool)).toBe("allow");
      }
      for (const tool of ["write", "edit", "patch", "apply_patch", "task"]) {
        expect(actionFor(update, tool)).toBe("deny");
      }
      expect(fake.promptCalls[0]!.agent).toBe("plan");
      // Sending even a partial legacy mask here replaces the complete policy.
      expect(fake.promptCalls[0]!.tools).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([
    ["explicit shell denies", { ...policy, toolPolicy: { deny: ["bash", "shell"] } }, "deny"],
    ["approval requirements", { ...policy, approvals: "ask" }, "ask"],
    ["deny by default", { ...policy, approvals: "deny" }, "deny"],
    ["wildcard deny", { ...policy, toolPolicy: { deny: ["*"] } }, "deny"],
  ] satisfies Array<[string, NativeAgentExecutionPolicy, string]>)(
    "preserves %s",
    async (_label, reviewShellPolicy, expectedAction) => {
      const fake = openCodeFake();
      const provider = openCodeProvider(fake);
      try {
        await provider.send("review-session", "Inspect evidence", {
          ...reviewOptions,
          reviewShellPolicy,
        });
        expect(actionFor(fake.updateCalls[0]!, "bash")).toBe(expectedAction);
        expect(actionFor(fake.updateCalls[0]!, "edit")).toBe("deny");
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("cannot widen an existing coordinator session", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const sessionId = await provider.createSession("review", "Coordinator", {
        policy: resolveNativeAgentExecutionPolicy(environment, "coordinator"),
      });
      await provider.send(sessionId, "Inspect evidence", reviewOptions);
      expect(actionFor(fake.updateCalls[0]!, "bash")).toBe("deny");
      expect(actionFor(fake.updateCalls[0]!, "read")).toBe("allow");
    } finally {
      await provider.dispose?.();
    }
  });

  test.each(["error envelope", "transport rejection"])(
    "does not dispatch if updating permissions fails: %s",
    async (failure) => {
      const fake = openCodeFake();
      if (failure === "error envelope") {
        fake.setUpdateResponse({ error: { message: "update failed" } });
      } else {
        fake.client.session.update = async () => {
          throw new Error("connection lost");
        };
      }
      const provider = openCodeProvider(fake);
      try {
        await expect(
          provider.send("review-session", "Inspect evidence", reviewOptions),
        ).rejects.toBeInstanceOf(ProviderUnavailableError);
        expect(fake.promptCalls).toHaveLength(0);
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("rehydrates reviewer permissions after provider recreation and keeps consolidation restricted", async () => {
    const fake = openCodeFake();
    const first = openCodeProvider(fake);
    try {
      await first.send("review-session", "Inspect evidence", reviewOptions);
    } finally {
      await first.dispose?.();
    }
    const restored = openCodeProvider(fake);
    try {
      // No create/resume and no mounted renderer: dispatch supplies the policy.
      await restored.send("review-session", "Continue inspection", {
        ...reviewOptions,
        requestId: "review-continuation",
      });
      expect(fake.updateCalls).toHaveLength(2);
      expect(actionFor(fake.updateCalls[1]!, "bash")).toBe("allow");
      await restored.send("consolidation-session", "Combine the reports", {
        requestId: "consolidation-request",
        mode: "build",
        readOnly: true,
      });
      expect(fake.updateCalls).toHaveLength(2);
      expect(fake.promptCalls.at(-1)!.tools).toMatchObject({
        bash: false,
        shell: false,
        write: false,
        edit: false,
      });
    } finally {
      await restored.dispose?.();
    }
  });
});
