import { describe, expect, test } from "bun:test";
import type { AgentInteractionRequest } from "./agent-interactions.js";
import { PENDING_INTERACTION_DETAIL_MAX, summarizePendingInteractions } from "./agent-registry.js";

function request(
  id: string,
  overrides: Partial<AgentInteractionRequest> & {
    title?: string;
    questions?: AgentInteractionRequest["presentation"]["questions"];
  } = {},
): AgentInteractionRequest {
  const { title, questions, ...rest } = overrides;
  return {
    version: 1,
    id,
    provider: "claude",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId: "session",
    state: "pending",
    revision: 1,
    presentation: {
      title: title ?? "Claude wants to run bun install",
      body: "Command: bun install --token=SECRET",
      questions: questions ?? [],
    },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...rest,
  };
}

function question(prompt: string, secret = false) {
  return {
    id: "q",
    prompt,
    required: true,
    multiple: false,
    secret,
    allowFreeText: true,
    options: [],
  };
}

describe("summarizePendingInteractions", () => {
  test("an approval is summarised by its title, never its body", () => {
    expect(summarizePendingInteractions([request("a")])).toEqual({
      interactionId: "a",
      kind: "command-approval",
      label: "Needs approval",
      detail: "Claude wants to run bun install",
      since: 1_000,
      count: 1,
    });
  });

  test("a fixed command approval title gets the operation label", () => {
    const summary = summarizePendingInteractions([request("a", { title: "Approve command" })]);
    expect(summary?.label).toBe("Needs command approval");
    expect(summary?.detail).toBeUndefined();
  });

  test("a question is summarised by its first prompt on one line", () => {
    const summary = summarizePendingInteractions([
      request("q", {
        kind: "question",
        title: "Claude needs input",
        questions: [question("Which API\nshould this use?")],
      }),
    ]);
    expect(summary).toMatchObject({ label: "Question", detail: "Which API should this use?" });
  });

  test("a request holding secret input, a link or a plan gets only its label", () => {
    const secret = summarizePendingInteractions([
      request("s", {
        kind: "question",
        title: "Enter your API key",
        questions: [question("API key", true)],
      }),
    ]);
    expect(secret).toMatchObject({ label: "Question" });
    expect(secret?.detail).toBeUndefined();
    const form = summarizePendingInteractions([
      request("f", {
        kind: "mcp-form",
        title: "Enter your API key",
        questions: [question("Schema")],
      }),
    ]);
    expect(form).toMatchObject({ label: "Needs input" });
    expect(form?.detail).toBeUndefined();
    const link = summarizePendingInteractions([
      request("u", { kind: "mcp-url", title: "Sign in at https://example.invalid/?code=1" }),
    ]);
    expect(link).toMatchObject({ label: "Needs you to open a link" });
    expect(link?.detail).toBeUndefined();
    const plan = summarizePendingInteractions([
      request("p", { kind: "plan-approval", title: "Approve the plan" }),
    ]);
    expect(plan).toMatchObject({ label: "Plan ready for review" });
    expect(plan?.detail).toBeUndefined();
  });

  test("the oldest blocking request is the one named; settled ones are not counted", () => {
    const summary = summarizePendingInteractions([
      request("late", { createdAt: 3_000 }),
      request("advisory", { createdAt: 500, blocking: false }),
      request("early", { createdAt: 2_000 }),
      request("done", { createdAt: 100, state: "resolved" }),
    ]);
    expect(summary).toMatchObject({ interactionId: "early", since: 2_000, count: 3 });
    expect(summarizePendingInteractions([request("done", { state: "resolved" })])).toBeUndefined();
    expect(summarizePendingInteractions([])).toBeUndefined();
  });

  test("a long title is bounded and control characters are dropped", () => {
    const summary = summarizePendingInteractions([
      request("a", { title: `Run\u0007 ${"x".repeat(400)}` }),
    ]);
    expect(Array.from(summary!.detail!)).toHaveLength(PENDING_INTERACTION_DETAIL_MAX);
    expect(summary!.detail!.startsWith("Run x")).toBe(true);
    expect(summary!.detail!.endsWith("…")).toBe(true);
  });
});
