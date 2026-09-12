import { describe, expect, test } from "bun:test";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import type { AgentSessionProvider } from "./native-agent-provider.js";
import {
  openCodeFake,
  openCodeProvider,
  type OpenCodeFake,
} from "./agent-provider-test-support.js";
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

// Mirrors OpenCode's documented simple-glob and last-match-wins evaluator.
// Supplying `agentRules` exercises the server's agent-then-session rule order.
function actionFor(
  update: Record<string, unknown>,
  tool: string,
  pattern = "*",
  agentRules: Rule[] = [],
) {
  const matches = (candidate: string, value: string) => {
    const source = candidate
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")
      .replaceAll("?", ".");
    return new RegExp(`^${source}$`, "s").test(value);
  };
  return [...agentRules, ...(update.permission as Rule[])].findLast(
    (rule) => matches(rule.permission, tool) && matches(rule.pattern, pattern),
  )?.action;
}

async function createReviewerSession(
  fake: OpenCodeFake,
  provider: AgentSessionProvider,
  sessionPolicy: NativeAgentExecutionPolicy = policy,
) {
  fake.setCreateResponse({ data: { id: "review-session" } });
  return provider.createSession("review", "Independent reviewer", {
    mode: "plan",
    readOnly: true,
    reviewerSession: true,
    policy: sessionPolicy,
  });
}

describe("OpenCode reviewer shell permissions", () => {
  test("forwards the selected model and non-default reasoning to session.create", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      fake.setCreateResponse({ data: { id: "review-session" } });
      await provider.createSession("review", "Independent reviewer", {
        mode: "plan",
        readOnly: true,
        reviewerSession: true,
        policy,
        model: "opencode-go/deepseek-v4-flash",
        effort: "high",
      });
      expect(fake.createCalls[0]).toMatchObject({
        title: "Independent reviewer",
        model: {
          providerID: "opencode-go",
          id: "deepseek-v4-flash",
          variant: "high",
        },
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("makes shell available without enabling editing or dropping environment policy", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const sessionId = await createReviewerSession(fake, provider);
      await provider.send(sessionId, "Inspect the packaged Git diff", reviewOptions);
      expect(fake.updateCalls).toHaveLength(1);
      const update = fake.updateCalls[0]!;
      expect(update).toMatchObject({ sessionID: "review-session", directory: "/workspace" });
      for (const tool of ["read", "grep"]) {
        expect(actionFor(update, tool)).toBe("allow");
      }
      for (const tool of [
        "write",
        "edit",
        "patch",
        "apply_patch",
        "task",
        "todowrite",
        "webfetch",
        "websearch",
      ]) {
        expect(actionFor(update, tool)).toBe("deny");
      }
      for (const tool of ["bash", "shell"]) {
        expect(actionFor(update, tool, "git diff HEAD")).toBe("allow");
        expect(actionFor(update, tool, "rg -n TODO apps")).toBe("allow");
        expect(actionFor(update, tool, "git commit -am review")).toBe("deny");
        expect(actionFor(update, tool, "git diff HEAD && touch changed")).toBe("deny");
        expect(actionFor(update, tool, "git diff --output=result.patch HEAD")).toBe("deny");
        expect(actionFor(update, tool, "find . -delete")).toBe("deny");
      }
      expect(fake.promptCalls[0]!.agent).toBe("plan");
      // Sending even a partial legacy mask here replaces the complete policy.
      expect(fake.promptCalls[0]!.tools).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([
    ["explicit bash deny", { ...policy, toolPolicy: { deny: ["bash"] } }, "deny"],
    ["explicit shell deny", { ...policy, toolPolicy: { deny: ["shell"] } }, "deny"],
    ["approval requirements", { ...policy, approvals: "ask" }, "ask"],
    ["deny by default", { ...policy, approvals: "deny" }, "deny"],
    ["wildcard deny", { ...policy, toolPolicy: { deny: ["*"] } }, "deny"],
  ] satisfies Array<[string, NativeAgentExecutionPolicy, string]>)(
    "preserves %s",
    async (_label, reviewShellPolicy, expectedAction) => {
      const fake = openCodeFake();
      const provider = openCodeProvider(fake);
      try {
        const sessionId = await createReviewerSession(fake, provider, reviewShellPolicy);
        await provider.send(sessionId, "Inspect evidence", {
          ...reviewOptions,
          reviewShellPolicy,
        });
        expect(actionFor(fake.updateCalls[0]!, "bash", "git diff HEAD")).toBe(expectedAction);
        expect(actionFor(fake.updateCalls[0]!, "shell", "git diff HEAD")).toBe(expectedAction);
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
      expect(fake.updateCalls).toHaveLength(0);
      expect(fake.promptCalls[0]!.tools).toMatchObject({ bash: false, shell: false });
    } finally {
      await provider.dispose?.();
    }
  });

  test("cannot widen a coordinator session after provider recreation", async () => {
    const fake = openCodeFake();
    const first = openCodeProvider(fake);
    fake.setCreateResponse({ data: { id: "coordinator-session" } });
    try {
      await first.createSession("review", "Coordinator", {
        policy: resolveNativeAgentExecutionPolicy(environment, "coordinator"),
      });
    } finally {
      await first.dispose?.();
    }
    const restored = openCodeProvider(fake);
    try {
      await restored.send("coordinator-session", "Inspect evidence", reviewOptions);
      expect(fake.updateCalls).toHaveLength(0);
      expect(fake.promptCalls[0]!.tools).toMatchObject({ bash: false, shell: false });
    } finally {
      await restored.dispose?.();
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
        const sessionId = await createReviewerSession(fake, provider);
        await expect(
          provider.send(sessionId, "Inspect evidence", reviewOptions),
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
      const sessionId = await createReviewerSession(fake, first);
      await first.send(sessionId, "Inspect evidence", reviewOptions);
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
      expect(actionFor(fake.updateCalls[1]!, "bash", "git diff HEAD")).toBe("allow");
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

  test("restores the durable base rules when a reviewer turn becomes idle", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const sessionId = await createReviewerSession(fake, provider);
      await provider.send(sessionId, "Inspect evidence", reviewOptions);
      fake.setStatusResponse({ data: { [sessionId]: { type: "idle" } } });

      await expect(provider.status(sessionId)).resolves.toBe("idle");
      expect(fake.updateCalls).toHaveLength(2);
      const restored = fake.updateCalls[1]!;
      expect(actionFor(restored, "bash", "git commit -am later")).toBe("allow");
      expect(actionFor(restored, "edit")).toBe("allow");

      await provider.send(sessionId, "Continue in build mode", {
        requestId: "later-build-turn",
        mode: "build",
      });
      expect(fake.updateCalls).toHaveLength(2);
      expect(fake.promptCalls.at(-1)!.tools).toBeUndefined();
    } finally {
      await provider.dispose?.();
    }
  });

  test("restores an idle reviewer permission grant after provider recreation", async () => {
    const fake = openCodeFake();
    const first = openCodeProvider(fake);
    try {
      const sessionId = await createReviewerSession(fake, first);
      await first.send(sessionId, "Inspect evidence", reviewOptions);
    } finally {
      await first.dispose?.();
    }

    const restoredProvider = openCodeProvider(fake);
    restoredProvider.registerSession?.("review-session", {
      origin: "looped-review",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      reviewerSession: true,
      phase: "review",
    });
    fake.setStatusResponse({ data: { "review-session": { type: "idle" } } });
    try {
      await expect(restoredProvider.status("review-session")).resolves.toBe("idle");
      expect(fake.updateCalls).toHaveLength(2);
      expect(actionFor(fake.updateCalls[1]!, "edit")).toBe("allow");
      expect(actionFor(fake.updateCalls[1]!, "bash", "git commit -am later")).toBe("allow");
    } finally {
      await restoredProvider.dispose?.();
    }
  });

  test("session rules override a permissive plan agent for concrete command inputs", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      const sessionId = await createReviewerSession(fake, provider);
      await provider.send(sessionId, "Inspect evidence", reviewOptions);
      const permissivePlanAgent: Rule[] = [{ permission: "*", pattern: "*", action: "allow" }];
      const rules = fake.updateCalls[0]!;
      expect(actionFor(rules, "bash", "git diff HEAD", permissivePlanAgent)).toBe("allow");
      expect(actionFor(rules, "bash", "git commit -am changed", permissivePlanAgent)).toBe("deny");
      expect(actionFor(rules, "edit", "src/index.ts", permissivePlanAgent)).toBe("deny");
    } finally {
      await provider.dispose?.();
    }
  });
});
