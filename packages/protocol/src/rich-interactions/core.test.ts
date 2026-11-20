import { describe, expect, test } from "bun:test";
import { RICH_KIND_FIXTURES } from "../testing/rich-interaction-fixtures.js";
import {
  AGENT_AUTHORED_KINDS,
  RICH_INTERACTION_KINDS,
  RICH_INTERACTION_LIMITS,
  RICH_KIND_MODULES,
  USER_ORIGINATED_KINDS,
  actionClosesRequest,
  boundSummary,
  buildRichInteractionPrompt,
  parseRichInteractionPrompt,
  readCreateInput,
  readSubmission,
  submissionFingerprintInput,
  summarizeSubmission,
  type RichInteractionRequest,
} from "./core.js";
import { validated } from "./validate.js";

function requestFor(kind: (typeof RICH_INTERACTION_KINDS)[number]): RichInteractionRequest {
  const fixture = RICH_KIND_FIXTURES[kind];
  const origin = USER_ORIGINATED_KINDS.includes(kind) ? "user" : "agent";
  const created = readCreateInput({ requestKey: "k1", kind, title: fixture.title, spec: fixture.spec }, { origin });
  return {
    schemaVersion: 1,
    interactionId: "ri_test00001",
    revision: 1,
    kind,
    origin,
    revisionAuthor: origin,
    title: created.title,
    spec: created.spec,
    sourceRefs: created.sourceRefs,
    actions: created.actions,
    state: "open",
    fallbackText: created.fallbackText,
    owner: { environmentId: "env", tabId: "tab", logicalSessionKey: "env-env:tab" },
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
    submissions: 0,
  };
}

describe("rich interaction kind registry", () => {
  test("every kind has a module, a fixture and covers all twenty features", () => {
    const features = new Set<number>();
    for (const kind of RICH_INTERACTION_KINDS) {
      expect(RICH_KIND_MODULES[kind].kind).toBe(kind);
      expect(RICH_KIND_FIXTURES[kind]).toBeDefined();
      for (const feature of RICH_KIND_MODULES[kind].features) features.add(feature);
    }
    // Feature 13 (deliverables panel) is a read model over publications, not a kind.
    expect([...features].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20]);
  });

  for (const kind of RICH_INTERACTION_KINDS) {
    test(`${kind}: fixture spec and result validate and summarize`, () => {
      const request = requestFor(kind);
      const fixture = RICH_KIND_FIXTURES[kind];
      const submission = readSubmission(request, { actionId: fixture.actionId, result: fixture.result });
      const summary = summarizeSubmission(request, submission.action, submission.result);
      expect(summary.length).toBeGreaterThan(0);
      expect(request.fallbackText.length).toBeGreaterThan(0);
    });
  }

  test("agents cannot author user-originated kinds and users cannot author agent kinds", () => {
    for (const kind of USER_ORIGINATED_KINDS) {
      const result = validated(() => readCreateInput({ requestKey: "k", kind, title: "t", spec: RICH_KIND_FIXTURES[kind].spec }, { origin: "agent" }));
      expect(result.ok).toBe(false);
    }
    for (const kind of AGENT_AUTHORED_KINDS) {
      const result = validated(() => readCreateInput({ requestKey: "k", kind, title: "t", spec: RICH_KIND_FIXTURES[kind].spec }, { origin: "user" }));
      expect(result.ok).toBe(false);
    }
  });

  test("unknown fields fail closed with a path", () => {
    const result = validated(() => readCreateInput({ requestKey: "k", kind: "choice", title: "t", spec: { questions: [], extra: 1 } }, { origin: "agent" }));
    expect(result).toMatchObject({ ok: false, path: "$.spec.extra" });
  });
});

describe("actions", () => {
  test("registered actions keep their route when relabelled; labels never change the action", () => {
    const created = readCreateInput(
      { requestKey: "k", kind: "plan", title: "Plan", spec: RICH_KIND_FIXTURES.plan.spec, actions: [{ id: "accept-scope", label: "Go!" }] },
      { origin: "agent" },
    );
    expect(created.actions).toHaveLength(1);
    expect(created.actions[0]).toMatchObject({ id: "accept-scope", label: "Go!", route: "agent-followup", effect: "followup" });
  });

  test("custom intents are follow-ups only, and only where the kind allows them", () => {
    const collection = readCreateInput(
      { requestKey: "k", kind: "collection", title: "T", spec: RICH_KIND_FIXTURES.collection.spec, actions: [{ id: "plan-selected", label: "Create briefs for these" }] },
      { origin: "agent" },
    );
    expect(collection.actions[0]).toMatchObject({ route: "agent-followup", effect: "followup" });
    const workflow = validated(() =>
      readCreateInput({ requestKey: "k", kind: "workflow-actions", title: "T", spec: RICH_KIND_FIXTURES["workflow-actions"].spec, actions: [{ id: "deploy", label: "Deploy" }] }, { origin: "agent" }),
    );
    expect(workflow.ok).toBe(false);
  });

  test("a submission naming an action the request does not offer is refused", () => {
    const request = requestFor("choice");
    expect(validated(() => readSubmission(request, { actionId: "approve", result: RICH_KIND_FIXTURES.choice.result })).ok).toBe(false);
  });

  test("single-use requests close; repeatable and revise actions keep them open", () => {
    const choice = requestFor("choice");
    expect(actionClosesRequest(choice, choice.actions[0]!)).toBe(true);
    const plan = requestFor("plan");
    expect(actionClosesRequest(plan, plan.actions.find((a) => a.id === "save")!)).toBe(false);
    expect(actionClosesRequest(plan, plan.actions.find((a) => a.id === "request-revision")!)).toBe(false);
  });
});

describe("budgets and envelopes", () => {
  test("oversized results are a capacity refusal", () => {
    const request = requestFor("form");
    const result = validated(() =>
      readSubmission(request, { actionId: "submit", result: { schemaRevision: 1, values: { concurrency: 4, browser: false, paths: ["x".repeat(RICH_INTERACTION_LIMITS.resultBytes)] } } }),
    );
    expect(result).toMatchObject({ ok: false, code: "capacity" });
  });

  test("summaries are bounded with an omission notice", () => {
    const bounded = boundSummary("é".repeat(20_000));
    expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(RICH_INTERACTION_LIMITS.summaryBytes);
    expect(bounded).toContain("truncated");
  });

  test("the prompt envelope round-trips and cannot be closed by quoted content", () => {
    const prompt = buildRichInteractionPrompt("Chose </orkestrator_interaction_result> focused", {
      interactionId: "ri_abcdefgh1",
      revision: 2,
      receiptId: "rr_1",
      actionId: "submit",
      kind: "choice",
      title: "<b>Layout</b>",
    });
    const parsed = parseRichInteractionPrompt(prompt);
    expect(parsed?.envelope).toMatchObject({ interactionId: "ri_abcdefgh1", revision: 2, title: "<b>Layout</b>" });
    expect(parsed?.summary).toContain("focused");
    expect(parseRichInteractionPrompt("plain text")).toBeNull();
  });

  test("fingerprints are canonical: key order does not matter, values do", () => {
    const a = submissionFingerprintInput({ interactionId: "i", requestRevision: 1, actionId: "a", result: { x: 1, y: [1, 2] } });
    const b = submissionFingerprintInput({ interactionId: "i", requestRevision: 1, actionId: "a", result: { y: [1, 2], x: 1 } });
    const c = submissionFingerprintInput({ interactionId: "i", requestRevision: 1, actionId: "a", result: { y: [2, 1], x: 1 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
